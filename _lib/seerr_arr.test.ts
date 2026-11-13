import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookContext } from "./hook_context";
import { radarr, sonarr } from "../seerr/connect_arr";
import { type StarterProfile, starterProfile, withCutoff, withQuality } from "./starter_profiles.fixture";

// Seerr's link to Radarr, against fakes of Seerr's Radarr settings (read at Seerr 3.5.1) and two
// copies of Radarr on the box. Seerr's list gives each server's API key as it is, and saving a default
// takes it from any server of the same kind (4K or not). Run again after the box's address or Radarr's
// port changed, the link finds Seerr's entry by this Radarr's own key and moves it, so the entry stays
// Seerr's default. One it has to add beside another default says where Seerr sends requests.
//
// Once a manager has Profilarr's six profiles, the link also takes out the six the manager made at
// its first start, as Profilarr's link does (profilarr_links.test.ts has the rules), after moving a
// default that only Seerr keeps on one of them to Profilarr's everyday profile. The fake manager
// refuses a delete as the real one does, and knows nothing of Seerr.
//
// The fake manager carries the note HexOS leaves beside a new app's settings (hexos/fresh.json),
// unless a test takes it away: without it, or with the note of an app the owner already had
// (hexos/kept.json), no default moves and nothing is removed, whoever runs the link. The fake Seerr
// lists its requests as the real one does (routes/request.ts, read at 3.5.1): by status and by
// kind, a page at a time.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const BOX = "10.0.0.5";
const OLD_BOX = "10.0.0.30";
const SEERR = { url: `http://${BOX}:30357`, key: "seerr-key" };
const COPIES: Record<string, { port: number; key: string; displayName: string }> = {
  radarr: { port: 30025, key: "radarr-key", displayName: "Radarr" },
  "radarr-2": { port: 30125, key: "radarr-2-key", displayName: "Radarr 2" },
  sonarr: { port: 30113, key: "sonarr-key", displayName: "Sonarr" },
};

const STARTERS = ["Any", "SD", "HD-720p", "HD-1080p", "Ultra-HD", "HD - 720p/1080p"];
const HEXOS = ["1080p Balanced", "1080p Quality", "1080p Quality HDR", "2160p Balanced", "2160p Quality", "2160p Remux"];

type Profile = Partial<StarterProfile> & { id: number; name: string };

/** A manager's profiles after Profilarr's sync: its own six, untouched (ids 1 to 6), then Profilarr's (7 to 12). */
const synced = (managerId: "radarr" | "sonarr" = "radarr"): Profile[] => [
  ...STARTERS.map((name, at) => starterProfile(managerId, name, at + 1)),
  ...HEXOS.map((name, at) => ({
    ...starterProfile(managerId, "HD-1080p", at + 7),
    name,
    upgradeAllowed: true,
    minFormatScore: 20000,
    cutoffFormatScore: 400000,
    formatItems: [{ format: 1, name: "Not English", score: -999999 }],
  })),
];
const ID = Object.fromEntries([...STARTERS, ...HEXOS].map((name, at) => [name, at + 1])) as Record<string, number>;

interface Server {
  id: number;
  name: string;
  hostname: string;
  port: number;
  apiKey: string;
  is4k: boolean;
  isDefault: boolean;
  activeProfileId?: number;
  activeDirectory?: string;
  [field: string]: unknown;
}

interface Options {
  manager?: "radarr" | "sonarr";
  servers?: Server[];
  copy?: string;
  down?: "seerr" | "radarr";
  /** The manager's profiles: a manager Profilarr hasn't sent all six to, unless given. */
  profiles?: Profile[];
  /** What the manager lists at each path, or "down" for a list it won't give. */
  lists?: Record<string, unknown[] | "down">;
  /** The manager refuses to remove these, whatever uses them. */
  wontRemove?: string[];
  /** The manager answers a removal and keeps the profile. */
  ignoresRemoval?: boolean;
  /** Seerr's override rules, or "down" for a Seerr that won't list them. */
  rules?: unknown[] | "down";
  /** Seerr's requests, "down" for a Seerr that won't list them, or "short" for one that says there are more than it gives. */
  requests?: SeerrRequest[] | "down" | "short";
  keptApps?: string[];
  /** The notes HexOS left beside the manager's settings: one of a new app, unless given. */
  notes?: Array<"fresh" | "kept">;
  /** Seerr carries the note of an app the owner already had, from a collection run before this one. */
  seerrKept?: boolean;
  /** Seerr answers a save and keeps this profile id as the entry's default instead. */
  savesProfile?: number;
  /** Removing a profile also costs the manager this one of Profilarr's. */
  losesOnRemoval?: string;
}

/** A request in Seerr: its kind, its status (1 waiting, 2 approved, 3 declined, 4 failed, 5 completed), and what it names. */
interface SeerrRequest {
  type: "movie" | "tv";
  status: number;
  serverId?: number | null;
  profileId?: number | null;
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "seerr-arr-"));
});

function dir(name: string) {
  const path = join(root, name, "config");
  mkdirSync(path, { recursive: true });
  return path;
}

