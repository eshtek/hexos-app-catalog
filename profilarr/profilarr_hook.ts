// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import type { ContextMount, HookContext, HookInputDeclaration } from "../_lib/hook_context";

/**
 * Sets Profilarr up as HexOS ships it (configure-profilarr) and sends its profiles to Radarr and
 * Sonarr (connect-radarr, connect-sonarr). Profilarr does nothing until it has an account, and
 * adding an app or choosing its profiles are sign-in-only forms, so HexOS makes the account with the
 * sign-in the owner chose for the install or collection (`ctx.signIn`), which the links sign in
 * with too. Profilarr 2.2 could let the home network in without it, and gets that switched on;
 * 2.3 dropped the switch, so there the owner signs in with what they chose. A Profilarr the owner
 * already had, which a collection brings in, gets the password they chose (Profilarr has one
 * account and can't rename it). With no sign-in chosen (a deck from before they did) it gets
 * admin/adminadmin, kept beside its settings so the links can sign in; a link run from the card
 * asks for the sign-in when it has neither. The profiles are the Dictionarry database's; every one
 * of them gets "Not English", scored as Dictionarry scores a release a profile must never take, so
 * Radarr and Sonarr only grab releases with English in them. The forms are Profilarr's own pages,
 * read at 2.2.0 and 2.3.1, the version TrueNAS pins.
 */

const DICTIONARRY = "https://github.com/Dictionarry-Hub/database";
/**
 * The sign-in Profilarr gets when the owner chose none. Profilarr refuses a password under 8
 * characters, so it is longer than the other apps' "admin".
 */
const DEFAULT_SIGN_IN: Credentials = { username: "admin", password: "adminadmin" };

/** The profiles a link gives Radarr or Sonarr: an everyday, a quality and a 4K choice of each kind. */
const PROFILES = [
  "1080p Balanced",
  "1080p Quality",
  "1080p Quality HDR",
  "2160p Balanced",
  "2160p Quality",
  "2160p Remux",
];

const NOT_ENGLISH = "Not English";
/** Dictionarry's score for what a profile must never take: no release climbs back above the minimum. */
const NEVER = -999999;

const MANAGERS = {
  radarr: { name: "Radarr" },
  sonarr: { name: "Sonarr" },
} as const;

type ManagerId = keyof typeof MANAGERS;

interface Session {
  base: string;
  cookie?: string;
}

interface Credentials {
  username: string;
  password: string;
}

interface SignIn {
  session: Session;
  /** HexOS made the account just now: Profilarr was never set up. */
  made: boolean;
  /** The account is the one HexOS made, now or before. */
  ours: boolean;
  /** The sign-in the session was made with; undefined when the home network got in without one (2.2). */
  with?: Credentials;
}

interface ActionResult {
  type: string;
  status?: number;
  data?: Record<string, unknown>;
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

// --- talking to Profilarr ----------------------------------------------------

/**
 * SvelteKit sends page and form data as devalue's flattened array: the value is at index 0, and
 * each member of an array or object is the index of its own value. -1 is undefined.
 */
function hydrate(values: unknown[], at: number): unknown {
  if (at < 0) return undefined;
  const value = values[at];
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    // A typed value (["Date", "..."]): only dates come up in these pages
    if (typeof value[0] === "string") return value[0] === "Date" ? value[1] : undefined;
    return value.map((member) => hydrate(values, member as number));
  }
  return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, hydrate(values, member as number)]));
}

