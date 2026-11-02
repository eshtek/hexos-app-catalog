// Sibling files are type imports only: each script is compiled standalone, so runtime imports of them wouldn't resolve.
import { readFileSync } from "node:fs";
import { connect } from "node:net";

import type { WidgetContext, WidgetFieldValue, WidgetMount, WidgetQueryResult } from "../_lib/widget_context";

// Who's on a Minecraft server, how many ticks a second it runs, and the game mode it's played in.
// The card folds back to the plain one while nobody is on, as Valheim's does.
//
// Everything live comes from the server's own console (RCON): `list` names who's on, and `tick
// query` (Java 1.20.3 and later) gives the target rate and how long a tick takes. The image starts
// the console with a random password and writes both into server.properties. The script publishes no
// console port, so it's reached at the container's own address on its compose network, which the
// HexOS container opens from the host's network and nothing off the box can. The address, and
// server.properties where the mount doesn't show it, come from Docker over the socket the HexOS
// container has for its host commands. A box without the socket, or a server with its console off,
// keeps the plain card.

const DOCKER_SOCKET = "/var/run/docker.sock";
/** Docker and the console share the widget's 5 s timeout, so a stuck one reads as nothing rather than failing the card. */
const DOCKER_TIMEOUT_MS = 1500;
const RCON_TIMEOUT_MS = 2500;
const PROPERTIES = "/server.properties";
const DEFAULT_RCON_PORT = 25575;

// The console's packet types (the Source RCON protocol Minecraft speaks)
const LOGIN = 3;
const COMMAND = 2;
const LOGIN_ANSWER = 2;
/** Far above any answer this widget asks for; a longer one is a stream it shouldn't trust. */
const MAX_PACKET = 1 << 16;

const MODES: Record<string, string> = {
  survival: "Survival",
  creative: "Creative",
  adventure: "Adventure",
  spectator: "Spectator",
  // Numbers, from servers set up before 1.13
  "0": "Survival",
  "1": "Creative",
  "2": "Adventure",
  "3": "Spectator",
};

/** Text without the formatting codes (§a, §l) a MOTD or a console answer may carry. */
const plain = (text: string): string => text.replace(/§./g, "").trim();

const unescape = (value: string): string =>
  value.replace(/\\u([0-9a-fA-F]{4})|\\(.)/g, (_, hex: string | undefined, char: string) => {
    if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
    return char === "n" ? "\n" : char === "t" ? "\t" : char;
  });

/** server.properties as a map, in Java's properties format with the escapes Minecraft writes. */
export function properties(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimStart();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const at = line.search(/(?<!\\)[=:]/);
    if (at < 0) continue;
    found.set(unescape(line.slice(0, at).trim()), unescape(line.slice(at + 1).trimStart()));
  }
  return found;
}

/** `list`'s answer, "There are 2 of a max of 20 players online: Alex, Steve", or null for anything else. */
export function online(answer: string): { count: number; max: number; names: string[] } | null {
  const match = /There are (\d+) of a max of (\d+) players online:(.*)$/s.exec(plain(answer));
  if (!match) return null;
  const names = match[3]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return { count: Number(match[1]), max: Number(match[2]), names };
}

/** Ticks a second from `tick query`'s answer, never above the target rate, or null when it gives neither. */
export function ticksPerSecond(answer: string): string | null {
  const text = plain(answer);
  if (text.includes("The game is frozen")) return "Frozen";
  const target = Number(/Target tick rate: ([\d.]+) per second/.exec(text)?.[1]);
  const average = Number(/Average time per tick: ([\d.]+)ms/.exec(text)?.[1]);
  if (!(target > 0) || !Number.isFinite(average)) return null;
  return (average > 0 ? Math.min(target, 1000 / average) : target).toFixed(1);
}

/** The mode new players start in, or Hardcore, which overrides it. */
export function gameMode(settings: Map<string, string>): string | null {
  if (settings.get("hardcore") === "true") return "Hardcore";
  return MODES[settings.get("gamemode")?.trim().toLowerCase() ?? ""] ?? null;
}

/** Who's online in a line: "Alex, Steve, and 3 more". */
export function playersLine(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  if (names.length === 3) return `${names[0]}, ${names[1]}, and ${names[2]}`;
  return `${names[0]}, ${names[1]}, and ${names.length - 2} more`;
}

