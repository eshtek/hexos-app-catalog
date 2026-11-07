import { afterEach, describe, expect, test } from "bun:test";
import { createSocket, type Socket } from "node:dgram";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { WidgetContext } from "./widget_context";
import {
  ARTWORK,
  archiveSize,
  configMount,
  followLog,
  playerId,
  queryAnswerName,
  readLog,
  run,
  serverName,
  urlOption,
} from "../satisfactory-server/widget_players";

// What the server installed by HexOS on demeter (TrueNAS 25.10.3, image v1.9.11, game CL 517554)
// logged at its start on 2026-11-07, before anyone claimed it
const OPENED = "Log file open, 11/07/26 01:28:42";
const COMMAND_LINE =
  "LogInit: Command Line: -Port=7779 -ReliablePort=8888 -ExternalReliablePort=8888 -ini:Engine:[/Script/FactoryGame.FGSaveSession]:mNumRotatingAutosaves=5 -ini:Engine:[/Script/Engine.GarbageCollectionSettings]:gc.MaxObjectsInEditor=2162688 -ini:Engine:[/Script/OnlineSubsystemUtils.IpNetDriver]:LanServerMaxTickRate=30 -ini:Engine:[/Script/OnlineSubsystemUtils.IpNetDriver]:NetServerMaxTickRate=30 -ini:Engine:[/Script/OnlineSubsystemUtils.IpNetDriver]:ConnectionTimeout=30 -ini:Engine:[/Script/OnlineSubsystemUtils.IpNetDriver]:InitialConnectTimeout=30 -ini:Engine:[ConsoleVariables]:wp.Runtime.EnableServerStreaming=1 -ini:Game:[/Script/Engine.GameSession]:ConnectionTimeout=30 -ini:Game:[/Script/Engine.GameSession]:InitialConnectTimeout=30 -ini:Game:[/Script/Engine.GameSession]:MaxPlayers=4 -ini:GameUserSettings:[/Script/Engine.GameSession]:MaxPlayers=4 -multihome=::";
const ENTRY_MAP = "[2026.11.07-06.28.43:953][  0]LogLoad: LoadMap: /Game/FactoryGame/Map/DedicatedserverEntry?Name=Player";
const STARTED = [OPENED, COMMAND_LINE, ENTRY_MAP];

// Nobody joined demeter's server, so the way in and out follows the lines Satisfactory 1.0 servers
// logged in the community's log parsers (2024), with made-up ids and addresses. demeter's engine
// (5.6) names a driver "Name:GameNetDriver Def:GameNetDriver FGDSIpNetDriver_...", 1.0's (5.2)
// "GameNetDriver FGDSIpNetDriver_..."
const login = (name: string, steam: string) =>
  `[2026.11.07-07.00.01:100][500]LogNet: Login request: ?ClientIdentity=0123456789?EncryptionToken=?Name=${name} userId: Steam:2 (ForeignId=[Type=6 Handle=1 RepData=[${steam}]) platform: Steam`;
const joined = (name: string) => `[2026.11.07-07.00.02:200][530]LogNet: Join succeeded: ${name}`;
const closed = (steam: string, driver = "Name:GameNetDriver Def:GameNetDriver FGDSIpNetDriver_2147482169") =>
  `[2026.11.07-07.30.00:300][900]LogNet: UNetConnection::Close: [UNetConnection] RemoteAddr: 192.0.2.10:59946, Name: FGDSIpConnection_2147444421, Driver: ${driver}, IsServer: YES, PC: BP_PlayerController_C_2147444406, Owner: BP_PlayerController_C_2147444406, UniqueId: Steam:2 (ForeignId=[Type=6 Handle=1 RepData=[${steam}]), Channels: 41, Time: 2026.11.07-07.30.00`;
