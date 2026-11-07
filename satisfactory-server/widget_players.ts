// Sibling files are type imports only: each script is compiled standalone, so runtime imports of them wouldn't resolve.
import { createSocket } from "node:dgram";
import { type FileHandle, open } from "node:fs/promises";

import type { WidgetContext, WidgetFieldValue, WidgetMount, WidgetQueryResult } from "../_lib/widget_context";

// Who's on a Satisfactory server, out of how many it takes. The card folds back to the plain one
// while nobody is, as Minecraft's and Valheim's do.
//
// The players come from the server's own log, FactoryGame.log under the game's folder in /config.
// The server opens a new one each time it starts, and Unreal logs each player's way in and out:
//   LogNet: Login request: ?ClientIdentity=...?Name=Pioneer userId: Steam:2 (ForeignId=[Type=6 Handle=1 RepData=[...]) platform: Steam
//   LogNet: Join succeeded: Pioneer
//   LogNet: UNetConnection::Close: [UNetConnection] RemoteAddr: ..., Driver: GameNetDriver ..., UniqueId: Steam:2 (...), Channels: 41, Time: ...
// A leave names only the player's id, so each join takes the id its login gave. No other source
// names the players: the server's HTTPS API counts them, but only for a token, which it hands out
// without a password only before the server is claimed or while it has no player password, and its
// UDP query holds no count at all.
//
// The limit is the image's MAXPLAYERS (4 unless the owner sets the variable). The image passes it
// on the server's command line, which the log's first lines repeat:
//   LogInit: Command Line: -Port=7777 ... -ini:Game:[/Script/Engine.GameSession]:MaxPlayers=4 ...
//
// The title is the session the server loaded (sessionName= in its LoadMap line), else the name the
// owner gave the server in Server Manager, which the UDP query answers without a password.
//
// A server that runs for weeks writes a log of many megabytes, so the script keeps its place and
// reads only what the log gained since the last refresh. A log the mount doesn't show is read whole
// out of the app's container, over the daemon socket the HexOS container has for its host
// commands, while it's small enough to.

const LOG = "/gamefiles/FactoryGame/Saved/Logs/FactoryGame.log";
const DOCKER_SOCKET = "/var/run/docker.sock";
/** Docker and the query share the widget's 5 s timeout, so a stuck one reads as nothing rather than failing the card. */
const DOCKER_TIMEOUT_MS = 1500;
const QUERY_TIMEOUT_MS = 1000;
/** What one refresh reads of a log it's catching up on; the rest waits for the next refresh. */
const READ_BUDGET = 16 * 1024 * 1024;
const CHUNK = 1024 * 1024;
/** The largest log a refresh takes whole out of the container, where it can't keep its place. */
const DOCKER_MAX_BYTES = 8 * 1024 * 1024;
/** The log's opening bytes, which carry the moment it was opened, so a new log is never read as the old one grown. */
const HEAD_BYTES = 256;
/** Logins on their way in that a refresh keeps; a login that never joins leaves when its connection closes. */
const MAX_PENDING = 64;
const DEFAULT_MAX_PLAYERS = 4;
const DEFAULT_PORT = 7777;
const QUERY_MAGIC = 0xf6d5;

/** The config folder, by its host path, since the chart mounts it at /config itself. A later copy's ends in -2. */
export const configMount = (mounts: WidgetMount[]): WidgetMount | undefined =>
  mounts.find((m) => m.containerPath === "/config") ??
  mounts.find((m) => /\/satisfactory-server(-\d+)?\/config$/.test(m.hostPath));

export interface Roster {
  /** Who's on, by the player id their login gave, in the order they joined. */
  online: Map<string, string>;
  /** Logins on their way in, oldest first. */
  pending: { name: string; id: string }[];
  max: number;
  /** The game port, which the UDP query answers on. */
  port: number | null;
  session: string | null;
}

export const newRoster = (): Roster => ({
  online: new Map(),
  pending: [],
  max: DEFAULT_MAX_PLAYERS,
  port: null,
  session: null,
});

