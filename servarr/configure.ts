// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { chownSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import type { ContextMount, HookContext, HookInputDeclaration } from "../_lib/hook_context";

/**
 * Sets Radarr, Sonarr, Lidarr, Chaptarr and Prowlarr up as HexOS ships them. Fresh, Radarr, Lidarr and
 * Prowlarr open on a screen that makes the owner choose a sign-in, and Sonarr on a sign-in page
 * whose password is only in its log. So HexOS gives each the sign-in the owner chose for the
 * install (`ctx.signIn`) and lets the home network in without it: seed-sign-in writes it into
 * config.xml before the first start, and configure-<app> checks it once the app is up, sets it on
 * an app that has another (an app the owner already had, which a collection brings in), and adds
 * the library HexOS mounts as the app's root folder. With no sign-in from the owner (a deck from
 * before they chose one) the app gets admin/admin, kept beside its settings so a later check knows
 * it's HexOS's. Read at Radarr 6.4.4, Sonarr 5.0.0, Lidarr 3.1.6, Chaptarr 0.9.965 and Prowlarr
 * 2.6.5, the versions TrueNAS pins.
 *
 * Radarr and Sonarr start with renaming off, so an import keeps its release's file name and only
 * the folder is named by the app. configure-<app> turns renaming on once, with names that carry the
 * movie's or show's id, on an app that is still as it started: renaming off, its own name formats,
 * nothing in its library, and not one the owner already had. What the owner sets is theirs, and so
 * is what they change afterwards, which a note in hexos/naming.json keeps true.
 */

interface Library {
  path: string;
  name: string;
  /** Chaptarr keeps ebooks and audiobooks in folders of their own, each with its own profiles. */
  format?: "ebook" | "audiobook";
}

interface Naming {
  /** The app's switch for renaming what it imports. */
  rename: string;
  /** Where the app lists what its library holds, and what it calls them. */
  holds: { path: string; name: string };
  /** Each name format: the one the app starts with (NamingConfig.Default) and the one HexOS gives it. */
  formats: Record<string, { stock: string; hexos: string }>;
}

/**
 * The folder names carry the id Jellyfin reads ([tmdbid-...], [tvdbid-...]), so a title shared by
 * two movies or shows is matched to the right one. Emby and Plex match those folders by title and
 * year. The file names follow the TRaSH guides' shape.
 */
const RADARR_NAMING: Naming = {
  rename: "renameMovies",
  holds: { path: "/movie", name: "movies" },
  formats: {
    movieFolderFormat: {
      stock: "{Movie Title} ({Release Year})",
      hexos: "{Movie CleanTitle} ({Release Year}) [tmdbid-{TmdbId}]",
    },
    standardMovieFormat: {
      stock: "{Movie Title} ({Release Year}) {Quality Full}",
      hexos:
        "{Movie CleanTitle} {(Release Year)} [tmdbid-{TmdbId}] - {Edition Tags }{[Custom Formats]}{[Quality Full]}{[MediaInfo 3D]}{[MediaInfo VideoDynamicRangeType]}{[Mediainfo AudioCodec}{ Mediainfo AudioChannels]}{[Mediainfo VideoCodec]}{-Release Group}",
    },
  },
};

const SONARR_NAMING: Naming = {
  rename: "renameEpisodes",
  holds: { path: "/series", name: "shows" },
  formats: {
    seriesFolderFormat: { stock: "{Series Title}", hexos: "{Series TitleYear} [tvdbid-{TvdbId}]" },
    seasonFolderFormat: { stock: "Season {season}", hexos: "Season {season:00}" },
    standardEpisodeFormat: {
      stock: "{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}",
      hexos: "{Series Title} - S{season:00}E{episode:00} - {Episode Title} - {Quality Full}",
    },
    dailyEpisodeFormat: {
      stock: "{Series Title} - {Air-Date} - {Episode Title} {Quality Full}",
      hexos: "{Series Title} - {Air-Date} - {Episode Title} - {Quality Full}",
    },
    animeEpisodeFormat: {
      stock: "{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}",
      hexos: "{Series Title} - S{season:00}E{episode:00} - {Episode Title} - {Quality Full}",
    },
  },
};

