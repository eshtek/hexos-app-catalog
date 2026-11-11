import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookContext } from "./hook_context";
import { configure } from "../servarr/configure";

// Pre-configure Radarr and Pre-configure Sonarr turn renaming on, against a fake of each app's
// naming settings (NamingConfig.Default and the config/naming controller, read at Radarr 6.4.4 and
// Sonarr 5.0.0). Only an app still as it started is changed: renaming off, its own name formats,
// nothing in its library, no note from an earlier run, and not one the owner already had. The fake
// app already has a sign-in and a library folder, so those two steps leave it alone.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const BOX = "10.0.0.5";
const KEY = "manager-key";

const STOCK = {
  radarr: {
    id: 1,
    renameMovies: false,
    replaceIllegalCharacters: true,
    colonReplacementFormat: "smart",
    standardMovieFormat: "{Movie Title} ({Release Year}) {Quality Full}",
    movieFolderFormat: "{Movie Title} ({Release Year})",
  },
  sonarr: {
    id: 1,
    renameEpisodes: false,
    replaceIllegalCharacters: true,
    colonReplacementFormat: 4,
    customColonReplacementFormat: "",
    multiEpisodeStyle: 5,
    standardEpisodeFormat: "{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}",
    dailyEpisodeFormat: "{Series Title} - {Air-Date} - {Episode Title} {Quality Full}",
    animeEpisodeFormat: "{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}",
    seriesFolderFormat: "{Series Title}",
    seasonFolderFormat: "Season {season}",
    specialsFolderFormat: "Specials",
  },
} as const;

const HEXOS = {
  radarr: {
    renameMovies: true,
    movieFolderFormat: "{Movie CleanTitle} ({Release Year}) [tmdbid-{TmdbId}]",
    standardMovieFormat:
      "{Movie CleanTitle} {(Release Year)} [tmdbid-{TmdbId}] - {Edition Tags }{[Custom Formats]}{[Quality Full]}{[MediaInfo 3D]}{[MediaInfo VideoDynamicRangeType]}{[Mediainfo AudioCodec}{ Mediainfo AudioChannels]}{[Mediainfo VideoCodec]}{-Release Group}",
  },
  sonarr: {
    renameEpisodes: true,
    seriesFolderFormat: "{Series TitleYear} [tvdbid-{TvdbId}]",
    seasonFolderFormat: "Season {season:00}",
    standardEpisodeFormat: "{Series Title} - S{season:00}E{episode:00} - {Episode Title} - {Quality Full}",
    dailyEpisodeFormat: "{Series Title} - {Air-Date} - {Episode Title} - {Quality Full}",
    animeEpisodeFormat: "{Series Title} - S{season:00}E{episode:00} - {Episode Title} - {Quality Full}",
  },
} as const;

type AppId = "radarr" | "sonarr" | "lidarr" | "prowlarr";

interface Options {
  /** The name the app runs under: `radarr-2` for a later copy. */
  runsAs?: string;
  naming?: Record<string, unknown>;
  /** What the app's library holds. */
  library?: unknown[];
  libraryDown?: boolean;
  /** The app refuses the change, with this reason. */
  refuses?: string;
  /** The app answers the change, and keeps what it had. */
  drops?: boolean;
  keptApps?: string[];
  note?: boolean;
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "servarr-configure-"));
});

