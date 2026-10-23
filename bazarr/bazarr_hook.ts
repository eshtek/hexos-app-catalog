// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import type { ContextMount, HookContext } from "../_lib/hook_context";

/**
 * Sets Bazarr up to fetch English subtitles (configure-bazarr) and points it at Radarr or Sonarr
 * (connect-radarr, connect-sonarr). A fresh Bazarr has no languages profile and no subtitle
 * sources, so it fetches nothing. HexOS gives it an English profile, the default for new movies and
 * shows and given to the ones Bazarr already knows, and sources that need no account. Each is set
 * once, on a Bazarr that has none, and noted in hexos/subtitles.json beside Bazarr's settings, so
 * what the owner changes afterwards stays theirs. The links do it too, for a Bazarr installed
 * before HexOS did this. Bazarr mounts shows at /tv where Sonarr has them at /shows, so the Sonarr link also maps that
 * path; movies are at /movies in both. The forms are Bazarr's own, read at 1.6.2, the version
 * TrueNAS pins.
 */

/**
 * Subtitle sources that work without an account, by Bazarr's names: Gestdown (Addic7ed's shows),
 * YIFY Subtitles (movies), Subtitle Cat (both), and Embedded Subtitles, which copies out a track the
 * file already carries. Bazarr counts such a track as downloaded unless the owner turns that off.
 */
const PROVIDERS = ["embeddedsubtitles", "gestdown", "yifysubtitles", "subtitlecat"];

const ENGLISH = "en";

const MANAGERS: Record<"radarr" | "sonarr", { name: string; mappingSetting: string; mappings: Array<[string, string]> }> = {
  radarr: { name: "Radarr", mappingSetting: "path_mappings_movie", mappings: [] },
  sonarr: { name: "Sonarr", mappingSetting: "path_mappings", mappings: [["/shows", "/tv"]] },
};

type ManagerId = keyof typeof MANAGERS;

/** What HexOS has set up in this Bazarr, so a later run leaves the owner's changes alone. */
interface Setup {
  /** The languages profile HexOS made, noted before Bazarr has it. */
  profile?: number;
  /** That profile is the default and was given to what Bazarr already knew: the first setup is done. */
  given?: boolean;
  /** HexOS turned its subtitle sources on. */
  providers?: boolean;
}

interface Bazarr {
  base: string;
  key: string;
}

interface Profile {
  profileId: number;
  items: Array<{ language: string }>;
}

interface Settings {
  general: Record<string, unknown> & { enabled_providers?: string[] };
}

/** What a run did: set it up now, found the owner's own, or found what HexOS set up before. */
type Outcome = "made" | "kept" | "before";

