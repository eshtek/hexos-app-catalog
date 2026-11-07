import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { WidgetContext, WidgetQueryResult } from "./widget_context";
import { ARTWORK, optionSettings, playerNames, run, serverMount } from "../palworld/widget_players";

// PalWorldSettings.ini as the chart's setup left it on demeter (TrueNAS 25.10.3, chart 1.3.13) on
// 2026-11-07: the keys it adds go in at the front, after a comma and a space. The password is a
// stand-in for the one the install generated.
const PASSWORD = "Xq7Lr2Vt9Mw4Kp1z";
const settingsFile = (port: number | string = 30443, enabled = "True", password = PASSWORD) =>
  [
    "[/Script/Pal.PalGameWorldSettings]",
    `OptionSettings=(RESTAPIPort=${port}, RESTAPIEnabled=${enabled}, AllowConnectPlatform=Steam, Difficulty=None,DayTimeSpeedRate=1.000000,DeathPenalty=All,bEnablePlayerToPlayerDamage=False,GuildPlayerMaxNum=20,bIsMultiplay=False,CoopPlayerMaxNum=4,ServerPlayerMaxNum=32,ServerName="HexOS Palworld Test",ServerDescription="Widget test",AdminPassword="${password}",ServerPassword="",PublicPort=38211,PublicIP="",RCONEnabled=True,RCONPort=38212,Region="",bUseAuth=True,BanListURL="https://api.palworldgame.com/api/banlist.txt")`,
    "",
  ].join("\n");

// The players and metrics answers as Palworld's REST API reference gives them
const PLAYER = {
  name: "PalUser",
  accountName: "paluser",
  playerId: "AFAFD830000000000000000000000000",
  userId: "steam_00000000000000000",
  ip: "127.0.0.1",
  ping: 3.14,
  location_x: 123.45,
  location_y: 67.89,
  level: 1,
  building_count: 119,
};
const METRICS = { serverfps: 57, currentplayernum: 1, serverframetime: 16.7671, maxplayernum: 32, uptime: 3600, basecampnum: 32, days: 1 };

describe("PalWorldSettings.ini", () => {
  test("reads the server's own settings", () => {
    const settings = optionSettings(settingsFile());
    expect(settings.get("RESTAPIPort")).toBe("30443");
    expect(settings.get("RESTAPIEnabled")).toBe("True");
    expect(settings.get("AdminPassword")).toBe(PASSWORD);
    expect(settings.get("ServerName")).toBe("HexOS Palworld Test");
    expect(settings.get("ServerPlayerMaxNum")).toBe("32");
    expect(settings.get("BanListURL")).toBe("https://api.palworldgame.com/api/banlist.txt");
  });

  test("a quoted value may hold commas, parentheses and escaped quotes, and a list sits in parentheses", () => {
    const settings = optionSettings(
      'OptionSettings=(ServerName="Pals, (and) friends",ServerDescription="say \\"hi\\"",CrossplayPlatforms=(Steam,Xbox,PS5,Mac),AdminPassword="a\\\\b",ServerPlayerMaxNum=8)\r\n',
    );
    expect(settings.get("ServerName")).toBe("Pals, (and) friends");
    expect(settings.get("ServerDescription")).toBe('say "hi"');
    expect(settings.get("CrossplayPlatforms")).toBe("(Steam,Xbox,PS5,Mac)");
    expect(settings.get("AdminPassword")).toBe("a\\b");
    expect(settings.get("ServerPlayerMaxNum")).toBe("8");
  });

  test("a file with no settings line reads as none", () => {
    expect(optionSettings("").size).toBe(0);
    expect(optionSettings("[/Script/Pal.PalGameWorldSettings]\n").size).toBe(0);
  });
});

describe("the players answer", () => {
  test("names each player, by their platform account when the game hasn't named them yet", () => {
    expect(playerNames({ players: [PLAYER] })).toEqual(["PalUser"]);
    expect(playerNames({ players: [{ ...PLAYER, name: "" }] })).toEqual(["paluser"]);
    expect(playerNames({ players: [{ ...PLAYER, name: "", accountName: "" }] })).toEqual([""]);
    expect(playerNames({ players: [] })).toEqual([]);
  });

  test("anything else reads as no answer", () => {
    expect(playerNames(null)).toBeNull();
    expect(playerNames({ error: "Unauthorized" })).toBeNull();
  });
});

describe("the server folder", () => {
  test("is found by its host path, a later copy's too, and never the SteamCMD folder", () => {
    const mount = { hostPath: "/mnt/SSDs/Media/palworld-2", containerPath: null, localPath: "/host/x" };
    const steamcmd = { hostPath: "/mnt/SSDs/Applications/palworld-2/steamcmd", containerPath: null, localPath: "/host/y" };
    expect(serverMount([steamcmd, mount])).toBe(mount);
    expect(serverMount([steamcmd, { ...mount, hostPath: "/mnt/SSDs/Media/palworld" }])?.hostPath).toBe("/mnt/SSDs/Media/palworld");
    expect(serverMount([steamcmd])).toBeUndefined();
  });
});

