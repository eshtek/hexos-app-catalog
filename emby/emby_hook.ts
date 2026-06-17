import type { HookContext } from "../_lib/hook_context";

const DEVICE_ID = "hexos-emby-setup";
const CLIENT_HEADER = `Emby Client="HexOS", Device="Setup", DeviceId="${DEVICE_ID}", Version="1.0.0"`;

const AUTO_RETRIES = 5;
const AUTO_RETRY_DELAY_MS = 5000;
const LIBRARY_PACE_MS = 5000;
const READINESS_ATTEMPTS = 20;
const READINESS_INTERVAL_MS = 5000;
const SUBSYSTEM_ATTEMPTS = 8;
const SUBSYSTEM_INTERVAL_MS = 5000;

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

  const username   = ctx.getInput<string>("admin_username") || "admin";
  const password   = ctx.getInput<string>("admin_password");
  const serverName = getServerName(ctx);

  if (!password) throw new Error("Admin password is required");

  await waitForWizard(ctx);
  await ctx.emitCheckpoint("embyReady");

  const alreadyConfigured = await isWizardComplete(ctx);
  if (alreadyConfigured) {
    ctx.log("Wizard already completed, skipping setup.");
    await ctx.emitCheckpoint("wizardComplete", "Already configured", 30);
  } else {
    await runWizard(ctx, username, password);
    await ctx.emitCheckpoint("wizardComplete", "Setup wizard complete", 30);
  }

  let token: string;
  try {
    token = await authenticate(ctx, username, password);
  } catch (e) {
    if (alreadyConfigured) {
      throw new Error("Existing Emby data detected. Please retry pre-configuration with the original username and password, or skip to keep your previous install.");
    }
    throw e;
  }

  await setServerName(ctx, token, serverName);
  await createLibraries(ctx, token);
}

function getServerName(ctx: HookContext): string {
  try {
    return ctx.getInput<string>("server_name") || "HexOS Emby";
  } catch {
    return "HexOS Emby";
  }
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

async function getExistingLibraryPaths(ctx: HookContext, token: string): Promise<Set<string>> {
  try {
    const resp = await fetch(api(ctx, "/Library/VirtualFolders"), {
      headers: authHeader(token),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return new Set();
    const data = await resp.json() as Array<{ Locations?: string[] }>;
    const paths = new Set<string>();
    for (const lib of data) {
      for (const loc of lib.Locations ?? []) paths.add(loc);
    }
    return paths;
  } catch {
    return new Set();
  }
}

async function createLibraries(ctx: HookContext, token: string): Promise<void> {
  await waitForLibrarySubsystem(ctx, token);
  await ctx.sleep(LIBRARY_PACE_MS);

  const existingPaths = await getExistingLibraryPaths(ctx, token);

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
            if (verified.has(lib.path)) {
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