function fakes(appId: AppId, options: Options = {}) {
  const runsAs = options.runsAs ?? appId;
  const port = 30025;
  const base = `http://${BOX}:${port}`;
  const api = appId === "radarr" || appId === "sonarr" ? "v3" : "v1";
  let naming: Record<string, unknown> = structuredClone(options.naming ?? (STOCK as Record<string, Record<string, unknown>>)[appId] ?? {});
  const requests: string[] = [];
  const puts: Array<Record<string, unknown>> = [];
  const checkpoints: Array<{ id: string; message?: string; skipped?: boolean }> = [];
  let registered: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    if (url.origin !== base) throw new Error(`Unexpected request: ${method} ${url}`);
    const path = url.pathname.startsWith(`/api/${api}`) ? url.pathname.slice(`/api/${api}`.length) : url.pathname;
    requests.push(`${method} ${path}`);
    if (path === "/system/status") return Response.json({ startTime: "2026-11-11T00:00:00Z" });
    if (path === "/config/host") {
      return Response.json({ authenticationMethod: "forms", authenticationRequired: "enabled", allowedHosts: "", username: "owner" });
    }
    if (path === "/rootfolder") return Response.json([{ path: "/library" }]);
    if (path === "/movie" || path === "/series") {
      if (options.libraryDown) return Response.json({ message: "Database is locked" }, { status: 500 });
      return Response.json(options.library ?? []);
    }
    if (path === "/config/naming" && method === "GET") return Response.json(naming);
    if (path === `/config/naming/${naming.id}` && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      puts.push(body);
      if (options.refuses) return Response.json([{ propertyName: "StandardMovieFormat", errorMessage: options.refuses }], { status: 400 });
      if (!options.drops) naming = body;
      return Response.json(naming, { status: 202 });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as typeof fetch;

  const config = join(root, runsAs, "config");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "config.xml"), `<Config><ApiKey>${KEY}</ApiKey></Config>`);
  const note = join(config, "hexos", "naming.json");
  if (options.note) {
    mkdirSync(join(config, "hexos"), { recursive: true });
    writeFileSync(note, "{}");
  }
  const ctx = {
    resourceId: runsAs,
    catalogAppId: appId,
    baseUrl: base,
    mounts: [{ containerPath: "/config", hostPath: `/mnt/pool/apps/${runsAs}/config`, localPath: config }],
    ...(options.keptApps ? { keptApps: options.keptApps } : {}),
    registerCheckpoints: async (list: Array<{ id: string }>) => {
      registered = list.map((each) => each.id);
    },
    emitCheckpoint: async (id: string, message?: string) => {
      checkpoints.push({ id, message });
    },
    skipCheckpoint: async (id: string, message?: string) => {
      checkpoints.push({ id, message, skipped: true });
    },
    sleep: async () => {},
    log: () => {},
    fail: (message: string, context?: Array<{ label: string; value: string }>) => {
      throw new Error([message, ...(context ?? []).map((each) => `${each.label}: ${each.value}`)].join(" | "));
    },
  } as unknown as HookContext;
  return {
    ctx,
    naming: () => naming,
    puts,
    requests,
    note: () => (existsSync(note) ? (JSON.parse(readFileSync(note, "utf-8")) as unknown) : undefined),
    step: () => checkpoints.find((each) => each.id === "naming"),
    registered: () => registered,
  };
}

/** The step left the app's naming alone, said so, and wrote no note. */
function leftAlone(run: ReturnType<typeof fakes>, start: Record<string, unknown>, message: string) {
  expect(run.puts).toEqual([]);
  expect(run.naming()).toEqual(start);
  expect(run.step()).toEqual({ id: "naming", message, skipped: true });
}

