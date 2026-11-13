// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { readFileSync } from "node:fs";

import type { ContextMount, HookContext, HookInputDeclaration } from "../_lib/hook_context";

/**
 * Sets Seerr up with this Emby server, as Seerr's own setup does (connect-seerr). Seerr signs in to
 * Emby through its Jellyfin sign-in with Emby as the server type, which makes the owner's Emby
 * administrator Seerr's administrator too. Then it turns on the movie and show libraries, starts a
 * scan and finishes Seerr's setup. The sign-in is the one the owner chose for the install or
 * collection (`ctx.signIn`), which Pre-configure Emby made an Emby administrator; run from the card
 * with none, it asks. A Seerr already set up with this server gets that account as an
 * administrator of its own, imported from Emby. Seerr's links to Radarr and Sonarr act as Seerr's
 * first administrator, so they need this one first. Run again, it moves Seerr to this server when
 * Seerr's own is gone: Emby reinstalled (a new server at the same address, which needs a new API key),
 * or this server at an address that no longer reaches it. Read at Seerr 3.5.1, the version TrueNAS
 * pins.
 */

/** Seerr's MediaServerType (server/constants/server.ts). */
const EMBY = 3;
const NOT_CONFIGURED = 4;
/** Seerr's Permission.ADMIN (server/lib/permissions.ts). */
const SEERR_ADMIN = 2;
const CLIENT_HEADER = 'Emby Client="HexOS", Device="Setup", DeviceId="hexos-seerr-link", Version="1.0.0"';

interface SeerrLibrary {
  id: string;
  name: string;
  enabled: boolean;
  type: "movie" | "show";
}

interface PublicSettings {
  initialized?: boolean;
  mediaServerType?: number;
}

interface SeerrUser {
  id: number;
  jellyfinUserId?: string | null;
  permissions?: number;
}

/** Seerr's settings for its Emby server, which it keeps as its Jellyfin settings. */
interface EmbySettings {
  name?: string;
  ip?: string;
  port?: number;
  useSsl?: boolean;
  urlBase?: string;
  serverId?: string;
}

interface SignIn {
  username: string;
  password: string;
  email?: string;
}

function configMount(mounts: ContextMount[]): ContextMount | undefined {
  return (
    mounts.find((m) => m.containerPath === "/app/config" || m.containerPath === "/config") ??
    mounts.find((m) => m.hostPath.endsWith("/seerr/config"))
  );
}

function readSeerrKey(mounts: ContextMount[]): string | undefined {
  try {
    const settings = JSON.parse(readFileSync(`${configMount(mounts)?.localPath}/settings.json`, "utf-8"));
    return (settings as { main?: { apiKey?: string } }).main?.apiKey;
  } catch {
    return undefined;
  }
}

/** Seerr's error code (`INVALID_CREDENTIALS`) or message from a refused call. */
async function reason(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { message?: string; error?: string };
    return body.message ?? body.error ?? text.slice(0, 300);
  } catch {
    return text.slice(0, 300) || `${response.status} ${response.statusText}`;
  }
}

