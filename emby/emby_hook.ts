// Sibling files are type imports only: each script is compiled standalone, so runtime imports of them wouldn't resolve.
import { Database } from "bun:sqlite";

import type { ContextMount, HookContext, HookInputDeclaration } from "../_lib/hook_context";

/**
 * Pre-configure Emby (configure-emby): finishes Emby's setup wizard with the sign-in the owner
 * chose for the install or collection (`ctx.signIn`) as its administrator, then makes its
 * libraries. An Emby the owner already had, which a collection brings in, gets the owner's sign-in
 * as an administrator of its own beside the ones it has (or, when a user by that name exists, that
 * user gets the password and is made one), through an administrator's token from Emby's own
 * database, read-only, or the sign-in of an administrator the owner gives. Its server name and
 * libraries stay as they are. Run from the card with no sign-in chosen, it asks for one.
 */

const DEVICE_ID = "hexos-emby-setup";
const CLIENT_HEADER = `Emby Client="HexOS", Device="Setup", DeviceId="${DEVICE_ID}", Version="1.0.0"`;
const SERVER_NAME = "HexOS Emby";
const DB_RELATIVE = "/data/authentication.db";

const AUTO_RETRIES = 5;
const AUTO_RETRY_DELAY_MS = 5000;
const LIBRARY_PACE_MS = 5000;
const READINESS_ATTEMPTS = 20;
const READINESS_INTERVAL_MS = 5000;
const SUBSYSTEM_ATTEMPTS = 8;
const SUBSYSTEM_INTERVAL_MS = 5000;

interface SignIn {
  username: string;
  password: string;
}

interface EmbyUser {
  Id: string;
  Name: string;
  Policy?: Record<string, unknown> & { IsAdministrator?: boolean; IsDisabled?: boolean };
}

function api(ctx: HookContext, path: string): string {
  return `${ctx.baseUrl}/emby${path}`;
}

function authHeader(token: string): Record<string, string> {
  return { "X-Emby-Token": token };
}

export async function afterInstall(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "embyReady",      message: "Starting Emby server" },
    { id: "wizardComplete", message: "Completing setup wizard" },
    { id: "lib_movies",     message: "Creating library: Movies" },
    { id: "lib_tv",         message: "Creating library: TV Shows" },
    { id: "lib_music",      message: "Creating library: Music" },
    { id: "lib_photos",     message: "Creating library: Photos" },
    { id: "lib_videos",     message: "Creating library: Videos" },
  ]);

  await waitForWizard(ctx);
  await ctx.emitCheckpoint("embyReady");

  let token: string;
  if (await isWizardComplete(ctx)) {
    token = await administrator(ctx);
    await ctx.emitCheckpoint("wizardComplete", ctx.signIn ? "Your sign-in is an administrator" : "Already configured", 30);
  } else {
    const account = ctx.signIn ?? (await chooseSignIn(ctx));
    await runWizard(ctx, account.username, account.password);
    token = await authenticate(ctx, account.username, account.password);
    await setServerName(ctx, token, SERVER_NAME);
    await ctx.emitCheckpoint("wizardComplete", "Setup wizard complete", 30);
  }
  await createLibraries(ctx, token);
}

async function ask(ctx: HookContext, inputs: HookInputDeclaration[], prompt: { title: string; description: string }) {
  if (typeof ctx.askForInputs !== "function") return undefined;
  return ctx.askForInputs(inputs, prompt).catch((error: unknown) => {
    if (error instanceof Error && error.name === "HookInputsUnanswered") return undefined;
    throw error;
  });
}

const signInQuestions: HookInputDeclaration[] = [
  { type: "question", id: "username", question: { question: "Emby username", type: "text", key: "username", required: true } },
  { type: "question", id: "password", question: { question: "Emby password", type: "password", key: "password", required: true } },
];

function answered(answers: Record<string, unknown> | undefined): SignIn | undefined {
  const username = typeof answers?.username === "string" ? answers.username.trim() : "";
  const password = typeof answers?.password === "string" ? answers.password : "";
  return username && password ? { username, password } : undefined;
}

/** A fresh Emby's administrator, from the owner, when no sign-in came with the install. */
async function chooseSignIn(ctx: HookContext): Promise<SignIn> {
  const chosen = answered(
    await ask(ctx, signInQuestions, {
      title: "Choose your Emby sign-in",
      description: "Emby makes this its administrator. You'll sign in to Emby with it.",
    }),
  );
  if (!chosen) ctx.fail("Emby needs a sign-in to finish its setup. Run Pre-configure Emby from its Connections tab to choose one.");
  return chosen;
}