function call(session: Session, path: string, init: { form?: Record<string, string>; json?: unknown } = {}) {
  // The Origin is Profilarr's own, as its pages send it: SvelteKit refuses a form posted from elsewhere
  const headers: Record<string, string> = { Accept: "application/json", Origin: session.base };
  if (session.cookie) headers.Cookie = session.cookie;
  let body: string | undefined;
  if (init.form) {
    body = new URLSearchParams(init.form).toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  } else if (init.json !== undefined) {
    body = JSON.stringify(init.json);
    headers["Content-Type"] = "application/json";
  }
  return fetch(`${session.base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(60_000),
  });
}

async function getJson<T>(session: Session, path: string): Promise<T> {
  const response = await call(session, path);
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

/** A page's own data, as its load gives it to the page. */
async function pageData<T>(session: Session, path: string): Promise<T> {
  const body = await getJson<{ type?: string; nodes?: Array<{ type?: string; data?: unknown[] } | null> }>(
    session,
    `${path}/__data.json`,
  );
  const page = body.nodes?.at(-1);
  if (body.type !== "data" || page?.type !== "data" || !page.data) throw new Error(`${path} sent no page data`);
  return hydrate(page.data, 0) as T;
}

/** Submit one of a page's forms. A form that refuses answers `failure`, with its error in `data`. */
async function act(session: Session, path: string, form: Record<string, string>): Promise<ActionResult> {
  const response = await call(session, path, { form });
  const text = await response.text();
  let body: { type?: string; status?: number; data?: string };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${path}: ${response.status} ${text.slice(0, 200)}`);
  }
  const cookie = response.headers
    .getSetCookie()
    .map((header) => header.split(";")[0])
    .find((pair) => pair.startsWith("session="));
  if (cookie) session.cookie = cookie;
  const data = typeof body.data === "string" ? hydrate(JSON.parse(body.data), 0) : undefined;
  return { type: body.type ?? "error", status: body.status, data: data as Record<string, unknown> | undefined };
}

const actionError = (result: ActionResult) =>
  typeof result.data?.error === "string" ? result.data.error : `${result.type} ${result.status ?? ""}`.trim();

// --- signing in --------------------------------------------------------------

type Door = "setup" | "open" | "signIn";

/** What Profilarr asks of a caller with no session: an account made first, nothing, or a sign-in. */
async function door(base: string): Promise<Door | undefined> {
  const response = await call({ base }, "/api/v1/status").catch(() => undefined);
  if (!response) return undefined;
  await response.body?.cancel();
  if (response.status === 200) return "open";
  if (response.status === 401) return "signIn";
  if (response.status === 303 && response.headers.get("location")?.includes("/auth/setup")) return "setup";
  return undefined;
}

/** Profilarr links Dictionarry before it first answers, which takes a while on a fresh install. */
async function waitForDoor(ctx: HookContext): Promise<Door> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const answer = await door(ctx.baseUrl);
    if (answer) return answer;
    await ctx.sleep(5_000);
  }
  ctx.fail("Profilarr didn't answer. Try again once it has started.");
}

const savedPath = (config: ContextMount) => `${config.localPath}/hexos/sign-in.json`;

/** The default sign-in HexOS gave Profilarr when the owner chose none. Never the owner's own. */
function savedSignIn(config: ContextMount): Credentials | undefined {
  try {
    const saved = JSON.parse(readText(savedPath(config)) ?? "") as Partial<Credentials>;
    return saved.username && saved.password ? { username: saved.username, password: saved.password } : undefined;
  } catch {
    return undefined;
  }
}

async function ask(ctx: HookContext, inputs: HookInputDeclaration[], prompt: { title: string; description: string }) {
  if (typeof ctx.askForInputs !== "function") return undefined;
  return ctx.askForInputs(inputs, prompt).catch((error: unknown) => {
    if (error instanceof Error && error.name === "HookInputsUnanswered") return undefined;
    throw error;
  });
}

