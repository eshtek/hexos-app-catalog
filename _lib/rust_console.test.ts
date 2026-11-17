import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

import {
  CUT,
  GARBLED,
  MAX_REPLY,
  NO_ANSWER,
  NO_COMMAND,
  NO_SETTINGS,
  NOTHING_PRINTED,
  STARTING,
  STOPPING,
  TOO_LONG,
  TURNED_AWAY,
  type Container,
  cleanCommand,
  consoleFrom,
  formatReply,
  outcomeMessage,
  rconCommand,
  run,
  runOn,
  stopsServer,
} from "../rust/console_command";
import type { HookContext } from "./hook_context";

// Run console command sends what the owner typed to Rust's web RCON and shows what came back as
// its step's message. These hold what it shows for each answer and each failure, and that the
// console password never reaches anything the owner, a log or an error could read.

const PASSWORD = "Zq9-pw-SECRET-7731";

describe("the command", () => {
  test("is one line, with no control or format characters", () => {
    expect(cleanCommand("  ownerid 76561198000000001\r\n")).toBe("ownerid 76561198000000001");
    expect(cleanCommand("say\thello\u0000 there‮")).toBe("say hello there");
    expect(cleanCommand("say a\nquit")).toBe("say a quit");
    expect(cleanCommand("   ")).toBe("");
    expect(cleanCommand(undefined)).toBe("");
    expect(cleanCommand(42)).toBe("");
  });

  test("knows the ones that stop the server", () => {
    for (const command of ["quit", "global.quit", "restart", "global.restart 60", "QUIT", "server.stop"]) expect(stopsServer(command)).toBe(true);
    for (const command of ["status", "say quit", "quitter", "server.writecfg", "restartx"]) expect(stopsServer(command)).toBe(false);
  });
});

describe("the reply", () => {
  test("an empty one says the server printed nothing", () => {
    expect(formatReply("", PASSWORD)).toBe(NOTHING_PRINTED);
    expect(formatReply(" \r\n\t\n", PASSWORD)).toBe(NOTHING_PRINTED);
    expect(formatReply("\u0000​", PASSWORD)).toBe(NOTHING_PRINTED);
  });

  test("keeps its lines, with Windows line endings made plain and no blank lines at either end", () => {
    expect(formatReply("\r\nhostname: HexOS Rust\r\nplayers : 1 (50 max)\rmap     : Procedural Map  \r\n\r\n", PASSWORD)).toBe(
      "hostname: HexOS Rust\nplayers : 1 (50 max)\nmap     : Procedural Map",
    );
    expect(formatReply("a\n\n\n\n\nb", PASSWORD)).toBe("a\n\nb");
  });

  test("drops control and direction characters a player's name could carry", () => {
    expect(formatReply("[CHAT] Al\u0007ex‮\u0000: hi\u001b[31m", PASSWORD)).toBe("[CHAT] Alex: hi[31m");
    expect(formatReply("a\tb", PASSWORD)).toBe("a b");
  });

  test("hides the console password wherever it appears", () => {
    expect(formatReply(`rcon.password: "${PASSWORD}"`, PASSWORD)).toBe('rcon.password: "(hidden)"');
    expect(formatReply(PASSWORD, PASSWORD)).toBe("(hidden)");
  });

  test(`shows at most ${MAX_REPLY} characters, says when it cut, and ends on a whole line`, () => {
    const lines = Array.from({ length: 200 }, (_, i) => `${String(i).padStart(3, "0")} 76561198000000001 "Player ${i}" 31ms`);
    const shown = formatReply(lines.join("\r\n"), PASSWORD);
    expect([...shown].length).toBeLessThanOrEqual(MAX_REPLY);
    expect(shown.endsWith(`\n${CUT}`)).toBe(true);
    const kept = shown.slice(0, -CUT.length - 1).split("\n");
    expect(kept.every((line) => lines.includes(line))).toBe(true);
    expect(kept[0]).toBe(lines[0]);
  });

  test("cuts one long line by character, never through an emoji", () => {
    const shown = formatReply("😀".repeat(5000), PASSWORD);
    expect([...shown].length).toBeLessThanOrEqual(MAX_REPLY);
    expect(shown).not.toContain("�");
    expect(shown.endsWith(CUT)).toBe(true);
  });

  test("a reply that fits is left whole", () => {
    expect(formatReply("x".repeat(MAX_REPLY), PASSWORD)).toBe("x".repeat(MAX_REPLY));
  });
});