function configMount(mounts: ContextMount[], appId: string): ContextMount | undefined {
  return mounts.find((m) => m.containerPath === "/config") ?? mounts.find((m) => m.hostPath.endsWith(`/${appId}/config`));
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

/** Bazarr's API key, from the `auth` block of its config.yaml. */
function bazarrKey(mounts: ContextMount[]): string | undefined {
  const yaml = readText(`${configMount(mounts, "bazarr")?.localPath}/config/config.yaml`);
  return yaml?.match(/^auth:\s*\n(?:[ \t]+.*\n)*?[ \t]+apikey:\s*['"]?([0-9a-f]+)/m)?.[1];
}

/** Bazarr once it answers with its key. It writes the key at its first start, before it answers. */
async function reach(ctx: HookContext, attempts: number): Promise<Bazarr> {
  for (let attempt = 1; ; attempt++) {
    const key = bazarrKey(ctx.mounts);
    if (key) {
      // Its status page asks Radarr and Sonarr their versions, so a cheaper page is asked instead
      const response = await fetch(`${ctx.baseUrl}/api/system/languages/profiles`, {
        headers: { "X-API-KEY": key },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
      await response?.body?.cancel();
      if (response?.ok) return { base: ctx.baseUrl, key };
    }
    if (attempt >= attempts) {
      ctx.fail(
        key
          ? "Bazarr didn't answer. Try again once it has started."
          : "HexOS couldn't read Bazarr's API key yet. Try again once it has started.",
      );
    }
    await ctx.sleep(5_000);
  }
}

/** One call to Bazarr's API: a form is posted, anything else read. A refusal fails the hook with `failure`. */
async function request<T>(ctx: HookContext, bazarr: Bazarr, failure: string, path: string, form?: URLSearchParams) {
  const headers: Record<string, string> = { "X-API-KEY": bazarr.key };
  if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
  const response = await fetch(`${bazarr.base}/api${path}`, {
    method: form ? "POST" : "GET",
    headers,
    body: form,
    // Saving a profile works out what every movie and episode is missing before it answers
    signal: AbortSignal.timeout(120_000),
  }).catch((error: unknown) => {
    ctx.fail(failure, [{ label: "Reason", value: error instanceof Error ? error.message : String(error) }]);
  });
  const text = await response.text();
  if (!response.ok) {
    ctx.fail(failure, [
      { label: "Status", value: String(response.status) },
      { label: "Reason", value: text.slice(0, 300) },
    ]);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

const LIBRARIES = [
  { name: "movies", path: "/movies", id: "radarrId", field: "radarrid", search: "wanted_search_missing_subtitles_movies" },
  { name: "shows", path: "/series", id: "sonarrSeriesId", field: "seriesid", search: "wanted_search_missing_subtitles_series" },
] as const;

/** The movies and shows Bazarr knows that have no languages profile. */
async function withoutProfile(ctx: HookContext, bazarr: Bazarr, library: (typeof LIBRARIES)[number]) {
  const listed = await request<{ data: Array<Record<string, number>> }>(
    ctx,
    bazarr,
    `HexOS couldn't read the ${library.name} Bazarr knows`,
    `${library.path}?profileid=none`,
  );
  return listed.data.map((item) => item[library.id]);
}

/**
 * Gives the profile to every movie and show Bazarr knew before it had one; the defaults cover the
 * rest. What it knew is searched now rather than at its next search, up to six hours away.
 */
async function give(ctx: HookContext, bazarr: Bazarr, profile: number) {
  for (const library of LIBRARIES) {
    const ids = await withoutProfile(ctx, bazarr, library);
    if (ids.length === 0) continue;
    for (let at = 0; at < ids.length; at += 100) {
      const form = new URLSearchParams();
      for (const id of ids.slice(at, at + 100)) {
        form.append(library.field, String(id));
        form.append("profileid", String(profile));
      }
      await request(ctx, bazarr, `Bazarr didn't take English for the ${library.name} it knows`, library.path, form);
    }
    const left = new Set(await withoutProfile(ctx, bazarr, library));
    if (ids.some((id) => left.has(id))) ctx.fail(`Bazarr saved English, but some ${library.name} it knows don't have it`);
    // Its own search on schedule finds them anyway, so one that won't start now is only noted
    const searched = await fetch(`${bazarr.base}/api/system/tasks`, {
      method: "POST",
      headers: { "X-API-KEY": bazarr.key, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ taskid: library.search }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => undefined);
    await searched?.body?.cancel();
    if (!searched?.ok) ctx.log(`Bazarr didn't start searching the ${library.name} it knows (${searched?.status ?? "no answer"})`);
  }
}

const isDefault = (settings: Settings, profile: number) =>
  ["serie", "movie"].every(
    (kind) =>
      settings.general[`${kind}_default_enabled`] === true && Number(settings.general[`${kind}_default_profile`]) === profile,
  );

function defaults(form: URLSearchParams, profile: number) {
  for (const kind of ["serie", "movie"]) {
    form.set(`settings-general-${kind}_default_enabled`, "true");
    form.set(`settings-general-${kind}_default_profile`, String(profile));
  }
}

/**
 * English subtitles from sources that need no account, set up once. A Bazarr with no languages
 * profile gets an English one, the default for new movies and shows, and given to the ones it
 * knows; one with no subtitle sources gets HexOS's. What it already has is the owner's, and so is
 * what they change after HexOS's setup.
 */
async function setUpSubtitles(ctx: HookContext, bazarr: Bazarr): Promise<{ english: Outcome; providers: Outcome }> {
  const config = configMount(ctx.mounts, "bazarr");
  if (!config) ctx.fail("HexOS couldn't find Bazarr's settings folder");
  const setupDir = `${config.localPath}/hexos`;
  const setupPath = `${setupDir}/subtitles.json`;
  const setup: Setup = (() => {
    try {
      return JSON.parse(readText(setupPath) ?? "{}") as Setup;
    } catch {
      return {};
    }
  })();
  const save = () => {
    mkdirSync(setupDir, { recursive: true });
    writeFileSync(setupPath, JSON.stringify(setup));
  };
  const profiles = () => request<Profile[]>(ctx, bazarr, "HexOS couldn't read Bazarr's languages", "/system/languages/profiles");
  const settings = () => request<Settings>(ctx, bazarr, "HexOS couldn't read Bazarr's settings", "/system/settings");

  const current = await settings();
  const languages = await request<Array<{ code2: string; enabled: boolean }>>(
    ctx,
    bazarr,
    "HexOS couldn't read Bazarr's languages",
    "/system/languages",
  );
  // Read last, just before the save: the form also removes every profile it isn't sent
  const existing = await profiles();

  const form = new URLSearchParams();
  // None, and none HexOS made that the owner has since removed
  const making = existing.length === 0 && !setup.given;
  let english: Outcome = setup.given ? "before" : "kept";
  if (making) {
    const profile = setup.profile ?? 1;
    // Noted first, so a run cut off once Bazarr has it still finishes the setup
    setup.profile = profile;
    save();
    // The form replaces the whole list of languages, so the ones already on go back with English
    for (const code of new Set([...languages.filter((l) => l.enabled).map((l) => l.code2), ENGLISH])) {
      form.append("languages-enabled", code);
    }
    form.set(
      "languages-profiles",
      JSON.stringify([
        {
          profileId: profile,
          name: "English",
          cutoff: null,
          items: [{ id: 1, language: ENGLISH, audio_exclude: "False", audio_only_include: "False", hi: "False", forced: "False" }],
          mustContain: [],
          mustNotContain: [],
          originalFormat: false,
          tag: null,
        },
      ]),
    );
    defaults(form, profile);
  }

  let providers: Outcome = "made";
  if (setup.providers) providers = "before";
  else if ((current.general.enabled_providers ?? []).length > 0) providers = "kept";
  if (providers === "made") for (const provider of PROVIDERS) form.append("settings-general-enabled_providers", provider);

  if ([...form.keys()].length > 0) {
    await request(ctx, bazarr, "Bazarr didn't save its subtitle settings", "/system/settings", form);
    if (providers === "made") {
      const enabled = (await settings()).general.enabled_providers ?? [];
      if (!PROVIDERS.every((provider) => enabled.includes(provider))) ctx.fail("Bazarr didn't turn on its subtitle sources");
      setup.providers = true;
      save();
    }
  }

  // The rest of the first setup, also for a run cut off part way: the defaults, then what Bazarr knew
  if (setup.profile !== undefined && !setup.given) {
    const profile = setup.profile;
    if ((await profiles()).some((entry) => entry.profileId === profile && entry.items.some((item) => item.language === ENGLISH))) {
      if (!isDefault(await settings(), profile)) {
        const again = new URLSearchParams();
        defaults(again, profile);
        await request(ctx, bazarr, "Bazarr didn't make English the default", "/system/settings", again);
        if (!isDefault(await settings(), profile)) ctx.fail("Bazarr didn't make English the default for new movies and shows");
      }
      await give(ctx, bazarr, profile);
      english = "made";
    } else if (making) {
      ctx.fail("Bazarr didn't keep the English languages profile");
    }
    // Otherwise the owner replaced it before HexOS finished, and theirs stays
    setup.given = true;
    save();
  }
  return { english, providers };
}

// --- the hooks ---------------------------------------------------------------

const BEFORE = "HexOS set this up before";

export async function configure(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "english", message: "Choosing English subtitles" },
    { id: "providers", message: "Turning on subtitle sources that need no account" },
  ]);
  // A first start sets up Bazarr's database before it answers
  const bazarr = await reach(ctx, 60);
  const { english, providers } = await setUpSubtitles(ctx, bazarr);
  if (english === "made") await ctx.emitCheckpoint("english");
  else await ctx.skipCheckpoint("english", english === "kept" ? "Bazarr already has a languages profile, so HexOS leaves it" : BEFORE);
  if (providers === "made") await ctx.emitCheckpoint("providers");
  else await ctx.skipCheckpoint("providers", providers === "kept" ? "Bazarr already has subtitle sources, so HexOS leaves them" : BEFORE);
}

async function connect(ctx: HookContext, managerId: ManagerId) {
  const manager = MANAGERS[managerId];
  await ctx.registerCheckpoints([
    { id: "locate", message: `Finding ${manager.name}` },
    { id: "subtitles", message: "Choosing English subtitles" },
    { id: "configure", message: `Pointing Bazarr at ${manager.name}` },
  ]);

  const bazarr = await reach(ctx, 6);
  const managerUrl = await ctx.getInstalledAppUrl(managerId);
  if (!managerUrl) ctx.fail(`${manager.name} isn't installed, or HexOS can't find its port`);
  const managerKey = readText(
    `${configMount(await ctx.getInstalledAppMounts(managerId), managerId)?.localPath}/config.xml`,
  )?.match(/<ApiKey>([^<]+)<\/ApiKey>/)?.[1];
  if (!managerKey) ctx.fail(`HexOS couldn't read ${manager.name}'s API key yet. Try again once it has started.`);
  // Bazarr's save doesn't answer until it reaches the manager, so one that isn't up yet is caught first
  const answered = await fetch(`${managerUrl}/api/v3/system/status`, {
    headers: { "X-Api-Key": managerKey },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
  await answered?.body?.cancel();
  if (!answered?.ok) ctx.fail(`${manager.name} isn't answering yet. Try again once it has started.`);
  await ctx.emitCheckpoint("locate");

  // A Bazarr installed before HexOS set this up gets it here, before its first sync with the manager
  const { english, providers } = await setUpSubtitles(ctx, bazarr);
  if (english === "made" || providers === "made") await ctx.emitCheckpoint("subtitles");
  else if (english === "before" && providers === "before") await ctx.skipCheckpoint("subtitles", BEFORE);
  else await ctx.skipCheckpoint("subtitles", "Bazarr already has its subtitle settings");

  const { hostname, port } = new URL(managerUrl);
  const form = new URLSearchParams({
    [`settings-general-use_${managerId}`]: "true",
    [`settings-${managerId}-ip`]: hostname,
    [`settings-${managerId}-port`]: port,
    [`settings-${managerId}-apikey`]: managerKey,
    [`settings-${managerId}-base_url`]: "",
    [`settings-${managerId}-ssl`]: "false",
  });
  if (manager.mappings.length > 0) {
    // Bazarr replaces the whole list with the one it is sent, an entry "from,to" per mapping, so the
    // owner's own mappings go back with this one; one they set for the same folder is theirs to keep
    const saved = (await request<Settings>(ctx, bazarr, "HexOS couldn't read Bazarr's settings", "/system/settings")).general[
      manager.mappingSetting
    ];
    const mappings = (Array.isArray(saved) ? saved : []).filter(
      (entry): entry is [string, string] =>
        Array.isArray(entry) && entry.length === 2 && entry.every((part) => typeof part === "string"),
    );
    for (const mapping of manager.mappings) {
      if (!mappings.some(([from]) => from === mapping[0])) mappings.push(mapping);
    }
    for (const [from, to] of mappings) form.append(`settings-general-${manager.mappingSetting}`, `${from},${to}`);
  }
  await request(ctx, bazarr, `Bazarr didn't accept ${manager.name}`, "/system/settings", form);

  // Bazarr reads the manager's library as soon as it reaches it, so it has to reach it
  for (let attempt = 1; ; attempt++) {
    const status = await request<{ data: Record<string, string> }>(ctx, bazarr, "HexOS couldn't read Bazarr's status", "/system/status");
    const version = status.data[`${managerId}_version`];
    if (version && version !== "unknown") break;
    if (attempt >= 3) {
      ctx.fail(`Bazarr couldn't reach ${manager.name}. Check that ${manager.name} is running, then try again.`, [
        { label: "Address", value: `${hostname}:${port}` },
      ]);
    }
    await ctx.sleep(5_000);
  }
  await ctx.emitCheckpoint("configure");
}

export const radarr = (ctx: HookContext) => connect(ctx, "radarr");
export const sonarr = (ctx: HookContext) => connect(ctx, "sonarr");