const APPS: Record<string, { name: string; api: string; libraries?: Library[]; noAllowedHosts?: boolean; naming?: Naming }> = {
  radarr: { name: "Radarr", api: "v3", libraries: [{ path: "/movies", name: "Movies" }], naming: RADARR_NAMING },
  sonarr: { name: "Sonarr", api: "v3", libraries: [{ path: "/shows", name: "Shows" }], naming: SONARR_NAMING },
  lidarr: { name: "Lidarr", api: "v1", libraries: [{ path: "/music", name: "Music" }] },
  chaptarr: {
    name: "Chaptarr",
    api: "v1",
    // Chaptarr takes "Disabled for Local Addresses" without a list, and keeps none in its file
    noAllowedHosts: true,
    libraries: [
      { path: "/books", name: "Books", format: "ebook" },
      { path: "/audiobooks", name: "Audiobooks", format: "audiobook" },
    ],
  },
  prowlarr: { name: "Prowlarr", api: "v1" },
};

/** Chaptarr's folderType, and the profile each format starts with (the UI's own numbers at 0.9.965). */
const CHAPTARR_FORMATS = {
  ebook: { folderType: 2, quality: "E-Book", metadata: "Ebook Default" },
  audiobook: { folderType: 1, quality: "Audiobook", metadata: "Audiobook Default" },
} as const;

/** The user the TrueNAS charts run these apps as. */
const APPS_UID = 568;
/** The sign-in an app gets when the owner chose none. */
const DEFAULT_SIGN_IN: SignIn = { username: "admin", password: "admin" };

interface SignIn {
  username: string;
  password: string;
}

interface HostConfig {
  authenticationMethod: string;
  authenticationRequired: string;
  allowedHosts: string;
  username: string;
  [field: string]: unknown;
}

interface Api {
  base: string;
  key: string;
  version: string;
}

