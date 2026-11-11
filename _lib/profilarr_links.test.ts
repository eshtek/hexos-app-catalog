import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookContext } from "./hook_context";
import { radarr, sonarr } from "../profilarr/profilarr_hook";
import { type StarterProfile, starterProfile, withCutoff, withQuality } from "./starter_profiles.fixture";

// Profilarr's link to Radarr and Sonarr, once the manager has Profilarr's six profiles: it takes
// out the six the manager made at its first start, each only when nothing uses it. The fake manager
// refuses a delete as the real one does (QualityProfileService.Delete, read at Radarr 6.4.4 and
// Sonarr 5.0.0): over a movie or show, an import list and, in Radarr, a collection. It knows
// nothing of Seerr or of auto tagging rules, so those are the link's own to check. The fake
// Profilarr already has the manager and its profiles, and lets the home network in (2.2).
//
// The fake manager carries the note HexOS leaves beside a new app's settings (hexos/fresh.json),
// unless a test takes it away: without it, or with the note of an app the owner already had
// (hexos/kept.json), nothing is removed, whoever runs the link. The fake Seerr lists its requests
// as the real one does (routes/request.ts, read at 3.5.1): by status and by kind, a page at a time.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const BOX = "10.0.0.5";
const PROFILARR = `http://${BOX}:30223`;
const SEERR = { url: `http://${BOX}:30357`, key: "seerr-secret-key" };
const DICTIONARRY = "https://github.com/Dictionarry-Hub/database";
const COPIES: Record<string, { port: number; key: string; displayName: string }> = {
  radarr: { port: 30025, key: "radarr-secret-key", displayName: "Radarr" },
  "radarr-2": { port: 30125, key: "radarr-2-secret-key", displayName: "Radarr 2" },
  sonarr: { port: 30113, key: "sonarr-secret-key", displayName: "Sonarr" },
};

const STARTERS = ["Any", "SD", "HD-720p", "HD-1080p", "Ultra-HD", "HD - 720p/1080p"];
const HEXOS = ["1080p Balanced", "1080p Quality", "1080p Quality HDR", "2160p Balanced", "2160p Quality", "2160p Remux"];

type Profile = StarterProfile;

/** A manager's profiles after Profilarr's sync: its own six, untouched (ids 1 to 6), then Profilarr's (7 to 12). */
function profiles(managerId: "radarr" | "sonarr" = "radarr"): Profile[] {
  const sent = (name: string, at: number): Profile => ({
    ...starterProfile(managerId, "HD-1080p", at + 7),
    name,
    upgradeAllowed: true,
    minFormatScore: 20000,
    cutoffFormatScore: 400000,
    formatItems: [{ format: 1, name: "Not English", score: -999999 }],
  });
  return [...STARTERS.map((name, at) => starterProfile(managerId, name, at + 1)), ...HEXOS.map(sent)];
}

const ID = Object.fromEntries(STARTERS.map((name, at) => [name, at + 1])) as Record<string, number>;

interface SeerrEntry {
  id: number;
  hostname: string;
  port: number;
  apiKey: string;
  activeProfileId: number;
  activeAnimeProfileId?: number;
}

/** A request in Seerr: its kind, its status (1 waiting, 2 approved, 3 declined, 4 failed, 5 completed), and what it names. */
interface SeerrRequest {
  type: "movie" | "tv";
  status: number;
  serverId?: number | null;
  profileId?: number | null;
}

interface SeerrOptions {
  entries: SeerrEntry[];
  rules?: unknown[] | "down";
  /** Seerr's requests, "down" for a Seerr that won't list them, or "short" for one that says there are more than it gives. */
  requests?: SeerrRequest[] | "down" | "short";
  /** Seerr's settings file, changed before it is written. */
  settings?: (settings: Record<string, unknown>) => Record<string, unknown>;
  /** The box can't say where Seerr answers. */
  noUrl?: boolean;
}