function packet(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, "utf8");
  // Length counts the id, the type, the body and its two closing zero bytes
  const out = Buffer.alloc(14 + payload.length);
  out.writeInt32LE(10 + payload.length, 0);
  out.writeInt32LE(id, 4);
  out.writeInt32LE(type, 8);
  payload.copy(out, 12);
  return out;
}

/**
 * Signs in to the console and asks each command in turn: their answers in order, or null when the
 * console can't be reached, refuses the password, or doesn't answer in time.
 */
export function rcon(
  host: string,
  port: number,
  password: string,
  commands: string[],
  timeoutMs = RCON_TIMEOUT_MS,
): Promise<string[] | null> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const answers: string[] = [];
    let buffer = Buffer.alloc(0);
    let signedIn = false;
    const finish = (value: string[] | null) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const askNext = () => {
      if (answers.length === commands.length) finish(answers);
      else socket.write(packet(10 + answers.length, COMMAND, commands[answers.length]));
    };
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
    socket.on("connect", () => socket.write(packet(1, LOGIN, password)));
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readInt32LE(0);
        if (length < 10 || length > MAX_PACKET) return finish(null);
        if (buffer.length < 4 + length) return;
        const id = buffer.readInt32LE(4);
        const type = buffer.readInt32LE(8);
        const body = buffer.subarray(12, 2 + length).toString("utf8");
        buffer = buffer.subarray(4 + length);
        if (!signedIn) {
          if (type !== LOGIN_ANSWER) continue;
          if (id === -1) return finish(null);
          signedIn = true;
          askNext();
        } else if (id === 10 + answers.length) {
          answers.push(body);
          askNext();
        }
      }
    });
  });
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

interface Container {
  Id: string;
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
}

/** The app's container and its address, by compose project, since a later copy's is ix-minecraft-2-minecraft-1. */
async function container(appId: string): Promise<{ id: string; address?: string } | null> {
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=ix-${appId}`] }));
  const listed = (await (await docker(`/containers/json?filters=${filters}`))?.json().catch(() => null)) as
    | Container[]
    | null;
  const found = listed?.[0];
  if (!found) return null;
  const address = Object.values(found.NetworkSettings?.Networks ?? {})
    .map((network) => network.IPAddress)
    .find(Boolean);
  return { id: found.Id, address };
}

/** The chart fixes the data mount's path in the container, so it's matched by its folder. */
const dataMount = (mounts: WidgetMount[], appId: string): WidgetMount | undefined =>
  mounts.find((mount) => mount.containerPath === "/data") ??
  mounts.find((mount) => mount.hostPath.endsWith(`/${appId}/data`));

async function readProperties(ctx: WidgetContext, containerId: string | undefined): Promise<string> {
  const mount = dataMount(ctx.mounts, ctx.appId);
  if (mount) {
    try {
      return readFileSync(mount.localPath + PROPERTIES, "utf-8");
    } catch {
      // Not written yet, or the dataset isn't visible from here
    }
  }
  if (!containerId) return "";
  const response = await docker(`/containers/${containerId}/archive?path=${encodeURIComponent(`/data${PROPERTIES}`)}`);
  return response ? untar(new Uint8Array(await response.arrayBuffer())) : "";
}

export async function run(ctx: WidgetContext): Promise<WidgetQueryResult> {
  const found = await container(ctx.appId);
  const settings = properties(await readProperties(ctx, found?.id));
  const password = settings.get("rcon.password");
  const port = Number(settings.get("rcon.port")) || DEFAULT_RCON_PORT;
  const answers =
    found?.address && password && settings.get("enable-rcon") === "true"
      ? await rcon(found.address, port, password, ["list", "tick query"])
      : null;
  const players = answers ? online(answers[0]) : null;
  const names = players?.names ?? [];
  const title = plain(settings.get("motd") ?? "") || "Minecraft";

  const fields: Record<string, WidgetFieldValue> = {
    // One entry while anyone's on: the server's MOTD in bold, the players in the small line under it
    online: { type: "list", entries: names.length ? [{ title, subtitle: playersLine(names) }] : [] },
  };
  if (players) fields.count = { type: "stat", label: "Players", value: `${players.count}/${players.max}` };
  // Only while someone plays, so the Server view doesn't hold the card open on an empty server
  if (names.length) {
    const tps = answers ? ticksPerSecond(answers[1]) : null;
    const mode = gameMode(settings);
    if (tps) fields.tps = { type: "stat", label: "TPS", value: tps };
    if (mode) fields.mode = { type: "stat", label: "Game mode", value: mode };
  }
  return { fields };
}
