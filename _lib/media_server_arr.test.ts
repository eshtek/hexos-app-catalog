import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookContext } from "./hook_context";
import { lidarr, radarr, sonarr } from "../servarr/connect_media_server";

// Jellyfin's, Emby's and Plex's links to Radarr and Sonarr, and Plex's to Lidarr, against a fake
// manager that keeps its connections as the real ones do (ProviderControllerBase, SchemaBuilder,
// MediaBrowser and PlexServer, read at Radarr 6.4.4, Sonarr 5.0.0 and Lidarr 3.2.1.5196, whose API
// is at /api/v1): a credential it holds reads as ********, an
// entry sent with ******** keeps the one it holds, a name is unique whatever its case, and a
// connection with an event on is tested before it is saved, where a refused credential is blamed
// on its own field. The media servers are fakes too: each answers its public id without a sign-in,
// Jellyfin and Emby list and make API keys for an administrator, and Jellyfin takes a token only
// in Authorization (12 turns away the older headers).

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const BOX = "10.0.0.5";
const OLD_BOX = "10.0.0.30";
const ELSEWHERE = "10.0.0.80";
const ADMIN = "administrator-token";
const OWNER_PLEX_TOKEN = "plex-account-token";

type ServerId = "jellyfin" | "emby" | "plex";
type ManagerId = "radarr" | "sonarr" | "lidarr";

const SERVERS = {
  jellyfin: { name: "Jellyfin", port: 30013, kind: "MediaBrowser", secret: "apiKey", prefix: "" },
  emby: { name: "Emby", port: 9096, kind: "MediaBrowser", secret: "apiKey", prefix: "/emby" },
  plex: { name: "Plex", port: 32400, kind: "PlexServer", secret: "authToken", prefix: "" },
} as const;

const COPIES: Record<string, { manager: ManagerId; port: number; key: string; displayName: string; folder: string }> = {
  radarr: { manager: "radarr", port: 30025, key: "radarr-api-key", displayName: "Radarr", folder: "/mnt/tank/Movies" },
  "radarr-2": { manager: "radarr", port: 30125, key: "radarr-2-api-key", displayName: "Radarr 2", folder: "/mnt/tank/Movies/radarr-2" },
  sonarr: { manager: "sonarr", port: 30113, key: "sonarr-api-key", displayName: "Sonarr", folder: "/mnt/tank/Shows" },
  lidarr: { manager: "lidarr", port: 30071, key: "lidarr-api-key", displayName: "Lidarr", folder: "/mnt/tank/Music" },
  "lidarr-2": { manager: "lidarr", port: 30171, key: "lidarr-2-api-key", displayName: "Lidarr 2", folder: "/mnt/tank/Music/lidarr-2" },
};

/** What each manager's API is under, its library's path in both apps, and Plex's name for that kind of library. */
const MANAGERS = {
  radarr: { api: "/api/v3", library: "/movies", plex: "movie", plexName: "Movie", run: radarr },
  sonarr: { api: "/api/v3", library: "/shows", plex: "show", plexName: "TV", run: sonarr },
  lidarr: { api: "/api/v1", library: "/music", plex: "artist", plexName: "Music", run: lidarr },
} as const;

const EVENTS = {
  radarr: ["onDownload", "onUpgrade", "onRename", "onMovieDelete", "onMovieFileDelete", "onMovieFileDeleteForUpgrade"],
  sonarr: ["onDownload", "onUpgrade", "onImportComplete", "onRename", "onSeriesAdd", "onSeriesDelete", "onEpisodeFileDelete", "onEpisodeFileDeleteForUpgrade"],
  lidarr: ["onReleaseImport", "onUpgrade", "onRename", "onArtistAdd", "onArtistDelete", "onAlbumDelete", "onTrackRetag"],
};
/** Events a connection has that say nothing about the library: never turned on. */
const OTHER_EVENTS = ["onGrab", "onHealthIssue", "onHealthRestored", "onApplicationUpdate", "onManualInteractionRequired"];

interface Field {
  name: string;
  value?: unknown;
}

interface Connection {
  id?: number;
  name: string;
  implementation: string;
  fields: Field[];
  [key: string]: unknown;
}

/** A media server somewhere on the network, as the manager's test and a caller with no sign-in find it. */
interface MediaServer {
  kind: "MediaBrowser" | "PlexServer";
  id: string;
  /** The credentials it takes: an administrator's, and the API keys it made. */
  takes: string[];
  /** Plex's libraries, by type. */
  libraries?: string[];
}

class Skipped extends Error {}

interface Options {
  manager?: ManagerId;
  copy?: string;
  /** The manager's connections before the run. */
  connections?: Connection[];
  /** Media servers at other addresses, by `host:port`. */
  others?: Record<string, MediaServer>;
  /** Another `host:port` this server answers at too. */
  alias?: string;
  /** This server answers nothing. */
  down?: boolean;
  /** The server's own settings hold no administrator's key or sign-in. */
  noCredential?: boolean;
  /** API keys this Jellyfin or Emby already made, by the app each is named for. */
  keys?: Array<{ AppName: string; AccessToken: string; DateCreated: string }>;
  libraries?: string[];
  /** The media server's mounts leave the manager's library out. */
  serverSeesLibrary?: boolean;
  /** What the owner answers when asked to switch a connection; unanswered when absent. */
  switches?: boolean;
  /** The manager's schema, changed for a manager that offers less. */
  schema?: (templates: Connection[]) => Connection[];
  /** The manager's test fails with these words, whatever it is sent. */
  testSays?: (connection: Connection) => string;
  /** The manager answers a save and keeps nothing of it. */
  forgets?: boolean;
  /** This server answers, but not with its public id. */
  noIdentity?: boolean;
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "media-server-arr-"));
});