function configMount(mounts: ContextMount[], appId: string): ContextMount | undefined {
  return mounts.find((m) => m.containerPath === "/config") ?? mounts.find((m) => new RegExp(`/${appId}(-\\d+)?/config$`).test(m.hostPath));
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

const xmlText = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

const signInPath = (config: ContextMount) => `${config.localPath}/hexos/sign-in.json`;

/** The default sign-in HexOS gave the app when the owner chose none. Never the owner's own. */
function savedSignIn(config: ContextMount): SignIn | undefined {
  try {
    const saved = JSON.parse(readText(signInPath(config)) ?? "") as Partial<SignIn>;
    return saved.username && saved.password ? { username: saved.username, password: saved.password } : undefined;
  } catch {
    return undefined;
  }
}

/** Kept before the app is told it, so a later check knows the app's sign-in is HexOS's default. */
function keepDefault(config: ContextMount): SignIn {
  mkdirSync(`${config.localPath}/hexos`, { recursive: true, mode: 0o700 });
  writeFileSync(signInPath(config), JSON.stringify(DEFAULT_SIGN_IN), { mode: 0o600 });
  return DEFAULT_SIGN_IN;
}

/** Once the app has the owner's sign-in, the default kept beside it no longer says anything true. */
const forgetDefault = (config: ContextMount) => rmSync(signInPath(config), { force: true });

function appOf(ctx: HookContext) {
  const catalogId = ctx.catalogAppId ?? ctx.resourceId;
  const app = APPS[catalogId];
  if (!app) ctx.fail(`HexOS can't set up ${ctx.resourceId} this way`);
  const config = configMount(ctx.mounts, catalogId);
  if (!config) ctx.fail(`HexOS couldn't find ${app.name}'s settings folder`);
  return { app, config };
}

/** The owner's answers, or undefined when they skip, the wait runs out, or this HexOS can't ask. */
async function ask(
  ctx: HookContext,
  inputs: HookInputDeclaration[],
  prompt: { title: string; description: string },
): Promise<Record<string, unknown> | undefined> {
  if (typeof ctx.askForInputs !== "function") return undefined;
  return ctx.askForInputs(inputs, prompt).catch((error: unknown) => {
    if (error instanceof Error && error.name === "HookInputsUnanswered") return undefined;
    throw error;
  });
}

const signInQuestions = (appName: string): HookInputDeclaration[] => [
  { type: "question", id: "username", question: { question: `${appName} username`, type: "text", key: "username", required: true } },
  { type: "question", id: "password", question: { question: `${appName} password`, type: "password", key: "password", required: true } },
];

// --- before the first start --------------------------------------------------

/**
 * A config.xml with the sign-in in it, written before the app makes its own. Radarr, Sonarr and
 * Lidarr make their first account from its Username and Password at the first start, then drop
 * both from the file; Prowlarr gets its account once it's up. Settings from an earlier install
 * keep theirs here, and configure-<app> gives them the owner's sign-in once the app is up.
 */
export async function seed(ctx: HookContext) {
  const { app, config } = appOf(ctx);
  await ctx.registerCheckpoints([{ id: "signIn", message: `Setting ${app.name}'s sign-in` }]);

  const configPath = `${config.localPath}/config.xml`;
  if (existsSync(configPath)) {
    await ctx.skipCheckpoint("signIn", `${app.name} keeps its settings from before`);
    return;
  }

  let signIn: SignIn;
  if (ctx.signIn) {
    signIn = ctx.signIn;
    forgetDefault(config);
  } else {
    signIn = savedSignIn(config) ?? keepDefault(config);
  }
  writeFileSync(
    configPath,
    [
      "<Config>",
      "  <AuthenticationMethod>Forms</AuthenticationMethod>",
      "  <AuthenticationRequired>DisabledForLocalAddresses</AuthenticationRequired>",
      `  <Username>${xmlText(signIn.username)}</Username>`,
      `  <Password>${xmlText(signIn.password)}</Password>`,
      "</Config>",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  chownSync(configPath, APPS_UID, APPS_UID);
  ctx.log(`${app.name}'s sign-in is set`);
  await ctx.emitCheckpoint("signIn");
}

// --- once it's up ------------------------------------------------------------

async function call<T>(api: Api, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${api.base}/api/${api.version}${path}`, {
    ...init,
    headers: { "X-Api-Key": api.key, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    // Only the app's own messages: a refused form can echo back what it was sent
    let reason = `${response.status} ${response.statusText}`;
    try {
      const body = JSON.parse(text) as Array<{ errorMessage?: string }> | { message?: string };
      reason = (Array.isArray(body) ? body.map((entry) => entry.errorMessage).filter(Boolean).join("; ") : body.message) || reason;
    } catch {}
    throw new Error(reason);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The app answers its API with the key it wrote at its first start. Until the seeded password has
 * left the file, that first start (which makes the account from it) isn't over.
 */
async function reach(ctx: HookContext, app: (typeof APPS)[string], config: ContextMount): Promise<Api> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const xml = readText(`${config.localPath}/config.xml`) ?? "";
    const key = xml.match(/<ApiKey>([^<]+)<\/ApiKey>/)?.[1];
    if (key && !xml.includes("<Password>")) {
      const api = { base: ctx.baseUrl, key, version: app.api };
      if (await call(api, "/system/status").then(() => true, () => false)) return api;
    }
    await ctx.sleep(5_000);
  }
  ctx.fail(`${app.name} didn't start. Try again once it's running.`);
}

const startedAt = (api: Api) =>
  call<{ startTime?: string }>(api, "/system/status").then((status) => status.startTime, () => undefined);

/** What the app asks of a browser on the home network: nothing, or a sign-in. */
async function door(base: string): Promise<"open" | "signIn" | undefined> {
  const response = await fetch(`${base}/`, { redirect: "manual", signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
  await response?.body?.cancel();
  if (response?.status === 200) return "open";
  if (response?.status === 302 || response?.status === 401) return "signIn";
  return undefined;
}

async function checkDoor(ctx: HookContext, app: (typeof APPS)[string]) {
  if ((await door(ctx.baseUrl)) !== "open") {
    ctx.fail(
      `${app.name} still asks for a sign-in on your home network. Run this again, or set Authentication Required to "Disabled for Local Addresses" in ${app.name}'s Settings, General.`,
    );
  }
}

/**
 * Whether the app takes this sign-in, through its own sign-in page: a refused one sends the browser
 * back to that page with `loginFailed`, a taken one to where it was going.
 */
async function signsIn(base: string, signIn: SignIn): Promise<boolean> {
  const response = await fetch(`${base}/login?returnUrl=%2F`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: signIn.username, password: signIn.password }),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
  await response?.body?.cancel();
  const location = response?.headers.get("location") ?? "";
  return response?.status === 302 && !location.includes("loginFailed");
}

