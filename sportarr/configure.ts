// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import type { ContextMount, HookContext, HookInputDeclaration } from "../_lib/hook_context";

/**
 * Sets Sportarr up as HexOS ships it. Sportarr gets the sign-in the owner chose for the install or
 * collection (`ctx.signIn`). It also gets the sports library HexOS mounts as its root folder.
 *
 * Sportarr reads no plain password from config.xml. It sets an account only through its settings,
 * which hash the password. So HexOS can't seed the sign-in before the first start, as it does for
 * Sonarr. The sign-in goes in through Sportarr's settings once Sportarr is up.
 *
 * A Sportarr the owner already had gets the chosen sign-in too, when a collection brings it in. With
 * no sign-in from the owner (a deck from before they chose one), a new install gets admin/adminadmin.
 * HexOS keeps that default beside the settings, so a later check knows it's HexOS's.
 *
 * Sportarr's API lets the home network in without the sign-in. Its web page always asks for it
 * (/api/auth/check). Read at Sportarr 4.1.11, the version TrueNAS pins.
 */

const NAME = "Sportarr";
/** Where HexOS mounts the sports library in Sportarr. */
const LIBRARY = "/media/sports";
/** The sign-in Sportarr gets when the owner chose none. Sportarr refuses a password under 6 characters, the deck one under 8. */
const DEFAULT_SIGN_IN: SignIn = { username: "admin", password: "adminadmin" };

interface SignIn {
  username: string;
  password: string;
}

interface Api {
  base: string;
  key: string;
}

/** Sportarr's settings, each block a JSON string, as its own settings page reads and saves them. */
interface Settings {
  securitySettings: string;
  [block: string]: unknown;
}

interface Security {
  authenticationMethod?: string;
  authenticationRequired?: string;
  username?: string;
  password?: string;
  [field: string]: unknown;
}

function configMount(mounts: ContextMount[]): ContextMount | undefined {
  return mounts.find((m) => m.containerPath === "/config") ?? mounts.find((m) => m.hostPath.endsWith("/sportarr/config"));
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

const signInPath = (config: ContextMount) => `${config.localPath}/hexos/sign-in.json`;

/** The default sign-in HexOS gave Sportarr when the owner chose none. Never the owner's own. */
function savedSignIn(config: ContextMount): SignIn | undefined {
  try {
    const saved = JSON.parse(readText(signInPath(config)) ?? "") as Partial<SignIn>;
    return saved.username && saved.password ? { username: saved.username, password: saved.password } : undefined;
  } catch {
    return undefined;
  }
}

/** Kept before Sportarr is told it, so a later check knows Sportarr's sign-in is HexOS's default. */
function keepDefault(config: ContextMount): SignIn {
  mkdirSync(`${config.localPath}/hexos`, { recursive: true, mode: 0o700 });
  writeFileSync(signInPath(config), JSON.stringify(DEFAULT_SIGN_IN), { mode: 0o600 });
  return DEFAULT_SIGN_IN;
}

/** Once Sportarr has the owner's sign-in, the default kept beside it no longer says anything true. */
const forgetDefault = (config: ContextMount) => rmSync(signInPath(config), { force: true });

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

const signInQuestions: HookInputDeclaration[] = [
  { type: "question", id: "username", question: { question: `${NAME} username`, type: "text", key: "username", required: true } },
  { type: "question", id: "password", question: { question: `${NAME} password`, type: "password", key: "password", required: true } },
];

async function call<T>(api: Api, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${api.base}/api${path}`, {
    ...init,
    headers: { "X-Api-Key": api.key, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    // Only Sportarr's own messages: a refused form can echo back what it was sent
    let reason = `${response.status} ${response.statusText}`;
    try {
      const body = JSON.parse(text) as { error?: string; message?: string };
      reason = body.error || body.message || reason;
    } catch {}
    throw new Error(reason);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Sportarr writes its API key at its first start, and answers with it once its database is ready. */
async function reach(ctx: HookContext, config: ContextMount): Promise<Api> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const key = readText(`${config.localPath}/config.xml`)?.match(/<ApiKey>([^<]+)<\/ApiKey>/)?.[1];
    if (key) {
      const api = { base: ctx.baseUrl, key };
      if (await call(api, "/settings").then(() => true, () => false)) return api;
    }
    await ctx.sleep(5_000);
  }
  ctx.fail(`${NAME} didn't start. Try again once it's running.`);
}

async function security(api: Api): Promise<{ settings: Settings; security: Security }> {
  const settings = await call<Settings>(api, "/settings");
  return { settings, security: JSON.parse(settings.securitySettings || "{}") as Security };
}

const lower = (value: unknown) => (typeof value === "string" ? value.toLowerCase() : "");
const hasAccount = (sec: Security) => ["forms", "basic"].includes(lower(sec.authenticationMethod)) && !!sec.username;

/**
 * Whether Sportarr takes this sign-in at its own sign-in endpoint. Sportarr takes 10 tries from one
 * address in 5 minutes (the "login" rate limit at 4.1.11), so a run tries at most twice, and a
 * refusal for too many tries says nothing about the sign-in.
 */
async function signsIn(base: string, signIn: SignIn): Promise<"yes" | "no" | "unknown"> {
  const response = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: signIn.username, password: signIn.password, rememberMe: false }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
  await response?.body?.cancel();
  if (response?.status === 200) return "yes";
  return response?.status === 429 ? "unknown" : "no";
}

/**
 * Gives Sportarr a sign-in through its settings, keeping how the owner had it ask for one when they
 * had it ask at all. Sportarr applies every block its settings save carries, so the whole set goes
 * back with only the security block changed, as its own settings page sends it.
 */
async function setSignIn(ctx: HookContext, api: Api, signIn: SignIn) {
  const { settings, security: sec } = await security(api);
  const kept = hasAccount(sec);
  const method = kept ? lower(sec.authenticationMethod) : "forms";
  const required = kept && lower(sec.authenticationRequired) === "enabled" ? "enabled" : "disabledForLocalAddresses";
  try {
    await call(api, "/settings", {
      method: "PUT",
      body: JSON.stringify({
        ...settings,
        securitySettings: JSON.stringify({
          ...sec,
          authenticationMethod: method,
          authenticationRequired: required,
          username: signIn.username,
          password: signIn.password,
        }),
      }),
    });
  } catch (error) {
    ctx.fail(`${NAME} didn't take its sign-in`, [{ label: "Reason", value: reason(error) }]);
  }

  // Sportarr saves the new password before it answers. So one try is enough.
  const taken = await signsIn(api.base, signIn);
  const now = (await security(api)).security;
  if (lower(now.authenticationMethod) !== method || lower(now.username) !== lower(signIn.username) || taken === "no") {
    ctx.fail(`${NAME} didn't keep the sign-in HexOS gave it. Run this again.`);
  }
  if (taken === "unknown") ctx.log(`${NAME} turned away the check of its new sign-in for too many tries. Its settings show the new username.`);
}

