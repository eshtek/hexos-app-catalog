// Sibling files are type imports only: each script is compiled standalone, so runtime imports of them wouldn't resolve.
import { createHash, randomBytes } from "node:crypto";
import { connect } from "node:net";

import type { WidgetContext, WidgetFieldValue, WidgetQueryResult } from "../_lib/widget_context";

// Who's on a Rust server, out of how many it takes. The card folds back to the plain one while
// nobody is on, as ARK's and Project Zomboid's do. The Settings tab also gets the console's address
// from it, with a Copy button, as Valheim's gets its join code.
//
// Rust's console is web RCON: a WebSocket at ws://<address>:<RCON_PORT>/<RCON_PASSWORD>, as
// Facepunch's own client (github.com/Facepunch/webrcon) opens it. A command goes over as a text
// frame, {"Identifier":1234,"Message":"playerlist","Name":"WebRcon"}, and its answer comes back
// with the same Identifier, its Message a JSON array of who's on:
//   [{"SteamID":"7656...","DisplayName":"Alex","Ping":31,"Address":"...","ConnectedSeconds":120,...}]
// Everything else the server sends (its console log, chat) carries 0 or -1 and is passed over. A
// wrong password has the server close the socket. The image starts the console on RCON_PORT with
// RCON_PASSWORD, both in the container's environment, so it's reached at the container's own
// address on its compose network, as ARK's is. The server's name and limit are SERVER_NAME and
// MAX_PLAYERS. While the game downloads or the map generates nothing listens on the port, and the
// card stays plain, as it does on a box without the Docker socket.
//
// The widget runtime gives scripts node:net and fetch, as every other game card uses, so the
// WebSocket is spoken here over a plain TCP socket: just enough of RFC 6455 for one command.

const DOCKER_SOCKET = "/var/run/docker.sock";
/** Docker and the console share the widget's 5 s timeout, so a stuck one reads as nobody on. */
const DOCKER_TIMEOUT_MS = 1500;
const RCON_TIMEOUT_MS = 2500;
const DEFAULT_RCON_PORT = 28016;
/** Far above a full server's player list; a longer message is a stream it shouldn't trust. */
const MAX_MESSAGE = 1 << 20;
/** The server's answer to the upgrade, headers and all. */
const MAX_HANDSHAKE = 8 << 10;
/** Steam caps a name at 32 characters. */
const MAX_NAME = 32;
const MAX_TITLE = 64;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// WebSocket opcodes
const CONTINUATION = 0x0;
const TEXT = 0x1;
const BINARY = 0x2;
const CLOSE = 0x8;
const PING = 0x9;

