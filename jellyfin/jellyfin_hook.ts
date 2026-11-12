// Sibling files are type imports only: each script is compiled standalone, so runtime imports of them wouldn't resolve.
import { Database } from "bun:sqlite";

import type { ContextMount, HookContext, HookInputDeclaration } from "../_lib/hook_context";

/**
 * Pre-configure Jellyfin (configure-jellyfin): finishes Jellyfin's setup wizard with the sign-in
 * the owner chose for the install or collection (`ctx.signIn`) as its administrator, then makes its
 * libraries and the now-playing widget's API key. A Jellyfin the owner already had, which a
 * collection brings in, gets the owner's sign-in as an administrator of its own beside the ones it
 * has (or, when a user by that name exists, that user gets the password and is made one), through
 * an administrator's key from Jellyfin's own database, read-only, or the sign-in of an
 * administrator the owner gives. Its server name and libraries stay as they are. Run from the card
 * with no sign-in chosen, it asks for one. A collection that brings in a Jellyfin the owner already
 * had hands it no sign-in to add but the administrator account the owner gave (`ctx.existingSignIns`),
 * which it signs in with and changes in no way.
 */

const DEVICE_ID = "hexos-jellyfin-setup";
const CLIENT_HEADER = `MediaBrowser Client="HexOS", Device="Setup", DeviceId="${DEVICE_ID}", Version="1.0.0"`;
const SERVER_NAME = "HexOS Jellyfin";
const DB_RELATIVE = "/data/jellyfin.db";
/** Jellyfin's PermissionKind.IsAdministrator. */
const IS_ADMINISTRATOR = 0;

/** The name of the API key the now-playing widget reads sessions with. */
const WIDGET_KEY_NAME = "HexOS";

const AUTO_RETRIES = 5;
const AUTO_RETRY_DELAY_MS = 5000;
const LIBRARY_PACE_MS = 5000;
/** How many looks a requested library gets to appear, about a minute's worth. */
const LIBRARY_APPEAR_ATTEMPTS = 12;
const READINESS_ATTEMPTS = 20;
const READINESS_INTERVAL_MS = 5000;
const SUBSYSTEM_ATTEMPTS = 8;
const SUBSYSTEM_INTERVAL_MS = 5000;

interface SignIn {
  username: string;
  password: string;
}

interface JellyfinUser {
  Id: string;
  Name: string;
  Policy?: Record<string, unknown> & { IsAdministrator?: boolean; IsDisabled?: boolean };
}

export async function afterInstall(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "jellyfinReady",  message: "Starting Jellyfin server" },
    { id: "wizardComplete", message: "Completing setup wizard" },
    { id: "lib_movies",     message: "Creating library: Movies" },
    { id: "lib_tv",         message: "Creating library: TV Shows" },
    { id: "lib_music",      message: "Creating library: Music" },
    { id: "lib_photos",     message: "Creating library: Photos" },
    { id: "lib_videos",     message: "Creating library: Videos" },
  ]);

  await waitForWizard(ctx);
  await ctx.emitCheckpoint("jellyfinReady");

  const kept = ctx.keptApps?.includes(ctx.resourceId) === true;
  let token: string;
  if (await isWizardComplete(ctx)) {
    token = kept ? await asOwnAdministrator(ctx) : await administrator(ctx);
    await ctx.emitCheckpoint(
      "wizardComplete",
      kept ? "Signed in with your administrator" : ctx.signIn ? "Your sign-in is an administrator" : "Already configured",
      30,
    );
  } else {
    // One the owner had but never finished setting up gets the account they gave, as its first
    const given = kept && !ctx.refusedSignIns?.includes(ctx.resourceId) ? ctx.existingSignIns?.[ctx.resourceId] : undefined;
    const account = ctx.signIn ?? (given?.username ? given : undefined) ?? (await chooseSignIn(ctx));
    await runWizard(ctx, account.username, account.password);
    token = await authenticate(ctx, account.username, account.password);
    await setServerName(ctx, token, SERVER_NAME);
    await ctx.emitCheckpoint("wizardComplete", "Setup wizard complete", 30);
  }
  await createLibraries(ctx, token);
  await ensureWidgetKey(ctx, token);
}

async function ask(ctx: HookContext, inputs: HookInputDeclaration[], prompt: { title: string; description: string }) {
  if (typeof ctx.askForInputs !== "function") return undefined;
  return ctx.askForInputs(inputs, prompt).catch((error: unknown) => {
    if (error instanceof Error && error.name === "HookInputsUnanswered") return undefined;
    throw error;
  });
}