for (const appId of ["radarr", "sonarr"] as const) {
  const name = appId === "radarr" ? "Radarr" : "Sonarr";
  const rename = appId === "radarr" ? "renameMovies" : "renameEpisodes";
  const folder = appId === "radarr" ? "movieFolderFormat" : "seriesFolderFormat";

  test(`a ${name} still as it started gets renaming on with HexOS's names, and a note of what was set`, async () => {
    const run = fakes(appId);
    await configure(run.ctx);
    // Everything the app holds goes back with the change, so what HexOS doesn't set stays as it was
    expect(run.puts).toEqual([{ ...STOCK[appId], ...HEXOS[appId] }]);
    expect(run.naming()).toEqual({ ...STOCK[appId], ...HEXOS[appId] });
    expect(run.note()).toEqual(HEXOS[appId]);
    expect(run.step()).toEqual({ id: "naming", message: undefined });
    expect(run.registered()).toEqual(["start", "signIn", "library-0", "naming"]);
  });

  test(`a second run leaves ${name}'s naming as the first set it`, async () => {
    const first = fakes(appId);
    await configure(first.ctx);
    const second = fakes(appId, { naming: first.naming(), note: true });
    await configure(second.ctx);
    leftAlone(second, first.naming(), `${name}'s naming was set up before`);
  });

  test(`a ${name} whose folder names the owner changed keeps its naming`, async () => {
    const start = { ...STOCK[appId], [folder]: "{My Own Format}" };
    const run = fakes(appId, { naming: start });
    await configure(run.ctx);
    leftAlone(run, start, `${name} keeps the naming it has`);
    expect(run.note()).toBeUndefined();
  });

  test(`a ${name} the owner already turned renaming on in keeps its naming`, async () => {
    const start = { ...STOCK[appId], [rename]: true };
    const run = fakes(appId, { naming: start });
    await configure(run.ctx);
    leftAlone(run, start, `${name} keeps the naming it has`);
    expect(run.note()).toBeUndefined();
  });

  test(`a ${name} the owner already had keeps its naming, even as it started`, async () => {
    const run = fakes(appId, { keptApps: [appId] });
    await configure(run.ctx);
    leftAlone(run, STOCK[appId], `${name} keeps the naming it has`);
    expect(run.note()).toBeUndefined();
    expect(run.requests).not.toContain("GET /config/naming");
  });

  test(`a ${name} with a note from an earlier run keeps its naming, even put back to how it started`, async () => {
    const run = fakes(appId, { note: true });
    await configure(run.ctx);
    leftAlone(run, STOCK[appId], `${name}'s naming was set up before`);
  });

  test(`a ${name} with a library keeps its naming, so nothing it holds is named two ways`, async () => {
    const run = fakes(appId, { library: [{ id: 1, title: "One the owner added" }] });
    await configure(run.ctx);
    leftAlone(run, STOCK[appId], `${name} already has ${appId === "radarr" ? "movies" : "shows"}, so it keeps the naming they have`);
    expect(run.note()).toBeUndefined();
  });

  test(`a ${name} that can't list its library is never taken for an empty one`, async () => {
    const run = fakes(appId, { libraryDown: true });
    await expect(configure(run.ctx)).rejects.toThrow(`HexOS couldn't read ${name}'s naming | Reason: Database is locked`);
    expect(run.puts).toEqual([]);
    expect(run.note()).toBeUndefined();
  });

  test(`a ${name} that refuses the naming fails the step with its own reason, and leaves no note`, async () => {
    const run = fakes(appId, { refuses: "Must contain movie title" });
    await expect(configure(run.ctx)).rejects.toThrow(`${name} didn't take its naming | Reason: Must contain movie title`);
    expect(run.note()).toBeUndefined();
  });

  test(`a ${name} that answers the change but keeps its old naming fails the step, and leaves no note`, async () => {
    const run = fakes(appId, { drops: true });
    await expect(configure(run.ctx)).rejects.toThrow(`${name} saved its naming, but HexOS couldn't find it there. Run this again.`);
    expect(run.note()).toBeUndefined();
  });
}

test("a later copy is judged by the name it runs under, not by the first copy's", async () => {
  const kept = fakes("radarr", { runsAs: "radarr-2", keptApps: ["radarr-2"] });
  await configure(kept.ctx);
  leftAlone(kept, STOCK.radarr, "Radarr keeps the naming it has");

  const fresh = fakes("radarr", { runsAs: "radarr-2", keptApps: ["radarr"] });
  await configure(fresh.ctx);
  expect(fresh.naming()).toEqual({ ...STOCK.radarr, ...HEXOS.radarr });
});

for (const appId of ["lidarr", "prowlarr"] as const) {
  test(`${appId} has no naming step, and its naming is never read`, async () => {
    const run = fakes(appId);
    await configure(run.ctx);
    expect(run.registered()).not.toContain("naming");
    expect(run.requests.some((request) => request.includes("/config/naming"))).toBe(false);
  });
}