// Lines written once the engine's clock runs start with a [time][frame] stamp
const STAMP = String.raw`^(?:\[[^\]]*\]\[[^\]]*\])?`;
const COMMAND_LINE = new RegExp(`${STAMP}LogInit: Command Line: (.*)$`);
const MAX_PLAYERS = /-ini:Game:\[\/Script\/Engine\.GameSession\]:MaxPlayers=(\d+)/;
const GAME_PORT = /(?:^|\s)-Port=(\d+)/;
const LOAD_MAP = new RegExp(`${STAMP}LogLoad: LoadMap: (.+)$`);
const LOGIN = new RegExp(`${STAMP}LogNet: Login request: (.*?) userId: (.+) platform: \\S+$`);
const JOINED = new RegExp(`${STAMP}LogNet: Join succeeded: (.+)$`);
// Only the game's own connections: a player's id on any other would end nothing they're in
const CLOSED = new RegExp(
  `${STAMP}LogNet: UNetConnection::Close: .*Driver: [^,]*GameNetDriver.*, UniqueId: (.+?)(?:, Channels: .*)?$`,
);

/** One option of an Unreal travel URL ("/Game/Map?listen?sessionName=Base"), or null. */
export function urlOption(url: string, key: string): string | null {
  for (const part of url.split("?").slice(1)) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).toLowerCase() === key.toLowerCase()) return part.slice(at + 1).trim() || null;
  }
  return null;
}

/**
 * A player's id as a login and a closed connection both print it: the platform's own id where the
 * line shows one (RepData), else the whole text. Null for a connection that never signed in.
 */
export function playerId(text: string): string | null {
  const platform = /RepData=\[([0-9A-Fa-f]+)\]/.exec(text)?.[1];
  if (platform) return platform.toUpperCase();
  const id = text.trim();
  return id && !/\b(?:INVALID|UNKNOWN)\b/i.test(id) ? id : null;
}

function join(roster: Roster, name: string): void {
  // The login under the same name, else the oldest still on its way in, in case the game names a
  // player otherwise than their login asked
  let at = roster.pending.findIndex((login) => login.name === name);
  if (at < 0 && roster.pending.length) at = 0;
  const id = at >= 0 ? roster.pending.splice(at, 1)[0].id : `name:${name}`;
  roster.online.delete(id);
  roster.online.set(id, name);
}

/** Reads one line of the log into the roster. */
export function feed(roster: Roster, raw: string): void {
  const line = raw.trimEnd();
  if (line.includes("LogNet: ")) {
    const joined = JOINED.exec(line);
    if (joined) return join(roster, joined[1].trim());
    const login = LOGIN.exec(line);
    if (login) {
      const id = playerId(login[2]);
      if (!id) return;
      roster.pending.push({ name: urlOption(login[1], "Name") ?? "", id });
      if (roster.pending.length > MAX_PENDING) roster.pending.shift();
      return;
    }
    const closed = CLOSED.exec(line);
    const id = closed ? playerId(closed[1]) : null;
    if (!id) return;
    roster.online.delete(id);
    roster.pending = roster.pending.filter((login) => login.id !== id);
    return;
  }
  if (line.includes("LogLoad: LoadMap: ")) {
    const url = LOAD_MAP.exec(line)?.[1];
    if (!url) return;
    // Loading a session ends every connection, and each player who follows it logs in again
    roster.online.clear();
    roster.pending = [];
    roster.session = urlOption(url, "sessionName");
    return;
  }
  if (line.includes("LogInit: Command Line: ")) {
    const command = COMMAND_LINE.exec(line)?.[1] ?? "";
    const max = Number(MAX_PLAYERS.exec(command)?.[1]);
    if (max > 0) roster.max = max;
    const port = Number(GAME_PORT.exec(command)?.[1]);
    if (port > 0) roster.port = port;
  }
}

/** The roster a whole log gives. */
export function readLog(text: string): Roster {
  const roster = newRoster();
  for (const line of text.split("\n")) feed(roster, line);
  return roster;
}