const NEVER_SIGNED_IN =
  "[2026.11.07-07.00.00:000][490]LogNet: UNetConnection::Close: [UNetConnection] RemoteAddr: 192.0.2.10:59900, Name: FGDSIpConnection_2147444400, Driver: Name:GameNetDriver Def:GameNetDriver FGDSIpNetDriver_2147482169, IsServer: YES, PC: NULL, Owner: NULL, UniqueId: INVALID, Channels: 2, Time: 2026.11.07-07.00.00";
const ALEX = "1100001000000A01";
const SAM = "1100001000000B02";
const NOOR = "1100001000000C03";
const sessionMap = (session: string) =>
  `[2026.11.07-06.40.00:000][100]LogLoad: LoadMap: /Game/FactoryGame/Map/GameLevel01/Persistent_Level?startloc=Grass Fields?sessionName=${session}?Visibility=SV_FriendsOnly?loadgame=${session}_autosave_0?listen`;

const names = (lines: string[]) => [...readLog(lines.join("\n")).online.values()];

describe("the server's log", () => {
  test("its command line gives the limit and the game port", () => {
    const roster = readLog(STARTED.join("\n"));
    expect(roster.max).toBe(4);
    expect(roster.port).toBe(7779);
    expect(readLog(COMMAND_LINE.replace(/MaxPlayers=4/g, "MaxPlayers=8")).max).toBe(8);
  });

  test("a log without the command line keeps the image's limit", () => {
    expect(readLog("").max).toBe(4);
    expect(readLog("").port).toBeNull();
  });

  test("nobody is on before anyone joins", () => {
    expect(names(STARTED)).toEqual([]);
  });

  test("a player is on from joining until their connection closes", () => {
    expect(names([...STARTED, login("Alex", ALEX), joined("Alex")])).toEqual(["Alex"]);
    expect(names([...STARTED, login("Alex", ALEX), joined("Alex"), closed(ALEX)])).toEqual([]);
  });

  test("players stay in the order they joined, and one leaving leaves the rest", () => {
    const log = [login("Alex", ALEX), joined("Alex"), login("Sam", SAM), joined("Sam"), login("Noor", NOOR), joined("Noor")];
    expect(names(log)).toEqual(["Alex", "Sam", "Noor"]);
    expect(names([...log, closed(SAM)])).toEqual(["Alex", "Noor"]);
  });

  test("a name with spaces reads whole", () => {
    expect(names([login("Pioneer One", ALEX), joined("Pioneer One")])).toEqual(["Pioneer One"]);
  });

  test("a player back after leaving is on once", () => {
    const log = [login("Alex", ALEX), joined("Alex"), closed(ALEX), login("Alex", ALEX), joined("Alex")];
    expect(names(log)).toEqual(["Alex"]);
    expect(names([login("Alex", ALEX), joined("Alex"), login("Alex", ALEX), joined("Alex")])).toEqual(["Alex"]);
  });

  test("a login that never joins counts for nothing, and its close keeps its id from a later join", () => {
    // A wrong password: the login, then its connection closing
    expect(names([login("Sam", SAM)])).toEqual([]);
    const log = [login("Sam", SAM), closed(SAM), login("Alex", ALEX), joined("Alex Renamed"), closed(ALEX)];
    expect(names(log)).toEqual([]);
  });

  test("a player the game names otherwise than their login takes that login's id, so their leave still counts", () => {
    expect(names([login("alex", ALEX), joined("Alex the Pioneer")])).toEqual(["Alex the Pioneer"]);
    expect(names([login("alex", ALEX), joined("Alex the Pioneer"), closed(ALEX)])).toEqual([]);
  });

  test("a connection that never signed in, or one off the game's driver, ends nobody's game", () => {
    const on = [login("Alex", ALEX), joined("Alex")];
    expect(names([...on, NEVER_SIGNED_IN])).toEqual(["Alex"]);
    expect(names([...on, closed(ALEX, "Name:BeaconNetDriver Def:BeaconNetDriver IpNetDriver_1")])).toEqual(["Alex"]);
  });

  test("an older engine's driver name ends a game too", () => {
    expect(names([login("Alex", ALEX), joined("Alex"), closed(ALEX, "GameNetDriver FGDSIpNetDriver_2147461209")])).toEqual([]);
  });

  test("a session loading starts the roster over and names the session", () => {
    const roster = readLog([...STARTED, login("Alex", ALEX), joined("Alex"), sessionMap("Northern Forest")].join("\n"));
    expect([...roster.online.values()]).toEqual([]);
    expect(roster.session).toBe("Northern Forest");
    expect(readLog(STARTED.join("\n")).session).toBeNull();
  });

  test("a log written on Windows line endings still reads", () => {
    expect(names([login("Alex", ALEX), joined("Alex")].map((line) => `${line}\r`))).toEqual(["Alex"]);
  });

  test("ids read the same from a login and a close", () => {
    expect(playerId(`Steam:2 (ForeignId=[Type=6 Handle=1 RepData=[${ALEX.toLowerCase()}])`)).toBe(ALEX);
    expect(playerId("EOS:00020aed06f0a6958c3c067fb4b73d51")).toBe("EOS:00020aed06f0a6958c3c067fb4b73d51");
    expect(playerId("INVALID")).toBeNull();
    expect(playerId("Steam:UNKNOWN")).toBeNull();
  });

  test("a travel URL's options read by name", () => {
    expect(urlOption("?ClientIdentity=1?Name=Pioneer One", "Name")).toBe("Pioneer One");
    expect(urlOption("/Game/Map??startloc=Grass Fields?sessionName=Base", "sessionname")).toBe("Base");
    expect(urlOption("/Game/FactoryGame/Map/DedicatedserverEntry?Name=Player", "sessionName")).toBeNull();
  });
});