/** Asks the owner for Profilarr's sign-in, and signs in with it. Undefined when they don't give it. */
async function askSignIn(ctx: HookContext, description: string): Promise<{ session: Session; with: Credentials } | undefined> {
  const answers = await ask(
    ctx,
    [
      { type: "question", id: "username", question: { question: "Profilarr username", type: "text", key: "username", required: true } },
      { type: "question", id: "password", question: { question: "Profilarr password", type: "password", key: "password", required: true } },
    ],
    { title: "Sign in to Profilarr", description },
  );
  const given = { username: String(answers?.username ?? "").trim(), password: String(answers?.password ?? "") };
  if (!given.username || !given.password) return undefined;
  const session: Session = { base: ctx.baseUrl };
  const signedIn = await act(session, "/auth/login", given);
  if (signedIn.type !== "redirect" || !session.cookie) {
    ctx.fail("Profilarr didn't accept that username and password. Run this again from Profilarr's Connections tab.");
  }
  return { session, with: given };
}

/**
 * Sign in to Profilarr. One with no account yet gets the owner's sign-in, or HexOS's default; one
 * with an account takes the owner's sign-in or the default, or none when the home network is let
 * in (2.2). Undefined when Profilarr has an account HexOS can't sign in to.
 */
async function signIn(ctx: HookContext): Promise<SignIn | undefined> {
  const config = configMount(ctx.mounts, "profilarr");
  if (!config) ctx.fail("HexOS couldn't find Profilarr's settings folder");
  const saved = savedSignIn(config);
  const way = await waitForDoor(ctx);

  if (way === "setup") {
    const account = ctx.signIn ?? DEFAULT_SIGN_IN;
    if (ctx.signIn) {
      rmSync(savedPath(config), { force: true });
    } else {
      // Kept before the account exists, for the links
      mkdirSync(`${config.localPath}/hexos`, { recursive: true, mode: 0o700 });
      writeFileSync(savedPath(config), JSON.stringify(account), { mode: 0o600 });
    }
    const session: Session = { base: ctx.baseUrl };
    // Named fields only: the owner's email in the sign-in is not Profilarr's
    const made = await act(session, "/auth/setup", {
      username: account.username,
      password: account.password,
      confirmPassword: account.password,
    });
    if (made.type !== "redirect" || !session.cookie) {
      ctx.fail("Profilarr didn't make its sign-in", [{ label: "Reason", value: actionError(made) }]);
    }
    await letHomeNetworkIn(ctx, session);
    return { session, made: true, ours: true, with: account };
  }
  // Profilarr counts refused sign-ins against the caller, so only the two HexOS knows are tried
  for (const known of [ctx.signIn, saved]) {
    if (!known) continue;
    const session: Session = { base: ctx.baseUrl };
    const signedIn = await act(session, "/auth/login", { username: known.username, password: known.password });
    if (signedIn.type === "redirect" && session.cookie) return { session, made: false, ours: true, with: known };
  }
  return way === "open" ? { session: { base: ctx.baseUrl }, made: false, ours: false } : undefined;
}

/**
 * Gives a Profilarr the owner already had the password they chose. Profilarr has one account and no
 * way to rename it, so its username stays; changing the password takes the current one, which HexOS
 * has only when the account is its default, and otherwise asks for.
 */
async function takeChosenPassword(ctx: HookContext, signedIn: SignIn | undefined): Promise<SignIn | undefined> {
  const wanted = ctx.signIn;
  if (!wanted) return signedIn;
  if (signedIn?.with?.password === wanted.password) return signedIn;
  let current = signedIn?.with ? { session: signedIn.session, with: signedIn.with } : undefined;
  current ??= await askSignIn(ctx, "Enter the sign-in you use for Profilarr now, so HexOS can change its password to the one you chose.");
  if (!current) return signedIn;
  const changed = await act(current.session, "/settings/security?/changePassword", {
    currentPassword: current.with.password,
    newPassword: wanted.password,
    confirmPassword: wanted.password,
  });
  if (changed.data?.passwordSuccess !== true) {
    ctx.fail("Profilarr didn't take the password you chose", [{ label: "Reason", value: actionError(changed) }]);
  }
  const config = configMount(ctx.mounts, "profilarr");
  if (config) rmSync(savedPath(config), { force: true });
  const session: Session = { base: ctx.baseUrl };
  const account = { username: current.with.username, password: wanted.password };
  const again = await act(session, "/auth/login", account);
  if (again.type !== "redirect" || !session.cookie) ctx.fail("Profilarr changed its password, but doesn't take the one you chose. Run this again.");
  return { session, made: false, ours: signedIn?.ours ?? false, with: account };
}