/**
 * Gives the app a sign-in through its own settings, keeping how the owner had it ask for one when
 * they had it ask at all. The app takes "Disabled for Local Addresses" only with Allowed Hosts
 * filled in, and a list pinned to the box's address would shut the app off for good if that
 * address changes. So when the list is empty, the box's address stands in for this one save, the
 * file gets the empty list back, and the app restarts to read it, as a fresh install has it.
 */
async function setSignIn(
  ctx: HookContext,
  app: (typeof APPS)[string],
  config: ContextMount,
  api: Api,
  host: HostConfig,
  signIn: SignIn,
) {
  const kept = host.authenticationMethod === "forms" || host.authenticationMethod === "basic";
  const method = kept ? host.authenticationMethod : "forms";
  const required = kept && host.authenticationRequired ? host.authenticationRequired : "disabledForLocalAddresses";
  const allowedHosts = host.allowedHosts ?? "";
  const standIn =
    !app.noAllowedHosts && required === "disabledForLocalAddresses" && allowedHosts.trim() === "" ? new URL(api.base).hostname : undefined;
  try {
    await call(api, "/config/host", {
      method: "PUT",
      body: JSON.stringify({
        ...host,
        authenticationMethod: method,
        authenticationRequired: required,
        allowedHosts: standIn ?? allowedHosts,
        username: signIn.username,
        password: signIn.password,
        passwordConfirmation: signIn.password,
      }),
    });
  } catch (error) {
    ctx.fail(`${app.name} didn't take its sign-in`, [{ label: "Reason", value: reason(error) }]);
  }

  if (standIn) {
    const configPath = `${config.localPath}/config.xml`;
    const xml = readText(configPath) ?? "";
    const named = `<AllowedHosts>${standIn}</AllowedHosts>`;
    if (!xml.includes(named)) ctx.fail(`HexOS couldn't find the Allowed Hosts it set in ${app.name}'s settings file`);
    writeFileSync(configPath, xml.replace(named, "<AllowedHosts></AllowedHosts>"));
  }
  // A new sign-in method, and the Allowed Hosts put back in the file, take hold at the next start
  if (standIn || method !== host.authenticationMethod || required !== host.authenticationRequired) {
    const before = await startedAt(api);
    await call(api, "/system/restart", { method: "POST" }).catch(() => undefined);
    let restarted = false;
    for (let attempt = 0; attempt < 40 && !restarted; attempt++) {
      await ctx.sleep(3_000);
      const at = await startedAt(api);
      restarted = at !== undefined && at !== before;
    }
    if (!restarted) ctx.fail(`${app.name} didn't come back after HexOS restarted it. Try again once it's running.`);
  }

  const now = await call<HostConfig>(api, "/config/host");
  let taken = false;
  for (let attempt = 0; attempt < 10 && !taken; attempt++) {
    taken = await signsIn(api.base, signIn);
    if (!taken) await ctx.sleep(2_000);
  }
  if (
    now.authenticationMethod !== method ||
    now.authenticationRequired !== required ||
    now.username !== signIn.username.toLowerCase() ||
    (now.allowedHosts ?? "") !== allowedHosts ||
    !taken
  ) {
    ctx.fail(`${app.name} restarted without the sign-in HexOS gave it. Run this again.`);
  }
}