describe("the config folder", () => {
  test("is found by its host path, a later copy's too", () => {
    const mount = { hostPath: "/mnt/SSDs/Applications/satisfactory-server-2/config", containerPath: null, localPath: "/host/x" };
    expect(configMount([mount])).toBe(mount);
    expect(configMount([{ ...mount, hostPath: "/mnt/SSDs/Applications/satisfactory-server/config" }])).toBeDefined();
    expect(configMount([{ ...mount, hostPath: "/mnt/SSDs/Applications/satisfactory/config" }])).toBeUndefined();
    expect(configMount([{ ...mount, hostPath: "/mnt/SSDs/Applications/satisfactory-server/backups" }])).toBeUndefined();
  });
});

const LOG_PATH = "gamefiles/FactoryGame/Saved/Logs/FactoryGame.log";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function configDir(lines?: string[]): string {
  const dir = mkdtempSync(`${tmpdir()}/satisfactory-`);
  dirs.push(dir);
  mkdirSync(`${dir}/gamefiles/FactoryGame/Saved/Logs`, { recursive: true });
  if (lines) writeFileSync(`${dir}/${LOG_PATH}`, `${lines.join("\n")}\n`);
  return dir;
}

describe("following the log", () => {
  test("a refresh reads only what the log gained since the last one", async () => {
    const dir = configDir(STARTED);
    const path = `${dir}/${LOG_PATH}`;
    expect([...((await followLog(path)) as { online: Map<string, string> }).online.values()]).toEqual([]);
    appendFileSync(path, `${login("Alex", ALEX)}\n${joined("Alex")}\n`);
    expect([...((await followLog(path)) as { online: Map<string, string> }).online.values()]).toEqual(["Alex"]);
    appendFileSync(path, `${closed(ALEX)}\n`);
    expect([...((await followLog(path)) as { online: Map<string, string> }).online.values()]).toEqual([]);
  });

  test("a line the server is still writing waits for its end", async () => {
    const dir = configDir(STARTED);
    const path = `${dir}/${LOG_PATH}`;
    const line = joined("Alex");
    appendFileSync(path, `${login("Alex", ALEX)}\n${line.slice(0, 40)}`);
    expect([...((await followLog(path)) as { online: Map<string, string> }).online.values()]).toEqual([]);
    appendFileSync(path, `${line.slice(40)}\n`);
    expect([...((await followLog(path)) as { online: Map<string, string> }).online.values()]).toEqual(["Alex"]);
  });

  test("a restart's new log starts over, even when it's already longer than the old one", async () => {
    const dir = configDir([...STARTED, login("Alex", ALEX), joined("Alex")]);
    const path = `${dir}/${LOG_PATH}`;
    expect([...((await followLog(path)) as { online: Map<string, string> }).online.values()]).toEqual(["Alex"]);
    const restarted = [OPENED.replace("01:28:42", "09:15:00"), COMMAND_LINE, ENTRY_MAP, login("Sam", SAM), joined("Sam")];
    writeFileSync(path, `${[...restarted, ...Array(40).fill(ENTRY_MAP.replace("LoadMap", "Other"))].join("\n")}\n`);
    expect([...((await followLog(path)) as { online: Map<string, string> }).online.values()]).toEqual(["Sam"]);
  });

  test("a log shorter than what was read is a new one, even when it opens the same way", async () => {
    const dir = configDir([...STARTED, login("Alex", ALEX), joined("Alex")]);
    const path = `${dir}/${LOG_PATH}`;
    await followLog(path);
    writeFileSync(path, `${STARTED.join("\n")}\n`);
    expect([...((await followLog(path)) as { online: Map<string, string> }).online.values()]).toEqual([]);
  });

  test("a long log is caught up on over several refreshes, and reads as nothing until then", async () => {
    const dir = configDir([...STARTED, login("Alex", ALEX), joined("Alex")]);
    const path = `${dir}/${LOG_PATH}`;
    expect(await followLog(path, 1000)).toBe("behind");
    let roster = await followLog(path, 1000);
    for (let i = 0; roster === "behind" && i < 10; i++) roster = await followLog(path, 1000);
    expect([...(roster as { online: Map<string, string> }).online.values()]).toEqual(["Alex"]);
  });

  test("no log reads as nothing", async () => {
    expect(await followLog(`${configDir()}/${LOG_PATH}`)).toBeNull();
  });
});