function fakes(options: Options = {}) {
  const managerId = options.manager ?? "radarr";
  const copy = options.copy ?? managerId;
  let servers = structuredClone(options.servers ?? []);
  let profiles = structuredClone(options.profiles ?? [{ id: 1, name: "Any" }, { id: 4, name: "1080p Balanced" }]);
  const lists: Record<string, unknown[] | "down"> = { "/movie": [], "/series": [], "/importlist": [], "/collection": [], "/autotagging": [], ...options.lists };
  const removals: string[] = [];
  const checkpoints: Array<{ id: string; message?: string; skipped?: boolean }> = [];
  // What the manager's own delete refuses over (QualityProfileService.Delete)
  const inUse = (id: number) =>
    [managerId === "radarr" ? "/movie" : "/series", "/importlist", ...(managerId === "radarr" ? ["/collection"] : [])].some((path) => {
      const rows = lists[path];
      return rows !== "down" && rows.some((row) => (row as { qualityProfileId?: number }).qualityProfileId === id);
    });
  // Seerr's own handling of isDefault (server/routes/settings/radarr.ts)
  const clearDefaults = (body: Server) => {
    if (body.isDefault) for (const server of servers.filter((each) => each.is4k === body.is4k)) server.isDefault = false;
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.origin === SEERR.url) {
      if (options.down === "seerr") throw new TypeError("fetch failed");
      if (url.pathname === "/api/v1/status") return Response.json({ version: "3.5.1" });
      if (url.pathname === "/api/v1/settings/public") return Response.json({ initialized: true });
      if (new Headers(init?.headers).get("X-Api-Key") !== SEERR.key) return new Response(null, { status: 403 });
      if (url.pathname === "/api/v1/overrideRule") {
        return options.rules === "down" ? Response.json({ message: "no" }, { status: 500 }) : Response.json(options.rules ?? []);
      }
      if (url.pathname === "/api/v1/request") {
        const all = options.requests ?? [];
        if (all === "down") return Response.json({ message: "no" }, { status: 500 });
        const statuses = { pending: [1], failed: [4] }[url.searchParams.get("filter") ?? ""] ?? [1, 2, 3, 4, 5];
        const kind = url.searchParams.get("mediaType") ?? "all";
        const matching = all === "short" ? [] : all.filter((each) => statuses.includes(each.status) && (kind === "all" || each.type === kind));
        const take = Number(url.searchParams.get("take") ?? 10);
        const skip = Number(url.searchParams.get("skip") ?? 0);
        return Response.json({
          pageInfo: { pages: Math.ceil(matching.length / take), pageSize: take, results: all === "short" ? 3 : matching.length, page: Math.ceil(skip / take) + 1 },
          results: matching.slice(skip, skip + take),
        });
      }
      if (url.pathname === `/api/v1/settings/${managerId}` && method === "GET") return Response.json(servers);
      if (body && options.savesProfile !== undefined) body.activeProfileId = options.savesProfile;
      if (url.pathname === `/api/v1/settings/${managerId}` && method === "POST") {
        clearDefaults(body);
        const created = { ...body, id: (servers.at(-1)?.id ?? -1) + 1 };
        servers = [...servers, created];
        return Response.json(created, { status: 201 });
      }
      const match = url.pathname.match(/^\/api\/v1\/settings\/(?:radarr|sonarr)\/(\d+)$/);
      if (match && method === "PUT") {
        const index = servers.findIndex((each) => each.id === Number(match[1]));
        if (index === -1) return Response.json({ message: "Settings instance not found" }, { status: 404 });
        clearDefaults(body);
        servers[index] = { ...body, id: Number(match[1]) };
        return Response.json(servers[index]);
      }
    }
    const target = Object.values(COPIES).find((each) => url.origin === `http://${BOX}:${each.port}`);
    if (target && options.down !== "radarr") {
      if (url.pathname === "/ping") return Response.json({ status: "OK" });
      if (new Headers(init?.headers).get("X-Api-Key") !== target.key) return new Response(null, { status: 401 });
      const at = url.pathname.slice("/api/v3".length);
      if (at === "/qualityprofile" && method === "GET") return Response.json(profiles);
      if (at === "/rootfolder") return Response.json([{ path: "/movies" }, { path: "/movies-kids" }]);
      if (at in lists && method === "GET") {
        const rows = lists[at];
        return rows === "down" ? Response.json({ message: "database is locked" }, { status: 500 }) : Response.json(rows);
      }
      const removal = at.match(/^\/qualityprofile\/(\d+)$/);
      if (removal && method === "DELETE") {
        const id = Number(removal[1]);
        const name = profiles.find((each) => each.id === id)?.name ?? String(id);
        removals.push(name);
        if (inUse(id) || options.wontRemove?.includes(name)) return Response.json({ message: `QualityProfile [${id}] is in use.` }, { status: 500 });
        if (!options.ignoresRemoval) profiles = profiles.filter((each) => each.id !== id && each.name !== options.losesOnRemoval);
        return Response.json({});
      }
    }
    if (target || url.hostname === OLD_BOX) throw new TypeError("fetch failed");
    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as typeof fetch;

  const seerrConfig = dir("seerr");
  writeFileSync(join(seerrConfig, "settings.json"), JSON.stringify({ main: { apiKey: SEERR.key } }));
  if (options.seerrKept) {
    mkdirSync(join(seerrConfig, "hexos"), { recursive: true });
    writeFileSync(join(seerrConfig, "hexos", "kept.json"), "{}");
  }
  const radarrConfig = dir(copy);
  writeFileSync(join(radarrConfig, "config.xml"), `<Config><ApiKey>${COPIES[copy].key}</ApiKey></Config>`);
  rmSync(join(radarrConfig, "hexos"), { recursive: true, force: true });
  mkdirSync(join(radarrConfig, "hexos"));
  for (const note of options.notes ?? ["fresh"]) writeFileSync(join(radarrConfig, "hexos", `${note}.json`), "{}");
  const ctx = {
    resourceId: "seerr",
    baseUrl: SEERR.url,
    mounts: [{ containerPath: "/app/config", hostPath: "/mnt/pool/apps/seerr/config", localPath: seerrConfig }],
    ...(options.keptApps ? { keptApps: options.keptApps } : {}),
    linkedApp: (app: string) => (app === managerId ? { name: copy, displayName: COPIES[copy].displayName } : null),
    getInstalledAppUrl: async (app: string) => (app === managerId ? `http://${BOX}:${COPIES[copy].port}` : null),
    getInstalledAppMounts: async () => [{ containerPath: "/config", hostPath: `/mnt/pool/apps/${copy}/config`, localPath: radarrConfig }],
    registerCheckpoints: async () => {},
    emitCheckpoint: async (id: string, message?: string) => {
      checkpoints.push({ id, message });
    },
    skipCheckpoint: async (id: string, message?: string) => {
      checkpoints.push({ id, message, skipped: true });
    },
    sleep: async () => {},
    log: () => {},
    fail: (message: string) => {
      throw new Error(message);
    },
  } as unknown as HookContext;
  return {
    ctx,
    servers: () => servers,
    checkpoints,
    names: () => profiles.map((each) => each.name),
    removals,
    step: (id: string) => checkpoints.find((each) => each.id === id),
    /** Whether Seerr carries HexOS's note of an app the owner already had. */
    seerrNotedKept: () => existsSync(join(seerrConfig, "hexos", "kept.json")),
  };
}