const signInQuestions: HookInputDeclaration[] = [
  { type: "question", id: "username", question: { question: "Jellyfin username", type: "text", key: "username", required: true } },
  { type: "question", id: "password", question: { question: "Jellyfin password", type: "password", key: "password", required: true } },
];

function answered(answers: Record<string, unknown> | undefined): SignIn | undefined {
  const username = typeof answers?.username === "string" ? answers.username.trim() : "";
  const password = typeof answers?.password === "string" ? answers.password : "";
  return username && password ? { username, password } : undefined;
}

/**
 * A token of the owner's own administrator on a Jellyfin they already had, tried once in the run (see
 * `ctx.tryExistingSignIn`), or the step stops and says so, having changed nothing. With no account
 * given, it asks for one as from the card.
 */
async function asOwnAdministrator(ctx: HookContext): Promise<string> {
  const token = await ctx.tryExistingSignIn?.(ctx.resourceId, (account) => administratorToken(ctx, account), {
    title: "Sign in to Jellyfin",
    description: "Jellyfin refused the admin account you gave. Enter an administrator's username and password so HexOS can use it.",
    username: true,
    app: "Jellyfin",
  });
  if (token === "refused") {
    stop(ctx, "Jellyfin refused the admin account you gave, or it isn't an administrator, so HexOS left Jellyfin as it is. Run Pre-configure Jellyfin from its Connections tab with an administrator's sign-in.");
  }
  return token ?? (await administrator(ctx));
}