/**
 * The local-network bypass is a switch that flips, so it is flipped only while it reads off.
 * Profilarr 2.3 has no such switch, and its page says nothing about one.
 */
async function letHomeNetworkIn(ctx: HookContext, session: Session) {
  const { localBypassEnabled } = await pageData<{ localBypassEnabled?: boolean }>(session, "/settings/security");
  if (localBypassEnabled !== false) return;
  const flipped = await act(session, "/settings/security?/toggleLocalBypass", {});
  if (flipped.data?.localBypassEnabled !== true) {
    ctx.fail("Profilarr didn't let the home network in", [{ label: "Reason", value: actionError(flipped) }]);
  }
}

// --- the Dictionarry database ------------------------------------------------

interface ProfilarrStatus {
  databases: Array<{ id: number; counts: { qualityProfiles: number } }>;
  arrs: Array<{ id: number; sync: { qualityProfiles: { count: number; status: string } } }>;
}

/** Dictionarry's id once its profiles are loaded. A Profilarr with no database at all is given it. */
async function dictionarry(ctx: HookContext, session: Session): Promise<number> {
  const linked = () => getJson<Array<{ id: number; repository_url: string }>>(session, "/api/v1/databases");
  let databases = await linked();
  // Profilarr links it at its first start, and never again if GitHub didn't answer then
  if (databases.length === 0) {
    const response = await call(session, "/api/v1/databases", {
      json: { name: "Dictionarry", repository_url: DICTIONARRY, branch: "v2", sync_strategy: 60, auto_pull: true },
    });
    if (!response.ok) {
      ctx.fail("Profilarr couldn't load the Dictionarry database", [
        { label: "Status", value: String(response.status) },
        { label: "Reason", value: (await response.text()).slice(0, 300) },
      ]);
    }
    databases = await linked();
  }
  const database = databases.find((entry) => entry.repository_url.replace(/\.git$/, "") === DICTIONARRY);
  if (!database) ctx.fail("Profilarr doesn't use the Dictionarry database, so HexOS leaves its profiles to you.");
  for (let attempt = 0; attempt < 36; attempt++) {
    const status = await getJson<ProfilarrStatus>(session, "/api/v1/status");
    if ((status.databases.find((entry) => entry.id === database.id)?.counts.qualityProfiles ?? 0) > 0) return database.id;
    await ctx.sleep(5_000);
  }
  ctx.fail("Profilarr's Dictionarry database has no profiles yet. Try again in a few minutes.");
}

interface PortableProfile {
  upgradesAllowed?: boolean;
  minimumScore: number;
  upgradeUntilScore: number;
  upgradeScoreIncrement: number;
  customFormatScores: Array<{ customFormatName: string; arrType: string; score: number }>;
}

async function exported<T>(session: Session, database: number, entityType: string, name: string): Promise<T | undefined> {
  const query = new URLSearchParams({ entityType, name });
  const response = await call(session, `/databases/${database}/export?${query}`);
  if (response.status === 404) {
    await response.body?.cancel();
    return undefined;
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`export ${name}: ${response.status} ${text.slice(0, 200)}`);
  return (JSON.parse(text) as { data: T }).data;
}

const refusesNonEnglish = (profile: PortableProfile | undefined) =>
  ["radarr", "sonarr"].every((arrType) =>
    profile?.customFormatScores.some(
      (entry) => entry.customFormatName === NOT_ENGLISH && entry.arrType === arrType && entry.score === NEVER,
    ),
  );

/**
 * Every profile refuses a release with no English in it. Dictionarry already refuses one in neither
 * English nor the original language; this goes on top, as the owner's own edit, so Dictionarry's
 * updates leave it in place. A profile that already scores it is left as it is.
 */
