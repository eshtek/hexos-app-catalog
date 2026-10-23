// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { chownSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import type { ContextMount, HookContext, HookInputDeclaration } from "../_lib/hook_context";

/**
 * Sets Radarr, Sonarr, Lidarr and Prowlarr up as HexOS ships them. Fresh, Radarr, Lidarr and
 * Prowlarr open on a screen that makes the owner choose a sign-in, and Sonarr on a sign-in page
 * whose password is only in its log. So HexOS gives each the sign-in the owner chose for the
 * install (`ctx.signIn`) and lets the home network in without it: seed-sign-in writes it into
 * config.xml before the first start, and configure-<app> checks it once the app is up, sets it on
 * an app that has another (an app the owner already had, which a collection brings in), and adds
 * the library HexOS mounts as the app's root folder. With no sign-in from the owner (a deck from
 * before they chose one) the app gets admin/admin, kept beside its settings so a later check knows
 * it's HexOS's. Read at Radarr 6.4.4, Sonarr 5.0.0, Lidarr 3.1.6 and Prowlarr 2.6.5, the versions
 * TrueNAS pins.
 */

const APPS: Record<string, { name: string; api: string; library?: { path: string; name: string } }> = {
  radarr: { name: "Radarr", api: "v3", library: { path: "/movies", name: "Movies" } },
  sonarr: { name: "Sonarr", api: "v3", library: { path: "/shows", name: "Shows" } },
  lidarr: { name: "Lidarr", api: "v1", library: { path: "/music", name: "Music" } },
  prowlarr: { name: "Prowlarr", api: "v1" },
};

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
  return mounts.find((m) => m.containerPath === "/config") ?? mounts.find((m) => m.hostPath.endsWith(`/${appId}/config`));
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
  const app = APPS[ctx.resourceId];
  if (!app) ctx.fail(`HexOS can't set up ${ctx.resourceId} this way`);
  const config = configMount(ctx.mounts, ctx.resourceId);
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
    body: new URLSearchParams({ username: signIn.username, password: signIn.password, rememberMe: "on" }),
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
    required === "disabledForLocalAddresses" && allowedHosts.trim() === "" ? new URL(api.base).hostname : undefined;
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
    if (named && (await signsIn(ctx.baseUrl, wanted))) {
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

/** The library HexOS mounts, as the app's root folder, when it has none. */
async function ensureLibrary(ctx: HookContext, app: (typeof APPS)[string], api: Api) {
  const library = app.library;
  if (!library) return;
  const folders = () => call<Array<{ path: string }>>(api, "/rootfolder");
  if ((await folders()).length > 0) {
    await ctx.skipCheckpoint("library", `${app.name} already has a library folder`);
    return;
  }
  if (ctx.mounts.length > 0 && !ctx.mounts.some((m) => m.containerPath === library.path)) {
    await ctx.skipCheckpoint("library", `HexOS didn't give ${app.name} a ${library.name} folder, so it has none to add`);
    return;
  }

  const folder: Record<string, unknown> = { path: library.path };
  if (ctx.resourceId === "lidarr") {
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
  await ctx.emitCheckpoint("library");
}

export async function configure(ctx: HookContext) {
  const { app, config } = appOf(ctx);
  await ctx.registerCheckpoints([
    { id: "start", message: `Waiting for ${app.name} to start` },
    { id: "signIn", message: `Checking ${app.name}'s sign-in` },
    ...(app.library ? [{ id: "library", message: `Adding your ${app.library.name} folder to ${app.name}` }] : []),
  ]);
  const api = await reach(ctx, app, config);
  await ctx.emitCheckpoint("start");
  await ensureSignIn(ctx, app, config, api);
  await ensureLibrary(ctx, app, api);
}
