// Sibling files are type imports only: each script is compiled standalone, so runtime imports of them wouldn't resolve.
// The console client below is the one in widget_players.ts, told apart by what went wrong.
import { createHash, randomBytes } from "node:crypto";
import { connect } from "node:net";

import type { HookContext } from "../_lib/hook_context";

// Run console command: the owner types a command, as they would in RustAdmin or the game's F1
// console, and sees what the server printed back. It's sent over Rust's web RCON, a WebSocket at
// ws://<address>:<RCON_PORT>/<RCON_PASSWORD>, as a text frame
// {"Identifier":1234,"Message":"say hello","Name":"WebRcon"}.
//
// Matching the reply: Facepunch's own client (github.com/Facepunch/webrcon, js/rconService.js)
// takes a message whose Identifier is its request's (above 1000) as the answer, and everything else
// (0 and -1: the server's log, chat) as the console's running output. Rust tags what a command
// prints while it runs with that command's Identifier, so a command that prints several lines can
// answer in several messages. So this keeps every message with its Identifier, and stops a moment
// after the last one. Lines tagged 0 or -1 are passed over: they're whatever else the server is
// doing (an autosave, a player's chat), not the command's answer.
//
// The password and port are the running container's own (RCON_PASSWORD and RCON_PORT in its
// environment, read over the Docker socket as tModLoader's setup does), so they're the ones the
// server started with, wherever HexOS moved the port. The console is tried at the box's address and
// its published port, as every hook reaches its app, then at the container's own address, as the
// card reaches it. A command is only sent once: the second address is tried only when the first
// never opened. On a box without the Docker socket, the app's TrueNAS values give the same two
// settings.

const DOCKER_SOCKET = "/var/run/docker.sock";
const DOCKER_TIMEOUT_MS = 5000;
/** A save on a big map takes a few seconds. */
const RCON_TIMEOUT_MS = 15_000;
/** How long to wait for more of an answer after its last piece. */
const SETTLE_MS = 400;
const DEFAULT_RCON_PORT = 28016;
/** Rust's own console line is far shorter; a longer one is pasted by mistake. */
const MAX_COMMAND = 1000;
/** What the step shows of an answer. `status` on a full server runs to a few thousand characters. */
export const MAX_REPLY = 1500;
const MAX_MESSAGE = 1 << 20;
const MAX_HANDSHAKE = 8 << 10;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const CONTINUATION = 0x0;
const TEXT = 0x1;
const BINARY = 0x2;
const CLOSE = 0x8;
const PING = 0x9;

export const NOTHING_PRINTED = "The server ran the command and printed nothing.";
export const CUT = "… The reply was longer, so the rest was cut off.";
export const STARTING =
  "The server's console isn't answering yet. If the server just started or updated, it's still starting. Try again in a few minutes.";
export const NO_ANSWER = "The server's console didn't answer in time. It may be busy saving the map. Try again in a minute.";
export const TURNED_AWAY =
  "The server's console closed the connection without answering, which it does when the console password doesn't match. Restart the server so it uses the one HexOS has, then try again.";
export const GARBLED = "The server's console sent an answer HexOS couldn't read. Try again in a minute.";
export const NO_COMMAND = "Type a command to run, such as status.";
export const TOO_LONG = `That command is too long. Rust's console takes up to ${MAX_COMMAND} characters.`;
export const NO_SETTINGS = "HexOS couldn't read this server's console settings. Make sure the server is running, then try again.";
export const STOPPING = "The server is shutting down. It starts again by itself, which takes a few minutes.";

/** The command as one line: no control or format characters, single spaces. */
export function cleanCommand(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/\s+/g, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim();
}

/** Commands that stop the server, which answers them by going away. */
export const stopsServer = (command: string): boolean => /^(global\.)?(quit|restart)(\s|$)|^server\.stop(\s|$)/i.test(command);

/**
 * The server's answer as the owner reads it: line endings made \n, no control or format
 * characters (player names come through as they typed them), no blank lines at either end, the
 * console password hidden wherever it appears, and at most `max` characters with a note when cut.
 */
export function formatReply(raw: string, password: string, max = MAX_REPLY): string {
  let text = raw
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === "\n" ? char : ""))
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
  if (password) text = text.split(password).join("(hidden)");
  if (!text.trim()) return NOTHING_PRINTED;
  const chars = [...text];
  if (chars.length <= max) return text;
  // Cut at a line's end when one is near, so the last line shown is whole
  let kept = chars.slice(0, Math.max(0, max - CUT.length - 1)).join("");
  const lineEnd = kept.lastIndexOf("\n");
  if (lineEnd > kept.length * 0.75) kept = kept.slice(0, lineEnd);
  return `${kept.trimEnd()}\n${CUT}`;
}

// --- the console: the widget's client, saying what went wrong ---