interface Options {
  manager?: "radarr" | "sonarr";
  /** The copy this run links. */
  copy?: string;
  profiles?: Profile[];
  /** What the manager lists at each path, or "down" for a list it won't give. */
  lists?: Record<string, unknown[] | "down">;
  /** The manager refuses to remove these, whatever uses them. */
  wontRemove?: string[];
  /** The manager answers a removal and keeps the profile. */
  ignoresRemoval?: boolean;
  keptApps?: string[];
  /** Seerr on the box: its entries for this kind of manager, "unreadable" settings, or absent. */
  seerr?: SeerrOptions | "unreadable";
  /** The notes HexOS left beside the manager's settings: one of a new app, unless given. */
  notes?: Array<"fresh" | "kept">;
  /** Removing a profile also costs the manager this one of Profilarr's. */
  losesOnRemoval?: string;
  /** How the box answers for Seerr's copies: absent on a box from before it, or failing. */
  copies?: "absent" | "fails";
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "profilarr-links-"));
});

function dir(name: string) {
  const path = join(root, name, "config");
  mkdirSync(path, { recursive: true });
  return path;
}

function fakes(options: Options = {}) {
  const managerId = options.manager ?? "radarr";
  const copy = options.copy ?? managerId;
  const target = COPIES[copy];
  const managerUrl = `http://${BOX}:${target.port}`;
  let list = structuredClone(options.profiles ?? profiles(managerId));
  const lists: Record<string, unknown[] | "down"> = {
    "/movie": [],
    "/series": [],
    "/importlist": [],
    "/collection": [],
    "/autotagging": [],
    ...options.lists,
  };
  const requests: string[] = [];
  const removals: string[] = [];
  const steps: Array<{ id: string; message?: string; skipped?: boolean }> = [];
  // What the manager's own delete refuses over
  const inUse = (id: number) =>
    [managerId === "radarr" ? "/movie" : "/series", "/importlist", ...(managerId === "radarr" ? ["/collection"] : [])].some((path) => {
      const rows = lists[path];
      return Array.isArray(rows) && rows.some((row) => (row as { qualityProfileId?: number }).qualityProfileId === id);
    });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname;
    requests.push(`${method} ${url.origin === managerUrl ? "manager" : url.origin === SEERR.url ? "seerr" : "profilarr"} ${path}`);
    if (url.origin === PROFILARR) {
      if (path === "/api/v1/status") {
        return Response.json({
          databases: [{ id: 1, counts: { qualityProfiles: 30 } }],
          arrs: [{ id: 7, sync: { qualityProfiles: { count: 6, status: "idle" } } }],
        });
      }
      if (path === "/api/v1/databases") return Response.json([{ id: 1, repository_url: DICTIONARRY }]);
      if (path === "/api/v1/arr") return Response.json([{ id: 7, type: managerId, url: managerUrl }]);
      if (path === "/arr/7/sync" && method === "POST") return Response.json({ type: "success", status: 200 });
      if (path === "/databases/1/export") return new Response(null, { status: 404 });
    }
    if (url.origin === managerUrl) {
      if (new Headers(init?.headers).get("X-Api-Key") !== target.key) return new Response(null, { status: 401 });
      const at = path.slice("/api/v3".length);
      if (at === "/qualityprofile" && method === "GET") return Response.json(list);
      const removal = at.match(/^\/qualityprofile\/(\d+)$/);
      if (removal && method === "DELETE") {
        const id = Number(removal[1]);
        const name = list.find((each) => each.id === id)?.name ?? String(id);
        removals.push(name);
        if (inUse(id) || options.wontRemove?.includes(name)) return Response.json({ message: `QualityProfile [${id}] is in use.` }, { status: 500 });
        if (!options.ignoresRemoval) list = list.filter((each) => each.id !== id && each.name !== options.losesOnRemoval);
        return Response.json({});
      }
      if (at in lists && method === "GET") {
        const rows = lists[at];
        return rows === "down" ? Response.json({ message: "database is locked" }, { status: 500 }) : Response.json(rows);
      }
    }
    if (url.origin === SEERR.url && options.seerr && options.seerr !== "unreadable") {
      if (new Headers(init?.headers).get("X-Api-Key") !== SEERR.key) return new Response(null, { status: 403 });
      if (path === "/api/v1/overrideRule") {
        const rules = options.seerr.rules ?? [];
        return rules === "down" ? Response.json({ message: "no" }, { status: 500 }) : Response.json(rules);
      }
      if (path === "/api/v1/request") {
        const all = options.seerr.requests ?? [];
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
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as typeof fetch;

  const profilarrConfig = dir("profilarr");
  const managerConfig = dir(copy);
  writeFileSync(join(managerConfig, "config.xml"), `<Config><ApiKey>${target.key}</ApiKey></Config>`);
  rmSync(join(managerConfig, "hexos"), { recursive: true, force: true });
  mkdirSync(join(managerConfig, "hexos"));
  for (const note of options.notes ?? ["fresh"]) writeFileSync(join(managerConfig, "hexos", `${note}.json`), "{}");
  const seerrConfig = dir("seerr");
  if (options.seerr === "unreadable") writeFileSync(join(seerrConfig, "settings.json"), "{ not json");
  else if (options.seerr) {
    const settings = { main: { apiKey: SEERR.key }, radarr: [], sonarr: [], [managerId]: options.seerr.entries };
    writeFileSync(join(seerrConfig, "settings.json"), JSON.stringify(options.seerr.settings ? options.seerr.settings(settings) : settings));
  }
  const mounts: Record<string, Array<{ containerPath: string; hostPath: string; localPath: string }>> = {
    [managerId]: [{ containerPath: "/config", hostPath: `/mnt/pool/apps/${copy}/config`, localPath: managerConfig }],
    seerr: options.seerr ? [{ containerPath: "/app/config", hostPath: "/mnt/pool/apps/seerr/config", localPath: seerrConfig }] : [],
  };
  const ctx = {
    resourceId: "profilarr",
    baseUrl: PROFILARR,
    mounts: [{ containerPath: "/config", hostPath: "/mnt/pool/apps/profilarr/config", localPath: profilarrConfig }],
    ...(options.keptApps ? { keptApps: options.keptApps } : {}),
    linkedApp: (app: string) => (app === managerId ? { name: copy, displayName: target.displayName } : null),
    getInstalledAppUrl: async (app: string) =>
      app === managerId ? managerUrl : app === "seerr" && options.seerr && !(options.seerr !== "unreadable" && options.seerr.noUrl) ? SEERR.url : null,
    getInstalledAppMounts: async (app: string) => mounts[app] ?? [],
    ...(options.copies === "absent"
      ? {}
      : {
          installedCopies: async (app: string) => {
            if (options.copies === "fails") throw new Error("The box didn't answer");
            return app === "seerr" && options.seerr ? ["seerr"] : [];
          },
        }),
    registerCheckpoints: async () => {},
    emitCheckpoint: async (id: string, message?: string) => {
      steps.push({ id, message });
    },
    skipCheckpoint: async (id: string, message?: string) => {
      steps.push({ id, message, skipped: true });
    },
    sleep: async () => {},
    log: () => {},
    fail: (message: string) => {
      throw new Error(message);
    },
  } as unknown as HookContext;
  return {
    ctx,
    names: () => list.map((each) => each.name),
    removals,
    requests,
    steps,
    tidy: () => steps.find((each) => each.id === "tidy"),
  };
}

/** Nothing was removed, nothing was tried, and the step says why. */
function removedNone(run: ReturnType<typeof fakes>, message: string) {
  expect(run.removals).toEqual([]);
  expect(run.names()).toEqual([...STARTERS, ...HEXOS]);
  expect(run.tidy()).toEqual({ id: "tidy", message, skipped: true });
}

/** Seerr's entry for a copy of a manager, with its default on a starter profile. */
const seerrEntry = (copy: string, profile: string, rest: Partial<SeerrEntry> = {}): SeerrEntry => ({
  id: 0,
  hostname: BOX,
  port: COPIES[copy].port,
  apiKey: COPIES[copy].key,
  activeProfileId: ID[profile] ?? 7,
  ...rest,
});

test("a Radarr with Profilarr's six and nothing on its own six ends with only Profilarr's", async () => {
  const run = fakes();
  await radarr(run.ctx);
  expect(run.names()).toEqual(HEXOS);
  expect(run.removals).toEqual(STARTERS);
  expect(run.tidy()).toEqual({ id: "tidy", message: undefined });
  expect(run.steps.map((each) => each.id)).toEqual(["locate", "signin", "add", "sync", "tidy"]);
});

test("a Sonarr with Profilarr's six and nothing on its own six ends with only Profilarr's", async () => {
  const run = fakes({ manager: "sonarr" });
  await sonarr(run.ctx);
  expect(run.names()).toEqual(HEXOS);
  // Sonarr has no collections to read
  expect(run.requests).not.toContain("GET manager /api/v3/collection");
});

test("a second run finds nothing to remove", async () => {
  const run = fakes({ profiles: profiles().filter((each) => HEXOS.includes(each.name)) });
  await radarr(run.ctx);
  expect(run.removals).toEqual([]);
  expect(run.tidy()).toEqual({ id: "tidy", message: "Radarr has none of the profiles it started with", skipped: true });
});

for (const { label, manager, lists, words } of [
  { label: "12 movies use", manager: "radarr", lists: { "/movie": Array.from({ length: 12 }, () => ({ qualityProfileId: 4 })) }, words: "12 movies use it" },
  { label: "one movie uses", manager: "radarr", lists: { "/movie": [{ qualityProfileId: 4 }, { qualityProfileId: 9 }] }, words: "a movie uses it" },
  { label: "an import list uses", manager: "radarr", lists: { "/importlist": [{ qualityProfileId: 4 }] }, words: "an import list uses it" },
  { label: "a collection uses", manager: "radarr", lists: { "/collection": [{ qualityProfileId: 4 }] }, words: "a collection uses it" },
  { label: "3 shows use", manager: "sonarr", lists: { "/series": Array.from({ length: 3 }, () => ({ qualityProfileId: 4 })) }, words: "3 shows use it" },
  {
    label: "an auto tagging rule names",
    manager: "radarr",
    lists: {
      "/autotagging": [
        { specifications: [{ implementation: "GenreSpecification", fields: [{ name: "value", value: ["4"] }] }] },
        { specifications: [{ implementation: "QualityProfileSpecification", fields: [{ name: "value", value: 4 }] }] },
      ],
    },
    words: "an auto tagging rule uses it",
  },
] as Array<{ label: string; manager: "radarr" | "sonarr"; lists: Record<string, unknown[]>; words: string }>) {
  test(`a starter profile ${label} stays, the step says who uses it, and the rest go`, async () => {
    const run = fakes({ manager, lists });
    await (manager === "radarr" ? radarr : sonarr)(run.ctx);
    const name = manager === "radarr" ? "Radarr" : "Sonarr";
    expect(run.names()).toEqual(["HD-1080p", ...HEXOS]);
    // Never asked of the manager: nothing is forced, and nothing is moved off the profile
    expect(run.removals).not.toContain("HD-1080p");
    expect(run.tidy()).toEqual({ id: "tidy", message: `${name} keeps HD-1080p because ${words}.` });
  });
}

test("the profile Seerr sends requests to stays, though Radarr itself would remove it", async () => {
  const run = fakes({ seerr: { entries: [seerrEntry("radarr", "Any")] } });
  await radarr(run.ctx);
  expect(run.names()).toEqual(["Any", ...HEXOS]);
  expect(run.removals).not.toContain("Any");
  expect(run.tidy()?.message).toBe("Radarr keeps Any because Seerr sends requests to it.");
});

test("Seerr's entry is known by Radarr's key after the box's address changed", async () => {
  const run = fakes({ seerr: { entries: [seerrEntry("radarr", "SD", { hostname: "10.0.0.30", port: 7878 })] } });
  await radarr(run.ctx);
  expect(run.names()).toEqual(["SD", ...HEXOS]);
});

test("Seerr's entry is known by Radarr's address when Radarr's key has changed since", async () => {
  const run = fakes({ seerr: { entries: [seerrEntry("radarr", "SD", { apiKey: "a-key-from-before" })] } });
  await radarr(run.ctx);
  expect(run.names()).toEqual(["SD", ...HEXOS]);
});

test("the profile Seerr sends Sonarr's anime requests to stays too", async () => {
  const run = fakes({ manager: "sonarr", seerr: { entries: [seerrEntry("sonarr", "1080p Balanced", { activeAnimeProfileId: ID["HD-720p"] })] } });
  await sonarr(run.ctx);
  expect(run.names()).toEqual(["HD-720p", ...HEXOS]);
  expect(run.tidy()?.message).toBe("Sonarr keeps HD-720p because Seerr sends requests to it.");
});

test("a profile only a Seerr override rule for this Radarr names stays", async () => {
  const rules = [
    { id: 1, radarrServiceId: 0, profileId: ID["Ultra-HD"] },
    // Another Radarr's rule, and a Sonarr's, say nothing about this one
    { id: 2, radarrServiceId: 5, profileId: ID.SD },
    { id: 3, sonarrServiceId: 0, profileId: ID.Any },
  ];
  const run = fakes({ seerr: { entries: [seerrEntry("radarr", "1080p Balanced")], rules } });
  await radarr(run.ctx);
  expect(run.names()).toEqual(["Ultra-HD", ...HEXOS]);
  expect(run.tidy()?.message).toBe("Radarr keeps Ultra-HD because a Seerr override rule uses it.");
});

test("Seerr's entry for another copy of Radarr holds nothing of this copy's", async () => {
  const run = fakes({ copy: "radarr-2", seerr: { entries: [seerrEntry("radarr", "Any")] } });
  await radarr(run.ctx);
  expect(run.names()).toEqual(HEXOS);
  // With no entry for this copy, Seerr's rules can't name it either
  expect(run.requests).not.toContain("GET seerr /api/v1/overrideRule");
});

test("a Radarr the owner already had keeps every profile, and isn't asked what uses them", async () => {
  const run = fakes({ keptApps: ["radarr"] });
  await radarr(run.ctx);
  removedNone(run, "Radarr is one you already had, so it keeps every profile it has");
  expect(run.requests.filter((request) => request.startsWith("GET manager /api/v3/movie"))).toEqual([]);
});

test("a later copy is judged by the name it runs under", async () => {
  const kept = fakes({ copy: "radarr-2", keptApps: ["radarr-2"] });
  await radarr(kept.ctx);
  removedNone(kept, "Radarr 2 is one you already had, so it keeps every profile it has");

  const fresh = fakes({ copy: "radarr-2", keptApps: ["radarr"] });
  await radarr(fresh.ctx);
  expect(fresh.names()).toEqual(HEXOS);
});

test("a Radarr missing one of Profilarr's profiles keeps the ones it started with", async () => {
  const run = fakes({ profiles: profiles().filter((each) => each.name !== "2160p Remux") });
  await radarr(run.ctx);
  expect(run.removals).toEqual([]);
  expect(run.names()).toEqual([...STARTERS, ...HEXOS.filter((name) => name !== "2160p Remux")]);
  expect(run.tidy()).toEqual({ id: "tidy", message: "Radarr doesn't have all of Profilarr's profiles, so it keeps the ones it started with", skipped: true });
});

for (const path of ["/movie", "/importlist", "/collection", "/autotagging"]) {
  test(`a Radarr that won't list ${path} is never taken to have nothing there`, async () => {
    const run = fakes({ lists: { [path]: "down" } });
    await radarr(run.ctx);
    removedNone(run, "HexOS couldn't read what uses Radarr's profiles, so it removed none");
  });
}

for (const { label, options } of [
  { label: "whose settings can't be read", options: { seerr: "unreadable" } },
  { label: "on a box that can't say whether it's installed", options: { seerr: { entries: [] }, copies: "fails" } },
  { label: "on a box from before it could say", options: { copies: "absent" } },
  { label: "whose override rules can't be read", options: { seerr: { entries: [seerrEntry("radarr", "1080p Balanced")], rules: "down" } } },
] as const) {
  test(`a Seerr ${label} is never taken to use nothing`, async () => {
    const run = fakes(options as Options);
    await radarr(run.ctx);
    removedNone(run, "HexOS couldn't read which profiles Seerr uses, so it removed none from Radarr");
  });
}

for (const { label, change } of [
  { label: "allows upgrades", change: { upgradeAllowed: true } },
  { label: "has a minimum score", change: { minFormatScore: 10 } },
  { label: "has a cutoff score", change: { cutoffFormatScore: 100 } },
  { label: "scores a format", change: { formatItems: [{ format: 1, name: "Not English", score: -999999 }] } },
] as Array<{ label: string; change: Partial<Profile> }>) {
  test(`a starter profile the owner changed so it ${label} stays`, async () => {
    const run = fakes({ profiles: profiles().map((each) => (each.name === "SD" ? { ...each, ...change } : each)) });
    await radarr(run.ctx);
    expect(run.names()).toEqual(["SD", ...HEXOS]);
    expect(run.removals).not.toContain("SD");
    expect(run.tidy()?.message).toBe("Radarr keeps SD because its settings were changed.");
  });
}

test("a profile Radarr won't remove is left, tried once, and the link still connects", async () => {
  const run = fakes({ wontRemove: ["Any"] });
  await radarr(run.ctx);
  expect(run.names()).toEqual(["Any", ...HEXOS]);
  expect(run.removals.filter((name) => name === "Any")).toHaveLength(1);
  expect(run.tidy()).toEqual({ id: "tidy", message: "Radarr keeps Any because Radarr wouldn't remove it." });
});

test("each profile that stays gets a sentence of its own", async () => {
  const run = fakes({ lists: { "/movie": [{ qualityProfileId: ID["HD-1080p"] }] }, seerr: { entries: [seerrEntry("radarr", "Any")] } });
  await radarr(run.ctx);
  expect(run.tidy()?.message).toBe("Radarr keeps Any because Seerr sends requests to it. Radarr keeps HD-1080p because a movie uses it.");
});

test("when every starter profile stays, the step is skipped with the reasons", async () => {
  const run = fakes({ profiles: profiles().filter((each) => each.name === "Any" || HEXOS.includes(each.name)), wontRemove: ["Any"] });
  await radarr(run.ctx);
  expect(run.tidy()).toEqual({ id: "tidy", message: "Radarr keeps Any because Radarr wouldn't remove it.", skipped: true });
});

test("a Radarr that answers a removal and keeps the profile fails the step", async () => {
  const run = fakes({ ignoresRemoval: true });
  await expect(radarr(run.ctx)).rejects.toThrow("Radarr answered, but still has Any, SD, HD-720p, HD-1080p, Ultra-HD, HD - 720p/1080p. Run this again.");
});

// --- a manager HexOS can't tell was new ----------------------------------------

test("a Radarr with no note that it was new keeps every profile, on a run from a card", async () => {
  // No collection is running, so nothing says which apps the owner already had
  const run = fakes({ notes: [] });
  await radarr(run.ctx);
  removedNone(run, "HexOS can't tell that Radarr was new when it was installed, so it keeps every profile it has");
  expect(run.requests.filter((request) => request.startsWith("GET manager /api/v3/movie"))).toEqual([]);
});

test("a Radarr noted as one the owner already had keeps every profile, on a run from a card", async () => {
  const run = fakes({ notes: ["fresh", "kept"] });
  await radarr(run.ctx);
  removedNone(run, "Radarr is one you already had, so it keeps every profile it has");
});

test("a Radarr a collection brings in as the owner's own keeps every profile, though HexOS installed it once", async () => {
  const run = fakes({ notes: ["fresh"], keptApps: ["radarr"] });
  await radarr(run.ctx);
  removedNone(run, "Radarr is one you already had, so it keeps every profile it has");
});

// --- a starter profile the owner changed ---------------------------------------

for (const manager of ["radarr", "sonarr"] as const) {
  const name = manager === "radarr" ? "Radarr" : "Sonarr";
  const link = manager === "radarr" ? radarr : sonarr;
  const hd = () => profiles(manager).find((each) => each.name === "HD-1080p") as Profile;
  // A quality HD-1080p doesn't take as it starts, one it does, and a cutoff other than its own
  const added = manager === "radarr" ? "Bluray-720p" : "Bluray-1080p Remux";
  for (const { label, changed } of [
    { label: "takes one more quality", changed: () => withQuality(hd(), added, true) },
    { label: "takes one quality fewer", changed: () => withQuality(hd(), "HDTV-1080p", false) },
    { label: "takes one group of qualities fewer", changed: () => withQuality(hd(), "WEBDL-1080p", false) },
    { label: "takes another quality in place of one", changed: () => withQuality(withQuality(hd(), "HDTV-1080p", false), added, true) },
    { label: "stops at another quality", changed: () => withCutoff(hd(), manager === "radarr" ? "Remux-1080p" : "Bluray-1080p") },
    { label: "lists no qualities at all", changed: () => ({ ...hd(), items: undefined }) as unknown as Profile },
  ]) {
    test(`a ${name} starter profile the owner changed so it ${label} stays, with no score touched`, async () => {
      const run = fakes({ manager, profiles: profiles(manager).map((each) => (each.name === "HD-1080p" ? changed() : each)) });
      await link(run.ctx);
      expect(run.names()).toEqual(["HD-1080p", ...HEXOS]);
      expect(run.removals).not.toContain("HD-1080p");
      expect(run.tidy()?.message).toBe(`${name} keeps HD-1080p because its settings were changed.`);
    });
  }
}

test("a Radarr starter profile given another language stays", async () => {
  const run = fakes({ profiles: profiles().map((each) => (each.name === "SD" ? { ...each, language: { id: 1, name: "English" } } : each)) });
  await radarr(run.ctx);
  expect(run.names()).toEqual(["SD", ...HEXOS]);
  expect(run.tidy()?.message).toBe("Radarr keeps SD because its settings were changed.");
});

test("a starter profile with another score increment for upgrades stays", async () => {
  const run = fakes({ profiles: profiles().map((each) => (each.name === "SD" ? { ...each, minUpgradeFormatScore: 50 } : each)) });
  await radarr(run.ctx);
  expect(run.names()).toEqual(["SD", ...HEXOS]);
});

// --- requests waiting in Seerr -------------------------------------------------

for (const { label, status } of [
  { label: "waiting for a yes", status: 1 },
  { label: "that failed and can be sent again", status: 4 },
]) {
  test(`a profile only a Seerr request ${label} names stays, and the rest go`, async () => {
    const requests: SeerrRequest[] = [{ type: "movie", status, serverId: 0, profileId: ID["HD-1080p"] }];
    const run = fakes({ seerr: { entries: [seerrEntry("radarr", "1080p Balanced")], requests } });
    await radarr(run.ctx);
    expect(run.names()).toEqual(["HD-1080p", ...HEXOS]);
    expect(run.removals).not.toContain("HD-1080p");
    expect(run.tidy()?.message).toBe("Radarr keeps HD-1080p because a request waiting in Seerr uses it.");
  });
}

test("a waiting request that names no entry goes to Seerr's default, so its profile stays", async () => {
  const requests: SeerrRequest[] = [{ type: "movie", status: 1, serverId: null, profileId: ID.SD }];
  const run = fakes({ seerr: { entries: [seerrEntry("radarr", "1080p Balanced")], requests } });
  await radarr(run.ctx);
  expect(run.names()).toEqual(["SD", ...HEXOS]);
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
  const run = fakes({ seerr: { entries: [seerrEntry("radarr", "1080p Balanced")], requests } });
  await radarr(run.ctx);
  expect(run.names()).toEqual(HEXOS);
});

test("a waiting request past Seerr's first page still keeps its profile", async () => {
  const requests: SeerrRequest[] = [
    ...Array.from({ length: 230 }, (): SeerrRequest => ({ type: "movie", status: 1, serverId: 0, profileId: null })),
    { type: "movie", status: 1, serverId: 0, profileId: ID["Ultra-HD"] },
  ];
  const run = fakes({ seerr: { entries: [seerrEntry("radarr", "1080p Balanced")], requests } });
  await radarr(run.ctx);
  expect(run.names()).toEqual(["Ultra-HD", ...HEXOS]);
});

for (const { label, requests } of [
  { label: "won't list its requests", requests: "down" },
  { label: "gives fewer requests than it counts", requests: "short" },
] as const) {
  test(`a Seerr that ${label} is never taken to have none waiting`, async () => {
    const run = fakes({ seerr: { entries: [seerrEntry("radarr", "1080p Balanced")], requests } });
    await radarr(run.ctx);
    removedNone(run, "HexOS couldn't read which profiles Seerr uses, so it removed none from Radarr");
  });
}

// --- a Seerr that says less than it should -------------------------------------

test("a Seerr whose settings have no list for this kind of manager is never taken to use nothing", async () => {
  const run = fakes({ seerr: { entries: [], settings: ({ radarr: _gone, ...rest }) => rest } });
  await radarr(run.ctx);
  removedNone(run, "HexOS couldn't read which profiles Seerr uses, so it removed none from Radarr");
});

for (const { label, seerr } of [
  { label: "whose settings hold no API key", seerr: { settings: (settings: Record<string, unknown>) => ({ ...settings, main: {} }) } },
  { label: "the box can't say the address of", seerr: { noUrl: true } },
]) {
  test(`a Seerr ${label} is never taken to have no rules for this Radarr`, async () => {
    // Its default is on one of Profilarr's, so only what it couldn't be asked is in doubt
    const run = fakes({ seerr: { entries: [seerrEntry("radarr", "1080p Balanced")], ...seerr } });
    await radarr(run.ctx);
    removedNone(run, "HexOS couldn't read which profiles Seerr uses, so it removed none from Radarr");
  });
}

test("a Radarr that lost one of Profilarr's profiles while its own were removed fails the step", async () => {
  const run = fakes({ losesOnRemoval: "2160p Remux" });
  await expect(radarr(run.ctx)).rejects.toThrow("Radarr is missing some of Profilarr's profiles. Run Connect to Radarr from Profilarr's Connections tab to send them again.");
});

test("no step's words carry a key", async () => {
  const run = fakes({ lists: { "/movie": [{ qualityProfileId: 4 }] }, seerr: { entries: [seerrEntry("radarr", "Any")], rules: [] } });
  await radarr(run.ctx);
  const words = JSON.stringify(run.steps);
  expect(words).not.toContain(COPIES.radarr.key);
  expect(words).not.toContain(SEERR.key);
});