async function emby<T>(ctx: HookContext, token: string, path: string, init: { body?: unknown } = {}): Promise<T> {
  const resp = await fetch(api(ctx, path), {
    method: init.body === undefined ? "GET" : "POST",
    headers: { ...authHeader(token), ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${path}: ${resp.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Whether the token acts as an administrator: only one reads the server's configuration. */
const actsAsAdministrator = (ctx: HookContext, token: string) =>
  emby(ctx, token, "/System/Configuration").then(() => true, () => false);

/**
 * An administrator's token from Emby's own database, read-only: an API key (a token with no user),
 * else the newest sign-ins, the first that acts as an administrator. Null when there's none.
 */
async function storedAdministratorToken(ctx: HookContext): Promise<string | null> {
  const config: ContextMount | undefined =
    ctx.mounts.find((m) => m.containerPath === "/config") ?? ctx.mounts.find((m) => m.hostPath.endsWith("/emby/config"));
  if (!config) return null;
  let tokens: string[] = [];
  let db: Database | undefined;
  try {
    db = new Database(config.localPath + DB_RELATIVE, { readonly: true });
    tokens = db
      .query<{ AccessToken: string }, []>(
        `SELECT AccessToken FROM Tokens_2
          WHERE IsActive = 1
          ORDER BY (UserId IS NULL OR UserId = '') DESC, DateLastActivityInt DESC
          LIMIT 5`,
      )
      .all()
      .map((row) => row.AccessToken);
  } catch {
    return null;
  } finally {
    db?.close();
  }
  for (const token of tokens) {
    if (await actsAsAdministrator(ctx, token)) return token;
  }
  return null;
}

/** Signs in, and says whether the account is an administrator. Undefined when Emby refuses it. */
async function signInAs(ctx: HookContext, account: SignIn): Promise<{ token: string; admin: boolean } | undefined> {
  const resp = await fetch(api(ctx, "/Users/AuthenticateByName"), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Emby-Authorization": CLIENT_HEADER },
    body: JSON.stringify({ Username: account.username, Pw: account.password }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => undefined);
  if (!resp?.ok) return undefined;
  const data = await resp.json() as { AccessToken?: string; User?: EmbyUser };
  return data.AccessToken ? { token: data.AccessToken, admin: data.User?.Policy?.IsAdministrator === true } : undefined;
}

/**
 * A token of an administrator on an Emby that was set up before. With the owner's sign-in, that
 * account becomes one first: made, or given the password and made an administrator when a user by
 * that name exists, by an administrator HexOS can act as.
 */
async function administrator(ctx: HookContext): Promise<string> {
  const wanted = ctx.signIn;
  if (!wanted) {
    const given = answered(
      await ask(ctx, signInQuestions, {
        title: "Sign in to Emby",
        description: "Enter the sign-in of an Emby administrator, so HexOS can set Emby up.",
      }),
    );
    const signedIn = given && (await signInAs(ctx, given));
    if (!signedIn?.admin) ctx.fail("HexOS needs an Emby administrator's sign-in to set Emby up. Run this again with one.");
    return signedIn.token;
  }

  const already = await signInAs(ctx, wanted);
  if (already?.admin) return already.token;

  let acting = await storedAdministratorToken(ctx);
  if (!acting) {
    const given = answered(
      await ask(ctx, signInQuestions, {
        title: "Sign in to Emby",
        description: `Enter the sign-in of an Emby administrator, so HexOS can add ${wanted.username} as one.`,
      }),
    );
    const signedIn = given && (await signInAs(ctx, given));
    if (!signedIn?.admin) ctx.fail(`HexOS needs an Emby administrator's sign-in to add ${wanted.username}. Run this again with one.`);
    acting = signedIn.token;
  }

  const users = await emby<EmbyUser[]>(ctx, acting, "/Users");
  let user = users.find((entry) => entry.Name.toLowerCase() === wanted.username.toLowerCase());
  user ??= await emby<EmbyUser>(ctx, acting, "/Users/New", { body: { Name: wanted.username } });
  await emby(ctx, acting, `/Users/${user.Id}/Password`, { body: { NewPw: wanted.password, ResetPassword: false } });
  user = await emby<EmbyUser>(ctx, acting, `/Users/${user.Id}`);
  if (!user.Policy?.IsAdministrator || user.Policy.IsDisabled) {
    await emby(ctx, acting, `/Users/${user.Id}/Policy`, { body: { ...user.Policy, IsAdministrator: true, IsDisabled: false } });
  }
  const now = await signInAs(ctx, wanted);
  if (!now?.admin) ctx.fail(`Emby didn't make ${wanted.username} an administrator. Run this again.`);
  ctx.log(`${wanted.username} is an Emby administrator`);
  return now.token;
}

async function waitForWizard(ctx: HookContext): Promise<void> {
  for (let i = 0; i < READINESS_ATTEMPTS; i++) {
    try {
      const resp = await fetch(api(ctx, "/Startup/User"), {
        signal: AbortSignal.timeout(5000),
      });
      if (resp.status === 200 || resp.status === 401 || resp.status === 403) return;
      ctx.log(`Waiting for wizard... status=${resp.status} (${i + 1}/${READINESS_ATTEMPTS})`);
    } catch {
      ctx.log(`Waiting for Emby to start... (${i + 1}/${READINESS_ATTEMPTS})`);
    }
    await ctx.sleep(READINESS_INTERVAL_MS);
  }
  throw new Error("Emby did not become ready in time");
}

async function isWizardComplete(ctx: HookContext): Promise<boolean> {
  try {
    const resp = await fetch(api(ctx, "/System/Info/Public"), {
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
    const probe = await fetch(api(ctx, "/Startup/User"), {
      signal: AbortSignal.timeout(5000),
    });
    if (probe.status === 200) return false;
    if (probe.status === 401 || probe.status === 403) return true;
  } catch {
    void 0;
  }
  return false;
}

async function runWizard(ctx: HookContext, username: string, password: string): Promise<void> {
  ctx.log("Running setup wizard...");

  const userResp = await fetch(api(ctx, "/Startup/User"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Name: username, Password: password }),
    signal: AbortSignal.timeout(10000),
  });
  if (!userResp.ok) throw new Error(`Failed to set admin user: ${userResp.status}`);
  ctx.log("Admin user set.");

  const configResp = await fetch(api(ctx, "/Startup/Configuration"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ UICulture: "en-US", MetadataCountryCode: "US", PreferredMetadataLanguage: "en" }),
    signal: AbortSignal.timeout(10000),
  });
  if (!configResp.ok) ctx.log(`Startup/Configuration returned ${configResp.status}, continuing.`);

  const remoteResp = await fetch(api(ctx, "/Startup/RemoteAccess"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ EnableRemoteAccess: true, EnableAutomaticPortMapping: false }),
    signal: AbortSignal.timeout(10000),
  });
  if (!remoteResp.ok) ctx.log(`Startup/RemoteAccess returned ${remoteResp.status}, continuing.`);

  const completeResp = await fetch(api(ctx, "/Startup/Complete"), {
    method: "POST",
    signal: AbortSignal.timeout(10000),
  });
  if (!completeResp.ok) ctx.log(`Startup/Complete returned ${completeResp.status}, continuing.`);
  ctx.log("Wizard complete.");
}

async function authenticate(ctx: HookContext, username: string, password: string): Promise<string> {
  ctx.log("Authenticating...");
  const resp = await fetch(api(ctx, "/Users/AuthenticateByName"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Emby-Authorization": CLIENT_HEADER,
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
    const getResp = await fetch(api(ctx, "/System/Configuration"), {
      headers: authHeader(token),
      signal: AbortSignal.timeout(10000),
    });
    if (!getResp.ok) { ctx.log(`Could not get system config: ${getResp.status}`); return; }
    const config = await getResp.json() as Record<string, unknown>;
    config.ServerName = serverName;
    const postResp = await fetch(api(ctx, "/System/Configuration"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeader(token),
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
      const resp = await fetch(api(ctx, "/Library/VirtualFolders"), {
        headers: authHeader(token),
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
    const resp = await fetch(api(ctx, "/Library/VirtualFolders"), {
      headers: authHeader(token),
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

        try {
          const params = new URLSearchParams({
            Name: lib.name,
            CollectionType: lib.collectionType,
            RefreshLibrary: "true",
          });
          const resp = await fetch(api(ctx, `/Library/VirtualFolders?${params}`), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...authHeader(token),
            },
            body: JSON.stringify({
              LibraryOptions: {
                EnableRealtimeMonitor: true,
                PathInfos: [{ Path: lib.path }],
              },
            }),
            signal: AbortSignal.timeout(15000),
          });

          if (resp.ok) {
            await ctx.sleep(2000);
            const verified = await getExistingLibraryPaths(ctx, token);
            if (verified?.has(lib.path)) {
              ctx.log(`Created library: ${lib.name}`);
              created = true;
              break;
            }
            ctx.log(`${lib.name}: 2xx but not found on verify, retrying...`);
          } else {
            lastStatus = `${resp.status} ${resp.statusText}`;
            lastBody = (await resp.text().catch(() => "")).substring(0, 500);
            ctx.log(`${lib.name}: ${lastStatus} ${lastBody}`);
          }
        } catch (e) {
          lastStatus = "Network error";
          lastBody = String(e);
          ctx.log(`${lib.name}: ${e}`);
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
            { label: "Endpoint", value: `POST ${api(ctx, "/Library/VirtualFolders")}` },
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
