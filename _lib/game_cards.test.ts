import { describe, expect, test } from "bun:test";

import { onlinePlayers, gameSettings, dataMount } from "../factorio/widget_players";
import { sessionPlayers as bedrockPlayers } from "../minecraft-bedrock/widget_players";
import { demux, envOf, plainLines, playersLine, sessionPlayers as terrariaPlayers } from "../terraria/widget_players";
import { sessionPlayers as tmodPlayers } from "../tmodloader/widget_players";
import { playersLine as tshockLine } from "../terraria-tshock/widget_players";

const frame = (text: string) => {
  const body = new TextEncoder().encode(text);
  const out = new Uint8Array(8 + body.length);
  out.set([1, 0, 0, 0, (body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255]);
  out.set(body, 8);
  return out;
};

describe("reading a container's console", () => {
  test("a container without a terminal frames its output; one with a terminal doesn't", () => {
    const framed = new Uint8Array([...frame("Alex has joined.\n"), ...frame("Server started\n")]);
    expect(demux(framed)).toBe("Alex has joined.\nServer started\n");
    expect(demux(new TextEncoder().encode("Alex has joined.\r\n"))).toBe("Alex has joined.\r\n");
  });

  test("drops terminal colours, title codes and carriage returns", () => {
    expect(plainLines("\x1b[39;49m\x1b]0;Terraria Server: World: \x07Alex has joined.\r\n\r\n: Sam has left.")).toEqual([
      "Alex has joined.",
      ": Sam has left.",
    ]);
  });

  test("reads the container's environment", () => {
    const env = envOf({ Id: "x", Config: { Env: ["TMOD_MAXPLAYERS=16", "TMOD_PASS=a=b"] } });
    expect(env.get("TMOD_MAXPLAYERS")).toBe("16");
    expect(env.get("TMOD_PASS")).toBe("a=b");
  });
});

describe("who's on", () => {
  test("Terraria counts who joined and hasn't left, past the console's prompt", () => {
    expect(terrariaPlayers(["Alex has joined.", ": Sam has joined.", "Alex has left.", "<Sam> hello"])).toEqual(["Sam"]);
  });

  test("tModLoader reads the same lines", () => {
    expect(tmodPlayers(["Alex has joined.", "Sam has joined.", "Sam has left."])).toEqual(["Alex"]);
  });

  test("Bedrock reads its connected and disconnected lines", () => {
    const lines = [
      "[2026-11-07 02:00:00:000 INFO] Player connected: Steve, xuid: 2535411111111111",
      "[2026-11-07 02:00:05:000 INFO] Player connected: Alex Smith, xuid: 2535422222222222",
      "[2026-11-07 02:10:00:000 INFO] Player disconnected: Steve, xuid: 2535411111111111, pfid: abc",
    ];
    expect(bedrockPlayers(lines)).toEqual(["Alex Smith"]);
  });

  test("Factorio reads /players online's answer", () => {
    expect(onlinePlayers("Online players (2):\n  alex (online)\n  sam (online)\n")).toEqual(["alex", "sam"]);
    expect(onlinePlayers("Online players (0):\n")).toEqual([]);
  });

  test("Factorio's name and limit come from its settings, and a limit of 0 is none", () => {
    expect(gameSettings(JSON.stringify({ name: "Our factory", max_players: 8 }))).toEqual({ name: "Our factory", max: 8 });
    expect(gameSettings(JSON.stringify({ name: "Name of the game as it will appear in the game listing", max_players: 0 }))).toEqual({ name: "Factorio", max: 0 });
    expect(gameSettings(null)).toEqual({ name: "Factorio", max: 0 });
  });

  test("Factorio finds a later copy's data folder by its host path", () => {
    const mount = { hostPath: "/mnt/SSDs/Applications/factorio-2/data", containerPath: null, localPath: "/host/x" };
    expect(dataMount([mount])).toBe(mount);
  });

  test("every card names players the same way", () => {
    for (const line of [playersLine, tshockLine]) {
      expect(line(["Alex"])).toBe("Alex");
      expect(line(["Alex", "Sam"])).toBe("Alex and Sam");
      expect(line(["Alex", "Sam", "Kim"])).toBe("Alex, Sam, and Kim");
      expect(line(["Alex", "Sam", "Kim", "Lee", "Max"])).toBe("Alex, Sam, and 3 more");
    }
  });
});
