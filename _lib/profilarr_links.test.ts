import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookContext } from "./hook_context";
import { radarr, sonarr } from "../profilarr/profilarr_hook";

// Profilarr's link to Radarr and Sonarr, once the manager has Profilarr's six profiles: it takes
// out the six the manager made at its first start, each only when nothing uses it. The fake manager
// refuses a delete as the real one does (QualityProfileService.Delete, read at Radarr 6.4.4 and
// Sonarr 5.0.0): over a movie or show, an import list and, in Radarr, a collection. It knows
// nothing of Seerr or of auto tagging rules, so those are the link's own to check. The fake
// Profilarr already has the manager and its profiles, and lets the home network in (2.2).

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

interface Profile {
  id: number;
  name: string;
  upgradeAllowed: boolean;
  minFormatScore: number;
  cutoffFormatScore: number;
  formatItems: Array<{ format: number; name: string; score: number }>;
}

/** A manager's profiles after Profilarr's sync: its own six, untouched (ids 1 to 6), then Profilarr's (7 to 12). */
function profiles(): Profile[] {
  const starter = (name: string, at: number): Profile => ({
    id: at + 1,
    name,
    upgradeAllowed: false,
    minFormatScore: 0,
    cutoffFormatScore: 0,
    // A custom format Profilarr adds joins every profile at 0 (CustomFormatAddedEvent)
    formatItems: [{ format: 1, name: "Not English", score: 0 }],
  });
  const sent = (name: string, at: number): Profile => ({
    id: at + 7,
    name,
    upgradeAllowed: true,
    minFormatScore: 20000,
    cutoffFormatScore: 400000,
    formatItems: [{ format: 1, name: "Not English", score: -999999 }],
  });
  return [...STARTERS.map(starter), ...HEXOS.map(sent)];
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
  seerr?: { entries: SeerrEntry[]; rules?: unknown[] | "down" } | "unreadable";
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
  let list = structuredClone(options.profiles ?? profiles());
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
        if (!options.ignoresRemoval) list = list.filter((each) => each.id !== id);
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
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as typeof fetch;

  const profilarrConfig = dir("profilarr");
  const managerConfig = dir(copy);
  writeFileSync(join(managerConfig, "config.xml"), `<Config><ApiKey>${target.key}</ApiKey></Config>`);
  const seerrConfig = dir("seerr");
  if (options.seerr === "unreadable") writeFileSync(join(seerrConfig, "settings.json"), "{ not json");
  else if (options.seerr) {
    writeFileSync(
      join(seerrConfig, "settings.json"),
      JSON.stringify({ main: { apiKey: SEERR.key }, radarr: [], sonarr: [], [managerId]: options.seerr.entries }),
    );
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
    getInstalledAppUrl: async (app: string) => (app === managerId ? managerUrl : app === "seerr" && options.seerr ? SEERR.url : null),
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
  removedNone(run, "Radarr was yours before, so it keeps every profile it has");
  expect(run.requests.filter((request) => request.startsWith("GET manager /api/v3/movie"))).toEqual([]);
});

test("a later copy is judged by the name it runs under", async () => {
  const kept = fakes({ copy: "radarr-2", keptApps: ["radarr-2"] });
  await radarr(kept.ctx);
  removedNone(kept, "Radarr 2 was yours before, so it keeps every profile it has");

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

test("no step's words carry a key", async () => {
  const run = fakes({ lists: { "/movie": [{ qualityProfileId: 4 }] }, seerr: { entries: [seerrEntry("radarr", "Any")], rules: [] } });
  await radarr(run.ctx);
  const words = JSON.stringify(run.steps);
  expect(words).not.toContain(COPIES.radarr.key);
  expect(words).not.toContain(SEERR.key);
});