/** Seerr's entry for a copy, at the address it had then, with the owner's choices. */
function entry(copy: string, rest: Partial<Server> = {}): Server {
  return {
    id: 0,
    name: COPIES[copy].displayName,
    hostname: BOX,
    port: COPIES[copy].port,
    apiKey: COPIES[copy].key,
    useSsl: false,
    baseUrl: "",
    is4k: false,
    isDefault: true,
    activeProfileId: 1,
    activeProfileName: "Any",
    activeDirectory: "/movies-kids",
    ...rest,
  };
}

test("a Seerr with no Radarr gets this one as its default", async () => {
  const { ctx, servers, step } = fakes();
  await radarr(ctx);
  expect(servers()).toHaveLength(1);
  expect(servers()[0]).toMatchObject({ hostname: BOX, port: 30025, apiKey: "radarr-key", isDefault: true, activeProfileName: "1080p Balanced" });
  expect(step("configure")).toEqual({ id: "configure", message: undefined });
});

for (const [label, moved] of [
  ["the box's address changed", { hostname: OLD_BOX }],
  ["Radarr's port changed", { port: 30026 }],
] as const) {
  test(`Seerr's entry with this Radarr's own key moves here and stays the default, with the owner's choices (${label})`, async () => {
    const { ctx, servers, step } = fakes({ servers: [entry("radarr", moved)] });
    await radarr(ctx);
    expect(servers()).toEqual([{ ...entry("radarr"), id: 0 }]);
    expect(step("configure")).toEqual({ id: "configure", message: undefined });
  });
}

test("another copy's entry is never taken for this copy's, so the second copy joins beside it", async () => {
  const first = entry("radarr");
  const { ctx, servers, step } = fakes({ servers: [first], copy: "radarr-2" });
  await radarr(ctx);
  expect(servers()).toHaveLength(2);
  expect(servers()[0]).toEqual(first);
  expect(servers()[1]).toMatchObject({ id: 1, name: "Radarr 2", port: 30125, apiKey: "radarr-2-key", isDefault: false });
  expect(step("configure")?.message).toBe(`Seerr sends requests to Radarr at ${BOX}:30025 by default. Radarr 2 was added beside it.`);
});

test("a default Seerr can't tell is this Radarr (a reinstall, with a new key and address) is left as it is, and the step says where requests go", async () => {
  const gone = entry("radarr", { hostname: OLD_BOX, apiKey: "reinstalled" });
  const { ctx, servers, step } = fakes({ servers: [gone] });
  await radarr(ctx);
  expect(servers()[0]).toEqual(gone);
  expect(servers()[1]).toMatchObject({ hostname: BOX, port: 30025, apiKey: "radarr-key", isDefault: false });
  expect(step("configure")?.message).toBe(`Seerr sends requests to Radarr at ${OLD_BOX}:30025 by default. Radarr was added beside it.`);
});