async function wantEnglish(
  ctx: HookContext,
  session: Session,
  database: number,
  progress?: (message: string) => Promise<void>,
) {
  if (!(await exported(session, database, "custom_format", NOT_ENGLISH))) {
    const response = await call(session, `/databases/${database}/import`, {
      json: {
        layer: "user",
        entityType: "custom_format",
        data: {
          name: NOT_ENGLISH,
          description: "Matches releases that don't include English. Other languages are allowed.",
          includeInRename: false,
          tags: ["Language"],
          conditions: [
            {
              name: "English",
              type: "language",
              arrType: "all",
              negate: true,
              required: true,
              languages: [{ name: "English", except: false }],
            },
          ],
          tests: [],
        },
      },
    });
    if (!response.ok) {
      ctx.fail("Profilarr didn't take the English format", [
        { label: "Status", value: String(response.status) },
        { label: "Reason", value: (await response.text()).slice(0, 300) },
      ]);
    }
  }
  // A format with no condition would match every release, and scored like this one it would refuse them all
  const format = await exported<{ conditions?: Array<{ type?: string; negate?: boolean; languages?: Array<{ name?: string }> }> }>(
    session,
    database,
    "custom_format",
    NOT_ENGLISH,
  );
  const english = format?.conditions?.length === 1 && format.conditions[0];
  if (!english || english.type !== "language" || !english.negate || english.languages?.[0]?.name !== "English") {
    ctx.fail(`Profilarr has a format named ${NOT_ENGLISH} that isn't HexOS's, so HexOS leaves the profiles as they are.`);
  }

  const { qualityProfiles } = await pageData<{ qualityProfiles?: Array<{ id: number; name: string }> }>(
    session,
    `/quality-profiles/${database}`,
  );
  if (!qualityProfiles?.length) ctx.fail("Profilarr listed no profiles in the Dictionarry database");
  for (const [at, { id, name }] of qualityProfiles.entries()) {
    await progress?.(`Making every profile want English (${at + 1} of ${qualityProfiles.length})`);
    const profile = await exported<PortableProfile>(session, database, "quality_profile", name);
    if (!profile || refusesNonEnglish(profile)) continue;
    // The form sets the profile's scores from what it is sent, so they go back as they are
    const scored = await act(session, `/quality-profiles/${database}/${id}/scoring?/update`, {
      upgradesAllowed: String(profile.upgradesAllowed !== false),
      minimumScore: String(profile.minimumScore),
      upgradeUntilScore: String(profile.upgradeUntilScore),
      upgradeScoreIncrement: String(profile.upgradeScoreIncrement),
      layer: "user",
      customFormatScores: JSON.stringify(
        ["radarr", "sonarr"].map((arrType) => ({ customFormatName: NOT_ENGLISH, arrType, score: NEVER })),
      ),
    });
    if (scored.type !== "success") {
      ctx.fail(`Profilarr didn't change ${name}`, [{ label: "Reason", value: actionError(scored) }]);
    }
  }
  for (const { name } of qualityProfiles) {
    if (!refusesNonEnglish(await exported<PortableProfile>(session, database, "quality_profile", name))) {
      ctx.fail(`Profilarr saved the English rule, but ${name} doesn't have it`);
    }
  }
}

// --- the hooks ---------------------------------------------------------------

/** Profilarr can't rename its account, so a username other than the one chosen is named. */
function chosenPasswordMessage(ctx: HookContext, signedIn: SignIn): string {
  const username = signedIn.with?.username;
  return username && ctx.signIn && username !== ctx.signIn.username
    ? `Profilarr uses the password you chose, with its username ${username}`
    : "Profilarr uses the password you chose";
}