async function call<T>(url: string, apiKey: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(await reason(response));
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const publicSettings = (seerr: string) =>
  fetch(`${seerr}/api/v1/settings/public`, { signal: AbortSignal.timeout(15_000) })
    .then((response) => (response.ok ? (response.json() as Promise<PublicSettings>) : undefined))
    .catch(() => undefined);

/** Seerr writes its settings on first start, a little after its container is up. */
async function waitForSeerr(ctx: HookContext, seerr: string): Promise<{ apiKey: string; before: PublicSettings }> {
  for (let attempt = 0; attempt < 24; attempt++) {
    const apiKey = readSeerrKey(await ctx.getInstalledAppMounts("seerr"));
    const before = await publicSettings(seerr);
    if (apiKey && before) return { apiKey, before };
    await ctx.sleep(5_000);
  }
  ctx.fail("Seerr didn't answer. Try again once it has started.");
}

/**
 * The Emby server that answers at an address now, by its id, or undefined when nothing does. Emby
 * answers `/System/Info/Public` without a sign-in.
 */
async function serverIdAt(url: string): Promise<string | undefined> {
  // Only the server's public id is read, so a certificate made for another name (an Emby reached by
  // its IP over TLS) doesn't count as no answer; nothing is sent
  const init = { signal: AbortSignal.timeout(10_000), tls: { rejectUnauthorized: false } };
  const response = await fetch(`${url}/System/Info/Public`, init as RequestInit).catch(() => undefined);
  if (!response?.ok) return undefined;
  const info = (await response.json().catch(() => undefined)) as { Id?: string } | undefined;
  return info?.Id || undefined;
}

async function ask(ctx: HookContext, inputs: HookInputDeclaration[], prompt: { title: string; description: string }) {
  if (typeof ctx.askForInputs !== "function") return undefined;
  return ctx.askForInputs(inputs, prompt).catch((error: unknown) => {
    if (error instanceof Error && error.name === "HookInputsUnanswered") return undefined;
    throw error;
  });
}

/** The owner's Emby administrator: the sign-in they chose, else the one they give now. */
async function account(ctx: HookContext): Promise<SignIn> {
  // An Emby the owner already had keeps its own administrator, which they gave in the walk: checked
  // with Emby once in the run, so a refused one never reaches Seerr, which would try it again
  if (ctx.keptApps?.includes(ctx.resourceId)) {
    const own = await ctx.tryExistingSignIn?.(ctx.resourceId, async (signIn) => ((await takes(ctx, signIn)) ? signIn : undefined), {
      title: "Sign in to Emby",
      description: "Emby refused the admin account you gave. Enter an administrator's username and password so HexOS can use it.",
      username: true,
      app: "Emby",
    });
    if (own === "refused") {
      const message = "Emby refused the admin account you gave, so HexOS couldn't connect Seerr to it. Open Emby in HexOS and run Pre-configure Emby with an administrator's sign-in.";
      if (ctx.skip) ctx.skip(message);
      ctx.fail(message);
    }
    if (own) return { username: own.username, password: own.password };
  } else if (ctx.signIn) return ctx.signIn;
  const answers = await ask(
    ctx,
    [
      { type: "question", id: "username", question: { question: "Emby username", type: "text", key: "username", required: true } },
      { type: "question", id: "password", question: { question: "Emby password", type: "password", key: "password", required: true } },
    ],
    { title: "Sign in to Emby", description: "Enter your Emby administrator's sign-in. You'll sign in to Seerr with it too." },
  );
  const username = typeof answers?.username === "string" ? answers.username.trim() : "";
  const password = typeof answers?.password === "string" ? answers.password : "";
  if (!username || !password) ctx.fail("Seerr needs your Emby sign-in. Run Connect to Seerr from Emby to give it.");
  return { username, password };
}

/** Whether Emby takes this account: false only when it refuses it. */
async function takes(ctx: HookContext, signIn: SignIn): Promise<boolean> {
  const resp = await fetch(`${ctx.baseUrl}/emby/Users/AuthenticateByName`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Emby-Authorization": CLIENT_HEADER },
    body: JSON.stringify({ Username: signIn.username, Pw: signIn.password }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
  if (!resp) ctx.fail("Emby didn't answer. Try again once it's running.");
  await resp.body?.cancel();
  if (resp.status === 401 || resp.status === 403) return false;
  if (!resp.ok) ctx.fail(`Emby didn't answer its sign-in (${resp.status}). Try again once it's running.`);
  return true;
}

/** The account signed in to Emby: its id and a session token. */
async function session(ctx: HookContext, signIn: SignIn): Promise<{ id: string; token: string }> {
  const resp = await fetch(`${ctx.baseUrl}/emby/Users/AuthenticateByName`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Emby-Authorization": CLIENT_HEADER },
    body: JSON.stringify({ Username: signIn.username, Pw: signIn.password }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
  const body = resp?.ok ? ((await resp.json()) as { AccessToken?: string; User?: { Id?: string } }) : undefined;
  if (!body?.User?.Id || !body.AccessToken) {
    const message = "Emby didn't accept its administrator's sign-in. Run Pre-configure Emby, then try again.";
    // Emby answered and refused it: its setup was skipped, which trying again won't change
    if (resp && ctx.skip) ctx.skip(message);
    ctx.fail(message);
  }
  return { id: body.User.Id, token: body.AccessToken };
}

/** The account's id in Emby, which Seerr knows its users by. */
async function embyUserId(ctx: HookContext, signIn: SignIn): Promise<string> {
  return (await session(ctx, signIn)).id;
}

/**
 * An API key for Seerr in this Emby, made with the owner's administrator as Seerr's own setup makes
 * one. An Emby Seerr didn't set up (a reinstalled one) doesn't know the key Seerr holds.
 */
async function seerrApiKey(ctx: HookContext, owner: SignIn): Promise<string> {
  const { token } = await session(ctx, owner);
  const headers = { "X-Emby-Token": token };
  const find = async () => {
    const response = await fetch(`${ctx.baseUrl}/emby/Auth/Keys`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) ctx.fail("Emby didn't list its API keys. Run Connect to Seerr from Emby with an administrator's sign-in.");
    const keys = ((await response.json()) as { Items?: Array<{ AppName?: string; AccessToken?: string; DateCreated?: string }> }).Items ?? [];
    return keys
      .filter((key) => key.AppName === "Seerr" && key.AccessToken)
      .sort((a, b) => (b.DateCreated ?? "").localeCompare(a.DateCreated ?? ""))[0]?.AccessToken;
  };
  const existing = await find();
  if (existing) return existing;
  const created = await fetch(`${ctx.baseUrl}/emby/Auth/Keys?App=Seerr`, { method: "POST", headers, signal: AbortSignal.timeout(15_000) });
  if (!created.ok) ctx.fail("Emby didn't make an API key for Seerr", [{ label: "Status", value: String(created.status) }]);
  const minted = await find();
  if (!minted) ctx.fail("Emby didn't make an API key for Seerr");
  return minted;
}

/**
 * Whether the owner wants Seerr moved off a server that no longer answers. Nothing proves that server
 * is gone for good (it may be another computer that's switched off), so the owner decides. False when
 * they say no, skip the question, or the box can't ask.
 */
async function ownerSwitches(ctx: HookContext, current: EmbySettings): Promise<boolean> {
  const address = `${current.ip}:${current.port}`;
  const answers = await ask(
    ctx,
    [
      {
        type: "question",
        id: "switch",
        question: { question: "Switch Seerr to this Emby server", description: "Seerr keeps its requests.", type: "boolean", key: "switch", required: true },
      },
    ],
    { title: "Switch Seerr's Emby server", description: `Seerr uses ${current.name ? `${current.name} at ${address}` : address}, which isn't answering.` },
  );
  return answers?.switch === true;
}

async function signIn(ctx: HookContext, seerr: string, signIn: SignIn): Promise<void> {
  const response = await fetch(`${seerr}/api/v1/auth/jellyfin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: signIn.username,
      password: signIn.password,
      // Seerr's first administrator takes this email, or the Emby username without one
      ...(signIn.email ? { email: signIn.email } : {}),
      hostname: ctx.host,
      port: ctx.port,
      useSsl: false,
      urlBase: "",
      serverType: EMBY,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (response.ok) return;
  const code = await reason(response);
  if (code === "INVALID_CREDENTIALS") {
    ctx.fail("Emby didn't accept that username and password. Run Connect to Seerr from Emby with the account you set Emby up with.");
  }
  if (code === "NOT_ADMIN") {
    ctx.fail("That Emby account isn't an administrator. Run Connect to Seerr from Emby with the account you set Emby up with.");
  }
  if (code === "CONNECTION_ERROR" || code === "INVALID_URL") {
    ctx.fail("Seerr couldn't reach this Emby server. Check Emby is running, then run Connect to Seerr from Emby again.", [
      { label: "Address", value: `${ctx.host}:${ctx.port}` },
    ]);
  }
  ctx.fail("Seerr couldn't sign in to Emby", [
    { label: "Status", value: String(response.status) },
    { label: "Reason", value: code },
  ]);
}

/**
 * A Seerr set up before gets the owner's account as an administrator: imported from Emby when
 * Seerr doesn't know it yet, and given Seerr's administrator permission. True when anything changed.
 */
async function makeSeerrAdministrator(ctx: HookContext, seerr: string, apiKey: string, owner: SignIn): Promise<boolean> {
  const id = await embyUserId(ctx, owner);
  const known = async () =>
    (await call<{ results: SeerrUser[] }>(`${seerr}/api/v1/user?take=1000&skip=0`, apiKey)).results.find(
      (user) => user.jellyfinUserId === id,
    );
  let user = await known();
  if (!user) {
    await call(`${seerr}/api/v1/user/import-from-jellyfin`, apiKey, { method: "POST", body: JSON.stringify({ jellyfinUserIds: [id] }) });
    user = await known();
  }
  if (!user) ctx.fail("Seerr didn't import your Emby administrator from Emby");
  if (((user.permissions ?? 0) & SEERR_ADMIN) === SEERR_ADMIN) return false;
  await call(`${seerr}/api/v1/user/${user.id}/settings/permissions`, apiKey, {
    method: "POST",
    body: JSON.stringify({ permissions: SEERR_ADMIN }),
  });
  return true;
}

export async function run(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "locate", message: "Finding Seerr" },
    { id: "signin", message: "Signing in to Seerr with Emby" },
    { id: "libraries", message: "Turning on Seerr's movie and show libraries" },
    { id: "finish", message: "Finishing Seerr's setup" },
  ]);

  const seerr = await ctx.getInstalledAppUrl("seerr");
  if (!seerr) ctx.fail("Seerr isn't installed, or HexOS can't find its port");
  if (!ctx.host || !ctx.port) ctx.fail("HexOS couldn't find this Emby server's address");
  const { apiKey, before } = await waitForSeerr(ctx, seerr);
  await ctx.emitCheckpoint("locate");
  let switched = false;

  if (before.mediaServerType === NOT_CONFIGURED) {
    await signIn(ctx, seerr, await account(ctx));
    await ctx.emitCheckpoint("signin");
  } else if (before.mediaServerType === EMBY) {
    // Seerr keeps one Emby server, in its Jellyfin settings. It's left alone while it still answers
    // as another server, which the owner chose. It moves to this one when its own is this server at
    // an address that no longer reaches it (the box's address or Emby's port changed), when its address
    // now answers as this server (Emby was reinstalled, which gives it a new id), or when its server
    // doesn't answer at all and the owner says so.
    const current = await call<EmbySettings>(`${seerr}/api/v1/settings/jellyfin`, apiKey);
    const thisServer = await serverIdAt(ctx.baseUrl);
    if (!thisServer) ctx.fail("Emby didn't answer. Try again once it has started.");
    const stored = current.ip ? `${current.useSsl ? "https" : "http"}://${current.ip}:${current.port ?? 8096}${current.urlBase ?? ""}` : undefined;
    const answering = stored ? await serverIdAt(stored) : undefined;
    // A Seerr from before it kept the server's id knows this one by its address
    const knowsThis = current.serverId ? current.serverId === thisServer : answering === thisServer;
    if (knowsThis && answering === thisServer) {
      // Only with the owner's chosen sign-in: run from the card, or for a server they had already, the
      // Seerr they set up stays theirs
      const chosen = ctx.keptApps?.includes(ctx.resourceId) ? undefined : ctx.signIn;
      if (chosen && (await makeSeerrAdministrator(ctx, seerr, apiKey, chosen))) {
        await ctx.emitCheckpoint("signin", "The account you chose is a Seerr administrator");
      } else {
        await ctx.skipCheckpoint("signin", "Seerr already uses this Emby server");
      }
    } else {
      if (!knowsThis && answering !== thisServer) {
        // Seerr keeps one media server, and switching it is the owner's to do: trying again can't help
        const message = "Seerr is already set up with another Emby server. Change it in Seerr's own settings, then run Connect to Seerr from Emby.";
        const context = [{ label: "Seerr uses", value: `${current.ip}:${current.port}` }];
        if (answering || !(await ownerSwitches(ctx, current))) {
          if (ctx.skip) ctx.skip(message, context);
          ctx.fail(message, context);
        }
      }
      // An address that answers as this server stays as the owner wrote it; anything else becomes
      // this one's. A server Seerr didn't know needs a key of its own and the owner as an administrator.
      const address =
        answering === thisServer
          ? { ip: current.ip, port: current.port, useSsl: current.useSsl, urlBase: current.urlBase ?? "" }
          : { ip: ctx.host, port: ctx.port, useSsl: false, urlBase: "" };
      const owner = knowsThis ? undefined : await account(ctx);
      const key = owner ? await seerrApiKey(ctx, owner) : undefined;
      try {
        // Seerr checks the server answers with the key before it keeps them
        await call(`${seerr}/api/v1/settings/jellyfin`, apiKey, { method: "POST", body: JSON.stringify({ ...address, ...(key ? { apiKey: key } : {}) }) });
      } catch (error) {
        ctx.fail("Seerr couldn't reach this Emby server. Check Emby is running, then run Connect to Seerr from Emby again.", [
          { label: "Address", value: `${address.ip}:${address.port}` },
          { label: "Reason", value: error instanceof Error ? error.message : String(error) },
        ]);
      }
      if (owner) await makeSeerrAdministrator(ctx, seerr, apiKey, owner);
      switched = !knowsThis;
      await ctx.emitCheckpoint("signin", switched ? "Seerr moved to this Emby server" : "Seerr reaches Emby at its new address");
    }
  } else {
    // Seerr keeps one media server, and switching it is the owner's to do: trying again can't help
    const message = "Seerr is already set up with another media server. Change it in Seerr's own settings, then run Connect to Seerr from Emby.";
    if (ctx.skip) ctx.skip(message);
    ctx.fail(message);
  }

  // The libraries the owner chose in Seerr are theirs: only a Seerr with none on, or one that just
  // moved to this server, gets them turned on
  let libraries: SeerrLibrary[] = [];
  try {
    libraries = await call<SeerrLibrary[]>(`${seerr}/api/v1/settings/jellyfin/library/sync`, apiKey, { method: "POST" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== "SYNC_ERROR_NO_LIBRARIES") {
      ctx.fail("Seerr couldn't read Emby's libraries", [{ label: "Reason", value: message }]);
    }
  }
  const media = libraries.filter((library) => library.type === "movie" || library.type === "show");
  if (media.length === 0) {
    await ctx.skipCheckpoint("libraries", "Emby has no movie or show library yet");
  } else if (!switched && libraries.some((library) => library.enabled)) {
    await ctx.skipCheckpoint("libraries", "Seerr's libraries are already chosen");
  } else {
    // A server Seerr just moved to gets what a new Seerr does: what it picked on its old server
    // belonged to that server's libraries
    for (const library of media.filter((each) => !each.enabled)) {
      await call(`${seerr}/api/v1/settings/jellyfin/library/${encodeURIComponent(library.id)}`, apiKey, {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
      });
    }
    // The scan fills Seerr with what's already in the libraries; a scan that doesn't start now runs
    // on Seerr's own schedule
    await call(`${seerr}/api/v1/settings/jellyfin/sync`, apiKey, {
      method: "POST",
      body: JSON.stringify({ start: true }),
    }).catch((error) => ctx.log(`Seerr's library scan didn't start: ${error}`));
    await ctx.emitCheckpoint("libraries");
  }

  if (before.initialized) {
    await ctx.skipCheckpoint("finish", "Seerr's setup was already finished");
    return;
  }
  await call(`${seerr}/api/v1/settings/initialize`, apiKey, { method: "POST" });
  const after = await publicSettings(seerr);
  if (!after?.initialized || after.mediaServerType !== EMBY) {
    ctx.fail("Seerr didn't finish its setup. Run Connect to Seerr from Emby again.");
  }
  await ctx.emitCheckpoint("finish");
}