interface Place {
  head: Buffer;
  offset: number;
  partial: string;
  decoder: TextDecoder;
  roster: Roster;
}

// Where each log was read up to, by its path. The platform keeps a widget's module loaded while its
// script is unchanged, so this lasts from one refresh to the next.
const places = new Map<string, Place>();
const reading = new Map<string, Promise<Roster | "behind" | null>>();

async function bytes(file: FileHandle, at: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, at);
  return buffer.subarray(0, bytesRead);
}

async function readOn(path: string, budget: number): Promise<Roster | "behind" | null> {
  let file: FileHandle;
  try {
    file = await open(path, "r");
  } catch {
    places.delete(path);
    return null; // no log yet, or the dataset isn't visible from here
  }
  try {
    const { size } = await file.stat();
    const head = await bytes(file, 0, Math.min(HEAD_BYTES, size));
    let place = places.get(path);
    if (!place || size < place.offset || !head.subarray(0, place.head.length).equals(place.head)) {
      place = { head, offset: 0, partial: "", decoder: new TextDecoder(), roster: newRoster() };
      places.set(path, place);
    }
    place.head = head;
    const end = Math.min(size, place.offset + budget);
    while (place.offset < end) {
      const chunk = await bytes(file, place.offset, Math.min(CHUNK, end - place.offset));
      if (!chunk.length) break;
      place.offset += chunk.length;
      const lines = (place.partial + place.decoder.decode(chunk, { stream: true })).split("\n");
      place.partial = lines.pop() ?? "";
      // A line with no end in sight isn't one the roster reads
      if (place.partial.length > CHUNK) place.partial = "";
      for (const line of lines) feed(place.roster, line);
    }
    // Part way through a long log, the roster may still hold players who left in what's unread
    return place.offset >= size ? place.roster : "behind";
  } catch {
    return null;
  } finally {
    await file.close();
  }
}

/**
 * The roster of the log at `path`, reading what it gained since the last refresh. "behind" while a
 * long log is still being caught up on, null when there's no log to read.
 */
export function followLog(path: string, budget = READ_BUDGET): Promise<Roster | "behind" | null> {
  // One read at a time per log, so a refresh that outlived its timeout can't read the same bytes twice
  const running = reading.get(path);
  if (running) return running;
  const read = readOn(path, budget).finally(() => reading.delete(path));
  reading.set(path, read);
  return read;
}

/** The file in a tar from Docker's archive endpoint: a 512-byte header, then its bytes. */
export function untar(tar: Uint8Array): string {
  const text = new TextDecoder();
  for (let at = 0; tar[at]; ) {
    const size = Number.parseInt(text.decode(tar.subarray(at + 124, at + 136)), 8);
    const type = tar[at + 156];
    if (type === 0 || type === 48) return text.decode(tar.subarray(at + 512, at + 512 + size)); // a regular file
    at += 512 + Math.ceil(size / 512) * 512; // a pax header ahead of the file
  }
  return "";
}