test("with only a 4K default, this Radarr becomes the default for the rest, and the 4K one keeps its own", async () => {
  const fourK = entry("radarr-2", { name: "Radarr 4K", hostname: "10.0.0.80", port: 7878, apiKey: "radarr-4k", is4k: true });
  const { ctx, servers, step } = fakes({ servers: [fourK] });
  await radarr(ctx);
  expect(servers()[0]).toEqual(fourK);
  expect(servers()[1]).toMatchObject({ port: 30025, is4k: false, isDefault: true });
  expect(step("configure")).toEqual({ id: "configure", message: undefined });
});

for (const down of ["seerr", "radarr"] as const) {
  test(`${down === "seerr" ? "Seerr" : "a Radarr"} that isn't answering yet fails with a plain message before anything is changed`, async () => {
    const { ctx, servers } = fakes({ down, servers: [entry("radarr")] });
    await expect(radarr(ctx)).rejects.toThrow(`${down === "seerr" ? "Seerr" : "Radarr"} isn't answering yet. Try again once it has started.`);
    expect(servers()).toEqual([entry("radarr")]);
  });
}

// --- the profiles a manager starts with ---------------------------------------

test("a new entry never takes a starter profile while the manager has one of the owner's own", async () => {
  const { ctx, servers } = fakes({ profiles: [{ id: 1, name: "Any" }, { id: 2, name: "SD" }, { id: 9, name: "My 4K" }] });
  await radarr(ctx);
  expect(servers()[0]).toMatchObject({ activeProfileId: 9, activeProfileName: "My 4K" });
});

test("a manager with only its starter profiles still gets its first, and keeps them all", async () => {
  const { ctx, servers, names, removals, step } = fakes({ profiles: synced().filter((each) => STARTERS.includes(each.name)) });
  await radarr(ctx);
  expect(servers()[0]).toMatchObject({ activeProfileName: "Any" });
  expect(removals).toEqual([]);
  expect(names()).toEqual(STARTERS);
  expect(step("tidy")).toEqual({ id: "tidy", message: "Radarr doesn't have all of Profilarr's profiles, so it keeps the ones it started with", skipped: true });
});

test("a Radarr Profilarr already tidied gets Profilarr's everyday profile, and nothing more is removed", async () => {
  const { ctx, servers, removals, step } = fakes({ profiles: synced().filter((each) => HEXOS.includes(each.name)) });
  await radarr(ctx);
  expect(servers()[0]).toMatchObject({ activeProfileId: ID["1080p Balanced"], activeProfileName: "1080p Balanced" });
  expect(removals).toEqual([]);
  expect(step("tidy")).toEqual({ id: "tidy", message: "Radarr has none of the profiles it started with", skipped: true });
});

test("a default on a starter profile only Seerr was holding moves to Profilarr's everyday profile, and the starters go", async () => {
  const { ctx, servers, names, step } = fakes({ profiles: synced(), servers: [entry("radarr")] });
  await radarr(ctx);
  // The folder and the rest of the owner's choices stay
  expect(servers()).toEqual([{ ...entry("radarr"), id: 0, activeProfileId: ID["1080p Balanced"], activeProfileName: "1080p Balanced" }]);
  expect(step("configure")?.message).toBe("Seerr sent Radarr's requests to Any. It sends them to 1080p Balanced now.");
  expect(names()).toEqual(HEXOS);
  expect(step("tidy")).toEqual({ id: "tidy", message: undefined });
});

test("Sonarr's anime default moves with its everyday one, each off the starter it was on", async () => {
  const start = entry("sonarr", { activeAnimeProfileId: ID.SD, activeAnimeProfileName: "SD", activeAnimeDirectory: "/movies" });
  const { ctx, servers, names, step } = fakes({ manager: "sonarr", profiles: synced("sonarr"), servers: [start] });
  await sonarr(ctx);
  expect(servers()[0]).toMatchObject({
    activeProfileId: ID["1080p Balanced"],
    activeProfileName: "1080p Balanced",
    activeAnimeProfileId: ID["1080p Balanced"],
    activeAnimeProfileName: "1080p Balanced",
  });
  expect(step("configure")?.message).toBe("Seerr sent Sonarr's requests to Any and SD. It sends them to 1080p Balanced now.");
  expect(names()).toEqual(HEXOS);
});

test("a default on one of Profilarr's profiles is the owner's pick and stays", async () => {
  const picked = entry("radarr", { activeProfileId: ID["2160p Remux"], activeProfileName: "2160p Remux" });
  const { ctx, servers, names, step } = fakes({ profiles: synced(), servers: [picked] });
  await radarr(ctx);
  expect(servers()).toEqual([picked]);
  expect(step("configure")).toEqual({ id: "configure", message: undefined });
  expect(names()).toEqual(HEXOS);
});

test("a default on a starter profile that movies use stays, and so does the profile", async () => {
  const { ctx, servers, names, removals, step } = fakes({ profiles: synced(), servers: [entry("radarr")], lists: { "/movie": [{ qualityProfileId: ID.Any }] } });
  await radarr(ctx);
  expect(servers()).toEqual([entry("radarr")]);
  expect(removals).not.toContain("Any");
  expect(names()).toEqual(["Any", ...HEXOS]);
  expect(step("tidy")?.message).toBe("Radarr keeps Any because a movie uses it.");
});

