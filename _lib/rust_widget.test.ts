import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

import {
  ARTWORK,
  acceptFor,
  cleanText,
  clientFrame,
  consoleField,
  envOf,
  playerNames,
  playersCard,
  playersLine,
  rconPath,
  readFrame,
  run,
  upgradeRequest,
  webRcon,
} from "../rust/widget_players";
import type { WidgetContext, WidgetFieldValue } from "./widget_context";

// playerlist's Message as Rust's server writes it (indented JSON), two players on
const PLAYERLIST = JSON.stringify(
  [
    { SteamID: "76561198000000001", OwnerSteamID: "0", DisplayName: "Alex", Ping: 31, Address: "203.0.113.7:51234", ConnectedSeconds: 120, VoiationLevel: 0, CurrentLevel: 0, UnspentXp: 0, Health: 100 },
    { SteamID: "76561198000000002", OwnerSteamID: "0", DisplayName: "Sam Smith", Ping: 48, Address: "203.0.113.8:51235", ConnectedSeconds: 5, VoiationLevel: 0, CurrentLevel: 0, UnspentXp: 0, Health: 57.5 },
  ],
  null,
  2,
);

describe("playerlist's answer", () => {
  test("names each player, in the server's order", () => {
    expect(playerNames(PLAYERLIST)).toEqual(["Alex", "Sam Smith"]);
  });

  test("an empty server answers with no names", () => {
    expect(playerNames("[]")).toEqual([]);
    expect(playerNames("[\n]")).toEqual([]);
  });

  test("anything but a list is no answer", () => {
    expect(playerNames("")).toBeNull();
    expect(playerNames("[{")).toBeNull();
    expect(playerNames("Unknown command: playerlist")).toBeNull();
    expect(playerNames('{"Players":2}')).toBeNull();
    expect(playerNames("null")).toBeNull();
  });

  test("a player with no usable name still counts, and odd entries are passed over", () => {
    expect(playerNames('[{"DisplayName":""},{"DisplayName":42},{"SteamID":"1"},null,7,{"DisplayName":"Kim"}]')).toEqual(["", "", "", "Kim"]);
  });

  test("a name is one line: no control or direction characters, single spaces, Steam's 32 at most", () => {
    expect(cleanText("  Al\u0000ex\r\n\tthe‮great​ ")).toBe("Alex thegreat");
    expect(cleanText("\u0007\u0008")).toBe("");
    expect(cleanText("x".repeat(100))).toHaveLength(32);
    // Cut by character, never through an emoji
    expect(cleanText("😀".repeat(40))).toBe("😀".repeat(32));
    expect(cleanText(undefined)).toBe("");
  });

  test("names players as every other card does", () => {
    expect(playersLine(["Alex"])).toBe("Alex");
    expect(playersLine(["Alex", "Sam"])).toBe("Alex and Sam");
    expect(playersLine(["Alex", "Sam", "Kim"])).toBe("Alex, Sam, and Kim");
    expect(playersLine(["Alex", "Sam", "Kim", "Lee", "Max"])).toBe("Alex, Sam, and 3 more");
  });
});