/** The file's size from Docker's X-Docker-Container-Path-Stat header (base64 JSON), or Infinity when it doesn't say. */
export function archiveSize(header: string | null): number {
  try {
    const size = JSON.parse(Buffer.from(header ?? "", "base64").toString("utf8")).size;
    return typeof size === "number" ? size : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

async function docker(path: string): Promise<Response | null> {
  try {
    const response = await fetch(`http://docker${path}`, {
      unix: DOCKER_SOCKET,
      signal: AbortSignal.timeout(DOCKER_TIMEOUT_MS),
    });
    return response.ok ? response : null;
  } catch {
    return null; // a box with no socket yet
  }
}

/** The log out of the app's running container while it's small enough to take whole, else "". */
async function logThroughDocker(appId: string): Promise<string> {
  // By compose project and service, since a later copy's container is ix-satisfactory-server-2-satisfactory-1
  const labels = [`com.docker.compose.project=ix-${appId}`, "com.docker.compose.service=satisfactory"];
  const filters = encodeURIComponent(JSON.stringify({ label: labels }));
  const listed = (await (await docker(`/containers/json?filters=${filters}`))?.json().catch(() => null)) as
    | { Id: string }[]
    | null;
  const id = listed?.[0]?.Id;
  if (!id) return "";
  const response = await docker(`/containers/${id}/archive?path=${encodeURIComponent(`/config${LOG}`)}`);
  if (!response) return "";
  if (archiveSize(response.headers.get("x-docker-container-path-stat")) > DOCKER_MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    return "";
  }
  try {
    return untar(new Uint8Array(await response.arrayBuffer()));
  } catch {
    return "";
  }
}

/** The server's name in a query answer to this cookie, null when it has none, or undefined for a datagram that isn't one. */
export function queryAnswerName(message: Buffer, cookie: bigint): string | null | undefined {
  try {
    // Magic, type 1 (the server's state), protocol version, then the cookie the request sent
    if (message.readUInt16LE(0) !== QUERY_MAGIC || message.readUInt8(2) !== 1 || message.readBigUInt64LE(4) !== cookie) {
      return undefined;
    }
    let at = 12 + 1 + 4 + 8; // the state, the server's net version and its flags
    at += 1 + message.readUInt8(at) * 3; // its sub-states, three bytes each
    const length = message.readUInt16LE(at);
    if (at + 2 + length > message.length) return undefined;
    return message.subarray(at + 2, at + 2 + length).toString("utf8").trim() || null;
  } catch {
    return undefined; // too short to be one
  }
}

/** The name the owner gave the server in Server Manager, from its lightweight UDP query, or null. */
export function serverName(host: string, port: number, timeoutMs = QUERY_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = createSocket(host.includes(":") ? "udp6" : "udp4");
    const cookie = BigInt(Date.now());
    const finish = (name: string | null) => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve(name);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on("error", () => finish(null));
    socket.on("message", (message: Buffer) => {
      const name = queryAnswerName(message, cookie);
      if (name !== undefined) finish(name);
    });
    const request = Buffer.alloc(13);
    request.writeUInt16LE(QUERY_MAGIC, 0);
    request.writeUInt8(0, 2); // poll the server's state
    request.writeUInt8(1, 3); // protocol version
    request.writeBigUInt64LE(cookie, 4);
    request.writeUInt8(1, 12); // end of the message
    socket.send(request, port, host, (error) => {
      if (error) finish(null);
    });
  });
}

/** Who's online in a line: "Alex, Steve, and 3 more", as every game card says it. */
export function playersLine(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  if (names.length === 3) return `${names[0]}, ${names[1]}, and ${names[2]}`;
  return `${names[0]}, ${names[1]}, and ${names.length - 2} more`;
}

export async function run(ctx: WidgetContext): Promise<WidgetQueryResult> {
  const config = configMount(ctx.mounts);
  const followed = config ? await followLog(config.localPath + LOG) : null;
  // A log still being caught up on reads as nothing yet, rather than as the whole log out of Docker
  const roster = followed === "behind" ? null : (followed ?? readLog(await logThroughDocker(ctx.appId)));
  const names = roster ? [...roster.online.values()] : [];
  const title = names.length
    ? (roster?.session ?? (await serverName(ctx.host, roster?.port ?? ctx.port ?? DEFAULT_PORT)) ?? "Satisfactory")
    : "Satisfactory";
  const fields: Record<string, WidgetFieldValue> = {
    // One entry while anyone's on: the session in bold, the players in the small line under it
    online: { type: "list", entries: names.length ? [{ title, subtitle: playersLine(names), image: ARTWORK }] : [] },
    count: { type: "stat", label: "Players", value: `${names.length}/${roster?.max ?? DEFAULT_MAX_PLAYERS}` },
  };
  return { fields };
}

// Satisfactory's key art, from Aaron (2026-11-07): cropped to the card's shape at the size a retina screen draws it (660x260), in WebP.
export const ARTWORK =
  "data:image/webp;base64,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";