test("a default on a starter profile the owner changed stays, and so does the profile", async () => {
  const changed = synced().map((each) => (each.name === "Any" ? { ...each, upgradeAllowed: true } : each));
  const { ctx, servers, names, removals } = fakes({ profiles: changed, servers: [entry("radarr")] });
  await radarr(ctx);
  expect(servers()).toEqual([entry("radarr")]);
  expect(removals).not.toContain("Any");
  expect(names()).toEqual(["Any", ...HEXOS]);
});

test("a Radarr the owner already had keeps Seerr's default and every profile", async () => {
  const { ctx, servers, names, removals, step } = fakes({ profiles: synced(), servers: [entry("radarr")], keptApps: ["radarr"] });
  await radarr(ctx);
  expect(servers()).toEqual([entry("radarr")]);
  expect(removals).toEqual([]);
  expect(names()).toEqual([...STARTERS, ...HEXOS]);
  expect(step("tidy")).toEqual({ id: "tidy", message: "Radarr is one you already had, so it keeps every profile it has", skipped: true });
});

test("a Seerr the owner already had keeps the default they chose, and Radarr keeps that profile", async () => {
  const { ctx, servers, names, removals, step } = fakes({ profiles: synced(), servers: [entry("radarr")], keptApps: ["seerr"] });
  await radarr(ctx);
  expect(servers()).toEqual([entry("radarr")]);
  expect(removals).not.toContain("Any");
  expect(names()).toEqual(["Any", ...HEXOS]);
  expect(step("tidy")?.message).toBe("Radarr keeps Any because Seerr sends requests to it.");
});

test("a default on a starter profile that an override rule of this entry also names stays", async () => {
  const { ctx, servers, names, step } = fakes({ profiles: synced(), servers: [entry("radarr")], rules: [{ id: 1, radarrServiceId: 0, profileId: ID.Any }] });
  await radarr(ctx);
  expect(servers()).toEqual([entry("radarr")]);
  expect(names()).toEqual(["Any", ...HEXOS]);
  expect(step("tidy")?.message).toBe("Radarr keeps Any because Seerr sends requests to it.");
});

test("a default on a starter profile that Seerr's 4K entry for the same Radarr names stays", async () => {
  const fourK = entry("radarr", { id: 1, name: "Radarr 4K", is4k: true, isDefault: true });
  const { ctx, servers, names } = fakes({ profiles: synced(), servers: [entry("radarr"), fourK] });
  await radarr(ctx);
  expect(servers()).toEqual([entry("radarr"), fourK]);
  expect(names()).toEqual(["Any", ...HEXOS]);
});

test("a profile only an override rule names stays, and the rest go", async () => {
  const picked = entry("radarr", { activeProfileId: ID["1080p Quality"], activeProfileName: "1080p Quality" });
  const { ctx, names, step } = fakes({ profiles: synced(), servers: [picked], rules: [{ id: 1, radarrServiceId: 0, profileId: ID["Ultra-HD"] }] });
  await radarr(ctx);
  expect(names()).toEqual(["Ultra-HD", ...HEXOS]);
  expect(step("tidy")?.message).toBe("Radarr keeps Ultra-HD because a Seerr override rule uses it.");
});

test("a Seerr that won't list its override rules moves no default and has nothing removed", async () => {
  const { ctx, servers, names, removals, step } = fakes({ profiles: synced(), servers: [entry("radarr")], rules: "down" });
  await radarr(ctx);
  expect(servers()).toEqual([entry("radarr")]);
  expect(removals).toEqual([]);
  expect(names()).toEqual([...STARTERS, ...HEXOS]);
  expect(step("tidy")).toEqual({ id: "tidy", message: "HexOS couldn't read which profiles Seerr uses, so it removed none from Radarr", skipped: true });
});

test("the profile a new entry was just given is never removed", async () => {
  // Profilarr's six are there, and the manager lists a starter first
  const { ctx, servers, names } = fakes({ profiles: synced() });
  await radarr(ctx);
  expect(servers()[0]).toMatchObject({ activeProfileName: "1080p Balanced" });
  expect(names()).toEqual(HEXOS);
});

for (const path of ["/movie", "/importlist", "/collection", "/autotagging"]) {
  test(`a Radarr that won't list ${path} is never taken to have nothing there: no default moves and nothing is removed`, async () => {
    const { ctx, servers, names, removals, step } = fakes({ profiles: synced(), servers: [entry("radarr")], lists: { [path]: "down" } });
    await radarr(ctx);
    expect(servers()).toEqual([entry("radarr")]);
    expect(removals).toEqual([]);
    expect(names()).toEqual([...STARTERS, ...HEXOS]);
    expect(step("tidy")).toEqual({ id: "tidy", message: "HexOS couldn't read what uses Radarr's profiles, so it removed none", skipped: true });
  });
}

