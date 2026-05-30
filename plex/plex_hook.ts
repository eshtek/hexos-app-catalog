import type { HookContext, PlexOAuthResult } from "../_lib/hook_context";

export async function afterInstall(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "plexReady", message: "Starting Plex server" },
    { id: "serverClaimed", message: "Claiming server to Plex account" },
    { id: "prefsSet", message: "Configuring preferences" },
    { id: "lib_movies", message: "Creating library: Movies" },
    { id: "lib_tv", message: "Creating library: TV Shows" },
    { id: "lib_music", message: "Creating library: Music" },
    { id: "lib_photos", message: "Creating library: Photos" },
    { id: "lib_videos", message: "Creating library: Videos" },
  ]);

  const { authToken } = ctx.getInput<PlexOAuthResult>("plex_login");
  if (!authToken) throw new Error("No Plex auth token provided");

  const serverName = getServerName(ctx);

  await ctx.waitForApp("/identity", { headers: { Accept: "application/json" } });
  await ctx.emitCheckpoint("plexReady");

  if (await isServerClaimed(authToken, ctx)) {
    ctx.log("Server already claimed, skipping.");
  } else {
    await claimServer(authToken, ctx);
  }
  await ctx.emitCheckpoint("serverClaimed");

  await setPreferences(authToken, ctx, serverName);
  await ctx.emitCheckpoint("prefsSet");

  await createLibraries(authToken, ctx);
}

function getServerName(ctx: HookContext): string {
  try {
    return ctx.getInput<string>("server_name") || "HexOS Plex";
  } catch {
    return "HexOS Plex";
  }
}

async function isServerClaimed(authToken: string, ctx: HookContext): Promise<boolean> {
  try {
    const resp = await fetch(`${ctx.baseUrl}/myplex/account?X-Plex-Token=${encodeURIComponent(authToken)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return false;
    const data = (await resp.json()) as { MyPlex?: { username?: string } };
    return !!data.MyPlex?.username;
  } catch {
    return false;
  }
}

async function claimServer(authToken: string, ctx: HookContext) {
  ctx.log("Claiming Plex server...");

  const claimResp = await fetch("https://plex.tv/api/claim/token.json", {
    headers: {
      "X-Plex-Token": authToken,
      "X-Plex-Client-Identifier": "hexos-platform",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!claimResp.ok) throw new Error(`Failed to get claim token: ${claimResp.status}`);
  const claimToken = ((await claimResp.json()) as { token?: string }).token ?? "";
  if (!claimToken) throw new Error("Failed to obtain claim token from plex.tv");

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(`${ctx.baseUrl}/myplex/claim?token=${encodeURIComponent(claimToken)}`, {
        method: "POST",
        headers: { "X-Plex-Token": authToken },
        signal: AbortSignal.timeout(15000),
      });
      if (resp.ok) {
        ctx.log("Server claimed successfully.");
        return;
      }
      ctx.log(`Claim attempt ${attempt + 1} returned ${resp.status}`);
    } catch (e) {
      ctx.log(`Claim attempt ${attempt + 1} error: ${e}`);
    }
    await ctx.sleep(5000);
  }

  ctx.log("Claim via /myplex/claim failed, trying preference injection...");
  await fetch(
    `${ctx.baseUrl}/:/prefs?X-Plex-Token=${encodeURIComponent(authToken)}&PlexOnlineToken=${encodeURIComponent(authToken)}`,
    { method: "PUT", signal: AbortSignal.timeout(10000) },
  );
  ctx.log("Fallback claim applied.");
}

async function setPreferences(authToken: string, ctx: HookContext, serverName: string) {
  const prefs: Record<string, string | number> = {
    AcceptedEULA: 1,
    PublishServerOnPlexOnlineKey: 1,
    FriendlyName: serverName,
  };

  for (const [key, value] of Object.entries(prefs)) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await fetch(
          `${ctx.baseUrl}/:/prefs?X-Plex-Token=${encodeURIComponent(authToken)}&${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
          { method: "PUT", signal: AbortSignal.timeout(5000) },
        );
        if (resp.ok) {
          ctx.log(`Set preference: ${key}`);
          break;
        }
      } catch {}
      await ctx.sleep(3000);
    }
  }
}