export function rconPath(password: string): string {
  return `/${password.replace(/[\s\p{Cc}]/gu, (char) => encodeURIComponent(char))}`;
}

function upgradeRequest(host: string, port: number, path: string, key: string): string {
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

const acceptFor = (key: string): string => createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");

function clientFrame(opcode: number, payload: Uint8Array, mask: Uint8Array = randomBytes(4)): Buffer {
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

function readFrame(buffer: Buffer): { fin: boolean; opcode: number; payload: Buffer; size: number } | null | "bad" {
  if (buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  if (buffer[0] & 0x70) return "bad";
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
    if (long > BigInt(MAX_MESSAGE)) return "bad";
    length = Number(long);
    at = 10;
  }
  if (length > MAX_MESSAGE) return "bad";
  if (opcode >= 0x8 && (!fin || length > 125)) return "bad";
  const mask = masked ? buffer.subarray(at, at + 4) : null;
  if (masked) at += 4;
  if (buffer.length < at + length) return null;
  const payload = Buffer.from(buffer.subarray(at, at + length));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return { fin, opcode, payload, size: at + length };
}

/**
 * What became of one command:
 * - `reply`: the Message of each of its answers, in order
 * - `unreachable`: the console never opened (nothing listening yet, or not a WebSocket), so the command wasn't sent
 * - `closed`: it opened and then closed without answering (a wrong password, or a server going away)
 * - `timeout`: it opened, took the command, and hadn't answered in time
 * - `garbled`: it sent something that isn't a WebSocket frame this client takes
 */
export type RconOutcome =
  | { kind: "reply"; messages: string[] }
  | { kind: "unreachable" | "closed" | "timeout" | "garbled" };

/** Sends one command and collects its answer. Nothing it returns carries the password, and it never throws. */
export function rconCommand(
  host: string,
  port: number,
  password: string,
  command: string,
  { timeoutMs = RCON_TIMEOUT_MS, settleMs = SETTLE_MS }: { timeoutMs?: number; settleMs?: number } = {},
): Promise<RconOutcome> {
  return new Promise((resolve) => {
    const key = randomBytes(16).toString("base64");
    const identifier = 1001 + Math.floor(Math.random() * 1_000_000);
    const answers: string[] = [];
    let socket: ReturnType<typeof connect>;
    let buffer = Buffer.alloc(0);
    let open = false;
    let done = false;
    let message: Buffer[] | null = null;
    let messageLength = 0;
    let settle: ReturnType<typeof setTimeout> | null = null;
    const finish = (failure: "unreachable" | "closed" | "timeout" | "garbled") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (settle) clearTimeout(settle);
      if (open && !socket.destroyed) {
        socket.end(clientFrame(CLOSE, Buffer.from([0x03, 0xe8])));
        setTimeout(() => socket.destroy(), 250).unref();
      } else socket.destroy();
      // Whatever answer came before the end is the answer
      resolve(answers.length > 0 ? { kind: "reply", messages: answers } : { kind: open || failure === "garbled" ? failure : "unreachable" });
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    try {
      socket = connect({ host, port });
    } catch {
      clearTimeout(timer);
      resolve({ kind: "unreachable" });
      return;
    }
    const send = (opcode: number, payload: Uint8Array) => {
      if (!done) socket.write(clientFrame(opcode, payload));
    };
    const received = (text: string) => {
      let answer: { Identifier?: unknown; Message?: unknown } | null = null;
      try {
        answer = JSON.parse(text);
      } catch {
        return;
      }
      if (answer?.Identifier !== identifier) return;
      answers.push(typeof answer.Message === "string" ? answer.Message : "");
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => finish("timeout"), settleMs);
    };
    socket.on("error", () => finish("closed"));
    socket.on("close", () => finish("closed"));
    socket.on("connect", () => socket.write(upgradeRequest(host, port, rconPath(password), key)));
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!open) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) {
          if (buffer.length > MAX_HANDSHAKE) finish("unreachable");
          return;
        }
        const head = buffer.subarray(0, end).toString("latin1").split("\r\n");
        const accept = head.find((line) => /^sec-websocket-accept:/i.test(line))?.replace(/^[^:]*:\s*/, "").trim();
        if (!/^HTTP\/1\.1 101\b/.test(head[0] ?? "") || accept !== acceptFor(key)) return finish("unreachable");
        open = true;
        buffer = buffer.subarray(end + 4);
        send(TEXT, Buffer.from(JSON.stringify({ Identifier: identifier, Message: command, Name: "WebRcon" }), "utf8"));
      }
      while (!done) {
        const frame = readFrame(buffer);
        if (frame === "bad") return finish("garbled");
        if (!frame) return;
        buffer = buffer.subarray(frame.size);
        if (frame.opcode === PING) send(0xa, frame.payload);
        else if (frame.opcode === CLOSE) return finish("closed");
        else if (frame.opcode === TEXT || frame.opcode === BINARY || frame.opcode === CONTINUATION) {
          if (frame.opcode === CONTINUATION ? !message : !!message) return finish("garbled");
          if (!message) {
            message = [];
            messageLength = 0;
          }
          message.push(frame.payload);
          messageLength += frame.payload.length;
          if (messageLength > MAX_MESSAGE) return finish("garbled");
          if (frame.fin) {
            const text = Buffer.concat(message).toString("utf8");
            message = null;
            received(text);
          }
        }
      }
    });
  });
}