async function ensureSignIn(ctx: HookContext, config: ContextMount, api: Api) {
  const sec = (await security(api)).security;

  // The sign-in the owner chose for this install or collection: Sportarr gets it, whatever it had
  const wanted = ctx.signIn;
  if (wanted) {
    if (lower(sec.authenticationMethod) === "external") {
      await ctx.skipCheckpoint("signIn", `${NAME} signs in through your own sign-in service, so it keeps that`);
      return;
    }
    if (hasAccount(sec) && lower(sec.username) === lower(wanted.username) && (await signsIn(ctx.baseUrl, wanted)) === "yes") {
      forgetDefault(config);
      await ctx.skipCheckpoint("signIn", `${NAME} already uses the sign-in you chose`);
      return;
    }
    await setSignIn(ctx, api, wanted);
    forgetDefault(config);
    await ctx.emitCheckpoint("signIn", `${NAME} uses the sign-in you chose`);
    return;
  }

  // No sign-in from the owner: a run from Sportarr's card, or a deck from before they chose one
  const saved = savedSignIn(config);
  if (hasAccount(sec)) {
    const ours = saved !== undefined && lower(sec.username) === lower(saved.username);
    await ctx.skipCheckpoint("signIn", ours ? `${NAME} already has its sign-in` : `${NAME} keeps the sign-in it has`);
    return;
  }
  // A new install from a deck from before the choice: the default, as Sonarr gets it before its first start
  if (ctx.event !== "userAction") {
    await setSignIn(ctx, api, saved ?? keepDefault(config));
    await ctx.emitCheckpoint("signIn");
    return;
  }
  // Never had one: the owner chooses it here
  const answers = await ask(ctx, signInQuestions, {
    title: `Choose a sign-in for ${NAME}`,
    description: `${NAME} has no sign-in yet. It opens without one until you choose one.`,
  });
  const username = typeof answers?.username === "string" ? answers.username.trim() : "";
  const password = typeof answers?.password === "string" ? answers.password : "";
  if (!username || !password) {
    await ctx.skipCheckpoint("signIn", `${NAME} keeps opening without a sign-in`);
    return;
  }
  await setSignIn(ctx, api, { username, password });
  await ctx.emitCheckpoint("signIn");
}

const trimmed = (path: string) => path.replace(/\/+$/, "");

/** The sports library HexOS mounts, as Sportarr's root folder, when it has none. */
async function ensureLibrary(ctx: HookContext, api: Api) {
  const folders = () => call<Array<{ path: string }>>(api, "/rootfolder");
  if ((await folders()).length > 0) {
    await ctx.skipCheckpoint("library", `${NAME} already has a library folder`);
    return;
  }
  if (ctx.mounts.length > 0 && !ctx.mounts.some((m) => m.containerPath === LIBRARY)) {
    await ctx.skipCheckpoint("library", `HexOS didn't give ${NAME} a sports folder, so it has none to add`);
    return;
  }
  try {
    await call(api, "/rootfolder", { method: "POST", body: JSON.stringify({ path: LIBRARY }) });
  } catch (error) {
    if (!(await folders()).some((entry) => trimmed(entry.path) === LIBRARY)) {
      ctx.fail(`${NAME} didn't take your sports folder. Add it in ${NAME}'s Settings, Media Management.`, [
        { label: "Reason", value: reason(error) },
      ]);
    }
  }
  if (!(await folders()).some((entry) => trimmed(entry.path) === LIBRARY)) {
    ctx.fail(`${NAME} saved your sports folder, but HexOS couldn't find it there`);
  }
  await ctx.emitCheckpoint("library");
}

export async function configure(ctx: HookContext) {
  const config = configMount(ctx.mounts);
  if (!config) ctx.fail(`HexOS couldn't find ${NAME}'s settings folder`);
  await ctx.registerCheckpoints([
    { id: "start", message: `Waiting for ${NAME} to start` },
    { id: "signIn", message: `Checking ${NAME}'s sign-in` },
    { id: "library", message: `Adding your sports folder to ${NAME}` },
  ]);
  const api = await reach(ctx, config);
  await ctx.emitCheckpoint("start");
  await ensureSignIn(ctx, config, api);
  await ensureLibrary(ctx, api);
}