const field = (connection: Connection, name: string) => connection.fields.find((each) => each.name === name)?.value;

/** The manager's schema entry for a connection, as its `/notification/schema` gives it. */
function template(manager: ManagerId, kind: "MediaBrowser" | "PlexServer" | "Webhook"): Connection {
  const events = [...EVENTS[manager], ...OTHER_EVENTS];
  // Plex's connection takes no grab, health or update events (PlexServer.cs)
  const supported = kind === "PlexServer" ? EVENTS[manager] : events.filter((event) => event !== "onManualInteractionRequired");
  const fields: Field[] =
    kind === "MediaBrowser"
      ? [
          { name: "host", value: "" },
          { name: "port", value: 8096 },
          { name: "useSsl", value: false },
          { name: "urlBase", value: "" },
          { name: "apiKey", value: "" },
          { name: "notify", value: false },
          { name: "updateLibrary", value: true },
          // Lidarr's Emby / Jellyfin connection maps no path (MediaBrowserSettings.cs)
          ...(manager === "lidarr" ? [] : [{ name: "mapFrom", value: "" }, { name: "mapTo", value: "" }]),
        ]
      : kind === "PlexServer"
        ? [
            { name: "server" },
            { name: "host", value: "" },
            { name: "port", value: 32400 },
            { name: "useSsl", value: false },
            { name: "urlBase", value: "" },
            { name: "authToken", value: "" },
            { name: "signIn", value: "startOAuth" },
            { name: "updateLibrary", value: true },
            { name: "mapFrom", value: "" },
            { name: "mapTo", value: "" },
          ]
        : [{ name: "url", value: "" }];
  return {
    name: "",
    implementation: kind,
    configContract: `${kind}Settings`,
    tags: [],
    ...Object.fromEntries(events.map((event) => [event, false])),
    ...Object.fromEntries(events.map((event) => [`supportsOn${event.slice(2)}`, supported.includes(event)])),
    fields,
  };
}

/** A connection the manager already has, as it keeps it: the credential as it is. */
function connection(manager: ManagerId, kind: "MediaBrowser" | "PlexServer", name: string, values: Record<string, unknown>, rest: Record<string, unknown> = {}): Connection {
  const base = template(manager, kind);
  return {
    ...base,
    ...Object.fromEntries(EVENTS[manager].map((event) => [event, true])),
    ...rest,
    name,
    fields: base.fields.map((each) => (each.name in values ? { ...each, value: values[each.name] } : each)),
  };
}

