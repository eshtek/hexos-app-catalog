import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as embyLibraries from "../emby/add_library";
import * as jellyfinLibraries from "../jellyfin/add_library";
import * as plexLibraries from "../plex/add_library";
import type { HookContext } from "./hook_context";

// The second step of Jellyfin's, Emby's and Plex's Connect to Sportarr: after the Sports library,
// the link adds the media server to Sportarr, so Sportarr tells it of each file it imports or
// renames. Sportarr is a fake that keeps its connections as the real one does
// (RootFolderAndNotificationEndpoints.cs and NotificationService.cs, read at 4.1.12.1122): a flat
// record whose settings are a JSON string, a list that shows a key as it is, a save that tests
// nothing, and a test that answers 400 with Sportarr's own message. Its test reaches Jellyfin with
// the key in Authorization, Emby with X-MediaBrowser-Token under /emby, and Plex with the token in
// the address. The media servers are fakes too: each answers its public id without a sign-in, and
// Jellyfin and Emby list and make API keys for an administrator.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "media-server-sportarr-"));
});

const BOX = "10.0.0.5";
const OLD_BOX = "10.0.0.30";
const ELSEWHERE = "10.0.0.80";
const ADMIN = "administrator-token";
const OWNER_PLEX_TOKEN = "plex-account-token";
const SPORTARR_URL = `http://${BOX}:1867`;
const SPORTARR_KEY = "sportarr-api-key";

type ServerId = "jellyfin" | "emby" | "plex";

const SERVERS = {
  jellyfin: { name: "Jellyfin", port: 30013, prefix: "", run: jellyfinLibraries.sportarr },
  emby: { name: "Emby", port: 9096, prefix: "/emby", run: embyLibraries.sportarr },
  plex: { name: "Plex", port: 32400, prefix: "", run: plexLibraries.sportarr },
} as const;

/** The events the link turns on: the ones Sportarr names a folder for. */
const EVENTS = { onDownload: true, onUpgrade: true, onRename: true };

interface Connection {
  id?: number;
  name: string;
  implementation: string;
  enabled?: boolean;
  tags?: number[];
  configJson: string;
  [field: string]: unknown;
}

/** A media server somewhere on the network, as Sportarr's test and a caller with no sign-in find it. */
interface MediaServer {
  kind: string;
  id: string;
  /** The keys or tokens it takes. */
  takes: string[];
}

class Skipped extends Error {}

interface Options {
  /** Sportarr's connections before the run. */
  connections?: Connection[];
  /** Media servers at other addresses, by `host:port`. */
  others?: Record<string, MediaServer>;
  /** Another `host:port` this server answers at too. */
  alias?: string;
  /** The server has no Sports library yet. */
  noLibrary?: boolean;
  /** The media server doesn't mount the Media location. */
  noMedia?: boolean;
  /** Where the media server mounts the Media location, when not at /media. */
  mediaAt?: string;
  /** API keys this Jellyfin or Emby already made. */
  keys?: Array<{ AppName: string; AccessToken: string; DateCreated: string }>;
  /** Sportarr isn't answering. */
  sportarrDown?: boolean;
  /** Sportarr's test fails with these words, whatever it is sent. */
  testSays?: (settings: Record<string, unknown>) => string;
  /** Sportarr answers a save and keeps nothing of it. */
  forgets?: boolean;
  /** This server answers, but not with its public id. */
  noIdentity?: boolean;
  /** The other link of the same script, for a media server that has one. */
  chaptarr?: boolean;
}

const settingsOf = (entry: Connection) => JSON.parse(entry.configJson) as Record<string, unknown>;

/** A connection Sportarr already has, as it keeps it. */
function connection(serverId: ServerId, name: string, settings: Record<string, unknown>, rest: Partial<Connection> = {}): Connection {
  return {
    name,
    implementation: SERVERS[serverId].name,
    enabled: true,
    tags: [],
    configJson: JSON.stringify({ updateLibrary: true, usePartialScan: true, ...EVENTS, ...settings }),
    created: "2026-11-01T00:00:00Z",
    ...rest,
  };
}