async function ensureSignIn(ctx: HookContext, app: (typeof APPS)[string], config: ContextMount, api: Api) {
  const host = await call<HostConfig>(api, "/config/host");
  const signedInAtHome = async () => {
    // Asking for a sign-in at home is the owner's choice to make
    if (host.authenticationRequired === "disabledForLocalAddresses") await checkDoor(ctx, app);
  };

  // The sign-in the owner chose for this install or collection: the app gets it, whatever it had
  const wanted = ctx.signIn;
  if (wanted) {
    if (host.authenticationMethod === "external") {
      await ctx.skipCheckpoint("signIn", `${app.name} signs in through your own sign-in service, so it keeps that`);
      return;
    }
    // The apps keep usernames in lower case
    const named = (host.authenticationMethod === "forms" || host.authenticationMethod === "basic") && host.username === wanted.username.toLowerCase();
    // Just started, an app can turn down the sign-in it was seeded with for a moment
    let takes = false;
    for (let attempt = 0; named && attempt < 5 && !takes; attempt++) {
      takes = await signsIn(ctx.baseUrl, wanted);
      if (!takes && attempt < 4) await ctx.sleep(2_000);
    }
    if (named && takes) {
      forgetDefault(config);
      await signedInAtHome();
      await ctx.skipCheckpoint("signIn", `${app.name} already uses the sign-in you chose`);
      return;
    }
    await setSignIn(ctx, app, config, api, host, wanted);
    forgetDefault(config);
    if ((await call<HostConfig>(api, "/config/host")).authenticationRequired === "disabledForLocalAddresses") {
      await checkDoor(ctx, app);
    }
    await ctx.emitCheckpoint("signIn", `${app.name} uses the sign-in you chose`);
    return;
  }

  // No sign-in from the owner: a run from the app's card, or a deck from before they chose one
  const saved = savedSignIn(config);
  const ours = saved !== undefined && host.username === saved.username.toLowerCase();
  if (host.authenticationMethod === "forms" && host.username) {
    if (ours) await signedInAtHome();
    await ctx.skipCheckpoint("signIn", ours ? `${app.name} already has its sign-in` : `${app.name} keeps the sign-in it has`);
    return;
  }
  // Set up by seed-sign-in with the account still to make (Prowlarr)
  if (host.authenticationMethod === "forms" && saved) {
    await setSignIn(ctx, app, config, api, host, saved);
    await checkDoor(ctx, app);
    await ctx.emitCheckpoint("signIn");
    return;
  }
  // Never had one: the owner chooses it here
  if (host.authenticationMethod === "none") {
    const answers = await ask(ctx, signInQuestions(app.name), {
      title: `Choose a sign-in for ${app.name}`,
      description: `${app.name} has no sign-in yet. Your home network still gets in without it.`,
    });
    const username = typeof answers?.username === "string" ? answers.username.trim() : "";
    const password = typeof answers?.password === "string" ? answers.password : "";
    if (!username || !password) {
      await ctx.skipCheckpoint("signIn", `${app.name} keeps opening without a sign-in`);
      return;
    }
    await setSignIn(ctx, app, config, api, host, { username, password });
    await checkDoor(ctx, app);
    await ctx.emitCheckpoint("signIn");
    return;
  }
  await ctx.skipCheckpoint("signIn", `${app.name} keeps the sign-in it has`);
}