async function getExistingLibraryPaths(authToken: string, ctx: HookContext): Promise<Set<string>> {
  try {
    const resp = await fetch(`${ctx.baseUrl}/library/sections?X-Plex-Token=${encodeURIComponent(authToken)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return new Set();
    const data = (await resp.json()) as { MediaContainer?: { Directory?: Array<{ Location?: Array<{ path?: string }> }> } };
    const paths = new Set<string>();
    for (const dir of data.MediaContainer?.Directory ?? []) {
      for (const loc of dir.Location ?? []) {
        if (loc.path) paths.add(loc.path);
      }
    }
    return paths;
  } catch {
    return new Set();
  }
}

const LIBRARIES: Array<{ name: string; type: string; location: string; agent: string; scanner: string; language: string; checkpointId: string }> = [
  { name: "Movies", type: "movie", location: "/movies", agent: "tv.plex.agents.movie", scanner: "Plex Movie", language: "en-US", checkpointId: "lib_movies" },
  { name: "TV Shows", type: "show", location: "/shows", agent: "tv.plex.agents.series", scanner: "Plex TV Series", language: "en-US", checkpointId: "lib_tv" },
  { name: "Music", type: "artist", location: "/music", agent: "tv.plex.agents.music", scanner: "Plex Music", language: "en-US", checkpointId: "lib_music" },
  { name: "Photos", type: "photo", location: "/photos", agent: "com.plexapp.agents.none", scanner: "Plex Photo Scanner", language: "xn", checkpointId: "lib_photos" },
  { name: "Videos", type: "movie", location: "/videos", agent: "com.plexapp.agents.none", scanner: "Plex Video Files Scanner", language: "xn", checkpointId: "lib_videos" },
];

async function createLibraries(authToken: string, ctx: HookContext) {
  await ctx.sleep(5000);

  const existingPaths = await getExistingLibraryPaths(authToken, ctx);

  for (const lib of LIBRARIES) {
    if (existingPaths.has(lib.location)) {
      ctx.log(`Library already exists: ${lib.name}`);
      await ctx.emitCheckpoint(lib.checkpointId, `${lib.name} — already exists`);
      continue;
    }

    let created = false;
    const lastErrors = new Map<string, LibraryError>();

    while (!created) {
      await ctx.updateCheckpointMessage(lib.checkpointId, `Creating library: ${lib.name}...`);
      created = await tryCreateLibrary(authToken, ctx, lib, lastErrors);

      if (created) {
        await ctx.emitCheckpoint(lib.checkpointId, `${lib.name} — created`);
      } else {
        const lastErr = lastErrors.get(lib.name);
        await ctx.updateCheckpointMessage(lib.checkpointId, `${lib.name} — failed`);

        const action = await ctx.awaitCheckpointRetry(lib.checkpointId,
          `Failed to create library: ${lib.name}`, [
            { label: "Endpoint", value: `POST ${ctx.baseUrl}/library/sections` },
            ...(lastErr?.status ? [{ label: "Status", value: lastErr.status }] : []),
            ...(lastErr?.body ? [{ label: "Response", value: lastErr.body }] : []),
            { label: "Agent", value: lib.agent },
            { label: "Scanner", value: lib.scanner },
          ]);

        if (action === "skip") {
          await ctx.skipCheckpoint(lib.checkpointId, `${lib.name} — skipped`);
          break;
        }
      }
    }
  }
}

interface LibraryError {
  status: string;
  body: string;
}

async function tryCreateLibrary(
  authToken: string,
  ctx: HookContext,
  lib: (typeof LIBRARIES)[number],
  lastErrors: Map<string, LibraryError>,
): Promise<boolean> {
  try {
    const params = new URLSearchParams({
      "X-Plex-Token": authToken,
      name: lib.name,
      type: lib.type,
      agent: lib.agent,
      scanner: lib.scanner,
      language: lib.language,
      location: lib.location,
    });
    const resp = await fetch(`${ctx.baseUrl}/library/sections?${params}`, {
      method: "POST",
      signal: AbortSignal.timeout(15000),
    });
    if (resp.ok) {
      ctx.log(`Created library: ${lib.name}`);
      return true;
    }
    const body = await resp.text().catch(() => "");
    ctx.log(`${lib.name}: ${resp.status} ${body.substring(0, 500)}`);
    lastErrors.set(lib.name, { status: `${resp.status} ${resp.statusText}`, body: body.substring(0, 500) });
    return false;
  } catch (e) {
    ctx.log(`${lib.name}: ${e}`);
    lastErrors.set(lib.name, { status: "Network error", body: String(e) });
    return false;
  }
}