function fakes(serverId: ServerId, options: Options = {}) {
  const server = SERVERS[serverId];
  const serverUrl = `http://${BOX}:${server.port}`;
  const keys = structuredClone(options.keys ?? []);
  const self: MediaServer = {
    kind: server.name,
    id: `this-${serverId}`,
    takes: serverId === "plex" ? [OWNER_PLEX_TOKEN] : [ADMIN, ...keys.map((key) => key.AccessToken)],
  };
  const network: Record<string, MediaServer> = {
    ...options.others,
    [`${BOX}:${server.port}`]: self,
    ...(options.alias ? { [options.alias]: self } : {}),
  };

  let nextId = 1;
  let connections: Connection[] = structuredClone(options.connections ?? []).map((each) => ({ ...each, id: nextId++ }));
  const libraries: string[] = options.noLibrary ? [] : ["/media/sports"];
  const requests: string[] = [];
  const tests: Connection[] = [];
  const serverRequests: Array<{ method: string; path: string; headers: Headers }> = [];
  const steps: Array<{ id: string; message?: string; skipped?: boolean }> = [];
  const logs: string[] = [];

  /** Sportarr's own test of a connection, by what answers at its address: undefined when it passes. */
  const refusal = (entry: Connection): string | undefined => {
    tests.push(entry);
    const settings = settingsOf(entry);
    if (options.testSays) return options.testSays(settings);
    if (!settings.host) return `${entry.implementation} host URL not configured`;
    if (!settings.apiKey) return `${entry.implementation} API key not configured`;
    let reached: MediaServer | undefined;
    try {
      reached = network[new URL(String(settings.host)).host];
    } catch {}
    if (!reached) return "Connection error: Connection refused";
    if (reached.kind !== entry.implementation) return "Connection failed: NotFound";
    if (!reached.takes.includes(String(settings.apiKey))) {
      return entry.implementation === "Plex" ? "Authentication failed - check your Plex token" : "Authentication failed - check your API key";
    }
    return undefined;
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    if (url.origin === SPORTARR_URL) {
      if (options.sportarrDown) throw new TypeError("fetch failed");
      if (url.pathname === "/ping") return new Response("Pong");
      if (headers.get("X-Api-Key") !== SPORTARR_KEY) return new Response(null, { status: 401 });
      requests.push(`${method} ${url.pathname}`);
      const body = init?.body ? (JSON.parse(String(init.body)) as Connection) : undefined;
      if (url.pathname === "/api/notification" && method === "GET") return Response.json(connections);
      if (url.pathname === "/api/notification/test" && method === "POST" && body) {
        const refused = refusal(body);
        return refused ? Response.json({ success: false, message: refused }, { status: 400 }) : Response.json({ success: true, message: "Connected" });
      }
      // A save tests nothing, and an update takes the name, the kind, whether it's on, the settings and the tags
      if (url.pathname === "/api/notification" && method === "POST" && body) {
        const made = { ...body, id: nextId++ };
        if (!options.forgets) connections = [...connections, made];
        return Response.json(made, { status: 201 });
      }
      const one = url.pathname.match(/^\/api\/notification\/(\d+)$/);
      if (one && method === "PUT" && body) {
        const held = connections.find((each) => each.id === Number(one[1]));
        if (!held) return new Response(null, { status: 404 });
        const next = { ...held, name: body.name, implementation: body.implementation, enabled: body.enabled, configJson: body.configJson, tags: body.tags };
        if (!options.forgets) connections = connections.map((each) => (each === held ? next : each));
        return Response.json(next);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }

    // A media server, by what answers at the address
    const reached = url.protocol === "http:" ? network[url.host] : undefined;
    if (!reached) throw new TypeError("fetch failed");
    const path = url.pathname;
    if (url.origin === serverUrl) serverRequests.push({ method, path: path + url.search, headers });
    const hidesId = options.noIdentity && reached === self;
    if (hidesId && /\/identity$|\/System\/Info\/Public$/.test(path)) return new Response(null, { status: 404 });
    if (reached.kind === "Plex" && path === "/identity") return Response.json({ MediaContainer: { machineIdentifier: reached.id } });
    if (reached.kind === "Jellyfin" && path === "/System/Info/Public") return Response.json({ Id: reached.id });
    if (reached.kind === "Emby" && path === "/emby/System/Info/Public") return Response.json({ Id: reached.id });
    if (url.origin !== serverUrl) return new Response(null, { status: 404 });
    if (serverId === "plex") {
      if (url.searchParams.get("X-Plex-Token") !== OWNER_PLEX_TOKEN) return new Response(null, { status: 401 });
      if (path === "/library/sections" && method === "GET") {
        return Response.json({ MediaContainer: { Directory: libraries.map((folder) => ({ Location: [{ path: folder }] })) } });
      }
      if (path === "/library/sections" && method === "POST") {
        libraries.push(url.searchParams.get("location") ?? "");
        return new Response(null, { status: 201 });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }
    // Jellyfin 12 takes a token in Authorization alone; Emby takes X-Emby-Token
    const token =
      serverId === "jellyfin" ? headers.get("Authorization")?.match(/^MediaBrowser Token="([^"]+)"$/)?.[1] : (headers.get("X-Emby-Token") ?? undefined);
    if (!token || !self.takes.includes(token)) return new Response(null, { status: 401 });
    const at = path.slice(server.prefix.length);
    if (at === "/System/Configuration") return Response.json({});
    if (at === "/Library/VirtualFolders" && method === "GET") return Response.json(libraries.map((folder) => ({ Locations: [folder] })));
    if (at === "/Library/VirtualFolders" && method === "POST") {
      libraries.push(url.searchParams.get("paths") ?? url.searchParams.get("Paths") ?? "");
      return new Response(null, { status: 204 });
    }
    if (at === "/Auth/Keys" && method === "GET") return Response.json({ Items: keys });
    if (at === "/Auth/Keys" && method === "POST") {
      const name = url.searchParams.get(serverId === "jellyfin" ? "app" : "App");
      if (!name) return new Response(null, { status: 400 });
      const made = { AppName: name, AccessToken: `${serverId}-key-for-${name}-${keys.length + 1}`, DateCreated: `2026-11-12T00:00:0${keys.length}Z` };
      keys.push(made);
      self.takes.push(made.AccessToken);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as typeof fetch;

  // The settings each app keeps on the pool, in a box of this run's own
  const box = mkdtempSync(join(root, "box-"));
  const serverConfig = join(box, serverId, "config");
  mkdirSync(join(serverConfig, "data"), { recursive: true });
  if (serverId === "jellyfin") {
    const db = new Database(join(serverConfig, "data/jellyfin.db"));
    db.run("CREATE TABLE ApiKeys (AccessToken TEXT, DateCreated TEXT)");
    db.run(`INSERT INTO ApiKeys VALUES ('${ADMIN}', '2026-01-01')`);
    db.close();
  } else if (serverId === "emby") {
    const db = new Database(join(serverConfig, "data/authentication.db"));
    db.run("CREATE TABLE Tokens_2 (AccessToken TEXT, DeviceId INT, UserId TEXT, IsActive INT, DateLastActivityInt INT)");
    db.run(`INSERT INTO Tokens_2 VALUES ('${ADMIN}', 1, '', 1, 1)`);
    db.close();
  } else {
    const prefs = join(serverConfig, "Library/Application Support/Plex Media Server");
    mkdirSync(prefs, { recursive: true });
    writeFileSync(join(prefs, "Preferences.xml"), `<?xml version="1.0"?><Preferences PlexOnlineToken="${OWNER_PLEX_TOKEN}" />`);
  }
  const sportarrConfig = join(box, "sportarr", "config");
  mkdirSync(sportarrConfig, { recursive: true });
  writeFileSync(join(sportarrConfig, "config.xml"), `<Config><ApiKey>${SPORTARR_KEY}</ApiKey></Config>`);

  const ctx = {
    resourceId: serverId,
    catalogAppId: serverId,
    baseUrl: serverUrl,
    mounts: [
      { containerPath: "/config", hostPath: `/mnt/tank/apps/${serverId}/config`, localPath: serverConfig },
      // The folder isn't on this box's disk, so the link has nothing to check the server sees inside it
      ...(options.noMedia ? [] : [{ containerPath: options.mediaAt ?? "/media", hostPath: "/mnt/tank/Media", localPath: join(root, "media") }]),
    ],
    getInstalledAppUrl: async (app: string) => (app === "sportarr" ? SPORTARR_URL : null),
    getInstalledAppMounts: async (app: string) =>
      app === "sportarr"
        ? [
            { containerPath: null, hostPath: "/mnt/tank/apps/sportarr/config", localPath: sportarrConfig },
            { containerPath: "/downloads", hostPath: "/mnt/tank/Downloads", localPath: join(root, "downloads") },
            { containerPath: "/media/sports", hostPath: "/mnt/tank/Media/sports", localPath: join(root, "media/sports") },
          ]
        : [],
    registerCheckpoints: async () => {},
    emitCheckpoint: async (id: string, message?: string) => {
      steps.push({ id, message });
    },
    skipCheckpoint: async (id: string, message?: string) => {
      steps.push({ id, message, skipped: true });
    },
    updateCheckpointMessage: async () => {},
    sleep: async () => {},
    log: (message: string) => {
      logs.push(message);
    },
    skip: (message: string) => {
      throw new Skipped(message);
    },
    fail: (message: string, context?: Array<{ label: string; value: string }>) => {
      throw new Error([message, ...(context ?? []).map((each) => `${each.label}: ${each.value}`)].join(" | "));
    },
  } as unknown as HookContext;

  return {
    ctx,
    run: () => (options.chaptarr && serverId !== "plex" ? (serverId === "jellyfin" ? jellyfinLibraries : embyLibraries).chaptarr(ctx) : server.run(ctx)),
    connections: () => connections,
    start: structuredClone(connections),
    libraries,
    keys,
    requests,
    /** What changed something in Sportarr: every request but a list and a test. */
    writes: () => requests.filter((each) => !each.startsWith("GET ") && each !== "POST /api/notification/test"),
    tests,
    serverRequests,
    steps,
    step: (id: string) => steps.find((each) => each.id === id),
    /** Everything the run put into words: steps and logs. */
    words: () => JSON.stringify([steps, logs]),
  };
}

describe.each(["jellyfin", "emby", "plex"] as const)("%s", (serverId) => {
  const server = SERVERS[serverId];
  const here = `http://${BOX}:${server.port}`;
  /** A credential this server takes that the link didn't make. */
  const owners = serverId === "plex" ? OWNER_PLEX_TOKEN : ADMIN;
  const made = serverId === "plex" ? OWNER_PLEX_TOKEN : `${serverId}-key-for-Sportarr-1`;

  test("a first run adds the Sports library, then one connection in Sportarr that its own test passed, with imports and renames on and nothing else", async () => {
    const world = fakes(serverId, { noLibrary: true });
    await world.run();
    expect(world.libraries).toEqual(["/media/sports"]);
    expect(world.connections()).toHaveLength(1);
    const [added] = world.connections();
    expect(added).toMatchObject({ name: server.name, implementation: server.name, enabled: true, tags: [] });
    // The whole record: no path mapping where both apps see the folder at /media/sports, and no other event
    expect(settingsOf(added)).toEqual({ host: here, apiKey: made, updateLibrary: true, usePartialScan: true, onDownload: true, onUpgrade: true, onRename: true });
    expect(world.requests).toEqual(["GET /api/notification", "POST /api/notification/test", "POST /api/notification", "GET /api/notification"]);
    expect(world.keys.map((key) => key.AppName)).toEqual(serverId === "plex" ? [] : ["Sportarr"]);
    expect(world.steps.map((each) => each.id)).toEqual([serverId === "plex" ? "sports" : "/media/sports", "sportarr"]);
  });

  test("a second run leaves one connection, makes no key and writes nothing", async () => {
    const first = fakes(serverId, { noLibrary: true });
    await first.run();
    const second = fakes(serverId, { connections: first.connections(), keys: first.keys });
    await second.run();
    expect(second.writes()).toEqual([]);
    expect(second.connections()).toEqual(second.start);
    expect(second.connections()).toHaveLength(1);
    expect(second.libraries).toEqual(["/media/sports"]);
    expect(second.keys).toEqual(first.keys);
    expect(second.step("sportarr")).toEqual({ id: "sportarr", message: `Sportarr already tells ${server.name} what it adds`, skipped: true });
  });

  test("a server that can't give its own id still finds its connection by its address, and takes no other for its own", async () => {
    const own = connection(serverId, "Living room", { host: here, apiKey: owners });
    const elsewhere = connection(serverId, "Basement", { host: `http://${OLD_BOX}:${server.port}`, apiKey: "another-servers-key" });
    const world = fakes(serverId, { connections: [elsewhere, own], noIdentity: true });
    await world.run();
    expect(world.writes()).toEqual([]);
    expect(world.connections()).toEqual(world.start);
  });

  test("a connection the owner made is kept as it is: its name, its events and its other choices", async () => {
    const own = connection(serverId, "Living room", { host: here, apiKey: owners, onRename: false, onGrab: true, usePartialScan: false, pathMapFrom: "/a", pathMapTo: "/b" });
    const world = fakes(serverId, { connections: [own] });
    await world.run();
    expect(world.writes()).toEqual([]);
    expect(world.connections()).toEqual(world.start);
    expect(world.keys).toEqual([]);
  });

  test("a connection that reaches this server by another name is the owner's, and no second one is added", async () => {
    const byName = connection(serverId, server.name, { host: `http://nas.home.arpa:${server.port}/`, apiKey: owners });
    const world = fakes(serverId, { connections: [byName], alias: `nas.home.arpa:${server.port}` });
    await world.run();
    expect(world.writes()).toEqual([]);
    expect(world.connections()).toEqual(world.start);
    expect(world.step("sportarr")?.message).toBe(`Sportarr already tells ${server.name} what it adds`);
  });

  test.each([
    ["its library updates turned off", { updateLibrary: false }, {}],
    ["no import or rename event on", { onDownload: false, onUpgrade: false, onRename: false, onGrab: true }, {}],
    ["the connection itself turned off", {}, { enabled: false }],
  ])("a connection with %s stays as it is, and the step says so", async (_, settings, rest) => {
    const off = connection(serverId, server.name, { host: here, apiKey: owners, ...settings }, rest);
    const world = fakes(serverId, { connections: [off] });
    await world.run();
    expect(world.connections()).toEqual(world.start);
    expect(world.step("sportarr")).toEqual({
      id: "sportarr",
      message: `Sportarr already has ${server.name}, with its library updates turned off. Turn them on in Sportarr's Settings, under Notifications.`,
      skipped: true,
    });
  });

  test("a connection to another server is left alone, and this server's is added beside it", async () => {
    const theirs = connection(serverId, "Basement", { host: `http://${ELSEWHERE}:8096`, apiKey: "another-servers-key" });
    const another = { kind: server.name, id: "another-server", takes: ["another-servers-key"] };
    const world = fakes(serverId, { connections: [theirs], others: { [`${ELSEWHERE}:8096`]: another } });
    await world.run();
    expect(world.connections()).toHaveLength(2);
    expect(world.connections()[0]).toEqual(world.start[0]);
    expect(settingsOf(world.connections()[1])).toMatchObject({ host: here, apiKey: made });
    // The other server's key is never tried against this one
    expect(world.tests.filter((sent) => settingsOf(sent).apiKey === "another-servers-key")).toEqual([]);
  });

  test("a connection of another kind at this server's address is not this server's, and this server's is added beside it", async () => {
    const other = serverId === "plex" ? "jellyfin" : "plex";
    const wrong = connection(other, "Wrong port", { host: here, apiKey: "theirs" });
    const world = fakes(serverId, { connections: [wrong] });
    await world.run();
    expect(world.connections()).toHaveLength(2);
    expect(world.connections()[0]).toEqual(world.start[0]);
    expect(world.tests.filter((sent) => sent.name === "Wrong port")).toEqual([]);
  });

  test("a connection whose credential this server no longer takes gets the one it takes now, in place", async () => {
    const stale = connection(serverId, "My server", { host: here, apiKey: "a-key-from-before", onRename: false, onGrab: true });
    const world = fakes(serverId, { connections: [stale] });
    await world.run();
    expect(world.connections()).toHaveLength(1);
    const [now] = world.connections();
    expect(now).toMatchObject({ id: 1, name: "My server", created: "2026-11-01T00:00:00Z" });
    expect(settingsOf(now)).toEqual({ ...settingsOf(stale), apiKey: made });
    expect(world.writes()).toEqual(["PUT /api/notification/1"]);
    expect(world.step("sportarr")?.message).toBe(`Sportarr reaches ${server.name} again`);
  });

  test("a server that answers Sportarr with something other than a refused credential fails the step, and its connection keeps its credential", async () => {
    const own = connection(serverId, server.name, { host: here, apiKey: owners });
    const world = fakes(serverId, { connections: [own], testSays: () => "Connection failed: ServiceUnavailable" });
    await expect(world.run()).rejects.toThrow(`Sportarr couldn't reach ${server.name} | Reason: Connection failed: ServiceUnavailable`);
    expect(world.writes()).toEqual([]);
    expect(world.connections()).toEqual(world.start);
    expect(world.keys).toEqual([]);
  });

  test("a connection Sportarr's own test refuses is never saved, and the reason carries no key or token", async () => {
    const world = fakes(serverId, { testSays: (sent) => `Connection error: ${sent.apiKey} refused as sent with ${SPORTARR_KEY}` });
    const error = (await world.run().catch((caught: unknown) => caught)) as Error;
    expect(error.message).toBe(`Sportarr couldn't connect to ${server.name} | Reason: Connection error: ******** refused as sent with ********`);
    expect(world.writes()).toEqual([]);
    expect(world.connections()).toEqual([]);
  });

  test("a Sportarr that answers the save and keeps no connection fails the step", async () => {
    const world = fakes(serverId, { forgets: true });
    await expect(world.run()).rejects.toThrow(`Sportarr saved ${server.name}, but HexOS couldn't find it there. Run this again.`);
  });

  test("a Sportarr that isn't answering fails the step after the library is added, and a run again picks up there", async () => {
    const world = fakes(serverId, { noLibrary: true, sportarrDown: true });
    await expect(world.run()).rejects.toThrow("Sportarr isn't answering yet. Try again once it has started.");
    expect(world.libraries).toEqual(["/media/sports"]);
    expect(world.connections()).toEqual([]);
    expect(world.keys).toEqual([]);
  });

  test("a server that doesn't mount Media gets no library and no connection, and no key is made", async () => {
    const world = fakes(serverId, { noLibrary: true, noMedia: true });
    await world.run();
    expect(world.libraries).toEqual([]);
    expect(world.requests).toEqual([]);
    expect(world.connections()).toEqual([]);
    expect(world.keys).toEqual([]);
    expect(world.step("sportarr")).toEqual({
      id: "sportarr",
      message: `${server.name} can't see Sportarr's Sports folder, so Sportarr has nothing to tell it about`,
      skipped: true,
    });
  });

  // Sportarr maps the path of the file itself before it names it (ApplyPathMapping), for Plex as for
  // the others, so no server is told of a folder it doesn't have. Sportarr runs as one copy, so no
  // later copy keeps its files a folder down.
  test("a server that sees Media at another path gets a connection that maps Sportarr's folder to it", async () => {
    const world = fakes(serverId, { mediaAt: "/data/media" });
    await world.run();
    expect(settingsOf(world.connections()[0])).toMatchObject({ host: here, pathMapFrom: "/media/sports", pathMapTo: "/data/media/sports" });
  });

  test("no step, log or failure carries a key or a token", async () => {
    const world = fakes(serverId, { noLibrary: true });
    await world.run();
    for (const secret of [made, ADMIN, OWNER_PLEX_TOKEN, SPORTARR_KEY]) expect(world.words()).not.toContain(secret);
  });
});

describe.each(["jellyfin", "emby"] as const)("%s keys", (serverId) => {
  const server = SERVERS[serverId];
  const here = `http://${BOX}:${server.port}`;

  test("a key already named Sportarr is used, and none is made", async () => {
    const keys = [
      { AppName: "Sportarr", AccessToken: "an-older-sportarr-key", DateCreated: "2026-01-01T00:00:00Z" },
      { AppName: "Sportarr", AccessToken: "the-newest-sportarr-key", DateCreated: "2026-06-01T00:00:00Z" },
      { AppName: "Radarr", AccessToken: "radarrs-key", DateCreated: "2026-07-01T00:00:00Z" },
    ];
    const world = fakes(serverId, { keys });
    await world.run();
    expect(settingsOf(world.connections()[0]).apiKey).toBe("the-newest-sportarr-key");
    expect(world.keys).toEqual(keys);
    expect(world.serverRequests.filter((request) => request.method === "POST")).toEqual([]);
  });

  test("a connection at the box's old address moves here when its saved key is this server's, with no new key", async () => {
    const before = connection(serverId, "My server", { host: `http://${OLD_BOX}:${server.port}`, apiKey: ADMIN, onRename: false });
    const world = fakes(serverId, { connections: [before] });
    await world.run();
    expect(world.connections()).toHaveLength(1);
    const [now] = world.connections();
    expect(now).toMatchObject({ id: 1, name: "My server" });
    expect(settingsOf(now)).toEqual({ ...settingsOf(before), host: here });
    expect(world.keys).toEqual([]);
    expect(world.step("sportarr")?.message).toBe(`Sportarr reaches ${server.name} at its new address`);
  });

  test("a connection at an address nothing answers at, with a key this server never made, is left alone, and this server's is added beside it", async () => {
    const theirs = connection(serverId, "Cabin", { host: `http://${OLD_BOX}:${server.port}`, apiKey: "a-key-this-server-never-made" });
    const world = fakes(serverId, { connections: [theirs] });
    await world.run();
    expect(world.connections()).toHaveLength(2);
    expect(world.connections()[0]).toEqual(world.start[0]);
    expect(settingsOf(world.connections()[1])).toMatchObject({ host: here, apiKey: `${serverId}-key-for-Sportarr-1` });
  });

  test("Connect to Chaptarr asks nothing of Sportarr", async () => {
    const world = fakes(serverId, { chaptarr: true });
    await world.run();
    expect(world.requests).toEqual([]);
    expect(world.connections()).toEqual([]);
    expect(world.step("sportarr")).toBeUndefined();
  });
});

test("Jellyfin is sent its administrator's token in Authorization alone, which is all Jellyfin 12 takes", async () => {
  const world = fakes("jellyfin");
  await world.run();
  const signedIn = world.serverRequests.filter((request) => request.path.startsWith("/Auth/Keys"));
  expect(signedIn.map((request) => `${request.method} ${request.path}`)).toEqual(["GET /Auth/Keys", "POST /Auth/Keys?app=Sportarr", "GET /Auth/Keys"]);
  for (const request of signedIn) {
    expect(request.headers.get("Authorization")).toBe(`MediaBrowser Token="${ADMIN}"`);
    for (const legacy of ["X-Emby-Token", "X-MediaBrowser-Token", "X-Emby-Authorization"]) expect(request.headers.has(legacy)).toBe(false);
  }
});

test("Emby makes Sportarr's key under /emby, with its administrator's token in X-Emby-Token", async () => {
  const world = fakes("emby");
  await world.run();
  const signedIn = world.serverRequests.filter((request) => request.path.startsWith("/emby/Auth/Keys"));
  expect(signedIn.map((request) => `${request.method} ${request.path}`)).toEqual(["GET /emby/Auth/Keys", "POST /emby/Auth/Keys?App=Sportarr", "GET /emby/Auth/Keys"]);
  for (const request of signedIn) expect(request.headers.get("X-Emby-Token")).toBe(ADMIN);
});

test("Plex's connection at an address nothing answers at is never moved: the owner's token opens every server of theirs, so this Plex's is added beside it", async () => {
  const theirs = connection("plex", "Cabin", { host: `http://${OLD_BOX}:32400`, apiKey: OWNER_PLEX_TOKEN });
  const world = fakes("plex", { connections: [theirs] });
  await world.run();
  expect(world.connections()).toHaveLength(2);
  expect(world.connections()[0]).toEqual(world.start[0]);
  expect(settingsOf(world.connections()[1])).toMatchObject({ host: `http://${BOX}:32400`, apiKey: OWNER_PLEX_TOKEN });
});

test("a Plex nobody signed in to is skipped before Sportarr is asked for anything", async () => {
  const world = fakes("plex");
  writeFileSync(
    join((world.ctx.mounts[0] as { localPath: string }).localPath, "Library/Application Support/Plex Media Server/Preferences.xml"),
    `<?xml version="1.0"?><Preferences />`,
  );
  const error = await world.run().catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Skipped);
  expect(world.requests).toEqual([]);
});