const trimmed = (path: string) => path.replace(/\/+$/, "");

/** Chaptarr's body for a folder: its fields carry the format's name, so each format is its own form. */
async function chaptarrFolder(ctx: HookContext, api: Api, library: Library, format: "ebook" | "audiobook") {
  const wanted = CHAPTARR_FORMATS[format];
  const pick = (profiles: Array<{ id: number; name: string }>, name: string) =>
    profiles.find((profile) => profile.name === name) ?? profiles.find((profile) => profile.name !== "None");
  const quality = pick(await call(api, "/qualityprofile"), wanted.quality);
  const metadata = pick(await call(api, "/metadataprofile"), wanted.metadata);
  if (!quality || !metadata) ctx.fail(`Chaptarr has no profiles to give your ${library.name} folder yet. Try again in a minute.`);
  return {
    name: library.name,
    folderType: wanted.folderType,
    defaultTags: [],
    isCalibreLibrary: false,
    [`${format}Monitored`]: true,
    [`${format}MonitorExistingMode`]: "all",
    [`${format}MonitorNewItems`]: "all",
    [`${format}QualityProfileId`]: quality.id,
    [`${format}MetadataProfileId`]: metadata.id,
    [`${format}Tags`]: [],
  };
}

/** A library HexOS mounts, as a root folder of the app, when the app has none of its kind. */
async function ensureLibrary(ctx: HookContext, app: (typeof APPS)[string], api: Api, library: Library, checkpoint: string) {
  const folders = () => call<Array<{ path: string; folderType?: number }>>(api, "/rootfolder");
  const present = await folders();
  const haveOne = library.format
    ? present.some((entry) => entry.folderType === CHAPTARR_FORMATS[library.format as "ebook"].folderType || entry.folderType === 0)
    : present.length > 0;
  if (haveOne) {
    await ctx.skipCheckpoint(checkpoint, `${app.name} already has a ${library.name} folder`);
    return;
  }
  if (ctx.mounts.length > 0 && !ctx.mounts.some((m) => m.containerPath === library.path)) {
    await ctx.skipCheckpoint(checkpoint, `HexOS didn't give ${app.name} a ${library.name} folder, so it has none to add`);
    return;
  }

  const folder: Record<string, unknown> = { path: library.path };
  if (library.format) Object.assign(folder, await chaptarrFolder(ctx, api, library, library.format));
  if ((ctx.catalogAppId ?? ctx.resourceId) === "lidarr") {
    // Lidarr's Standard profiles when it has them: its form starts on "Any", which takes any bitrate
    // and never upgrades it. Never the empty "None" metadata profile.
    const pick = (profiles: Array<{ id: number; name: string }>) =>
      profiles.find((profile) => profile.name === "Standard") ??
      profiles.filter((profile) => profile.name !== "None").sort((a, b) => a.name.localeCompare(b.name))[0];
    const quality = pick(await call(api, "/qualityprofile"));
    const metadata = pick(await call(api, "/metadataprofile"));
    if (!quality || !metadata) ctx.fail("Lidarr has no profiles to give its music folder yet. Try again in a minute.");
    Object.assign(folder, {
      name: library.name,
      defaultQualityProfileId: quality.id,
      defaultMetadataProfileId: metadata.id,
      defaultMonitorOption: "all",
      defaultNewItemMonitorOption: "all",
      defaultTags: [],
    });
  }
  try {
    await call(api, "/rootfolder", { method: "POST", body: JSON.stringify(folder) });
  } catch (error) {
    // Another link may have added it in the meantime (Seerr's makes the same one)
    if (!(await folders()).some((entry) => trimmed(entry.path) === library.path)) {
      ctx.fail(`${app.name} didn't take your ${library.name} folder. Add it in ${app.name}'s Settings, Media Management.`, [
        { label: "Reason", value: reason(error) },
      ]);
    }
  }
  if (!(await folders()).some((entry) => trimmed(entry.path) === library.path)) {
    ctx.fail(`${app.name} saved your ${library.name} folder, but HexOS couldn't find it there`);
  }
  await ctx.emitCheckpoint(checkpoint);
}