function fakes(serverId: ServerId, options: Options = {}) {
  const server = SERVERS[serverId];
  const managerId = options.manager ?? "radarr";
  const copy = options.copy ?? managerId;
  const target = COPIES[copy];
  const serverUrl = `http://${BOX}:${server.port}`;
  const managerUrl = `http://${BOX}:${target.port}`;
  const keys = structuredClone(options.keys ?? []);
  const self: MediaServer = {
    kind: server.kind,
    id: `this-${serverId}`,
    takes: serverId === "plex" ? [OWNER_PLEX_TOKEN] : [ADMIN, ...keys.map((key) => key.AccessToken)],
    libraries: options.libraries ?? ["movie", "show", "artist"],
  };
  const network: Record<string, MediaServer> = {
    ...options.others,
    ...(options.down ? {} : { [`${BOX}:${server.port}`]: self, ...(options.alias ? { [options.alias]: self } : {}) }),
  };

  let nextId = 1;
  let connections: Connection[] = structuredClone(options.connections ?? []).map((each) => ({ ...each, id: nextId++ }));
  const writes: string[] = [];
  const requests: string[] = [];
  const tests: Connection[] = [];
  const serverRequests: Array<{ method: string; path: string; headers: Headers }> = [];
  const steps: Array<{ id: string; message?: string; skipped?: boolean }> = [];
  const logs: string[] = [];
  let asked = 0;

  const secretOf = (entry: Connection) => (entry.implementation === "PlexServer" ? "authToken" : "apiKey");
  const masked = (entry: Connection): Connection => ({
    ...entry,
    fields: entry.fields.map((each) => (each.name === secretOf(entry) && each.value ? { ...each, value: "********" } : each)),
  });
  /** What a request stores: a credential sent as ******** is the one the manager holds. */
  const merged = (sent: Connection): Connection => {
    const held = connections.find((each) => each.id === sent.id);
    return {
      ...sent,
      fields: sent.fields.map((each) => (each.name === secretOf(sent) && each.value === "********" && held ? { ...each, value: field(held, each.name) } : each)),
    };
  };
  const enabled = (entry: Connection) => [...EVENTS[managerId], ...OTHER_EVENTS].some((event) => entry[event] === true);
  /** The manager's own test of a connection, by what answers at its address. */
  const refusal = (entry: Connection): Array<{ propertyName: string; errorMessage: string }> | undefined => {
    tests.push(entry);
    if (options.testSays) return [{ propertyName: "Host", errorMessage: options.testSays(entry) }];
    if (entry.implementation === "Webhook") return undefined;
    const reached = field(entry, "useSsl") === true ? undefined : network[`${field(entry, "host")}:${field(entry, "port")}`];
    if (!reached || reached.kind !== entry.implementation) return [{ propertyName: "Host", errorMessage: "Unable to send test message: Connection refused" }];
    const secret = secretOf(entry);
    if (!reached.takes.includes(String(field(entry, secret)))) {
      return [{ propertyName: secret === "apiKey" ? "ApiKey" : "AuthToken", errorMessage: secret === "apiKey" ? "API Key is invalid" : "Authentication Token is invalid" }];
    }
    if (reached.kind === "PlexServer" && !reached.libraries?.includes(MANAGERS[managerId].plex)) {
      return [{ propertyName: "Host", errorMessage: `At least one ${MANAGERS[managerId].plexName} library is required` }];
    }
    return undefined;
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    if (url.origin === managerUrl) {
      if (url.pathname === "/ping") return Response.json({ status: "OK" });
      if (headers.get("X-Api-Key") !== target.key) return new Response(null, { status: 401 });
      // Each manager answers under its own API version, and nothing under another's
      if (!url.pathname.startsWith(`${MANAGERS[managerId].api}/`)) return new Response(null, { status: 404 });
      requests.push(`${method} ${url.pathname}`);
      const at = url.pathname.slice(MANAGERS[managerId].api.length);
      const body = init?.body ? (JSON.parse(String(init.body)) as Connection) : undefined;
      if (at === "/notification" && method === "GET") return Response.json(connections.map(masked));
      if (at === "/notification/schema") {
        const templates = [template(managerId, "Webhook"), template(managerId, "MediaBrowser"), template(managerId, "PlexServer")];
        return Response.json(options.schema ? options.schema(templates) : templates);
      }
      if (at === "/notification/test" && method === "POST" && body) {
        const refused = refusal(merged(body));
        return refused ? Response.json(refused, { status: 400 }) : Response.json({});
      }
      const one = at.match(/^\/notification\/(\d+)$/);
      if ((at === "/notification" && method === "POST" && body) || (one && method === "PUT" && body)) {
        const id = one ? Number(one[1]) : undefined;
        writes.push(`${method} ${at}`);
        const held = connections.find((each) => each.id === id);
        if (one && !held) return new Response(null, { status: 404 });
        const next = merged({ ...body, id });
        if (connections.some((each) => each.id !== id && each.name.toLowerCase() === next.name.toLowerCase())) {
          return Response.json([{ propertyName: "Name", errorMessage: "Should be unique" }], { status: 400 });
        }
        // An enabled connection is tested when it's made, and when a change to it is saved, unless the caller forces it
        if (url.searchParams.get("forceSave") !== "true" && enabled(next) && (!held || JSON.stringify(held) !== JSON.stringify(next))) {
          const refused = refusal(next);
          if (refused) return Response.json(refused, { status: 400 });
        }
        if (options.forgets) return Response.json(masked({ ...next, id: id ?? nextId }), { status: one ? 202 : 201 });
        if (held) connections = connections.map((each) => (each.id === id ? next : each));
        else connections = [...connections, { ...next, id: nextId++ }];
        return Response.json(masked(connections.find((each) => each.id === (id ?? nextId - 1)) as Connection), { status: one ? 202 : 201 });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }

    // A media server, by what answers at the address
    const reached = url.protocol === "http:" ? network[url.host] : undefined;
    if (!reached) throw new TypeError("fetch failed");
    const path = url.pathname;
    if (url.origin === serverUrl) serverRequests.push({ method, path: path + url.search, headers });
    const hidesId = options.noIdentity && reached === self;
    if (reached.kind === "PlexServer" && path === "/identity" && !hidesId) return Response.json({ MediaContainer: { machineIdentifier: reached.id } });
    if (reached.kind === "MediaBrowser" && path === "/System/Info/Public" && !hidesId) return Response.json({ Id: reached.id });
    // Anything else asked of a server that is up gets an answer, which is all "is anything there" needs
    if (url.origin !== serverUrl || reached.kind === "PlexServer") return new Response(null, { status: 404 });
    // Jellyfin 12 takes a token in Authorization alone; Emby takes X-Emby-Token
    const token =
      serverId === "jellyfin" ? headers.get("Authorization")?.match(/^MediaBrowser Token="([^"]+)"$/)?.[1] : (headers.get("X-Emby-Token") ?? undefined);
    if (!token || !self.takes.includes(token)) return new Response(null, { status: 401 });
    if (path === `${server.prefix}/System/Configuration`) return Response.json({});
    if (path === `${server.prefix}/Auth/Keys` && method === "GET") return Response.json({ Items: keys });
    if (path === `${server.prefix}/Auth/Keys` && method === "POST") {
      const name = url.searchParams.get(serverId === "jellyfin" ? "app" : "App");
      if (!name) return new Response(null, { status: 400 });
      const made = { AppName: name, AccessToken: `${serverId}-key-for-${name}-${keys.length + 1}`, DateCreated: `2026-11-11T00:00:0${keys.length}Z` };
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
    if (!options.noCredential) db.run(`INSERT INTO ApiKeys VALUES ('${ADMIN}', '2026-01-01')`);
    db.close();
  } else if (serverId === "emby") {
    const db = new Database(join(serverConfig, "data/authentication.db"));
    db.run("CREATE TABLE Tokens_2 (AccessToken TEXT, DeviceId INT, UserId TEXT, IsActive INT, DateLastActivityInt INT)");
    if (!options.noCredential) db.run(`INSERT INTO Tokens_2 VALUES ('${ADMIN}', 1, '', 1, 1)`);
    db.close();
  } else {
    const prefs = join(serverConfig, "Library/Application Support/Plex Media Server");
    mkdirSync(prefs, { recursive: true });
    writeFileSync(join(prefs, "Preferences.xml"), `<?xml version="1.0"?><Preferences ${options.noCredential ? "" : `PlexOnlineToken="${OWNER_PLEX_TOKEN}"`} />`);
  }
  const managerConfig = join(box, copy, "config");
  mkdirSync(managerConfig, { recursive: true });
  writeFileSync(join(managerConfig, "config.xml"), `<Config><ApiKey>${target.key}</ApiKey></Config>`);
  const library = MANAGERS[managerId].library;

  const ctx = {
    resourceId: serverId,
    catalogAppId: serverId,
    baseUrl: serverUrl,
    mounts: [
      { containerPath: "/config", hostPath: `/mnt/tank/apps/${serverId}/config`, localPath: serverConfig },
      { containerPath: "/media", hostPath: "/mnt/tank/Media", localPath: join(root, "media") },
      ...(options.serverSeesLibrary === false
        ? []
        : [
            { containerPath: "/movies", hostPath: "/mnt/tank/Movies", localPath: join(root, "movies") },
            { containerPath: "/shows", hostPath: "/mnt/tank/Shows", localPath: join(root, "shows") },
            { containerPath: "/music", hostPath: "/mnt/tank/Music", localPath: join(root, "music") },
          ]),
    ],
    linkedApp: (app: string) => (app === managerId ? { name: copy, displayName: target.displayName } : null),
    getInstalledAppUrl: async (app: string) => (app === managerId ? managerUrl : null),
    getInstalledAppMounts: async (app: string) =>
      app === managerId
        ? [
            { containerPath: "/config", hostPath: `/mnt/tank/apps/${copy}/config`, localPath: managerConfig },
            { containerPath: "/downloads", hostPath: "/mnt/tank/Downloads", localPath: join(root, "downloads") },
            { containerPath: library, hostPath: target.folder, localPath: join(root, "library") },
          ]
        : [],
    askForInputs: async () => {
      asked++;
      if (options.switches === undefined) throw Object.assign(new Error("skipped"), { name: "HookInputsUnanswered" });
      return { switch: options.switches };
    },
    registerCheckpoints: async () => {},
    emitCheckpoint: async (id: string, message?: string) => {
      steps.push({ id, message });
    },
    skipCheckpoint: async (id: string, message?: string) => {
      steps.push({ id, message, skipped: true });
    },
    sleep: async () => {},
    log: (message: string) => {
      logs.push(message);
    },
    skip: (message: string, context?: Array<{ label: string; value: string }>) => {
      throw new Skipped([message, ...(context ?? []).map((each) => `${each.label}: ${each.value}`)].join(" | "));
    },
    fail: (message: string, context?: Array<{ label: string; value: string }>) => {
      throw new Error([message, ...(context ?? []).map((each) => `${each.label}: ${each.value}`)].join(" | "));
    },
  } as unknown as HookContext;

  return {
    ctx,
    run: () => MANAGERS[managerId].run(ctx),
    connections: () => connections,
    start: structuredClone(connections),
    keys,
    writes,
    requests,
    tests,
    serverRequests,
    steps,
    step: (id: string) => steps.find((each) => each.id === id),
    logs,
    asked: () => asked,
    /** Everything the run put into words: steps and logs. */
    words: () => JSON.stringify([steps, logs]),
  };
}

/** The values a connection holds, by field, with its credential as the manager keeps it. */
const values = (entry: Connection) => Object.fromEntries(entry.fields.map((each) => [each.name, each.value]));
const eventsOn = (entry: Connection) => Object.keys(entry).filter((key) => key.startsWith("on") && entry[key] === true);

describe.each(["jellyfin", "emby", "plex"] as const)("%s", (serverId) => {
  const server = SERVERS[serverId];
  const here = { host: BOX, port: server.port };

  for (const managerId of ["radarr", "sonarr"] as const) {
    const manager = COPIES[managerId].displayName;

    test(`a ${manager} with no connection gets one to this server, with the library events on and nothing else`, async () => {
      const world = fakes(serverId, { manager: managerId });
      await world.run();
      expect(world.connections()).toHaveLength(1);
      const [made] = world.connections();
      expect(made).toMatchObject({ name: server.name, implementation: server.kind });
      const credential = serverId === "plex" ? OWNER_PLEX_TOKEN : `${serverId}-key-for-${manager}-1`;
      expect(values(made)).toMatchObject({ ...here, useSsl: false, urlBase: "", [server.secret]: credential, updateLibrary: true, mapFrom: "", mapTo: "" });
      if (serverId !== "plex") expect(values(made).notify).toBe(false);
      expect(eventsOn(made).sort()).toEqual([...EVENTS[managerId]].sort());
      // The manager's own test passed it, and one key was made, named for the manager
      expect(world.tests).toHaveLength(1);
      expect(world.keys.map((key) => key.AppName)).toEqual(serverId === "plex" ? [] : [manager]);
      expect(world.steps).toEqual([
        { id: "locate", message: undefined },
        { id: "key", message: undefined },
        { id: "connect", message: undefined },
      ]);
    });
  }

  test("a second run adds nothing, makes no key and writes nothing", async () => {
    const first = fakes(serverId);
    await first.run();
    const second = fakes(serverId, { connections: first.connections(), keys: first.keys });
    await second.run();
    expect(second.writes).toEqual([]);
    expect(second.connections()).toEqual(second.start);
    expect(second.keys).toEqual(first.keys);
    expect(second.step("key")).toEqual({ id: "key", message: `Radarr's connection to ${server.name} works as it is`, skipped: true });
    expect(second.step("connect")).toEqual({ id: "connect", message: `Radarr already tells ${server.name} what it changes`, skipped: true });
  });

  test("a connection the owner made or changed is kept as it is: its name, its events and its other choices", async () => {
    const credential = serverId === "plex" ? OWNER_PLEX_TOKEN : ADMIN;
    const own = connection("radarr", server.kind, "Living room", { ...here, [server.secret]: credential, mapFrom: "/movies", mapTo: "/data/movies" }, {
      onRename: false,
      onGrab: true,
    });
    const world = fakes(serverId, { connections: [own] });
    await world.run();
    expect(world.writes).toEqual([]);
    expect(world.connections()).toEqual(world.start);
    expect(world.keys).toEqual([]);
  });

  test("a connection that reaches this server by another name is the owner's, and no second one is added", async () => {
    const credential = serverId === "plex" ? OWNER_PLEX_TOKEN : ADMIN;
    const byName = connection("radarr", server.kind, server.name, { host: "nas.home.arpa", port: server.port, [server.secret]: credential });
    const world = fakes(serverId, { connections: [byName], alias: `nas.home.arpa:${server.port}` });
    await world.run();
    expect(world.writes).toEqual([]);
    expect(world.connections()).toEqual(world.start);
    expect(world.step("connect")?.message).toBe(`Radarr already tells ${server.name} what it changes`);
  });

  test("a connection with its library updates turned off stays off, and the step says so", async () => {
    const credential = serverId === "plex" ? OWNER_PLEX_TOKEN : ADMIN;
    const off = connection("radarr", server.kind, server.name, { ...here, [server.secret]: credential, updateLibrary: false });
    const world = fakes(serverId, { connections: [off] });
    await world.run();
    expect(world.connections()).toEqual(world.start);
    expect(world.step("connect")).toEqual({
      id: "connect",
      message: `Radarr already has ${server.name}, with its library updates turned off. Turn them on in Radarr's Settings, under Connect.`,
      skipped: true,
    });
  });

  test("a connection to another server is left alone, and this server's is added beside it", async () => {
    const theirs = connection("radarr", server.kind, "Basement", { host: ELSEWHERE, port: 8096, [server.secret]: "another-servers-key" });
    const another = { kind: server.kind, id: "another-server", takes: ["another-servers-key"], libraries: ["movie", "show"] };
    const world = fakes(serverId, { connections: [theirs], others: { [`${ELSEWHERE}:8096`]: another } });
    await world.run();
    expect(world.connections()).toHaveLength(2);
    expect(world.connections()[0]).toEqual(world.start[0]);
    expect(values(world.connections()[1])).toMatchObject(here);
    // The other server's key is never tried against this one
    expect(world.tests.filter((sent) => field(sent, server.secret) === "another-servers-key")).toEqual([]);
  });

  test("a connection under this server's name that reaches another server stops the step, and nothing is changed", async () => {
    const theirs = connection("radarr", server.kind, server.name.toUpperCase(), { host: ELSEWHERE, port: 8096, [server.secret]: "another-servers-key" });
    const another = { kind: server.kind, id: "another-server", takes: ["another-servers-key"], libraries: ["movie", "show"] };
    const world = fakes(serverId, { connections: [theirs], others: { [`${ELSEWHERE}:8096`]: another } });
    const error = await world.run().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Skipped);
    expect((error as Error).message).toBe(
      `Radarr already has a connection named ${server.name.toUpperCase()}, at ${ELSEWHERE}:8096. Rename that one in Radarr's Settings, under Connect, then run this again. | Radarr's ${server.name.toUpperCase()}: ${ELSEWHERE}:8096 | This ${server.name}: ${BOX}:${server.port}`,
    );
    expect(world.writes).toEqual([]);
    expect(world.connections()).toEqual(world.start);
    expect(world.asked()).toBe(0);
    expect(world.keys).toEqual([]);
  });

  test("a connection of another kind under this server's name stops the step too", async () => {
    const hook = { ...template("radarr", "Webhook"), name: server.name, onDownload: true, fields: [{ name: "url", value: "http://example.invalid/hook" }] };
    const world = fakes(serverId, { connections: [hook] });
    const error = await world.run().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Skipped);
    expect((error as Error).message).toBe(`Radarr already has a connection named ${server.name}. Rename that one in Radarr's Settings, under Connect, then run this again.`);
    expect(world.connections()).toEqual(world.start);
  });

  test("a connection of another media server's kind under this server's name is never switched, even where nothing answers", async () => {
    const otherKind = server.kind === "PlexServer" ? "MediaBrowser" : "PlexServer";
    const theirs = connection("radarr", otherKind, server.name, { host: OLD_BOX, port: server.port, [otherKind === "PlexServer" ? "authToken" : "apiKey"]: "theirs" });
    const world = fakes(serverId, { connections: [theirs], switches: true });
    const error = await world.run().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Skipped);
    expect(world.asked()).toBe(0);
    expect(world.connections()).toEqual(world.start);
  });

  for (const answer of [true, false, undefined]) {
    const said = answer === undefined ? "doesn't answer" : answer ? "says yes" : "says no";
    test(`a connection under this server's name at an address nothing answers at: the owner is asked, and ${said}`, async () => {
      // A key this server never made (it was reinstalled), or Plex's account token, which proves no server
      const credential = serverId === "plex" ? OWNER_PLEX_TOKEN : "a-key-from-before";
      const stale = connection("radarr", server.kind, server.name, { host: OLD_BOX, port: server.port, [server.secret]: credential }, { onRename: false });
      const world = fakes(serverId, { connections: [stale], switches: answer });
      const error = await world.run().catch((caught: unknown) => caught);
      expect(world.asked()).toBe(1);
      if (answer) {
        expect(error).toBeUndefined();
        expect(world.connections()).toHaveLength(1);
        const [now] = world.connections();
        expect(values(now)).toMatchObject({ ...here, [server.secret]: serverId === "plex" ? OWNER_PLEX_TOKEN : `${serverId}-key-for-Radarr-1` });
        // Its other choices are still the owner's
        expect(now).toMatchObject({ id: 1, name: server.name, onRename: false, onDownload: true });
        expect(world.step("connect")?.message).toBe(`Radarr reaches ${server.name} at its new address`);
      } else {
        expect(error).toBeInstanceOf(Skipped);
        expect(world.connections()).toEqual(world.start);
        expect(world.keys).toEqual([]);
      }
    });
  }

  test("a server that isn't answering fails the step, and a connection to it keeps its credential", async () => {
    const credential = serverId === "plex" ? OWNER_PLEX_TOKEN : ADMIN;
    const own = connection("radarr", server.kind, server.name, { ...here, [server.secret]: credential });
    const world = fakes(serverId, { connections: [own], down: true });
    await expect(world.run()).rejects.toThrow(`Radarr couldn't reach ${server.name} | Reason: Unable to send test message: Connection refused`);
    expect(world.writes).toEqual([]);
    expect(world.connections()).toEqual(world.start);
  });

  test("a server whose settings hold no credential adds nothing", async () => {
    const world = fakes(serverId, { noCredential: true });
    const error = (await world.run().catch((caught: unknown) => caught)) as Error;
    if (serverId === "plex") {
      expect(error).toBeInstanceOf(Skipped);
      expect(error.message).toBe("Plex has no sign-in yet. Open Plex in HexOS and run Pre-configure Plex, then run this again.");
    } else {
      expect(error).not.toBeInstanceOf(Skipped);
      expect(error.message).toBe(
        `HexOS couldn't find ${serverId === "emby" ? "an Emby" : "a Jellyfin"} administrator's key. Open ${server.name} in HexOS and run Pre-configure ${server.name}, then try again.`,
      );
    }
    expect(world.connections()).toEqual([]);
  });

  test("a connection of another kind at this server's address is not this server's, and this server's is added beside it", async () => {
    // A connection the owner pointed at the wrong port, say: the manager's own test would refuse it
    const otherKind = server.kind === "PlexServer" ? "MediaBrowser" : "PlexServer";
    const wrong = connection("radarr", otherKind, "Wrong port", { ...here, [otherKind === "PlexServer" ? "authToken" : "apiKey"]: "theirs" });
    const world = fakes(serverId, { connections: [wrong] });
    await world.run();
    expect(world.connections()).toHaveLength(2);
    expect(world.connections()[0]).toEqual(world.start[0]);
    expect(world.connections()[1]).toMatchObject({ name: server.name, implementation: server.kind });
    expect(world.tests.filter((sent) => sent.name === "Wrong port")).toEqual([]);
  });

  test("a server that can't give its own id never takes a connection nothing answers at for its own", async () => {
    // With no id on either side there is nothing to compare, which is not a match
    const elsewhere = connection("radarr", server.kind, "Basement", { host: OLD_BOX, port: server.port, [server.secret]: "another-servers-key" });
    const world = fakes(serverId, { connections: [elsewhere], noIdentity: true });
    await world.run();
    expect(world.connections()).toHaveLength(2);
    expect(world.connections()[0]).toEqual(world.start[0]);
    expect(values(world.connections()[1])).toMatchObject(here);
  });

  test("a server that doesn't mount the manager's library has nothing to be told, and gets no connection or key", async () => {
    const world = fakes(serverId, { serverSeesLibrary: false });
    const error = await world.run().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Skipped);
    expect((error as Error).message).toBe(`${server.name} can't see Radarr's Movies folder, so Radarr has nothing to tell it about.`);
    expect(world.connections()).toEqual([]);
    expect(world.keys).toEqual([]);
  });

  test("a manager that doesn't offer the connection is skipped", async () => {
    const world = fakes(serverId, { schema: (templates) => templates.filter((each) => each.implementation !== server.kind) });
    const error = await world.run().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Skipped);
    expect((error as Error).message).toBe(`Radarr doesn't offer a connection to ${server.name}`);
    expect(world.connections()).toEqual([]);
  });

  test("an event the manager's connection doesn't take is left off", async () => {
    const world = fakes(serverId, {
      schema: (templates) => templates.map((each) => (each.implementation === server.kind ? { ...each, supportsOnMovieDelete: false } : each)),
    });
    await world.run();
    expect(eventsOn(world.connections()[0]).sort()).toEqual(EVENTS.radarr.filter((event) => event !== "onMovieDelete").sort());
  });

  test("a manager that refuses the connection fails the step with its own reason, never the credential", async () => {
    const world = fakes(serverId, { testSays: (sent) => `Unable to connect with ${field(sent, server.secret)} as sent with ${COPIES.radarr.key}` });
    const error = (await world.run().catch((caught: unknown) => caught)) as Error;
    expect(error.message).toBe(`Radarr couldn't connect to ${server.name} | Reason: Unable to connect with ******** as sent with ********`);
    expect(world.connections()).toEqual([]);
  });

  test("a manager that answers the save and keeps no connection fails the step", async () => {
    const world = fakes(serverId, { forgets: true });
    await expect(world.run()).rejects.toThrow(`Radarr saved ${server.name}, but HexOS couldn't find it there. Run this again.`);
  });

  test("no step, log or failure carries a key or a token", async () => {
    const world = fakes(serverId);
    await world.run();
    const credential = values(world.connections()[0])[server.secret] as string;
    for (const secret of [credential, ADMIN, OWNER_PLEX_TOKEN, COPIES.radarr.key]) expect(world.words()).not.toContain(secret);
  });
});

