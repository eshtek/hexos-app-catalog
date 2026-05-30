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

  await claimServer(authToken, ctx);
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

async function createLibraries(authToken: string, ctx: HookContext) {
  const libraries = [
    { name: "Movies", type: "movie", location: "/movies", agent: "tv.plex.agents.movie", scanner: "Plex Movie", checkpointId: "lib_movies" },
    { name: "TV Shows", type: "show", location: "/shows", agent: "tv.plex.agents.series", scanner: "Plex TV Series", checkpointId: "lib_tv" },
    { name: "Music", type: "artist", location: "/music", agent: "tv.plex.agents.music", scanner: "Plex Music", checkpointId: "lib_music" },
    { name: "Photos", type: "photo", location: "/photos", agent: "com.plexapp.agents.none", scanner: "Plex Photo Scanner", checkpointId: "lib_photos" },
    { name: "Videos", type: "other", location: "/videos", agent: "com.plexapp.agents.none", scanner: "Plex Video Files Scanner", checkpointId: "lib_videos" },
  ];

  await ctx.sleep(5000);

  // Fetch once upfront — only matters on retries where some libraries already exist
  const existingPaths = await getExistingLibraryPaths(authToken, ctx);

  for (const lib of libraries) {
    if (existingPaths.has(lib.location)) {
      ctx.log(`Library already exists: ${lib.name}`);
      await ctx.emitCheckpoint(lib.checkpointId, `${lib.name} — already exists`);
      continue;
    }

    await ctx.updateCheckpointMessage(lib.checkpointId, `Creating library: ${lib.name}...`);

    let created = false;
    let backoff = 5000;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const params = new URLSearchParams({
          "X-Plex-Token": authToken,
          name: lib.name,
          type: lib.type,
          agent: lib.agent,
          scanner: lib.scanner,
          language: "en-US",
          location: lib.location,
        });
        const resp = await fetch(`${ctx.baseUrl}/library/sections?${params}`, {
          method: "POST",
          signal: AbortSignal.timeout(15000),
        });
        if (resp.ok) {
          ctx.log(`Created library: ${lib.name}`);
          created = true;
          break;
        }
        ctx.log(`${lib.name} attempt ${attempt + 1}: ${resp.status}`);
        await ctx.updateCheckpointMessage(lib.checkpointId, `Creating library: ${lib.name} (attempt ${attempt + 2})...`);
      } catch (e) {
        ctx.log(`${lib.name} attempt ${attempt + 1}: ${e}`);
        await ctx.updateCheckpointMessage(lib.checkpointId, `Creating library: ${lib.name} (attempt ${attempt + 2})...`);
      }
      await ctx.sleep(backoff);
      backoff = Math.min(backoff * 1.5, 20000);
    }

    if (created) {
      await ctx.emitCheckpoint(lib.checkpointId, `${lib.name} — created`);
    } else {
      await ctx.emitCheckpoint(lib.checkpointId, `${lib.name} — failed after 10 attempts`);
      ctx.log(`Failed to create library ${lib.name} after 10 attempts`);
    }
  }

  // Validate all libraries exist
  const finalPaths = await getExistingLibraryPaths(authToken, ctx);
  const missing = libraries.filter((lib) => !finalPaths.has(lib.location));
  if (missing.length > 0) {
    const names = missing.map((lib) => lib.name).join(", ");
    throw new Error(`Failed to create libraries: ${names}`);
  }
}