describe("what the owner reads for each outcome", () => {
  test("a reply, joined when it came in pieces", () => {
    expect(outcomeMessage({ kind: "reply", messages: ["one", "two"] }, "status", PASSWORD)).toEqual({ ok: true, message: "one\ntwo" });
    expect(outcomeMessage({ kind: "reply", messages: [""] }, "server.writecfg", PASSWORD)).toEqual({ ok: true, message: NOTHING_PRINTED });
  });

  test("each failure says what to do", () => {
    expect(outcomeMessage({ kind: "unreachable" }, "status", PASSWORD)).toEqual({ ok: false, message: STARTING });
    expect(outcomeMessage({ kind: "closed" }, "status", PASSWORD)).toEqual({ ok: false, message: TURNED_AWAY });
    expect(outcomeMessage({ kind: "timeout" }, "status", PASSWORD)).toEqual({ ok: false, message: NO_ANSWER });
    expect(outcomeMessage({ kind: "garbled" }, "status", PASSWORD)).toEqual({ ok: false, message: GARBLED });
    expect(STARTING).toContain("still starting");
    expect(STARTING).toContain("Try again in a few minutes");
  });

  test("a server told to stop that goes away has done as asked", () => {
    expect(outcomeMessage({ kind: "closed" }, "quit", PASSWORD)).toEqual({ ok: true, message: STOPPING });
    expect(outcomeMessage({ kind: "timeout" }, "global.quit", PASSWORD)).toEqual({ ok: true, message: STOPPING });
    // One that never opened didn't get the command
    expect(outcomeMessage({ kind: "unreachable" }, "quit", PASSWORD)).toEqual({ ok: false, message: STARTING });
  });

  test("names no tab", () => {
    for (const message of [STARTING, NO_ANSWER, TURNED_AWAY, GARBLED, NO_COMMAND, TOO_LONG, NO_SETTINGS, STOPPING, NOTHING_PRINTED, CUT]) {
      expect(message).not.toMatch(/\b(Connections|Customize|Settings) tab\b/);
    }
  });
});

describe("where the console is", () => {
  const container: Container = {
    Config: { Env: [`RCON_PASSWORD=${PASSWORD}=x`, "RCON_PORT=28017", "SERVER_PORT=28015"] },
    NetworkSettings: { Networks: { "ix-rust_default": { IPAddress: "172.16.5.2" } } },
  };

  test("the running container's password and port, at the box's address first and its own after", () => {
    expect(consoleFrom("192.168.1.20", container, null)).toEqual({ password: `${PASSWORD}=x`, port: 28017, hosts: ["192.168.1.20", "172.16.5.2"] });
    expect(consoleFrom(undefined, container, null)?.hosts).toEqual(["172.16.5.2"]);
  });

  test("the app's TrueNAS values when Docker can't say, with the port it published for the console", () => {
    const values = {
      envs: [
        { name: "RCON_PASSWORD", value: PASSWORD },
        { name: "SERVER_PORT", value: 28020 },
      ],
      ports: [
        { port_number: 28020, container_port: 28020, protocol: "udp" },
        { port_number: 28021, container_port: 28021, protocol: "tcp" },
        { port_number: 28021, container_port: 28021, protocol: "udp" },
      ],
    };
    expect(consoleFrom("192.168.1.20", null, values)).toEqual({ password: PASSWORD, port: 28021, hosts: ["192.168.1.20"] });
    expect(consoleFrom("192.168.1.20", null, { ...values, envs: [...values.envs, { name: "RCON_PORT", value: 28030 }] })?.port).toBe(28030);
  });

  test("nothing without a password, or anywhere to try", () => {
    expect(consoleFrom("192.168.1.20", null, null)).toBeNull();
    expect(consoleFrom("192.168.1.20", null, { envs: [] })).toBeNull();
    expect(consoleFrom(undefined, { Config: { Env: [`RCON_PASSWORD=${PASSWORD}`] } }, null)).toBeNull();
  });
});