describe.each(["jellyfin", "emby"] as const)("%s keys", (serverId) => {
  const server = SERVERS[serverId];
  const here = { host: BOX, port: server.port };

  test("a later copy's connection maps its library to the folder the server sees it in, and its key is named for the copy", async () => {
    const world = fakes(serverId, { copy: "radarr-2" });
    await world.run();
    expect(values(world.connections()[0])).toMatchObject({ ...here, mapFrom: "/movies", mapTo: "/movies/radarr-2" });
    expect(world.keys.map((key) => key.AppName)).toEqual(["Radarr 2"]);
  });

  test("a connection to the other server of this kind on the same box, at its own port, is left alone, and this server's is added beside it", async () => {
    // Emby beside Jellyfin: the same kind of connection at the box's address, and a key this server never made
    const other = serverId === "jellyfin" ? SERVERS.emby : SERVERS.jellyfin;
    const theirs = connection("radarr", "MediaBrowser", other.name, { host: BOX, port: other.port, apiKey: "the-other-servers-key" });
    const another = { kind: "MediaBrowser" as const, id: "the-other-server", takes: ["the-other-servers-key"] };
    const world = fakes(serverId, { connections: [theirs], others: { [`${BOX}:${other.port}`]: another } });
    await world.run();
    expect(world.connections()).toHaveLength(2);
    expect(world.connections()[0]).toEqual(world.start[0]);
    expect(values(world.connections()[1])).toMatchObject({ ...here, apiKey: `${serverId}-key-for-Radarr-1` });
    // Its key is never tried against this server, and never replaced
    expect(world.tests.filter((sent) => field(sent, "apiKey") === "the-other-servers-key")).toEqual([]);
  });

  test("a key already named for the manager is used, and none is made", async () => {
    const keys = [
      { AppName: "Radarr", AccessToken: "an-older-radarr-key", DateCreated: "2026-01-01T00:00:00Z" },
      { AppName: "Radarr", AccessToken: "the-newest-radarr-key", DateCreated: "2026-06-01T00:00:00Z" },
      { AppName: "Seerr", AccessToken: "seerrs-key", DateCreated: "2026-07-01T00:00:00Z" },
    ];
    const world = fakes(serverId, { keys });
    await world.run();
    expect(values(world.connections()[0]).apiKey).toBe("the-newest-radarr-key");
    expect(world.keys).toEqual(keys);
    expect(world.serverRequests.filter((request) => request.method === "POST")).toEqual([]);
  });

  test("each copy gets a key of its own", async () => {
    const first = fakes(serverId);
    await first.run();
    const second = fakes(serverId, { copy: "radarr-2", keys: first.keys });
    await second.run();
    expect(second.keys.map((key) => key.AppName)).toEqual(["Radarr", "Radarr 2"]);
    expect(values(second.connections()[0]).apiKey).toBe(`${serverId}-key-for-Radarr 2-2`);
  });

  test("a connection whose key this server no longer takes (it was reinstalled) gets a new key, in place", async () => {
    const stale = connection("radarr", "MediaBrowser", "My server", { ...here, apiKey: "a-key-from-before", notify: true }, { onRename: false });
    const world = fakes(serverId, { connections: [stale] });
    await world.run();
    expect(world.connections()).toHaveLength(1);
    const [now] = world.connections();
    expect(now).toMatchObject({ id: 1, name: "My server", onRename: false });
    expect(values(now)).toMatchObject({ ...here, apiKey: `${serverId}-key-for-Radarr-1`, notify: true });
    expect(world.step("connect")?.message).toBe(`Radarr reaches ${server.name} again`);
  });

  test("a connection that reaches this server by another name gets a new key when its own is refused, and keeps its address", async () => {
    const byName = connection("radarr", "MediaBrowser", "My server", { host: "nas.home.arpa", port: server.port, apiKey: "a-key-the-owner-removed", urlBase: "" });
    const world = fakes(serverId, { connections: [byName], alias: `nas.home.arpa:${server.port}` });
    await world.run();
    expect(world.connections()).toHaveLength(1);
    expect(values(world.connections()[0])).toMatchObject({ host: "nas.home.arpa", port: server.port, apiKey: `${serverId}-key-for-Radarr-1` });
    expect(world.step("connect")?.message).toBe(`Radarr reaches ${server.name} again`);
  });

  test("a connection at the box's old address moves here when its saved key is this server's, with no new key", async () => {
    const before = connection("radarr", "MediaBrowser", "My server", { host: OLD_BOX, port: server.port, apiKey: ADMIN, urlBase: "/old" }, { onRename: false });
    const world = fakes(serverId, { connections: [before] });
    await world.run();
    expect(world.connections()).toHaveLength(1);
    const [now] = world.connections();
    expect(values(now)).toMatchObject({ ...here, urlBase: "", apiKey: ADMIN });
    expect(now).toMatchObject({ id: 1, name: "My server", onRename: false });
    expect(world.keys).toEqual([]);
    expect(world.asked()).toBe(0);
    expect(world.step("key")).toEqual({ id: "key", message: `Radarr already has a key ${server.name} takes`, skipped: true });
    expect(world.step("connect")?.message).toBe(`Radarr reaches ${server.name} at its new address`);
  });
});