for (const { label, lists, words } of [
  { label: "an import list uses", lists: { "/importlist": [{ qualityProfileId: 3 }] }, words: "an import list uses it" },
  { label: "2 collections use", lists: { "/collection": [{ qualityProfileId: 3 }, { qualityProfileId: 3 }] }, words: "2 collections use it" },
  {
    label: "an auto tagging rule names",
    lists: { "/autotagging": [{ specifications: [{ implementation: "QualityProfileSpecification", fields: [{ name: "value", value: 3 }] }] }] },
    words: "an auto tagging rule uses it",
  },
] as Array<{ label: string; lists: Record<string, unknown[]>; words: string }>) {
  test(`a starter profile ${label} stays and is never asked of Radarr`, async () => {
    const { ctx, names, removals, step } = fakes({ profiles: synced(), lists });
    await radarr(ctx);
    expect(removals).not.toContain("HD-720p");
    expect(names()).toEqual(["HD-720p", ...HEXOS]);
    expect(step("tidy")?.message).toBe(`Radarr keeps HD-720p because ${words}.`);
  });
}

test("a show on a starter profile keeps it in Sonarr", async () => {
  const { ctx, names, removals } = fakes({ manager: "sonarr", profiles: synced("sonarr"), lists: { "/series": [{ qualityProfileId: ID.SD }] } });
  await sonarr(ctx);
  expect(removals).not.toContain("SD");
  expect(names()).toEqual(["SD", ...HEXOS]);
});

test("a later copy the owner already had is judged by the name it runs under", async () => {
  const kept = fakes({ copy: "radarr-2", profiles: synced(), keptApps: ["radarr-2"] });
  await radarr(kept.ctx);
  expect(kept.removals).toEqual([]);

  const fresh = fakes({ copy: "radarr-2", profiles: synced(), keptApps: ["radarr"] });
  await radarr(fresh.ctx);
  expect(fresh.names()).toEqual(HEXOS);
});

test("a profile Radarr won't remove is left, tried once, and the link still connects", async () => {
  const { ctx, names, removals, step } = fakes({ profiles: synced(), wontRemove: ["SD"] });
  await radarr(ctx);
  expect(names()).toEqual(["SD", ...HEXOS]);
  expect(removals.filter((name) => name === "SD")).toHaveLength(1);
  expect(step("tidy")).toEqual({ id: "tidy", message: "Radarr keeps SD because Radarr wouldn't remove it." });
});

test("a Radarr that answers a removal and keeps the profile fails the step", async () => {
  const { ctx } = fakes({ profiles: synced(), ignoresRemoval: true });
  await expect(radarr(ctx)).rejects.toThrow("Radarr answered, but still has Any, SD, HD-720p, HD-1080p, Ultra-HD, HD - 720p/1080p. Run this again.");
});

test("Seerr's entry at an old address still holds its default, by this Radarr's key", async () => {
  // Kept in Seerr by a Seerr the owner already had, so the default stays where it is
  const { ctx, names } = fakes({ profiles: synced(), servers: [entry("radarr", { hostname: OLD_BOX })], keptApps: ["seerr"] });
  await radarr(ctx);
  expect(names()).toEqual(["Any", ...HEXOS]);
});

for (const { label, change } of [
  { label: "allows upgrades", change: { upgradeAllowed: true } },
  { label: "has a minimum score", change: { minFormatScore: 10 } },
  { label: "has a cutoff score", change: { cutoffFormatScore: 100 } },
  { label: "scores a format", change: { formatItems: [{ format: 1, name: "Not English", score: 50 }] } },
] as Array<{ label: string; change: Partial<Profile> }>) {
  test(`a starter profile the owner changed so it ${label} stays, with nothing using it`, async () => {
    const { ctx, names, removals, step } = fakes({ profiles: synced().map((each) => (each.name === "SD" ? { ...each, ...change } : each)) });
    await radarr(ctx);
    expect(removals).not.toContain("SD");
    expect(names()).toEqual(["SD", ...HEXOS]);
    expect(step("tidy")?.message).toBe("Radarr keeps SD because its settings were changed.");
  });
}

for (const manager of ["radarr", "sonarr"] as const) {
  const name = manager === "radarr" ? "Radarr" : "Sonarr";
  const link = manager === "radarr" ? radarr : sonarr;
  const hd = () => synced(manager).find((each) => each.name === "HD-1080p") as StarterProfile;
  // A quality HD-1080p doesn't take as it starts
  const added = manager === "radarr" ? "Bluray-720p" : "Bluray-1080p Remux";
  for (const { label, changed } of [
    { label: "takes one more quality", changed: () => withQuality(hd(), added, true) },
    { label: "takes one quality fewer", changed: () => withQuality(hd(), "HDTV-1080p", false) },
    { label: "takes one group of qualities fewer", changed: () => withQuality(hd(), "WEBDL-1080p", false) },
    { label: "takes another quality in place of one", changed: () => withQuality(withQuality(hd(), "HDTV-1080p", false), added, true) },
    { label: "stops at another quality", changed: () => withCutoff(hd(), manager === "radarr" ? "Remux-1080p" : "Bluray-1080p") },
    { label: "lists no qualities at all", changed: () => ({ ...hd(), items: undefined }) as unknown as StarterProfile },
    { label: "has another score increment for upgrades", changed: () => ({ ...hd(), minUpgradeFormatScore: 50 }) },
  ]) {
    test(`a ${name} starter profile the owner changed so it ${label} stays, and a default on it stays too`, async () => {
      const start = entry(manager, { activeProfileId: ID["HD-1080p"], activeProfileName: "HD-1080p" });
      const { ctx, servers, names, removals, step } = fakes({
        manager,
        profiles: synced(manager).map((each) => (each.name === "HD-1080p" ? changed() : each)),
        servers: [start],
      });
      await link(ctx);
      expect(servers()[0]).toMatchObject({ activeProfileId: ID["HD-1080p"], activeProfileName: "HD-1080p" });
      expect(removals).not.toContain("HD-1080p");
      expect(names()).toEqual(["HD-1080p", ...HEXOS]);
      expect(step("tidy")?.message).toBe(`${name} keeps HD-1080p because Seerr sends requests to it.`);
    });
  }
}

