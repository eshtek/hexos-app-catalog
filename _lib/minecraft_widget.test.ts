import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import type { WidgetContext } from "./widget_context";
import { ARTWORK, gameMode, online, playersLine, properties, rcon, run, ticksPerSecond } from "../minecraft/widget_server";

// What a vanilla 26.3 server installed by HexOS answered on demeter on 2026-11-02, one player on
const LIST = "There are 1 of a max of 20 players online: AverageCakeSlice";
const TICK_QUERY =
  "The game is running normallyTarget tick rate: 20.0 per second.\nAverage time per tick: 13.9ms (Target: 50.0ms)Percentiles: P50: 13.6ms P95: 18.1ms P99: 29.6ms. Sample: 100";

describe("server.properties", () => {
  test("reads its keys, with the escapes Minecraft writes", () => {
    const read = properties(
      [
        "#Minecraft server properties",
        "enable-rcon=true",
        "gamemode=survival",
        "motd=\\u00A7aMinecraft on HexOS",
        "rcon.password=abc\\=123",
        "rcon.port=25575",
        "",
      ].join("\n"),
    );
    expect(read.get("enable-rcon")).toBe("true");
    expect(read.get("motd")).toBe("§aMinecraft on HexOS");
    expect(read.get("rcon.password")).toBe("abc=123");
    expect(read.get("rcon.port")).toBe("25575");
  });

  test("names the game mode, Hardcore over the mode new players start in", () => {
    expect(gameMode(properties("gamemode=creative"))).toBe("Creative");
    expect(gameMode(properties("gamemode=1"))).toBe("Creative");
    expect(gameMode(properties("gamemode=survival\nhardcore=true"))).toBe("Hardcore");
    expect(gameMode(properties("gamemode=something"))).toBeNull();
  });
});

describe("the console's answers", () => {
  test("list says who's on, out of how many", () => {
    expect(online(LIST)).toEqual({ count: 1, max: 20, names: ["AverageCakeSlice"] });
    expect(online("There are 0 of a max of 20 players online: ")).toEqual({ count: 0, max: 20, names: [] });
    expect(online("§6There are 2 of a max of 10 players online: §fAlex, Steve")?.names).toEqual(["Alex", "Steve"]);
    expect(online("Unknown or incomplete command")).toBeNull();
  });

  test("tick query gives ticks a second, never above the target", () => {
    expect(ticksPerSecond(TICK_QUERY)).toBe("20.0");
    expect(ticksPerSecond("Target tick rate: 20.0 per second.Average time per tick: 80.0ms")).toBe("12.5");
    expect(ticksPerSecond("Target tick rate: 20.0 per second.Average time per tick: 0.0ms")).toBe("20.0");
    expect(ticksPerSecond("The game is frozenTarget tick rate: 20.0 per second.")).toBe("Frozen");
    // A server from before 1.20.3 has no tick command
    expect(ticksPerSecond("Unknown or incomplete command, see below for error")).toBeNull();
  });

  test("the players read as one line", () => {
    expect(playersLine(["Alex"])).toBe("Alex");
    expect(playersLine(["Alex", "Steve"])).toBe("Alex and Steve");
    expect(playersLine(["Alex", "Steve", "Noor"])).toBe("Alex, Steve, and Noor");
    expect(playersLine(["Alex", "Steve", "Noor", "Kai", "Ana"])).toBe("Alex, Steve, and 3 more");
  });
});

// A console that speaks the protocol the way Minecraft's does: a sign-in answered with the request's
// id, or -1 for a wrong password, then one answer per command
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

function frame(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, "utf8");
  const out = Buffer.alloc(14 + payload.length);
  out.writeInt32LE(10 + payload.length, 0);
  out.writeInt32LE(id, 4);
  out.writeInt32LE(type, 8);
  payload.copy(out, 12);
  return out;
}

function console_(password: string, answers: Record<string, string>, { split = false, silent = false } = {}): Promise<number> {
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readInt32LE(0)) {
        const length = buffer.readInt32LE(0);
        const id = buffer.readInt32LE(4);
        const type = buffer.readInt32LE(8);
        const body = buffer.subarray(12, 2 + length).toString("utf8");
        buffer = buffer.subarray(4 + length);
        if (silent) continue;
        const reply =
          type === 3 ? frame(body === password ? id : -1, 2, "") : frame(id, 0, answers[body] ?? "Unknown command");
        // A reply cut in two, as TCP may deliver it
        if (split) {
          socket.write(reply.subarray(0, 7));
          setTimeout(() => socket.write(reply.subarray(7)), 5);
        } else socket.write(reply);
      }
    });
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

describe("the console", () => {
  test("signs in and answers each command in order", async () => {
    const port = await console_("secret", { list: LIST, "tick query": TICK_QUERY });
    expect(await rcon("127.0.0.1", port, "secret", ["list", "tick query"])).toEqual([LIST, TICK_QUERY]);
  });

  test("reads an answer TCP delivers in pieces", async () => {
    const port = await console_("secret", { list: LIST }, { split: true });
    expect(await rcon("127.0.0.1", port, "secret", ["list"])).toEqual([LIST]);
  });

  test("a wrong password, a console that never answers, or none at all reads as nothing", async () => {
    const port = await console_("secret", { list: LIST });
    expect(await rcon("127.0.0.1", port, "wrong", ["list"])).toBeNull();
    const silent = await console_("secret", {}, { silent: true });
    expect(await rcon("127.0.0.1", silent, "secret", ["list"], 200)).toBeNull();
    const closed = await console_("secret", {});
    for (const server of servers.splice(0)) server.close();
    expect(await rcon("127.0.0.1", closed, "secret", ["list"], 500)).toBeNull();
  });
});

describe("the card", () => {
  test("its artwork is a WebP within the platform's cap on an image field", () => {
    expect(ARTWORK.startsWith("data:image/webp;base64,")).toBe(true);
    expect(ARTWORK.length).toBeLessThanOrEqual(60_000);
  });

  const context = (dataDir: string): WidgetContext => ({
    appId: "minecraft-hexos-test-no-such-app",
    host: "10.0.0.49",
    port: 25565,
    mounts: [{ hostPath: "/mnt/SSDs/Applications/minecraft-hexos-test-no-such-app/data", containerPath: null, localPath: dataDir }],
    log: () => {},
  });

  test("stays the plain card when the server's container can't be found", async () => {
    const dir = mkdtempSync(`${tmpdir()}/minecraft-widget-`);
    writeFileSync(`${dir}/server.properties`, "enable-rcon=true\nrcon.password=secret\ngamemode=survival\n");
    const result = await run(context(dir));
    expect(result.fields).toEqual({ online: { type: "list", entries: [] } });
  });
});