// --- where the console is ---

async function docker(path: string): Promise<Response | null> {
  try {
    const response = await fetch(`http://docker${path}`, { unix: DOCKER_SOCKET, signal: AbortSignal.timeout(DOCKER_TIMEOUT_MS) });
    return response.ok ? response : null;
  } catch {
    return null;
  }
}

export interface Container {
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

export interface Console {
  password: string;
  port: number;
  /** Where to try, in order. */
  hosts: string[];
}

/** The console's password, port and addresses from the running container, else from the app's TrueNAS values. */
export function consoleFrom(
  host: string | undefined,
  container: Container | null,
  values: Record<string, unknown> | null,
): Console | null {
  const env = new Map<string, string>(
    (container?.Config?.Env ?? []).map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
  );
  const address = Object.values(container?.NetworkSettings?.Networks ?? {}).map((network) => network.IPAddress).find(Boolean);
  if (!env.has("RCON_PASSWORD") && values) {
    // ix-app's values: the script's envs and ports, macros resolved
    for (const pair of Array.isArray(values.envs) ? (values.envs as Array<{ name?: unknown; value?: unknown }>) : []) {
      if (typeof pair?.name === "string" && pair.value !== undefined && pair.value !== null) env.set(pair.name, String(pair.value));
    }
    if (!env.has("RCON_PORT")) {
      const ports = Array.isArray(values.ports) ? (values.ports as Array<{ port_number?: unknown; protocol?: unknown }>) : [];
      const tcp = ports.find((each) => each?.protocol === "tcp")?.port_number;
      if (tcp !== undefined) env.set("RCON_PORT", String(tcp));
    }
  }
  const password = env.get("RCON_PASSWORD");
  if (!password) return null;
  const port = Number(env.get("RCON_PORT")) || DEFAULT_RCON_PORT;
  const hosts = [host, address].filter((each): each is string => typeof each === "string" && each.length > 0);
  return hosts.length ? { password, port, hosts: [...new Set(hosts)] } : null;
}

/** Tries each address until one opens; the command is sent at most once. */
export async function runOn(target: Console, command: string, options?: { timeoutMs?: number; settleMs?: number }): Promise<RconOutcome> {
  let outcome: RconOutcome = { kind: "unreachable" };
  for (const host of target.hosts) {
    outcome = await rconCommand(host, target.port, target.password, command, options);
    if (outcome.kind !== "unreachable") break;
  }
  return outcome;
}

/** What the step says for an outcome: the answer, or why there is none. `ok` is false for a failure. */
export function outcomeMessage(outcome: RconOutcome, command: string, password: string): { ok: boolean; message: string } {
  if (outcome.kind === "reply") return { ok: true, message: formatReply(outcome.messages.join("\n"), password) };
  if (outcome.kind === "unreachable") return { ok: false, message: STARTING };
  // A server told to stop goes away without a word
  if (stopsServer(command) && (outcome.kind === "closed" || outcome.kind === "timeout")) return { ok: true, message: STOPPING };
  if (outcome.kind === "closed") return { ok: false, message: TURNED_AWAY };
  if (outcome.kind === "timeout") return { ok: false, message: NO_ANSWER };
  return { ok: false, message: GARBLED };
}

export async function run(ctx: HookContext, options?: { timeoutMs?: number; settleMs?: number; container?: Container | null }) {
  await ctx.registerCheckpoints([{ id: "command", message: "Running your command" }]);
  const command = cleanCommand(ctx.inputs.command);
  if (!command) ctx.fail(NO_COMMAND);
  if ([...command].length > MAX_COMMAND) ctx.fail(TOO_LONG);

  const container = options && "container" in options ? options.container ?? null : await containerOf(ctx.resourceId);
  const values = container ? null : ((await ctx.getAppValues?.().catch(() => null)) ?? null);
  const found = consoleFrom(ctx.host, container, values);
  if (!found) ctx.fail(NO_SETTINGS);

  const outcome = await runOn(found, command, options);
  const { ok, message } = outcomeMessage(outcome, command, found.password);
  if (!ok) ctx.fail(message);
  await ctx.emitCheckpoint("command", message);
}