describe("the card", () => {
  const env = envOf({ Config: { Env: ["SERVER_NAME=HexOS Rust", "MAX_PLAYERS=50", "RCON_PASSWORD=a=b"] } });

  test("reads the container's environment, values with = in them included", () => {
    expect(env.get("RCON_PASSWORD")).toBe("a=b");
  });

  test("names who's on under the server's name, over its artwork", () => {
    expect(playersCard(["Alex", "Sam Smith"], env)).toEqual({
      online: { type: "list", entries: [{ title: "HexOS Rust", subtitle: "Alex and Sam Smith", image: ARTWORK }] },
      count: { type: "stat", label: "Players", value: "2/50" },
    });
  });

  test("a player still without a name counts, and the line names the rest", () => {
    expect(playersCard(["", "Kim"], env).online).toEqual({
      type: "list",
      entries: [{ title: "HexOS Rust", subtitle: "Kim", image: ARTWORK }],
    });
    expect(playersCard([""], env).online).toEqual({ type: "list", entries: [{ title: "HexOS Rust", image: ARTWORK }] });
  });

  test("nobody on, or a server still starting, keeps the plain card", () => {
    const plain: Record<string, WidgetFieldValue> = { online: { type: "list", entries: [] }, count: { type: "stat", label: "Players", value: "0/50" } };
    expect(playersCard([], env)).toEqual(plain);
    expect(playersCard(null, env)).toEqual(plain);
  });

  test("without a limit or a name it says what it knows", () => {
    expect(playersCard(["Alex"], new Map())).toEqual({
      online: { type: "list", entries: [{ title: "Rust", subtitle: "Alex", image: ARTWORK }] },
      count: { type: "stat", label: "Players", value: "1" },
    });
  });

  test("its artwork is a WebP within the platform's cap on an image field", () => {
    expect(ARTWORK.startsWith("data:image/webp;base64,")).toBe(true);
    expect(ARTWORK.length).toBeGreaterThan(1000);
    expect(ARTWORK.length).toBeLessThanOrEqual(60_000);
  });

  test("stays the plain card when the server's container can't be found", async () => {
    const ctx: WidgetContext = { appId: "rust-hexos-test-no-such-app", host: "10.0.0.49", port: 28015, mounts: [], log: () => {} };
    const result = await run(ctx);
    expect(result.fields?.online).toEqual({ type: "list", entries: [] });
    expect(result.fields?.count).toEqual({ type: "stat", label: "Players", value: "0" });
    // The Settings tab shows the console's address as still to come, rather than no row
    expect(result.fields?.console).toEqual({ type: "stat", label: "Console address", value: "" });
  });
});

describe("the console's address on the Settings tab", () => {
  test("is the box's address and the port the running server's console took", () => {
    expect(consoleField("192.168.1.20", new Map([["RCON_PORT", "28017"]]))).toEqual({ type: "stat", label: "Console address", value: "192.168.1.20:28017" });
    expect(consoleField("fd00::20", new Map([["RCON_PORT", "28016"]]))).toEqual({ type: "stat", label: "Console address", value: "[fd00::20]:28016" });
  });

  test("is empty, which the tab shows as loading, while the port isn't known", () => {
    for (const env of [new Map<string, string>(), new Map([["RCON_PORT", ""]]), new Map([["RCON_PORT", "nope"]]), new Map([["RCON_PORT", "70000"]])]) {
      expect(consoleField("192.168.1.20", env)).toEqual({ type: "stat", label: "Console address", value: "" });
    }
    expect(consoleField("", new Map([["RCON_PORT", "28016"]]))).toEqual({ type: "stat", label: "Console address", value: "" });
  });

  test("never carries the password", () => {
    const env = new Map([["RCON_PASSWORD", "Zq9-pw-SECRET-7731"], ["RCON_PORT", "28016"]]);
    expect(JSON.stringify(consoleField("192.168.1.20", env))).not.toContain("Zq9-pw-SECRET-7731");
  });

  test("is one of the widget's settings, and fills no slot on the card", async () => {
    const script = JSON.parse(await Bun.file(`${import.meta.dir}/../rust.json`).text());
    const widget = script.widgets.find((each: { id: string }) => each.id === "players");
    expect(widget.settings).toEqual([{ field: "console" }]);
    expect(widget.slots.map((slot: { field: string }) => slot.field)).not.toContain("console");
  });
});