/** Text a player or the owner typed, fit for one line: no control or format characters, single spaces, at most `max` characters. */
export function cleanText(raw: unknown, max = MAX_NAME): string {
  if (typeof raw !== "string") return "";
  const text = raw
    .replace(/\s+/g, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim();
  return [...text].slice(0, max).join("").trim();
}

/**
 * The names in playerlist's answer, one per player on, in the order the server lists them (a player
 * with no usable name is an empty string, so they still count), or null when it isn't a list.
 */
export function playerNames(message: string): string[] | null {
  let players: unknown;
  try {
    players = JSON.parse(message);
  } catch {
    return null;
  }
  if (!Array.isArray(players)) return null;
  return players
    .filter((player) => player !== null && typeof player === "object")
    .map((player: { DisplayName?: unknown }) => cleanText(player.DisplayName));
}

/** Who's online in a line: "Alex, Steve, and 3 more". */
export function playersLine(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  if (names.length === 3) return `${names[0]}, ${names[1]}, and ${names[2]}`;
  return `${names[0]}, ${names[1]}, and ${names.length - 2} more`;
}

/**
 * The path that carries the password. Rust's WebSocket server (Fleck) hands the path over as it
 * arrives, undecoded, and Rust compares it with its password, so every character that can stand in
 * a request line is sent as it is. Whitespace and control characters can't (they would end the
 * request line or the request), so those are percent-encoded: a password with them can't sign in
 * from any client, but it can't break the request either.
 */
export function rconPath(password: string): string {
  return `/${password.replace(/[\s\p{Cc}]/gu, (char) => encodeURIComponent(char))}`;
}

/** The HTTP request that opens the WebSocket. */
export function upgradeRequest(host: string, port: number, path: string, key: string): string {
  const authority = `${host.includes(":") ? `[${host}]` : host}:${port}`;
  return [
    `GET ${path} HTTP/1.1`,
    `Host: ${authority}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ].join("\r\n");
}

/** The Sec-WebSocket-Accept a server must answer `key` with. */
export const acceptFor = (key: string): string => createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");

/** A whole client frame: FIN set, the payload masked with `mask` as a client's must be. */
export function clientFrame(opcode: number, payload: Uint8Array, mask: Uint8Array = randomBytes(4)): Buffer {
  const length = payload.length;
  const head = length < 126 ? 2 : length <= 0xffff ? 4 : 10;
  const out = Buffer.alloc(head + 4 + length);
  out[0] = 0x80 | opcode;
  if (length < 126) out[1] = 0x80 | length;
  else if (length <= 0xffff) {
    out[1] = 0x80 | 126;
    out.writeUInt16BE(length, 2);
  } else {
    out[1] = 0x80 | 127;
    out.writeBigUInt64BE(BigInt(length), 2);
  }
  out.set(mask.subarray(0, 4), head);
  for (let i = 0; i < length; i++) out[head + 4 + i] = payload[i] ^ mask[i & 3];
  return out;
}

export interface Frame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  /** Bytes of the buffer the frame took. */
  size: number;
}

/** The frame at the start of `buffer`: null while it hasn't all arrived, "bad" for one this client won't take. */
export function readFrame(buffer: Buffer, maxPayload = MAX_MESSAGE): Frame | null | "bad" {
  if (buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  if (buffer[0] & 0x70) return "bad"; // an extension nobody agreed to
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let at = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    at = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const long = buffer.readBigUInt64BE(2);
    if (long > BigInt(maxPayload)) return "bad";
    length = Number(long);
    at = 10;
  }
  if (length > maxPayload) return "bad";
  if (opcode >= 0x8 && (!fin || length > 125)) return "bad"; // a control frame is whole and short
  const mask = masked ? buffer.subarray(at, at + 4) : null;
  if (masked) at += 4;
  if (buffer.length < at + length) return null;
  const payload = Buffer.from(buffer.subarray(at, at + length));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return { fin, opcode, payload, size: at + length };
}

/**
 * Opens the console, asks one command and gives its answer's Message, or null when the console
 * can't be reached, refuses the password, or doesn't answer in time. Nothing it returns or throws
 * carries the password.
 */
export function webRcon(host: string, port: number, password: string, command: string, timeoutMs = RCON_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    const key = randomBytes(16).toString("base64");
    // Above 1000, as Facepunch's client numbers its requests; the server's own lines carry 0 or -1
    const identifier = 1001 + Math.floor(Math.random() * 1_000_000);
    const socket = connect({ host, port });
    let buffer = Buffer.alloc(0);
    let open = false;
    let done = false;
    let message: Buffer[] | null = null;
    let messageLength = 0;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (open && !socket.destroyed) {
        // Said goodbye (1000, normal closure), so the server logs no dropped connection
        socket.end(clientFrame(CLOSE, Buffer.from([0x03, 0xe8])));
        setTimeout(() => socket.destroy(), 250).unref();
      } else socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const send = (opcode: number, payload: Uint8Array) => {
      if (!done) socket.write(clientFrame(opcode, payload));
    };
    const received = (text: string) => {
      let answer: { Identifier?: unknown; Message?: unknown } | null = null;
      try {
        answer = JSON.parse(text);
      } catch {
        return; // not one of the console's messages
      }
      if (answer?.Identifier === identifier) finish(typeof answer.Message === "string" ? answer.Message : null);
    };
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
    socket.on("connect", () => socket.write(upgradeRequest(host, port, rconPath(password), key)));
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!open) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) {
          if (buffer.length > MAX_HANDSHAKE) finish(null);
          return;
        }
        const head = buffer.subarray(0, end).toString("latin1").split("\r\n");
        const accept = head.find((line) => /^sec-websocket-accept:/i.test(line))?.replace(/^[^:]*:\s*/, "").trim();
        if (!/^HTTP\/1\.1 101\b/.test(head[0] ?? "") || accept !== acceptFor(key)) return finish(null);
        open = true;
        buffer = buffer.subarray(end + 4);
        send(TEXT, Buffer.from(JSON.stringify({ Identifier: identifier, Message: command, Name: "WebRcon" }), "utf8"));
      }
      while (!done) {
        const frame = readFrame(buffer);
        if (frame === "bad") return finish(null);
        if (!frame) return;
        buffer = buffer.subarray(frame.size);
        if (frame.opcode === PING) send(0xa, frame.payload);
        else if (frame.opcode === CLOSE) return finish(null);
        else if (frame.opcode === TEXT || frame.opcode === BINARY || frame.opcode === CONTINUATION) {
          if (frame.opcode === CONTINUATION ? !message : !!message) return finish(null); // out of order
          if (!message) {
            message = [];
            messageLength = 0;
          }
          message.push(frame.payload);
          messageLength += frame.payload.length;
          if (messageLength > MAX_MESSAGE) return finish(null);
          if (frame.fin) {
            const text = Buffer.concat(message).toString("utf8");
            message = null;
            received(text);
          }
        }
        // A pong, or an opcode nobody uses, is passed over
      }
    });
  });
}

async function docker(path: string): Promise<Response | null> {
  try {
    const response = await fetch(`http://docker${path}`, { unix: DOCKER_SOCKET, signal: AbortSignal.timeout(DOCKER_TIMEOUT_MS) });
    return response.ok ? response : null;
  } catch {
    return null; // a box with no socket yet
  }
}

interface Container {
  Config?: { Env?: string[] };
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
}

/** The app's running container, by compose project, since a later copy's is ix-rust-2-rust-2-1. */
async function containerOf(appId: string): Promise<Container | null> {
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=ix-${appId}`], status: ["running"] }));
  const listed = (await (await docker(`/containers/json?filters=${filters}`))?.json().catch(() => null)) as Array<{ Id: string }> | null;
  const id = listed?.[0]?.Id;
  return id ? (((await (await docker(`/containers/${id}/json`))?.json().catch(() => null)) as Container | null) ?? null) : null;
}

/** A container's environment as a map. */
export const envOf = (container: Container | null): Map<string, string> =>
  new Map((container?.Config?.Env ?? []).map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));

const addressOf = (container: Container | null): string | null =>
  Object.values(container?.NetworkSettings?.Networks ?? {}).map((network) => network.IPAddress).find(Boolean) ?? null;

/** The card's fields for who's on (null: the console didn't answer, so nobody reads as on) and the server's environment. */
export function playersCard(names: string[] | null, env: Map<string, string>): Record<string, WidgetFieldValue> {
  const on = names ?? [];
  const named = on.filter(Boolean);
  const max = Number(env.get("MAX_PLAYERS")) || 0;
  const title = cleanText(env.get("SERVER_NAME"), MAX_TITLE) || "Rust";
  return {
    // One entry while anyone's on: the server's name in bold, the players in the small line under it
    online: {
      type: "list",
      entries: on.length ? [{ title, ...(named.length ? { subtitle: playersLine(named) } : {}), image: ARTWORK }] : [],
    },
    count: { type: "stat", label: "Players", value: max > 0 ? `${on.length}/${max}` : `${on.length}` },
  };
}

/**
 * Where admin tools such as RustAdmin reach the console, for the Settings tab: the box's address and
 * the port the running server's console took, wherever HexOS moved it. Empty while that isn't known
 * (no container found yet), which the tab shows as still to come. Never the password: the tab
 * already shows it, hidden, as the answer to its question.
 */
export function consoleField(host: string, env: Map<string, string>): WidgetFieldValue {
  const port = Number(env.get("RCON_PORT"));
  const known = host && Number.isInteger(port) && port > 0 && port < 65536;
  return { type: "stat", label: "Console address", value: known ? `${host.includes(":") ? `[${host}]` : host}:${port}` : "" };
}

export async function run(ctx: WidgetContext): Promise<WidgetQueryResult> {
  const container = await containerOf(ctx.appId);
  const env = envOf(container);
  const address = addressOf(container);
  const password = env.get("RCON_PASSWORD");
  const port = Number(env.get("RCON_PORT")) || DEFAULT_RCON_PORT;
  const answer = address && password ? await webRcon(address, port, password, "playerlist") : null;
  return { fields: { ...playersCard(answer === null ? null : playerNames(answer), env), console: consoleField(ctx.host, env) } };
}

// Rust's key art, its Steam library hero (app 252490), a stand-in until the card has art of its own: cropped to the card's shape at its center, 660x260, WebP at quality 78.
export const ARTWORK =
  "data:image/webp;base64,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";
