// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { readFileSync, rmSync } from "node:fs";

import type { ContextMount, HookContext, HookInputDeclaration } from "../_lib/hook_context";

/**
 * Once qBittorrent is up (configure-qbittorrent), gives it the sign-in the owner chose for the
 * install or collection, and a folder for downloads in progress when it keeps them with the
 * finished ones. A qBittorrent HexOS just installed has both from seed-webui, so this only checks
 * them; one the owner already had, which a collection brings in, gets them here through its own
 * WebUI. With no sign-in chosen (a run from the app's card) its sign-in stays as it is. The Radarr,
 * Sonarr, Lidarr and Prowlarr installed beside it get the chosen sign-in at once (`shareSignIn`), so
 * none is locked out for using the old one before its link runs. Read at qBittorrent 5.3.0, the version
 * TrueNAS pins.
 */

interface Session {
  base: string;
  cookie?: string;
}

interface Preferences {
  save_path?: string;
  temp_path?: string;
  temp_path_enabled?: boolean;
  web_ui_username?: string;
}

interface SignIn {
  username: string;
  password: string;
}

function configMount(mounts: ContextMount[]): ContextMount | undefined {
  return mounts.find((m) => m.containerPath === "/config") ?? mounts.find((m) => m.hostPath.endsWith("/qbittorrent/config"));
}

/** Radarr, Sonarr, Lidarr and Prowlarr, by the API version each keeps its download clients under. */
const MANAGERS = { radarr: "v3", sonarr: "v3", lidarr: "v1", prowlarr: "v1" } as const;

interface DownloadClient {
  id: number;
  implementation: string;
  fields: Array<{ name: string; value?: unknown }>;
  [key: string]: unknown;
}

/**
 * Gives each installed manager's entry for this qBittorrent the sign-in it now takes. A manager signs
 * in with its own copy on every poll, and qBittorrent locks out an address after five failures, so
 * a manager still holding an old password would be locked out before its link runs. Saved without
 * the manager's test (`forceSave`), which signs in from that same address.
 */