test("a Radarr starter profile given another language stays, with nothing using it", async () => {
  const { ctx, names, step } = fakes({ profiles: synced().map((each) => (each.name === "SD" ? { ...each, language: { id: 1, name: "English" } } : each)) });
  await radarr(ctx);
  expect(names()).toEqual(["SD", ...HEXOS]);
  expect(step("tidy")?.message).toBe("Radarr keeps SD because its settings were changed.");
});

// --- a manager or a Seerr the owner already had, on a run from a card -----------

test("a Radarr with no note that it was new keeps Seerr's default and every profile, on a run from a card", async () => {
  // No collection is running, so nothing says which apps the owner already had
  const { ctx, servers, names, removals, step } = fakes({ profiles: synced(), servers: [entry("radarr")], notes: [] });
  await radarr(ctx);
  expect(servers()).toEqual([entry("radarr")]);
  expect(removals).toEqual([]);
  expect(names()).toEqual([...STARTERS, ...HEXOS]);
  expect(step("tidy")).toEqual({ id: "tidy", message: "HexOS can't tell that Radarr was new when it was installed, so it keeps every profile it has", skipped: true });
});

test("a Radarr noted as one the owner already had keeps Seerr's default and every profile, on a run from a card", async () => {
  const { ctx, servers, names, removals, step } = fakes({ profiles: synced(), servers: [entry("radarr")], notes: ["fresh", "kept"] });
  await radarr(ctx);
  expect(servers()).toEqual([entry("radarr")]);
  expect(removals).toEqual([]);
  expect(names()).toEqual([...STARTERS, ...HEXOS]);
  expect(step("tidy")).toEqual({ id: "tidy", message: "Radarr is one you already had, so it keeps every profile it has", skipped: true });
});

test("a Seerr a collection brings in as the owner's own is noted as kept, and one HexOS installed is not", async () => {
  const kept = fakes({ profiles: synced(), servers: [entry("radarr")], keptApps: ["seerr"] });
  await radarr(kept.ctx);
  expect(kept.seerrNotedKept()).toBe(true);

  root = mkdtempSync(join(tmpdir(), "seerr-arr-"));
  const installed = fakes({ profiles: synced(), servers: [entry("radarr")], keptApps: ["radarr"] });
  await radarr(installed.ctx);
  expect(installed.seerrNotedKept()).toBe(false);
});

test("a Seerr noted as one the owner already had keeps the default they chose, on a run from a card", async () => {
  const { ctx, servers, names, removals, step } = fakes({ profiles: synced(), servers: [entry("radarr")], seerrKept: true });
  await radarr(ctx);
  expect(servers()).toEqual([entry("radarr")]);
  expect(removals).not.toContain("Any");
  expect(names()).toEqual(["Any", ...HEXOS]);
  expect(step("tidy")?.message).toBe("Radarr keeps Any because Seerr sends requests to it.");
});

test("a Seerr the owner already had keeps a Sonarr anime default on a starter profile, and Sonarr keeps that profile", async () => {
  const start = entry("sonarr", {
    activeProfileId: ID["1080p Balanced"],
    activeProfileName: "1080p Balanced",
    activeAnimeProfileId: ID.SD,
    activeAnimeProfileName: "SD",
    activeAnimeDirectory: "/movies",
  });
  const { ctx, servers, names, removals, step } = fakes({ manager: "sonarr", profiles: synced("sonarr"), servers: [start], keptApps: ["seerr"] });
  await sonarr(ctx);
  expect(servers()).toEqual([start]);
  expect(removals).not.toContain("SD");
  expect(names()).toEqual(["SD", ...HEXOS]);
  expect(step("tidy")?.message).toBe("Sonarr keeps SD because Seerr sends requests to it.");
});

// --- Seerr's other entries for the same manager ---------------------------------