// --- a console that speaks web RCON the way Rust's does ---

function serverFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const length = payload.length;
  const head = length < 126 ? 2 : length <= 0xffff ? 4 : 10;
  const out = Buffer.alloc(head + length);
  out[0] = (fin ? 0x80 : 0) | opcode;
  if (length < 126) out[1] = length;
  else if (length <= 0xffff) {
    out[1] = 126;
    out.writeUInt16BE(length, 2);
  } else {
    out[1] = 127;
    out.writeBigUInt64BE(BigInt(length), 2);
  }
  payload.copy(out, head);
  return out;
}

function unmask(buffer: Buffer): { opcode: number; payload: Buffer; size: number } | null {
  if (buffer.length < 2) return null;
  let length = buffer[1] & 0x7f;
  let at = 2;
  if (length === 126) {
    length = buffer.readUInt16BE(2);
    at = 4;
  } else if (length === 127) {
    length = Number(buffer.readBigUInt64BE(2));
    at = 10;
  }
  const mask = buffer.subarray(at, at + 4);
  at += 4;
  if (buffer.length < at + length) return null;
  const payload = Buffer.from(buffer.subarray(at, at + length));
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return { opcode: buffer[0] & 0x0f, payload, size: at + length };
}

const line = (Message: string, Identifier: number) => serverFrame(0x1, Buffer.from(JSON.stringify({ Message, Identifier, Type: "Generic", Stacktrace: "" }), "utf8"));

/** How the fake answers a command: messages to send with its identifier, or what else to do. */
type Answer = string[] | "silent" | "close" | ((socket: Socket, identifier: number) => void);

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

function fakeRust(password: string, answers: Record<string, Answer>) {
  const seen = { commands: [] as string[], connections: 0 };
  const server = createServer((socket) => {
    seen.connections++;
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    let open = false;
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!open) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const lines = buffer.subarray(0, end).toString("utf8").split("\r\n");
        buffer = buffer.subarray(end + 4);
        const key = lines.find((l) => l.toLowerCase().startsWith("sec-websocket-key:"))!.split(": ")[1];
        const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        // As Rust's does, a wrong password is turned away once the socket is open
        if (lines[0].split(" ")[1] !== `/${password}`) return socket.end(serverFrame(0x8, Buffer.from([0x03, 0xe8])));
        open = true;
      }
      for (;;) {
        const frame = unmask(buffer);
        if (!frame) return;
        buffer = buffer.subarray(frame.size);
        if (frame.opcode !== 0x1) continue;
        const request = JSON.parse(frame.payload.toString()) as { Identifier: number; Message: string };
        seen.commands.push(request.Message);
        const answer = answers[request.Message] ?? [`Command not found: ${request.Message}`];
        if (answer === "silent") continue;
        if (answer === "close") return void socket.destroy();
        if (typeof answer === "function") answer(socket, request.Identifier);
        else for (const message of answer) socket.write(line(message, request.Identifier));
      }
    });
  });
  servers.push(server);
  const port = new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
  return { port, seen };
}

const quick = { timeoutMs: 1500, settleMs: 100 };