/** An administrator's session for this account: undefined when Jellyfin refuses it, or it isn't an administrator. */
async function administratorToken(ctx: HookContext, account: SignIn): Promise<string | undefined> {
  const resp = await fetch(`${ctx.baseUrl}/Users/AuthenticateByName`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": CLIENT_HEADER },
    body: JSON.stringify({ Username: account.username, Pw: account.password }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => undefined);
  if (!resp) ctx.fail("Jellyfin didn't answer. Try again once it's running.");
  if (resp.status === 401 || resp.status === 403) {
    await resp.body?.cancel();
    return undefined;
  }
  if (!resp.ok) ctx.fail(`Jellyfin didn't answer its sign-in (${resp.status}). Try again once it's running.`);
  const data = await resp.json() as { AccessToken?: string; User?: { Policy?: { IsAdministrator?: boolean } } };
  return data.AccessToken && data.User?.Policy?.IsAdministrator === true ? data.AccessToken : undefined;
}

/** Ends a step whose app refused the account the owner gave: trying again can't help. */
function stop(ctx: HookContext, message: string): never {
  if (ctx.skip) ctx.skip(message);
  ctx.fail(message);
}

/** A fresh Jellyfin's administrator, from the owner, when no sign-in came with the install. */
async function chooseSignIn(ctx: HookContext): Promise<SignIn> {
  const chosen = answered(
    await ask(ctx, signInQuestions, {
      title: "Choose your Jellyfin sign-in",
      description: "Jellyfin makes this its administrator. You'll sign in to Jellyfin with it.",
    }),
  );
  if (!chosen) ctx.fail("Jellyfin needs a sign-in to finish its setup. Run Pre-configure Jellyfin from its Connections tab to choose one.");
  return chosen;
}

const tokenHeader = (token: string) => ({ "Authorization": `MediaBrowser Token="${token}"` });

async function jellyfin<T>(ctx: HookContext, token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const resp = await fetch(`${ctx.baseUrl}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { ...tokenHeader(token), ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${path}: ${resp.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * An administrator's key from Jellyfin's own database, read-only: an API key (HexOS's widget makes
 * one), else the newest sign-in of an administrator. Null when there's neither, or no database.
 */
function storedAdministratorToken(ctx: HookContext): string | null {
  const config: ContextMount | undefined =
    ctx.mounts.find((m) => m.containerPath === "/config") ?? ctx.mounts.find((m) => m.hostPath.endsWith("/jellyfin/config"));
  if (!config) return null;
  let db: Database | undefined;
  try {
    db = new Database(config.localPath + DB_RELATIVE, { readonly: true });
    const key = db.query<{ AccessToken: string }, []>("SELECT AccessToken FROM ApiKeys ORDER BY DateCreated DESC LIMIT 1").get();
    if (key?.AccessToken) return key.AccessToken;
    const session = db
      .query<{ AccessToken: string }, [number]>(
        `SELECT d.AccessToken FROM Devices d
           JOIN Permissions p ON p.UserId = d.UserId AND p.Kind = ? AND p.Value = 1
          WHERE d.IsActive = 1
          ORDER BY d.DateLastActivity DESC
          LIMIT 1`,
      )
      .get(IS_ADMINISTRATOR);
    return session?.AccessToken ?? null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Signs in, and says whether the account is an administrator. Undefined when Jellyfin refuses it. */
async function signInAs(ctx: HookContext, account: SignIn): Promise<{ token: string; admin: boolean } | undefined> {
  const resp = await fetch(`${ctx.baseUrl}/Users/AuthenticateByName`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": CLIENT_HEADER },
    body: JSON.stringify({ Username: account.username, Pw: account.password }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => undefined);
  if (!resp?.ok) return undefined;
  const data = await resp.json() as { AccessToken?: string; User?: JellyfinUser };
  return data.AccessToken ? { token: data.AccessToken, admin: data.User?.Policy?.IsAdministrator === true } : undefined;
}

/**
 * A token of an administrator on a Jellyfin that was set up before. With the owner's sign-in, that
 * account becomes one first: made, or given the password and made an administrator when a user by
 * that name exists, by an administrator HexOS can act as.
 */
async function administrator(ctx: HookContext): Promise<string> {
  const wanted = ctx.signIn;
  if (!wanted) {
    const given = answered(
      await ask(ctx, signInQuestions, {
        title: "Sign in to Jellyfin",
        description: "Enter the sign-in of a Jellyfin administrator, so HexOS can set Jellyfin up.",
      }),
    );
    const signedIn = given && (await signInAs(ctx, given));
    if (!signedIn?.admin) ctx.fail("HexOS needs a Jellyfin administrator's sign-in to set Jellyfin up. Run this again with one.");
    return signedIn.token;
  }

  const already = await signInAs(ctx, wanted);
  if (already?.admin) return already.token;

  let acting = storedAdministratorToken(ctx);
  if (acting && !(await jellyfin(ctx, acting, "/Users").then(() => true, () => false))) acting = null;
  if (!acting) {
    const given = answered(
      await ask(ctx, signInQuestions, {
        title: "Sign in to Jellyfin",
        description: "Enter the sign-in of a Jellyfin administrator, so HexOS can add the account you chose as one.",
      }),
    );
    const signedIn = given && (await signInAs(ctx, given));
    if (!signedIn?.admin) ctx.fail("HexOS needs a Jellyfin administrator's sign-in to add the account you chose. Run this again with one.");
    acting = signedIn.token;
  }

  const users = await jellyfin<JellyfinUser[]>(ctx, acting, "/Users");
  let user = users.find((entry) => entry.Name.toLowerCase() === wanted.username.toLowerCase());
  if (user) {
    await jellyfin(ctx, acting, `/Users/${user.Id}/Password`, { body: { NewPw: wanted.password, ResetPassword: false } });
    user = await jellyfin<JellyfinUser>(ctx, acting, `/Users/${user.Id}`);
  } else {
    user = await jellyfin<JellyfinUser>(ctx, acting, "/Users/New", { body: { Name: wanted.username, Password: wanted.password } });
  }
  if (!user.Policy?.IsAdministrator || user.Policy.IsDisabled) {
    await jellyfin(ctx, acting, `/Users/${user.Id}/Policy`, { body: { ...user.Policy, IsAdministrator: true, IsDisabled: false } });
  }
  const now = await signInAs(ctx, wanted);
  if (!now?.admin) ctx.fail("Jellyfin didn't make the account you chose an administrator. Run this again.");
  ctx.log("The account you chose is a Jellyfin administrator");
  return now.token;
}

/**
 * The API key the now-playing widget reads sessions with (jellyfin/widget_now_playing.ts finds it
 * by name in Jellyfin's database). Made once: a rerun finds it and leaves it. A failure here costs
 * only the widget, which then asks for a key, so it never fails the setup.
 */
async function ensureWidgetKey(ctx: HookContext, token: string): Promise<void> {
  const headers = { "Authorization": `MediaBrowser Token="${token}"` };
  try {
    const listResp = await fetch(`${ctx.baseUrl}/Auth/Keys`, { headers, signal: AbortSignal.timeout(10000) });
    if (!listResp.ok) {
      ctx.log(`Auth/Keys returned ${listResp.status}; the widget will ask for an API key.`);
      return;
    }
    const keys = await listResp.json() as { Items?: Array<{ AppName?: string }> };
    if (keys.Items?.some((key) => key.AppName === WIDGET_KEY_NAME)) {
      ctx.log("Widget API key already exists.");
      return;
    }
    const createResp = await fetch(`${ctx.baseUrl}/Auth/Keys?app=${WIDGET_KEY_NAME}`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(10000),
    });
    ctx.log(createResp.ok ? "Created the widget API key." : `Creating the widget API key returned ${createResp.status}.`);
  } catch (e) {
    ctx.log(`Could not create the widget API key: ${e}`);
  }
}

async function waitForWizard(ctx: HookContext): Promise<void> {
  for (let i = 0; i < READINESS_ATTEMPTS; i++) {
    try {
      const resp = await fetch(`${ctx.baseUrl}/Startup/User`, {
        signal: AbortSignal.timeout(5000),
      });
      if (resp.status === 200 || resp.status === 401) return;
      ctx.log(`Waiting for wizard... status=${resp.status} (${i + 1}/${READINESS_ATTEMPTS})`);
    } catch {
      ctx.log(`Waiting for Jellyfin to start... (${i + 1}/${READINESS_ATTEMPTS})`);
    }
    await ctx.sleep(READINESS_INTERVAL_MS);
  }
  throw new Error("Jellyfin did not become ready in time");
}

async function isWizardComplete(ctx: HookContext): Promise<boolean> {
  try {
    const resp = await fetch(`${ctx.baseUrl}/System/Info/Public`, {
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const data = await resp.json() as { StartupWizardCompleted?: boolean };
      if (typeof data.StartupWizardCompleted === "boolean") return data.StartupWizardCompleted;
    }
  } catch {
    void 0;
  }

  try {
    const probe = await fetch(`${ctx.baseUrl}/Startup/User`, {
      signal: AbortSignal.timeout(5000),
    });
    if (probe.status === 200) return false;
    if (probe.status === 401) return true;
  } catch {
    void 0;
  }
  return false;
}

async function runWizard(ctx: HookContext, username: string, password: string): Promise<void> {
  ctx.log("Running setup wizard...");

  const userResp = await fetch(`${ctx.baseUrl}/Startup/User`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Name: username, Password: password }),
    signal: AbortSignal.timeout(10000),
  });
  if (!userResp.ok) throw new Error(`Failed to set admin user: ${userResp.status}`);
  ctx.log("Admin user set.");

  const configResp = await fetch(`${ctx.baseUrl}/Startup/Configuration`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ UICulture: "en-US", MetadataCountryCode: "US", PreferredMetadataLanguage: "en" }),
    signal: AbortSignal.timeout(10000),
  });
  if (!configResp.ok) ctx.log(`Startup/Configuration returned ${configResp.status}, continuing.`);

  const remoteResp = await fetch(`${ctx.baseUrl}/Startup/RemoteAccess`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ EnableRemoteAccess: true, EnableAutomaticPortMapping: false }),
    signal: AbortSignal.timeout(10000),
  });
  if (!remoteResp.ok) ctx.log(`Startup/RemoteAccess returned ${remoteResp.status}, continuing.`);

  const completeResp = await fetch(`${ctx.baseUrl}/Startup/Complete`, {
    method: "POST",
    signal: AbortSignal.timeout(10000),
  });
  if (!completeResp.ok) ctx.log(`Startup/Complete returned ${completeResp.status}, continuing.`);
  ctx.log("Wizard complete.");
}

async function authenticate(ctx: HookContext, username: string, password: string): Promise<string> {
  ctx.log("Authenticating...");
  const resp = await fetch(`${ctx.baseUrl}/Users/AuthenticateByName`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Jellyfin dropped the legacy X-Emby-Authorization header (EnableLegacyAuthorization is off
      // since its 2026-05-31 migration); without client details in Authorization the sign-in is a 400.
      "Authorization": CLIENT_HEADER,
    },
    body: JSON.stringify({ Username: username, Pw: password }),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`Authentication failed: ${resp.status}`);
  const data = await resp.json() as { AccessToken?: string };
  if (!data.AccessToken) throw new Error("No access token in authentication response");
  ctx.log("Authenticated.");
  return data.AccessToken;
}

async function setServerName(ctx: HookContext, token: string, serverName: string): Promise<void> {
  try {
    const getResp = await fetch(`${ctx.baseUrl}/System/Configuration`, {
      headers: { "Authorization": `MediaBrowser Token="${token}"` },
      signal: AbortSignal.timeout(10000),
    });
    if (!getResp.ok) { ctx.log(`Could not get system config: ${getResp.status}`); return; }
    const config = await getResp.json() as Record<string, unknown>;
    config.ServerName = serverName;
    const postResp = await fetch(`${ctx.baseUrl}/System/Configuration`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `MediaBrowser Token="${token}"`,
      },
      body: JSON.stringify(config),
      signal: AbortSignal.timeout(10000),
    });
    if (postResp.ok) ctx.log(`Server name set to: ${serverName}`);
    else ctx.log(`Server name update returned ${postResp.status}, continuing.`);
  } catch (e) {
    ctx.log(`Server name update failed: ${e}, continuing.`);
  }
}

async function waitForLibrarySubsystem(ctx: HookContext, token: string): Promise<void> {
  for (let i = 0; i < SUBSYSTEM_ATTEMPTS; i++) {
    try {
      const resp = await fetch(`${ctx.baseUrl}/Library/VirtualFolders`, {
        headers: { "Authorization": `MediaBrowser Token="${token}"` },
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        ctx.log("Library subsystem ready.");
        return;
      }
      ctx.log(`Library subsystem not ready, waiting... (${i + 1}/${SUBSYSTEM_ATTEMPTS})`);
    } catch (e) {
      ctx.log(`Library subsystem check error: ${e}`);
    }
    await ctx.sleep(SUBSYSTEM_INTERVAL_MS);
  }
  ctx.log("Library subsystem readiness check exhausted, proceeding anyway.");
}

const LIBRARIES = [
  { name: "Movies", collectionType: "movies",     path: "/movies", checkpointId: "lib_movies" },
  { name: "Shows",  collectionType: "tvshows",    path: "/shows",  checkpointId: "lib_tv" },
  { name: "Music",  collectionType: "music",      path: "/music",  checkpointId: "lib_music" },
  { name: "Photos", collectionType: "homevideos", path: "/photos", checkpointId: "lib_photos" },
  { name: "Videos", collectionType: "homevideos", path: "/videos", checkpointId: "lib_videos" },
];

/** The paths of the server's libraries, or null when they could not be read. */
async function getExistingLibraryPaths(ctx: HookContext, token: string): Promise<Set<string> | null> {
  try {
    const resp = await fetch(`${ctx.baseUrl}/Library/VirtualFolders`, {
      headers: { "Authorization": `MediaBrowser Token="${token}"` },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as Array<{ Locations?: string[] }>;
    const paths = new Set<string>();
    for (const lib of data) {
      for (const loc of lib.Locations ?? []) paths.add(loc);
    }
    return paths;
  } catch {
    return null;
  }
}

/** Whether a requested library has appeared: a server busy with its first scan can take a while to list it. */
async function libraryAppears(ctx: HookContext, token: string, path: string): Promise<boolean> {
  for (let i = 0; i < LIBRARY_APPEAR_ATTEMPTS; i++) {
    await ctx.sleep(i === 0 ? 2000 : AUTO_RETRY_DELAY_MS);
    if ((await getExistingLibraryPaths(ctx, token))?.has(path)) return true;
  }
  return false;
}

/**
 * Whether the app was given the folder a library reads. HexOS leaves a folder's mount out of the
 * app when its owner turned that location off, and Jellyfin refuses a library at a path it can't see.
 * Mounts that couldn't be read prove nothing, so every library is asked for then.
 */
const hasFolder = (ctx: HookContext, path: string): boolean =>
  ctx.mounts.length === 0 || ctx.mounts.some((mount) => mount.containerPath === path);

async function createLibraries(ctx: HookContext, token: string): Promise<void> {
  await waitForLibrarySubsystem(ctx, token);
  await ctx.sleep(LIBRARY_PACE_MS);

  const listed = await getExistingLibraryPaths(ctx, token);
  // A run from the app card is on a server that may already have its libraries: libraries it
  // cannot list are not assumed missing, or it would make them again.
  if (listed === null && ctx.event === "action") {
    throw new Error("Could not read the server's libraries, so none were created. Run it again.");
  }
  const existingPaths = listed ?? new Set<string>();

  for (let i = 0; i < LIBRARIES.length; i++) {
    const lib = LIBRARIES[i];

    if (existingPaths.has(lib.path)) {
      ctx.log(`Library already exists: ${lib.name}`);
      await ctx.emitCheckpoint(lib.checkpointId, `${lib.name} — already exists`);
      if (i < LIBRARIES.length - 1) await ctx.sleep(LIBRARY_PACE_MS);
      continue;
    }

    if (!hasFolder(ctx, lib.path)) {
      ctx.log(`No ${lib.path} folder in the app, so no library is made for it: ${lib.name}`);
      await ctx.skipCheckpoint(lib.checkpointId, `HexOS didn't give Jellyfin a ${lib.name} folder, so it has no library to make`);
      continue;
    }

    let created = false;
    let lastStatus = "";
    let lastBody = "";

    while (!created) {
      for (let attempt = 0; attempt < AUTO_RETRIES; attempt++) {
        await ctx.updateCheckpointMessage(
          lib.checkpointId,
          attempt === 0
            ? `Creating library: ${lib.name}...`
            : `Creating library: ${lib.name}... (retry ${attempt}/${AUTO_RETRIES})`,
        );

        // Jellyfin makes a library for every request, numbering the name (Movies2, Movies3), and a
        // request that seemed to fail may have worked. So one goes out only when the server says
        // this library isn't there.
        const current = await getExistingLibraryPaths(ctx, token);
        if (current?.has(lib.path)) {
          ctx.log(`Library is there: ${lib.name}`);
          created = true;
          break;
        }
        if (current === null) {
          lastStatus = "Could not read the server's libraries";
          lastBody = "";
          ctx.log(`${lib.name}: ${lastStatus}`);
          await ctx.sleep(AUTO_RETRY_DELAY_MS);
          continue;
        }

        try {
          const params = new URLSearchParams({
            name: lib.name,
            collectionType: lib.collectionType,
            paths: lib.path,
            refreshLibrary: "true",
          });
          const resp = await fetch(`${ctx.baseUrl}/Library/VirtualFolders?${params}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `MediaBrowser Token="${token}"`,
            },
            // Jellyfin's own form turns real-time monitoring on; without it, what Radarr and Sonarr
            // download shows up only at the next scheduled scan
            body: JSON.stringify({ LibraryOptions: { EnableRealtimeMonitor: true } }),
            signal: AbortSignal.timeout(15000),
          });

          if (resp.ok) {
            if (await libraryAppears(ctx, token, lib.path)) {
              ctx.log(`Created library: ${lib.name}`);
              created = true;
              break;
            }
            ctx.log(`${lib.name}: 204 but not found on verify, retrying...`);
          } else {
            lastStatus = `${resp.status} ${resp.statusText}`;
            lastBody = (await resp.text().catch(() => "")).substring(0, 500);
            ctx.log(`${lib.name}: ${lastStatus} ${lastBody}`);
          }
        } catch (e) {
          lastStatus = "Network error";
          lastBody = String(e);
          ctx.log(`${lib.name}: ${e}`);
          if (await libraryAppears(ctx, token, lib.path)) {
            created = true;
            break;
          }
        }

        await ctx.sleep(AUTO_RETRY_DELAY_MS);
      }

      if (created) {
        await ctx.emitCheckpoint(lib.checkpointId, `${lib.name} — created`);
      } else {
        await ctx.updateCheckpointMessage(lib.checkpointId, `${lib.name} — failed`);
        // A run from the app card has no retry or skip to wait on: it stops here, and running it
        // again carries on from the libraries already made.
        if (ctx.event === "action") {
          throw new Error(`Could not create the ${lib.name} library. Run it again to retry it.`);
        }
        const action = await ctx.awaitCheckpointRetry(
          lib.checkpointId,
          `Failed to create library: ${lib.name}`,
          [
            { label: "Endpoint", value: `POST ${ctx.baseUrl}/Library/VirtualFolders` },
            ...(lastStatus ? [{ label: "Status", value: lastStatus }] : []),
            ...(lastBody ? [{ label: "Response", value: lastBody }] : []),
            { label: "Collection type", value: lib.collectionType },
          ],
        );
        if (action === "skip") {
          await ctx.skipCheckpoint(lib.checkpointId, `${lib.name} — skipped`);
          break;
        }
      }
    }

    if (i < LIBRARIES.length - 1) await ctx.sleep(LIBRARY_PACE_MS);
  }
}