export async function configure(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "signin", message: "Making Profilarr's sign-in" },
    { id: "database", message: "Loading Dictionarry's profiles" },
    { id: "english", message: "Making every profile want English" },
  ]);
  const before = await signIn(ctx);
  const signedIn = await takeChosenPassword(ctx, before);
  if (!signedIn?.ours) {
    if (signedIn && signedIn !== before) await ctx.emitCheckpoint("signin", chosenPasswordMessage(ctx, signedIn));
    else await ctx.skipCheckpoint("signin", "Profilarr keeps the sign-in it has");
    for (const id of ["database", "english"]) await ctx.skipCheckpoint(id, "Profilarr was set up before, so its profiles stay as they are");
    return;
  }
  const { session, made } = signedIn;
  if (made) await ctx.emitCheckpoint("signin");
  else if (signedIn !== before) await ctx.emitCheckpoint("signin", chosenPasswordMessage(ctx, signedIn));
  else await ctx.skipCheckpoint("signin", "Profilarr already has its sign-in");
  const database = await dictionarry(ctx, session);
  await ctx.emitCheckpoint("database");
  await wantEnglish(ctx, session, database, (message) => ctx.updateCheckpointMessage("english", message));
  await ctx.emitCheckpoint("english", "Every profile wants English");
}

interface ArrDelayProfile {
  id: number;
  [field: string]: unknown;
}