for (const { label, where } of [
  { label: "still at the box's old address, known by this Radarr's key", where: { hostname: OLD_BOX } },
  { label: "at this Radarr's address with a key from before", where: { apiKey: "a-key-from-before" } },
]) {
  test(`Seerr's 4K entry ${label} keeps the starter profile it names`, async () => {
    const everyday = entry("radarr", { activeProfileId: ID["1080p Balanced"], activeProfileName: "1080p Balanced" });
    const fourK = entry("radarr", { id: 1, name: "Radarr 4K", is4k: true, activeProfileId: ID["Ultra-HD"], activeProfileName: "Ultra-HD", ...where });
    const { ctx, servers, names, removals, step } = fakes({ profiles: synced(), servers: [everyday, fourK] });
    await radarr(ctx);
    expect(servers()).toEqual([everyday, fourK]);
    expect(removals).not.toContain("Ultra-HD");
    expect(names()).toEqual(["Ultra-HD", ...HEXOS]);
    expect(step("tidy")?.message).toBe("Radarr keeps Ultra-HD because Seerr sends requests to it.");
  });
}

// --- requests waiting in Seerr ---------------------------------------------------

for (const { label, status } of [
  { label: "waiting for a yes", status: 1 },
  { label: "that failed and can be sent again", status: 4 },
]) {
  test(`a profile only a Seerr request ${label} names stays, and the rest go`, async () => {
    const picked = entry("radarr", { activeProfileId: ID["1080p Quality"], activeProfileName: "1080p Quality" });
    const requests: SeerrRequest[] = [{ type: "movie", status, serverId: 0, profileId: ID["HD-1080p"] }];
    const { ctx, names, removals, step } = fakes({ profiles: synced(), servers: [picked], requests });
    await radarr(ctx);
    expect(removals).not.toContain("HD-1080p");
    expect(names()).toEqual(["HD-1080p", ...HEXOS]);
    expect(step("tidy")?.message).toBe("Radarr keeps HD-1080p because a request waiting in Seerr uses it.");
  });
}

test("a default on a starter profile that a waiting request also names stays, and so does the profile", async () => {
  const requests: SeerrRequest[] = [{ type: "movie", status: 1, serverId: null, profileId: ID.Any }];
  const { ctx, servers, names, step } = fakes({ profiles: synced(), servers: [entry("radarr")], requests });
  await radarr(ctx);
  expect(servers()).toEqual([entry("radarr")]);
  expect(names()).toEqual(["Any", ...HEXOS]);
  expect(step("tidy")?.message).toBe("Radarr keeps Any because Seerr sends requests to it.");
});

test("requests that reached a manager, were declined, name another entry or are for shows hold nothing of this Radarr's", async () => {
  const requests: SeerrRequest[] = [
    { type: "movie", status: 2, serverId: 0, profileId: ID.Any },
    { type: "movie", status: 3, serverId: 0, profileId: ID.SD },
    { type: "movie", status: 5, serverId: 0, profileId: ID["HD-720p"] },
    { type: "movie", status: 1, serverId: 5, profileId: ID["HD-1080p"] },
    { type: "tv", status: 1, serverId: 0, profileId: ID["Ultra-HD"] },
    { type: "movie", status: 1, serverId: 0, profileId: null },
  ];
  const { ctx, servers, names } = fakes({ profiles: synced(), servers: [entry("radarr")], requests });
  await radarr(ctx);
  expect(servers()[0]).toMatchObject({ activeProfileName: "1080p Balanced" });
  expect(names()).toEqual(HEXOS);
});

test("a waiting request past Seerr's first page still keeps its profile", async () => {
  const requests: SeerrRequest[] = [
    ...Array.from({ length: 230 }, (): SeerrRequest => ({ type: "movie", status: 1, serverId: 0, profileId: null })),
    { type: "movie", status: 1, serverId: 0, profileId: ID["Ultra-HD"] },
  ];
  const { ctx, names } = fakes({ profiles: synced(), requests });
  await radarr(ctx);
  expect(names()).toEqual(["Ultra-HD", ...HEXOS]);
});

for (const { label, requests } of [
  { label: "won't list its requests", requests: "down" },
  { label: "gives fewer requests than it counts", requests: "short" },
] as const) {
  test(`a Seerr that ${label} moves no default and has nothing removed`, async () => {
    const { ctx, servers, names, removals, step } = fakes({ profiles: synced(), servers: [entry("radarr")], requests });
    await radarr(ctx);
    expect(servers()).toEqual([entry("radarr")]);
    expect(removals).toEqual([]);
    expect(names()).toEqual([...STARTERS, ...HEXOS]);
    expect(step("tidy")).toEqual({ id: "tidy", message: "HexOS couldn't read which profiles Seerr uses, so it removed none from Radarr", skipped: true });
  });
}

// --- what Seerr and the manager hold afterwards ----------------------------------

test("a Seerr that reads back a default Radarr doesn't have fails the step, before anything is removed", async () => {
  const { ctx, removals } = fakes({ profiles: synced(), savesProfile: 99 });
  await expect(radarr(ctx)).rejects.toThrow("Seerr saved Radarr, but its default profile isn't one Radarr has. Run this again.");
  expect(removals).toEqual([]);
});

test("a Radarr that lost one of Profilarr's profiles while its own were removed fails the step", async () => {
  const { ctx } = fakes({ profiles: synced(), losesOnRemoval: "2160p Remux" });
  await expect(radarr(ctx)).rejects.toThrow("Radarr is missing some of Profilarr's profiles. Run Connect to Radarr from Profilarr's Connections tab to send them again.");
});