describe("the console", () => {
  test("gives every message with the command's identifier, and passes over the server's own lines", async () => {
    const { port } = fakeRust(PASSWORD, {
      "server.save": (socket, identifier) => {
        socket.write(line("[CHAT] Alex: hi", -1));
        socket.write(line("Saving 31,337 entities", identifier));
        socket.write(line("Autosave in 600s", 0));
        setTimeout(() => socket.write(line("Saved 31,337 ents, cache(0.01), write(0.02), disk(0.01).", identifier)), 30);
      },
    });
    expect(await rconCommand("127.0.0.1", await port, PASSWORD, "server.save", quick)).toEqual({
      kind: "reply",
      messages: ["Saving 31,337 entities", "Saved 31,337 ents, cache(0.01), write(0.02), disk(0.01)."],
    });
  });

  test("tells a wrong password, a console that never answers, and one not listening apart", async () => {
    const { port } = fakeRust(PASSWORD, { status: ["ok"], hang: "silent" });
    expect(await rconCommand("127.0.0.1", await port, "wrong", "status", quick)).toEqual({ kind: "closed" });
    expect(await rconCommand("127.0.0.1", await port, PASSWORD, "hang", { timeoutMs: 300 })).toEqual({ kind: "timeout" });
    const closed = fakeRust(PASSWORD, {});
    const closedPort = await closed.port;
    servers.pop()!.close();
    expect(await rconCommand("127.0.0.1", closedPort, PASSWORD, "status", quick)).toEqual({ kind: "unreachable" });
  });

  test("something that isn't a WebSocket is a console not up yet", async () => {
    const server = createServer((socket) => socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"));
    servers.push(server);
    const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
    expect(await rconCommand("127.0.0.1", port, PASSWORD, "status", quick)).toEqual({ kind: "unreachable" });
    // A port that takes the connection and drops it, as Docker's proxy does before the server listens
    const dropper = createServer((socket) => socket.destroy());
    servers.push(dropper);
    const dropPort = await new Promise<number>((resolve) => dropper.listen(0, "127.0.0.1", () => resolve((dropper.address() as { port: number }).port)));
    expect(await rconCommand("127.0.0.1", dropPort, PASSWORD, "status", quick)).toEqual({ kind: "unreachable" });
  });

  test("tries the next address only when the first never opened, so a command is never sent twice", async () => {
    const { port, seen } = fakeRust(PASSWORD, { status: ["hostname: HexOS Rust"], hang: "silent" });
    const p = await port;
    // ::1 isn't listened on, so the command goes to 127.0.0.1
    expect(await runOn({ password: PASSWORD, port: p, hosts: ["::1", "127.0.0.1"] }, "status", quick)).toEqual({ kind: "reply", messages: ["hostname: HexOS Rust"] });
    expect(seen.commands).toEqual(["status"]);
    // One that opened and never answered isn't tried again
    expect(await runOn({ password: PASSWORD, port: p, hosts: ["127.0.0.1", "127.0.0.1"] }, "hang", { timeoutMs: 300 })).toEqual({ kind: "timeout" });
    expect(seen.commands).toEqual(["status", "hang"]);
  });
});

// --- the hook, end to end ---

interface Run {
  checkpoints: string[];
  failed?: string;
  thrown?: string;
  logs: string[];
}

async function runHook(command: unknown, container: Container | null, values: Record<string, unknown> | null = null): Promise<Run> {
  const result: Run = { checkpoints: [], logs: [] };
  const ctx = {
    resourceId: "rust",
    host: "127.0.0.1",
    port: 28015,
    inputs: { command },
    mounts: [],
    log: (message: string) => result.logs.push(message),
    registerCheckpoints: async (list: Array<{ message: string }>) => {
      result.checkpoints.push(...list.map((each) => each.message));
    },
    emitCheckpoint: async (_id: string, message?: string) => {
      if (message !== undefined) result.checkpoints.push(message);
    },
    skipCheckpoint: async (_id: string, message?: string) => {
      if (message !== undefined) result.checkpoints.push(message);
    },
    getAppValues: async () => values ?? {},
    fail: (message: string, context?: Array<{ label: string; value: string }>) => {
      result.failed = [message, ...(context ?? []).map((item) => `${item.label}: ${item.value}`)].join("\n");
      throw new Error(message);
    },
  } as unknown as HookContext;
  try {
    await run(ctx, { ...quick, container });
  } catch (error) {
    result.thrown = String(error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : error);
  }
  return result;
}

const everything = (result: Run) => [...result.checkpoints, result.failed ?? "", result.thrown ?? "", ...result.logs].join("\n");

describe("Run console command", () => {
  const containerFor = (port: number, password = PASSWORD): Container => ({
    Config: { Env: [`RCON_PASSWORD=${password}`, `RCON_PORT=${port}`] },
    NetworkSettings: { Networks: { "ix-rust_default": { IPAddress: "127.0.0.1" } } },
  });

  test("shows the server's reply as the step's message", async () => {
    const { port, seen } = fakeRust(PASSWORD, {
      "ownerid 76561198000000001": ['Added owner Alex, steamid 76561198000000001'],
      status: ["hostname: HexOS Rust\r\nversion : 2590 secure (secure mode enabled, connected to Steam3)\r\nplayers : 1 (50 max)\r\n"],
    });
    const p = await port;
    const owner = await runHook("  ownerid 76561198000000001\n", containerFor(p));
    expect(owner.failed).toBeUndefined();
    expect(owner.checkpoints).toEqual(["Running your command", "Added owner Alex, steamid 76561198000000001"]);
    const status = await runHook("status", containerFor(p));
    expect(status.checkpoints.at(-1)).toBe("hostname: HexOS Rust\nversion : 2590 secure (secure mode enabled, connected to Steam3)\nplayers : 1 (50 max)");
    expect(seen.commands).toEqual(["ownerid 76561198000000001", "status"]);
  });

  test("says when the server printed nothing", async () => {
    const { port } = fakeRust(PASSWORD, { "server.writecfg": [""] });
    expect((await runHook("server.writecfg", containerFor(await port))).checkpoints.at(-1)).toBe(NOTHING_PRINTED);
  });

  test("takes the console from the app's values when Docker can't say", async () => {
    const { port } = fakeRust(PASSWORD, { "say hello": ["[SERVER] hello"] });
    const p = await port;
    const result = await runHook("say hello", null, {
      envs: [{ name: "RCON_PASSWORD", value: PASSWORD }, { name: "RCON_PORT", value: p }],
      ports: [{ port_number: p, protocol: "tcp" }],
    });
    expect(result.checkpoints.at(-1)).toBe("[SERVER] hello");
  });

  test("fails with a message saying what to do, for each way it can go wrong", async () => {
    const { port } = fakeRust(PASSWORD, { hang: "silent", junk: (socket) => socket.write(Buffer.from([0xc1, 0x00])) });
    const p = await port;
    expect((await runHook("   ", containerFor(p))).failed).toBe(NO_COMMAND);
    expect((await runHook(undefined, containerFor(p))).failed).toBe(NO_COMMAND);
    expect((await runHook(`say ${"x".repeat(1000)}`, containerFor(p))).failed).toBe(TOO_LONG);
    expect((await runHook("status", null, null)).failed).toBe(NO_SETTINGS);
    expect((await runHook("status", containerFor(p, "not-the-password"))).failed).toBe(TURNED_AWAY);
    expect((await runHook("hang", containerFor(p))).failed).toBe(NO_ANSWER);
    expect((await runHook("junk", containerFor(p))).failed).toBe(GARBLED);
    const gone = fakeRust(PASSWORD, {});
    const gonePort = await gone.port;
    servers.pop()!.close();
    expect((await runHook("status", containerFor(gonePort))).failed).toBe(STARTING);
  });

  test("a server told to quit that goes away has done as asked", async () => {
    const { port } = fakeRust(PASSWORD, { quit: "close" });
    const result = await runHook("quit", containerFor(await port));
    expect(result.failed).toBeUndefined();
    expect(result.checkpoints.at(-1)).toBe(STOPPING);
  });

  test("never lets the console password into a message, a log or an error", async () => {
    const { port } = fakeRust(PASSWORD, {
      "rcon.password": [`rcon.password: "${PASSWORD}"`],
      [`say ${PASSWORD}`]: [`[SERVER] ${PASSWORD}`],
      hang: "silent",
    });
    const p = await port;
    const runs = [
      await runHook("rcon.password", containerFor(p)),
      await runHook(`say ${PASSWORD}`, containerFor(p)),
      await runHook("hang", containerFor(p)),
      await runHook("status", containerFor(p, `${PASSWORD}-old`)),
      await runHook("status", containerFor(1)),
      await runHook("", containerFor(p)),
    ];
    expect(runs[0].checkpoints.at(-1)).toBe('rcon.password: "(hidden)"');
    for (const result of runs) expect(everything(result)).not.toContain(PASSWORD);
  });
});