test("Jellyfin is sent its administrator's token in Authorization alone, which is all Jellyfin 12 takes", async () => {
  const world = fakes("jellyfin");
  await world.run();
  const signedIn = world.serverRequests.filter((request) => request.path.startsWith("/Auth/Keys"));
  expect(signedIn.map((request) => `${request.method} ${request.path}`)).toEqual(["GET /Auth/Keys", "POST /Auth/Keys?app=Radarr", "GET /Auth/Keys"]);
  for (const request of signedIn) {
    expect(request.headers.get("Authorization")).toBe(`MediaBrowser Token="${ADMIN}"`);
    for (const legacy of ["X-Emby-Token", "X-MediaBrowser-Token", "X-Emby-Authorization"]) expect(request.headers.has(legacy)).toBe(false);
    expect(request.path).not.toContain("api_key");
  }
});

test("Plex's connection from the box's old address is never moved on a passing test alone: the owner's token opens every server of theirs", async () => {
  // Another Plex server of the same owner, switched on, under another name
  const theirs = connection("radarr", "PlexServer", "Cabin", { host: ELSEWHERE, port: 32400, authToken: OWNER_PLEX_TOKEN });
  const another = { kind: "PlexServer" as const, id: "the-cabin", takes: [OWNER_PLEX_TOKEN], libraries: ["movie", "show"] };
  const world = fakes("plex", { connections: [theirs], others: { [`${ELSEWHERE}:32400`]: another } });
  await world.run();
  expect(world.connections()).toHaveLength(2);
  expect(world.connections()[0]).toEqual(world.start[0]);
});