describe("the WebSocket", () => {
  test("the password rides in the path as Rust compares it, with only what can't stand in a request line encoded", () => {
    expect(rconPath("Ab3dEf9h")).toBe("/Ab3dEf9h");
    expect(rconPath("p@ss#w?rd/%x")).toBe("/p@ss#w?rd/%x");
    expect(rconPath("two words")).toBe("/two%20words");
    expect(rconPath("a\r\nHost: evil")).toBe("/a%0D%0AHost:%20evil");
    expect(rconPath("é")).toBe("/é");
  });

  test("asks for the upgrade as RFC 6455 says", () => {
    expect(upgradeRequest("172.16.4.2", 28016, "/secret", "dGhlIHNhbXBsZSBub25jZQ==")).toBe(
      "GET /secret HTTP/1.1\r\nHost: 172.16.4.2:28016\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
    );
    expect(upgradeRequest("fd00::2", 28016, "/x", "k")).toContain("Host: [fd00::2]:28016\r\n");
    // RFC 6455's own example
    expect(acceptFor("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  test("a client frame is masked, in each length form", () => {
    const mask = new Uint8Array([1, 2, 3, 4]);
    for (const [length, head] of [
      [5, 2],
      [125, 2],
      [126, 4],
      [65_535, 4],
      [65_536, 10],
    ]) {
      const payload = Buffer.alloc(length, 0x61);
      const frame = clientFrame(0x1, payload, mask);
      expect(frame[0]).toBe(0x81);
      expect(frame[1] & 0x80).toBe(0x80);
      expect(frame.length).toBe(head + 4 + length);
      expect([...frame.subarray(head, head + 4)]).toEqual([1, 2, 3, 4]);
      expect(frame[head + 4]).toBe(0x61 ^ 1);
      const read = readFrame(frame, 1 << 20);
      expect(read && read !== "bad" ? [read.fin, read.opcode, read.payload.equals(payload), read.size] : read).toEqual([true, 1, true, frame.length]);
    }
  });

  test("reads a server's frames in each length form, and waits for one still arriving", () => {
    for (const length of [0, 125, 126, 70_000]) {
      const frame = serverFrame(0x1, Buffer.alloc(length, 0x62));
      expect(readFrame(frame.subarray(0, frame.length - 1))).toBeNull();
      const read = readFrame(frame);
      expect(read && read !== "bad" ? read.payload.length : read).toBe(length);
    }
    expect(readFrame(Buffer.from([0x81]))).toBeNull();
  });

  test("refuses a frame it shouldn't trust", () => {
    expect(readFrame(serverFrame(0x1, Buffer.alloc(2_000_000)))).toBe("bad");
    expect(readFrame(Buffer.from([0x81, 127, 0xff, 0, 0, 0, 0, 0, 0, 0]))).toBe("bad");
    expect(readFrame(Buffer.from([0xc1, 0]))).toBe("bad"); // a compressed frame nobody agreed to
    expect(readFrame(Buffer.from([0x09, 0]))).toBe("bad"); // a ping in pieces
  });
});

// A console that speaks web RCON the way Rust's does
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

const json = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");

interface Behaviour {
  /** Sends the reply to a command, given the request's identifier; defaults to one frame. */
  reply?: (socket: Socket, identifier: number, message: string) => void;
  silent?: boolean;
  badAccept?: boolean;
}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** Also records what the client sent: its request line and the pongs it answered with. */
function fakeRust(password: string, answers: Record<string, string>, behaviour: Behaviour = {}) {
  const seen = { requestLines: [] as string[], pongs: [] as string[], masked: true };
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let open = false;
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!open) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const lines = buffer.subarray(0, end).toString("utf8").split("\r\n");
        buffer = buffer.subarray(end + 4);
        seen.requestLines.push(lines[0]);
        const key = lines.find((l) => l.toLowerCase().startsWith("sec-websocket-key:"))!.split(": ")[1];
        const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${behaviour.badAccept ? "x" : accept}\r\n\r\n`);
        // As Rust's does, the path is compared as it arrived
        if (lines[0].split(" ")[1] !== `/${password}`) return socket.end();
        open = true;
      }
      for (;;) {
        const frame = readFrame(buffer);
        if (!frame || frame === "bad") return;
        if (!(buffer[1] & 0x80)) seen.masked = false;
        buffer = buffer.subarray(frame.size);
        if (frame.opcode === 0xa) seen.pongs.push(frame.payload.toString());
        if (frame.opcode !== 0x1 || behaviour.silent) continue;
        const request = JSON.parse(frame.payload.toString()) as { Identifier: number; Message: string; Name: string };
        const message = answers[request.Message] ?? "";
        if (behaviour.reply) behaviour.reply(socket, request.Identifier, message);
        else socket.write(serverFrame(0x1, json({ Message: message, Identifier: request.Identifier, Type: "Generic", Stacktrace: "" })));
      }
    });
  });
  servers.push(server);
  const port = new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
  return { port, seen };
}

describe("the console", () => {
  test("opens, asks, and gives the answer with its identifier", async () => {
    const { port, seen } = fakeRust("secret", { playerlist: PLAYERLIST });
    expect(await webRcon("127.0.0.1", await port, "secret", "playerlist")).toBe(PLAYERLIST);
    expect(seen.requestLines).toEqual(["GET /secret HTTP/1.1"]);
    expect(seen.masked).toBe(true);
  });

  test("passes over the server's own lines, answers a ping, and joins a reply in pieces", async () => {
    const { port, seen } = fakeRust("secret", { playerlist: PLAYERLIST }, {
      reply: (socket, identifier, message) => {
        socket.write(serverFrame(0x1, json({ Message: "[CHAT] Alex: hi", Identifier: -1, Type: "Chat", Stacktrace: "" })));
        socket.write(serverFrame(0x1, json({ Message: "Saved 31,337 ents", Identifier: 0, Type: "Generic", Stacktrace: "" })));
        socket.write(serverFrame(0x9, Buffer.from("are you there")));
        const whole = json({ Message: message, Identifier: identifier, Type: "Generic", Stacktrace: "" });
        const a = whole.subarray(0, 10);
        const b = whole.subarray(10, 200);
        const c = whole.subarray(200);
        socket.write(serverFrame(0x1, a, false));
        // A control frame may come between a message's pieces
        socket.write(serverFrame(0x9, Buffer.from("again")));
        // And TCP may cut a frame anywhere
        const middle = serverFrame(0x0, b, false);
        socket.write(middle.subarray(0, 3));
        setTimeout(() => {
          socket.write(middle.subarray(3));
          socket.write(serverFrame(0x0, c, true));
        }, 20);
      },
    });
    expect(await webRcon("127.0.0.1", await port, "secret", "playerlist")).toBe(PLAYERLIST);
    expect(seen.pongs).toEqual(["are you there", "again"]);
  });

  test("a wrong password, a console that never answers, or none at all reads as nothing", async () => {
    const wrong = fakeRust("secret", { playerlist: PLAYERLIST });
    expect(await webRcon("127.0.0.1", await wrong.port, "wrong", "playerlist")).toBeNull();
    const silent = fakeRust("secret", {}, { silent: true });
    expect(await webRcon("127.0.0.1", await silent.port, "secret", "playerlist", 200)).toBeNull();
    const forged = fakeRust("secret", { playerlist: PLAYERLIST }, { badAccept: true });
    expect(await webRcon("127.0.0.1", await forged.port, "secret", "playerlist")).toBeNull();
    // A server still downloading the game or generating its map: nothing listens yet
    const closed = fakeRust("secret", {});
    const closedPort = await closed.port;
    for (const server of servers.splice(0)) server.close();
    expect(await webRcon("127.0.0.1", closedPort, "secret", "playerlist", 500)).toBeNull();
  });

  test("a close frame ends it", async () => {
    const { port } = fakeRust("secret", {}, { reply: (socket) => socket.write(serverFrame(0x8, Buffer.from([0x03, 0xe8]))) });
    expect(await webRcon("127.0.0.1", await port, "secret", "playerlist", 1000)).toBeNull();
  });
});