const namingPath = (config: ContextMount) => `${config.localPath}/hexos/naming.json`;

/**
 * Renaming on, with HexOS's name formats, once. Only an app still as it started is changed: one the
 * owner already had, one whose naming they set, and one with anything in its library keep what they
 * have, since new names there would sit beside the old ones. The app's whole naming goes back with
 * the change, so the settings HexOS doesn't set stay as they are.
 */
async function ensureNaming(ctx: HookContext, app: (typeof APPS)[string], config: ContextMount, api: Api) {
  const naming = app.naming;
  if (!naming) return;
  const keeps = (why = `${app.name} keeps the naming it has`) => ctx.skipCheckpoint("naming", why);
  if (ctx.keptApps?.includes(ctx.resourceId)) return keeps();
  // Set once: naming the owner puts back to how the app started is still the owner's choice
  if (existsSync(namingPath(config))) return keeps(`${app.name}'s naming was set up before`);

  const read = () => call<Record<string, unknown> & { id: number }>(api, "/config/naming");
  const matches = (settings: Record<string, unknown>, rename: boolean, which: "stock" | "hexos") =>
    settings[naming.rename] === rename && Object.entries(naming.formats).every(([field, format]) => settings[field] === format[which]);
  let current: Awaited<ReturnType<typeof read>>;
  let held: unknown;
  try {
    current = await read();
    if (!matches(current, false, "stock")) return keeps();
    held = await call<unknown>(api, naming.holds.path);
  } catch (error) {
    ctx.fail(`HexOS couldn't read ${app.name}'s naming`, [{ label: "Reason", value: reason(error) }]);
  }
  // Only an empty list says the library is empty
  if (!Array.isArray(held) || held.length > 0) {
    return keeps(`${app.name} already has ${naming.holds.name}, so it keeps the naming they have`);
  }

  const wanted = {
    [naming.rename]: true,
    ...Object.fromEntries(Object.entries(naming.formats).map(([field, format]) => [field, format.hexos])),
  };
  try {
    await call(api, `/config/naming/${current.id}`, { method: "PUT", body: JSON.stringify({ ...current, ...wanted }) });
  } catch (error) {
    ctx.fail(`${app.name} didn't take its naming`, [{ label: "Reason", value: reason(error) }]);
  }
  if (!matches(await read(), true, "hexos")) ctx.fail(`${app.name} saved its naming, but HexOS couldn't find it there. Run this again.`);
  mkdirSync(`${config.localPath}/hexos`, { recursive: true, mode: 0o700 });
  writeFileSync(namingPath(config), JSON.stringify(wanted));
  await ctx.emitCheckpoint("naming");
}

export async function configure(ctx: HookContext) {
  const { app, config } = appOf(ctx);
  await ctx.registerCheckpoints([
    { id: "start", message: `Waiting for ${app.name} to start` },
    { id: "signIn", message: `Checking ${app.name}'s sign-in` },
    ...(app.libraries ?? []).map((library, index) => ({
      id: `library-${index}`,
      message: `Adding your ${library.name} folder to ${app.name}`,
    })),
    ...(app.naming ? [{ id: "naming", message: `Turning on renaming in ${app.name}` }] : []),
  ]);
  const api = await reach(ctx, app, config);
  await ctx.emitCheckpoint("start");
  await ensureSignIn(ctx, app, config, api);
  for (const [index, library] of (app.libraries ?? []).entries()) {
    await ensureLibrary(ctx, app, api, library, `library-${index}`);
  }
  await ensureNaming(ctx, app, config, api);
}