test("a later copy gets no connection to Plex, which would be told of folders it doesn't have, and the step says Plex finds them itself", async () => {
  // Plex's connection names a title's folder under Plex's own library folder, never under the mapped one
  const world = fakes("plex", { copy: "radarr-2" });
  const error = await world.run().catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Skipped);
  expect((error as Error).message).toBe(
    "Plex finds what Radarr 2 adds when it next scans its library. Radarr 2 can't tell Plex sooner, because the two see Radarr 2's Movies folder at different paths.",
  );
  expect(world.connections()).toEqual([]);
  expect(world.writes).toEqual([]);
  expect(world.tests).toEqual([]);
});

test("a Plex with no library of the manager's kind fails the step with the manager's reason", async () => {
  const world = fakes("plex", { manager: "sonarr", libraries: ["movie"] });
  await expect(world.run()).rejects.toThrow("Sonarr couldn't connect to Plex | Reason: At least one TV library is required");
  expect(world.connections()).toEqual([]);
});

describe("Lidarr", () => {
  const here = { host: BOX, port: SERVERS.plex.port };

  test("a Lidarr with no connection gets one to Plex through its own API version, with the library events on and nothing else", async () => {
    const world = fakes("plex", { manager: "lidarr" });
    await world.run();
    expect(world.connections()).toHaveLength(1);
    const [made] = world.connections();
    expect(made).toMatchObject({ name: "Plex", implementation: "PlexServer" });
    expect(values(made)).toMatchObject({ ...here, useSsl: false, urlBase: "", authToken: OWNER_PLEX_TOKEN, updateLibrary: true, mapFrom: "", mapTo: "" });
    expect(eventsOn(made).sort()).toEqual([...EVENTS.lidarr].sort());
    expect(world.requests).toEqual(["GET /api/v1/notification", "GET /api/v1/notification/schema", "POST /api/v1/notification", "GET /api/v1/notification"]);
    expect(world.tests).toHaveLength(1);
    expect(world.steps).toEqual([
      { id: "locate", message: undefined },
      { id: "key", message: undefined },
      { id: "connect", message: undefined },
    ]);
  });

  test("a second run leaves the one connection, and writes nothing", async () => {
    const first = fakes("plex", { manager: "lidarr" });
    await first.run();
    const second = fakes("plex", { manager: "lidarr", connections: first.connections() });
    await second.run();
    expect(second.writes).toEqual([]);
    expect(second.connections()).toEqual(second.start);
    expect(second.step("connect")).toEqual({ id: "connect", message: "Lidarr already tells Plex what it changes", skipped: true });
  });

  test("a connection the owner made is kept as it is, and no second one is added", async () => {
    const own = connection("lidarr", "PlexServer", "Living room", { ...here, authToken: OWNER_PLEX_TOKEN }, { onRename: false, onGrab: true });
    const world = fakes("plex", { manager: "lidarr", connections: [own] });
    await world.run();
    expect(world.writes).toEqual([]);
    expect(world.connections()).toEqual(world.start);
  });

  test("a connection to another Plex server is left alone, and this server's is added beside it", async () => {
    const theirs = connection("lidarr", "PlexServer", "Cabin", { host: ELSEWHERE, port: 32400, authToken: OWNER_PLEX_TOKEN });
    const another = { kind: "PlexServer" as const, id: "the-cabin", takes: [OWNER_PLEX_TOKEN], libraries: ["artist"] };
    const world = fakes("plex", { manager: "lidarr", connections: [theirs], others: { [`${ELSEWHERE}:32400`]: another } });
    await world.run();
    expect(world.connections()).toHaveLength(2);
    expect(world.connections()[0]).toEqual(world.start[0]);
    expect(values(world.connections()[1])).toMatchObject(here);
  });

  test("a later copy gets no connection to Plex, which would be told of folders it doesn't have", async () => {
    const world = fakes("plex", { manager: "lidarr", copy: "lidarr-2" });
    const error = await world.run().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Skipped);
    expect((error as Error).message).toBe(
      "Plex finds what Lidarr 2 adds when it next scans its library. Lidarr 2 can't tell Plex sooner, because the two see Lidarr 2's Music folder at different paths.",
    );
    expect(world.connections()).toEqual([]);
    expect(world.requests).toEqual([]);
  });

  test("a Plex with no Music library fails the step with Lidarr's reason", async () => {
    const world = fakes("plex", { manager: "lidarr", libraries: ["movie", "show"] });
    await expect(world.run()).rejects.toThrow("Lidarr couldn't connect to Plex | Reason: At least one Music library is required");
    expect(world.connections()).toEqual([]);
  });

  test("a Plex that doesn't mount Music has nothing to be told", async () => {
    const world = fakes("plex", { manager: "lidarr", serverSeesLibrary: false });
    const error = await world.run().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Skipped);
    expect((error as Error).message).toBe("Plex can't see Lidarr's Music folder, so Lidarr has nothing to tell it about.");
    expect(world.connections()).toEqual([]);
  });

  // Lidarr 3.2.1.5196 names no real folder to Jellyfin or Emby (MediaBrowserService.cs, line 38), so
  // its connection there would be kept and update nothing
  test.each(["jellyfin", "emby"] as const)("%s gets no connection from Lidarr, and neither app is asked for anything", async (serverId) => {
    const world = fakes(serverId, { manager: "lidarr" });
    const error = await world.run().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Skipped);
    expect((error as Error).message).toBe(
      `${SERVERS[serverId].name} finds what Lidarr adds when it next scans its library. Lidarr can't tell ${SERVERS[serverId].name} sooner yet.`,
    );
    expect(world.connections()).toEqual([]);
    expect(world.requests).toEqual([]);
    expect(world.serverRequests).toEqual([]);
    expect(world.keys).toEqual([]);
  });
});