async function arrCall<T>(url: string, apiKey: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${url}/api/v3${path}`, {
    ...init,
    headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text.slice(0, 300) || `${response.status} ${response.statusText}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

async function connect(ctx: HookContext, managerId: ManagerId) {
  const manager = MANAGERS[managerId];
  await ctx.registerCheckpoints([
    { id: "locate", message: `Finding ${manager.name}` },
    { id: "signin", message: "Signing in to Profilarr" },
    { id: "add", message: `Adding ${manager.name} to Profilarr` },
    { id: "sync", message: `Sending Profilarr's profiles to ${manager.name}` },
  ]);

  const managerUrl = await ctx.getInstalledAppUrl(managerId);
  if (!managerUrl) ctx.fail(`${manager.name} isn't installed, or HexOS can't find its port`);
  const managerKey = readText(
    `${configMount(await ctx.getInstalledAppMounts(managerId), managerId)?.localPath}/config.xml`,
  )?.match(/<ApiKey>([^<]+)<\/ApiKey>/)?.[1];
  if (!managerKey) ctx.fail(`HexOS couldn't read ${manager.name}'s API key yet. Try again once it has started.`);
  await ctx.emitCheckpoint("locate");

  const signedIn =
    (await signIn(ctx)) ??
    (await askSignIn(ctx, `Enter the sign-in you use for Profilarr, so HexOS can add ${manager.name} to it.`).then((given) =>
      given ? { ...given, made: false, ours: false } : undefined,
    ));
  // The owner skipped giving the sign-in, so trying again can't help
  if (!signedIn) {
    const message = `HexOS couldn't sign in to Profilarr, so it can't add ${manager.name} to it. Run this again from Profilarr's Connections tab.`;
    if (ctx.skip) ctx.skip(message);
    ctx.fail(message);
  }
  const { session, made } = signedIn;
  const database = await dictionarry(ctx, session);
  // A Profilarr HexOS never set up is set up now, as its install would have
  if (made) await wantEnglish(ctx, session, database);
  await ctx.emitCheckpoint("signin");

  const listed = () => getJson<Array<{ id: number; type: string; url: string }>>(session, "/api/v1/arr");
  const sameUrl = (url: string) => url.replace(/\/+$/, "") === managerUrl;
  let instance = (await listed()).find((entry) => entry.type === managerId && sameUrl(entry.url));
  if (instance) {
    await ctx.skipCheckpoint("add", `Profilarr already has ${manager.name}`);
  } else {
    // Adding an app also rewrites its default delay profile (600-minute delays, torrents first) unless
    // that's switched off in Profilarr's settings. HexOS leaves how and when downloads start alone, so
    // the app gets back the one it had.
    const delay = await arrCall<ArrDelayProfile>(managerUrl, managerKey, "/delayprofile/1");
    const added = await act(session, "/arr/new", {
      name: manager.name,
      type: managerId,
      url: managerUrl,
      external_url: "",
      api_key: managerKey,
      tags: "[]",
    });
    if (added.type !== "redirect") {
      ctx.fail(`Profilarr didn't add ${manager.name}`, [{ label: "Reason", value: actionError(added) }]);
    }
    const kept = async () => JSON.stringify(await arrCall(managerUrl, managerKey, "/delayprofile/1")) === JSON.stringify(delay);
    if (!(await kept())) {
      await arrCall(managerUrl, managerKey, "/delayprofile/1", { method: "PUT", body: JSON.stringify(delay) });
      if (!(await kept())) ctx.fail(`Profilarr changed ${manager.name}'s delay profile, and HexOS couldn't put it back`);
    }
    instance = (await listed()).find((entry) => entry.type === managerId && sameUrl(entry.url));
    if (!instance) ctx.fail(`Profilarr added ${manager.name}, but HexOS couldn't find it there`);
    await ctx.emitCheckpoint("add");
  }

  // The profiles an app already syncs are the owner's choice: only an app with none is given these
  const sync = () =>
    getJson<ProfilarrStatus>(session, "/api/v1/status").then(
      (status) => status.arrs.find((entry) => entry.id === instance.id)?.sync.qualityProfiles,
    );
  const choosing = ((await sync())?.count ?? 0) === 0;
  if (choosing) {
    const saved = await act(session, `/arr/${instance.id}/sync?/saveQualityProfiles`, {
      selections: JSON.stringify(PROFILES.map((profileName) => ({ databaseId: database, profileName }))),
      priorities: "[]",
      // Dictionarry's updates reach the app as they're pulled
      trigger: "on_pull",
      cron: "",
    });
    if (saved.type !== "success") {
      ctx.fail(`Profilarr didn't save ${manager.name}'s profiles`, [{ label: "Reason", value: actionError(saved) }]);
    }
  }
  const queued = await act(session, `/arr/${instance.id}/sync?/syncQualityProfiles`, {});
  if (queued.type !== "success" && queued.status !== 409) {
    ctx.fail(`Profilarr didn't start sending ${manager.name} its profiles`, [{ label: "Reason", value: actionError(queued) }]);
  }
  let state = "pending";
  for (let attempt = 0; attempt < 48 && (state === "pending" || state === "in_progress"); attempt++) {
    await ctx.sleep(5_000);
    state = (await sync())?.status ?? "idle";
  }
  if (state !== "idle") {
    ctx.fail(
      state === "failed"
        ? `Profilarr couldn't send ${manager.name} its profiles. Its Sync page for ${manager.name} says why.`
        : `Profilarr is still sending ${manager.name} its profiles. Run this again in a few minutes.`,
    );
  }

  // What Profilarr says it sent, checked where it went
  if (choosing) {
    const profiles = await arrCall<Array<{ name: string }>>(managerUrl, managerKey, "/qualityprofile");
    const missing = PROFILES.filter((name) => !profiles.some((profile) => profile.name === name));
    if (missing.length > 0) {
      ctx.fail(`Profilarr finished, but ${manager.name} is missing some of its profiles`, [
        { label: "Missing", value: missing.join(", ") },
      ]);
    }
  }
  if (await exported(session, database, "custom_format", NOT_ENGLISH)) {
    const formats = await arrCall<Array<{ name: string }>>(managerUrl, managerKey, "/customformat");
    if (!formats.some((format) => format.name === NOT_ENGLISH)) {
      ctx.fail(`Profilarr finished, but ${manager.name} doesn't have the English format`);
    }
  }
  await ctx.emitCheckpoint("sync");
}

export const radarr = (ctx: HookContext) => connect(ctx, "radarr");
export const sonarr = (ctx: HookContext) => connect(ctx, "sonarr");