async function shareSignIn(ctx: HookContext, signIn: SignIn) {
  const self = new URL(ctx.baseUrl);
  for (const [managerId, api] of Object.entries(MANAGERS)) {
    const url = await ctx.getInstalledAppUrl(managerId);
    if (!url) continue;
    try {
      const mounts = await ctx.getInstalledAppMounts(managerId);
      const config = mounts.find((m) => m.containerPath === "/config") ?? mounts.find((m) => m.hostPath.endsWith(`/${managerId}/config`));
      const apiKey = config && readFileSync(`${config.localPath}/config.xml`, "utf-8").match(/<ApiKey>([^<]+)<\/ApiKey>/)?.[1];
      if (!apiKey) continue;
      const headers = { "X-Api-Key": apiKey, "Content-Type": "application/json" };
      const listed = await fetch(`${url}/api/${api}/downloadclient`, { headers, signal: AbortSignal.timeout(30_000) });
      if (!listed.ok) throw new Error(`${listed.status} ${listed.statusText}`);
      for (const client of (await listed.json()) as DownloadClient[]) {
        const field = (name: string) => client.fields.find((f) => f.name === name)?.value;
        // Another qBittorrent, or one the owner reaches with its API key instead, is left as it is
        if (client.implementation !== "QBittorrent" || field("apiKey")) continue;
        if (field("host") !== self.hostname || Number(field("port")) !== Number(self.port)) continue;
        const fields = client.fields.map((f) =>
          f.name === "username" ? { ...f, value: signIn.username } : f.name === "password" ? { ...f, value: signIn.password } : f,
        );
        const saved = await fetch(`${url}/api/${api}/downloadclient/${client.id}?forceSave=true`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ ...client, fields }),
          signal: AbortSignal.timeout(30_000),
        });
        await saved.body?.cancel();
        if (!saved.ok) throw new Error(`${saved.status} ${saved.statusText}`);
      }
    } catch (error) {
      ctx.log(`${managerId} keeps the qBittorrent sign-in it had: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function savedSignIn(path: string): SignIn | undefined {
  try {
    const saved = JSON.parse(readFileSync(path, "utf-8")) as Partial<SignIn>;
    return saved.username && saved.password ? { username: saved.username, password: saved.password } : undefined;
  } catch {
    return undefined;
  }
}

/** The WebUI checks a request comes from its own pages when CSRF protection is on. */
const headersFor = (session: Session, extra: Record<string, string> = {}) => ({
  Referer: `${session.base}/`,
  Origin: session.base,
  ...(session.cookie ? { Cookie: session.cookie } : {}),
  ...extra,
});

/** 200 when the WebUI lets this caller in as it is (the home network, or a session), 403 when it wants a sign-in. */
async function versionStatus(session: Session): Promise<number | undefined> {
  const response = await fetch(`${session.base}/api/v2/app/version`, {
    headers: headersFor(session),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
  await response?.body?.cancel();
  return response?.status;
}

/**
 * Signs in with a session of its own: 204 (5.x) or "Ok." (4.x) when qBittorrent takes the sign-in,
 * "Fails." when it doesn't. Each refusal counts toward qBittorrent's ban, so callers try few. From
 * an address its whitelist lets in, qBittorrent takes any sign-in, so it proves nothing there.
 */
async function signsIn(base: string, signIn: SignIn): Promise<Session | undefined> {
  const session: Session = { base };
  const response = await fetch(`${base}/api/v2/auth/login`, {
    method: "POST",
    headers: headersFor(session, { "Content-Type": "application/x-www-form-urlencoded" }),
    body: new URLSearchParams({ username: signIn.username, password: signIn.password }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
  if (!response) return undefined;
  const text = (await response.text()).trim();
  const cookie = response.headers
    .getSetCookie()
    .map((header) => header.split(";")[0])
    .find((pair) => /^(SID|QBT_SID_\d+)=/.test(pair));
  return response.ok && text !== "Fails." && cookie ? { base, cookie } : undefined;
}

async function preferences(session: Session): Promise<Preferences> {
  const response = await fetch(`${session.base}/api/v2/app/preferences`, {
    headers: headersFor(session),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return (await response.json()) as Preferences;
}

async function setPreferences(session: Session, changes: Record<string, unknown>) {
  const response = await fetch(`${session.base}/api/v2/app/setPreferences`, {
    method: "POST",
    headers: headersFor(session, { "Content-Type": "application/x-www-form-urlencoded" }),
    body: new URLSearchParams({ json: JSON.stringify(changes) }),
    signal: AbortSignal.timeout(15_000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
}

async function ask(ctx: HookContext, inputs: HookInputDeclaration[], prompt: { title: string; description: string }) {
  if (typeof ctx.askForInputs !== "function") return undefined;
  return ctx.askForInputs(inputs, prompt).catch((error: unknown) => {
    if (error instanceof Error && error.name === "HookInputsUnanswered") return undefined;
    throw error;
  });
}

/**
 * A way into the WebUI: as the home network when it lets HexOS in, else with a sign-in HexOS knows,
 * else, when there's a sign-in to set, with the one the owner gives. Says which sign-in got in, when
 * one did.
 */
async function enter(ctx: HookContext, credentialsPath: string): Promise<{ session: Session; with?: SignIn } | undefined> {
  const open: Session = { base: ctx.baseUrl };
  if ((await versionStatus(open)) === 200) return { session: open };
  for (const known of [ctx.signIn, savedSignIn(credentialsPath)]) {
    if (!known) continue;
    const session = await signsIn(ctx.baseUrl, known);
    if (session) return { session, with: known };
  }
  if (!ctx.signIn) return undefined;
  const answers = await ask(
    ctx,
    [
      { type: "question", id: "username", question: { question: "qBittorrent username", type: "text", key: "username", required: true } },
      { type: "question", id: "password", question: { question: "qBittorrent password", type: "password", key: "password", required: true } },
    ],
    {
      title: "Sign in to qBittorrent",
      description: "Enter the sign-in you use for qBittorrent now, so HexOS can change it to the one you chose.",
    },
  );
  const given = { username: String(answers?.username ?? "").trim(), password: String(answers?.password ?? "") };
  if (!given.username || !given.password) return undefined;
  const session = await signsIn(ctx.baseUrl, given);
  if (!session) ctx.fail("qBittorrent didn't accept that username and password. Run Pre-configure qBittorrent from its Connections tab to try again.");
  return { session, with: given };
}

export async function configure(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "start", message: "Waiting for qBittorrent to start" },
    { id: "signIn", message: "Checking qBittorrent's sign-in" },
    { id: "folders", message: "Checking qBittorrent's download folders" },
  ]);
  const config = configMount(ctx.mounts);
  if (!config) ctx.fail("HexOS couldn't find qBittorrent's settings folder");
  const credentialsPath = `${config.localPath}/hexos/webui.json`;

  let answered = false;
  for (let attempt = 0; attempt < 60 && !answered; attempt++) {
    const status = await versionStatus({ base: ctx.baseUrl });
    answered = status === 200 || status === 403;
    if (!answered) await ctx.sleep(5_000);
  }
  if (!answered) ctx.fail("qBittorrent didn't start. Try again once it's running.");
  await ctx.emitCheckpoint("start");

  const entered = await enter(ctx, credentialsPath);
  if (!entered) {
    await ctx.skipCheckpoint("signIn", "qBittorrent keeps the sign-in it has");
    await ctx.skipCheckpoint("folders", "HexOS couldn't open qBittorrent's settings, so they stay as they are");
    return;
  }
  const { session } = entered;

  const wanted = ctx.signIn;
  if (!wanted) {
    await ctx.skipCheckpoint("signIn", "qBittorrent keeps the sign-in it has");
  } else if (entered.with?.username === wanted.username && entered.with.password === wanted.password) {
    rmSync(credentialsPath, { force: true });
    await ctx.skipCheckpoint("signIn", "qBittorrent already uses the sign-in you chose");
  } else {
    // Let in by the home network, HexOS can't tell which password qBittorrent has, so it sets it
    await setPreferences(session, { web_ui_username: wanted.username, web_ui_password: wanted.password });
    const taken =
      (await preferences(session)).web_ui_username === wanted.username &&
      (entered.with === undefined || (await signsIn(ctx.baseUrl, wanted)) !== undefined);
    if (!taken) ctx.fail("qBittorrent didn't take the sign-in you chose. Run this again.");
    rmSync(credentialsPath, { force: true });
    await ctx.emitCheckpoint("signIn", "qBittorrent uses the sign-in you chose");
  }
  // Even when it already had it: an earlier run may have changed it before its links ran
  if (wanted) await shareSignIn(ctx, wanted);

  // A download in progress kept apart from the finished ones, inside the folder they finish in
  const prefs = await preferences(session);
  if (prefs.temp_path_enabled) {
    await ctx.skipCheckpoint("folders", "qBittorrent already keeps downloads in progress apart");
  } else {
    const savePath = (prefs.save_path || "/config/Downloads").replace(/\/+$/, "");
    const tempPath = `${savePath}/incomplete/`;
    await setPreferences(session, { temp_path_enabled: true, temp_path: tempPath });
    const after = await preferences(session);
    if (!after.temp_path_enabled) ctx.fail("qBittorrent didn't keep its folder for downloads in progress. Run this again.");
    await ctx.emitCheckpoint("folders", "qBittorrent keeps downloads in progress apart");
  }
}