describe("the card", () => {
  const dirs: string[] = [];
  const servers: { stop: () => void }[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    for (const server of servers.splice(0)) server.stop();
  });

  /** A server folder holding this settings file, as a later copy's. */
  function serverDir(settings?: string): string {
    const dir = mkdtempSync(`${tmpdir()}/palworld-`);
    dirs.push(dir);
    mkdirSync(`${dir}/Pal/Saved/Config/LinuxServer`, { recursive: true });
    if (settings !== undefined) writeFileSync(`${dir}/Pal/Saved/Config/LinuxServer/PalWorldSettings.ini`, settings);
    return dir;
  }

  /** A REST API that wants admin and the password, answering with these players and metrics. */
  function api(players: object[], metrics: object | null = METRICS): { port: number; asked: string[] } {
    const asked: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const path = new URL(request.url).pathname;
        asked.push(path);
        if (request.headers.get("authorization") !== `Basic ${btoa(`admin:${PASSWORD}`)}`) {
          return new Response("Unauthorized", { status: 401 });
        }
        if (path === "/v1/api/players") return Response.json({ players });
        if (path === "/v1/api/metrics" && metrics) return Response.json(metrics);
        return new Response("Not found", { status: 404 });
      },
    });
    servers.push(server);
    return { port: server.port as number, asked };
  }

  const context = (dir: string | null): WidgetContext => ({
    appId: "palworld-hexos-test-no-such-app",
    host: "127.0.0.1",
    port: 1,
    mounts: dir
      ? [
          { hostPath: "/mnt/SSDs/Applications/palworld-2/steamcmd", containerPath: null, localPath: "/tmp/unused" },
          { hostPath: "/mnt/SSDs/Media/palworld-2", containerPath: null, localPath: dir },
        ]
      : [],
    log: () => {},
  });

  test("one entry while anyone's on: the server's name, the players under it, over the artwork", async () => {
    const { port, asked } = api([PLAYER, { ...PLAYER, name: "Zoe" }]);
    const result = await run(context(serverDir(settingsFile(port))));
    expect(result.fields).toEqual({
      online: { type: "list", entries: [{ title: "HexOS Palworld Test", subtitle: "PalUser, Zoe", image: ARTWORK }] },
      count: { type: "stat", label: "Players", value: "2/32" },
    });
    expect(asked.sort()).toEqual(["/v1/api/metrics", "/v1/api/players"]);
  });

  test("nobody on folds the card back", async () => {
    const { port } = api([]);
    expect((await run(context(serverDir(settingsFile(port))))).fields).toEqual({
      online: { type: "list", entries: [] },
      count: { type: "stat", label: "Players", value: "0/32" },
    });
  });

  test("the limit is the one the server runs with, which a world's own settings may override", async () => {
    const { port } = api([PLAYER], { ...METRICS, maxplayernum: 16 });
    expect((await run(context(serverDir(settingsFile(port))))).fields?.count).toEqual({ type: "stat", label: "Players", value: "1/16" });
  });

  test("the limit falls back to the settings file when the metrics don't answer", async () => {
    const { port } = api([PLAYER], null);
    const count = (await run(context(serverDir(settingsFile(port).replace("ServerPlayerMaxNum=32", "ServerPlayerMaxNum=12"))))).fields
      ?.count;
    expect(count).toEqual({ type: "stat", label: "Players", value: "1/12" });
  });

  test("a player still loading in counts, and the line names the rest", async () => {
    const { port } = api([{ ...PLAYER, name: "", accountName: "" }]);
    const result = await run(context(serverDir(settingsFile(port))));
    expect(result.fields?.online).toEqual({ type: "list", entries: [{ title: "HexOS Palworld Test", image: ARTWORK }] });
    expect(result.fields?.count).toEqual({ type: "stat", label: "Players", value: "1/32" });
  });

  test("a server with no name is Palworld", async () => {
    const { port } = api([PLAYER]);
    const online = (await run(context(serverDir(settingsFile(port).replace('ServerName="HexOS Palworld Test"', 'ServerName=""'))))).fields
      ?.online;
    expect(online?.type === "list" && online.entries[0].title).toBe("Palworld");
  });

  const plain = (result: WidgetQueryResult) => result.fields?.online;

  test("a wrong password keeps the plain card rather than failing it", async () => {
    const { port } = api([PLAYER]);
    expect(plain(await run(context(serverDir(settingsFile(port, "True", "wrong")))))).toEqual({ type: "list", entries: [] });
  });

  test("with the API off, it never asks", async () => {
    const { port, asked } = api([PLAYER]);
    expect(plain(await run(context(serverDir(settingsFile(port, "False")))))).toEqual({ type: "list", entries: [] });
    expect(asked).toEqual([]);
  });

  test("a server that isn't answering keeps the plain card", async () => {
    const { port } = api([PLAYER]);
    servers.splice(0).forEach((server) => server.stop());
    expect(plain(await run(context(serverDir(settingsFile(port)))))).toEqual({ type: "list", entries: [] });
  });

  test("no settings file keeps the plain card", async () => {
    expect((await run(context(serverDir()))).fields).toEqual({
      online: { type: "list", entries: [] },
      count: { type: "stat", label: "Players", value: "0" },
    });
    expect(plain(await run(context(null)))).toEqual({ type: "list", entries: [] });
  });

  test("the password never leaves for anywhere but the server", async () => {
    const { port } = api([PLAYER]);
    const logged: string[] = [];
    const result = await run({ ...context(serverDir(settingsFile(port))), log: (message) => logged.push(message) });
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(logged.join("\n")).not.toContain(PASSWORD);
  });

  test("its artwork is a WebP within the platform's cap on an image field", () => {
    expect(ARTWORK.startsWith("data:image/webp;base64,")).toBe(true);
    expect(ARTWORK.length).toBeLessThanOrEqual(60_000);
  });
});