// demeter's server answering the query on 2026-11-07, unclaimed, so with no name: state 1 (idle),
// net CL 517554, four sub-states
const DEMETER_ANSWER = "d5f6010115cd5b070000000001b2e50700000000000000000004000300010100030100020100000001";
const DEMETER_COOKIE = 123456789n;

function answer(cookie: bigint, name: string): Buffer {
  const head = Buffer.from(DEMETER_ANSWER.slice(0, -6), "hex");
  head.writeBigUInt64LE(cookie, 4);
  const text = Buffer.from(name, "utf8");
  const length = Buffer.alloc(2);
  length.writeUInt16LE(text.length);
  return Buffer.concat([head, length, text, Buffer.from([1])]);
}

describe("the UDP query", () => {
  test("reads an unclaimed server's answer as no name", () => {
    expect(queryAnswerName(Buffer.from(DEMETER_ANSWER, "hex"), DEMETER_COOKIE)).toBeNull();
  });

  test("reads the server's name", () => {
    expect(queryAnswerName(answer(7n, "HexOS Factory"), 7n)).toBe("HexOS Factory");
  });

  test("ignores an answer to another request, or one too short to be one", () => {
    expect(queryAnswerName(answer(7n, "HexOS Factory"), 8n)).toBeUndefined();
    expect(queryAnswerName(Buffer.from("d501", "hex"), 7n)).toBeUndefined();
    expect(queryAnswerName(answer(7n, "HexOS Factory").subarray(0, 30), 7n)).toBeUndefined();
  });

  const sockets: Socket[] = [];
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });
  /** A server answering the query with `name`, or never, on a port of its own. */
  function queryServer(name: string | null): Promise<number> {
    const socket = createSocket("udp4");
    sockets.push(socket);
    socket.on("message", (request, from) => {
      if (name === null || request.readUInt16LE(0) !== 0xf6d5) return;
      socket.send(answer(request.readBigUInt64LE(4), name), from.port, from.address);
    });
    return new Promise((resolve) => socket.bind(0, "127.0.0.1", () => resolve(socket.address().port)));
  }

  test("asks the server for its name", async () => {
    expect(await serverName("127.0.0.1", await queryServer("HexOS Factory"))).toBe("HexOS Factory");
  });

  test("a server that doesn't answer reads as no name", async () => {
    expect(await serverName("127.0.0.1", await queryServer(null), 200)).toBeNull();
  });

  describe("on the card", () => {
    const context = (dir: string | null, port: number): WidgetContext => ({
      appId: "satisfactory-server-hexos-test-no-such-app",
      host: "127.0.0.1",
      port,
      mounts: dir ? [{ hostPath: "/mnt/SSDs/Applications/satisfactory-server-2/config", containerPath: null, localPath: dir }] : [],
      log: () => {},
    });
    const withPort = (port: number) => COMMAND_LINE.replace("-Port=7779", `-Port=${port}`);

    test("one entry while anyone's on: the server's name, the players under it, over the artwork", async () => {
      const port = await queryServer("HexOS Factory");
      const dir = configDir([OPENED, withPort(port), ENTRY_MAP, login("Alex", ALEX), joined("Alex"), login("Sam", SAM), joined("Sam")]);
      const result = await run(context(dir, 1));
      expect(result.fields).toEqual({
        online: { type: "list", entries: [{ title: "HexOS Factory", subtitle: "Alex and Sam", image: ARTWORK }] },
        count: { type: "stat", label: "Players", value: "2/4" },
      });
    });

    test("the session's name comes first", async () => {
      const port = await queryServer("HexOS Factory");
      const dir = configDir([OPENED, withPort(port), sessionMap("Northern Forest"), login("Alex", ALEX), joined("Alex")]);
      const online = (await run(context(dir, 1))).fields?.online;
      expect(online?.type === "list" && online.entries[0].title).toBe("Northern Forest");
    });

    test("a server with no name is Satisfactory", async () => {
      const port = await queryServer(null);
      const dir = configDir([OPENED, withPort(port), ENTRY_MAP, login("Alex", ALEX), joined("Alex")]);
      const online = (await run(context(dir, 1))).fields?.online;
      expect(online?.type === "list" && online.entries[0].title).toBe("Satisfactory");
    });

    test("nobody on folds the card back", async () => {
      const dir = configDir([...STARTED, login("Alex", ALEX), joined("Alex"), closed(ALEX)]);
      expect((await run(context(dir, 1))).fields).toEqual({
        online: { type: "list", entries: [] },
        count: { type: "stat", label: "Players", value: "0/4" },
      });
    });

    test("a log it can't read keeps the plain card rather than failing it", async () => {
      expect((await run(context(null, 1))).fields).toEqual({
        online: { type: "list", entries: [] },
        count: { type: "stat", label: "Players", value: "0/4" },
      });
    });
  });
});

describe("the container's copy of the log", () => {
  test("is taken only while Docker says it's small enough", () => {
    const stat = (size: number) => Buffer.from(JSON.stringify({ name: "FactoryGame.log", size, mode: 420 })).toString("base64");
    expect(archiveSize(stat(69_161))).toBe(69_161);
    expect(archiveSize(null)).toBe(Number.POSITIVE_INFINITY);
    expect(archiveSize("not base64 json")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("the card's artwork", () => {
  test("is a WebP within the platform's cap on an image field", () => {
    expect(ARTWORK.startsWith("data:image/webp;base64,")).toBe(true);
    expect(ARTWORK.length).toBeLessThanOrEqual(60_000);
  });
});
