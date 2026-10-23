// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { readFileSync } from "node:fs";

import type { ContextMount, HookContext } from "../_lib/hook_context";

/**
 * Adds Radarr or Sonarr to Seerr as its default service, so a request made in Seerr lands in the
 * manager (connect-radarr, connect-sonarr). Seerr needs a quality profile and a root folder from the
 * manager: Profilarr's everyday profile when Profilarr has sent it, else the manager's first, and
 * its first root folder, made at the library the HexOS install mounts when it has none yet. Run
 * again, it puts back how Seerr reaches the manager, and keeps the profile, folder and other
 * choices the owner made in Seerr while the manager still has them.
 */

/** The profile Profilarr's link sends both managers for everyday requests. */
const PREFERRED_PROFILE = "1080p Balanced";

const MANAGERS = {
  radarr: { name: "Radarr", library: "/movies", path: "radarr" },
  sonarr: { name: "Sonarr", library: "/shows", path: "sonarr" },
} as const;

type ManagerId = keyof typeof MANAGERS;

function configMount(mounts: ContextMount[], appId: string): ContextMount | undefined {
  return (
    mounts.find((m) => m.containerPath === "/config" || m.containerPath === "/app/config") ??
    mounts.find((m) => m.hostPath.endsWith(`/${appId}/config`))
  );
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

async function call<T>(url: string, apiKey: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
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
    { id: "library", message: `Reading ${manager.name}'s profile and library` },
    { id: "configure", message: `Adding ${manager.name} to Seerr` },
  ]);

  const settings = readText(`${configMount(ctx.mounts, "seerr")?.localPath}/settings.json`);
  const seerrKey = settings ? (JSON.parse(settings) as { main?: { apiKey?: string } }).main?.apiKey : undefined;
  if (!seerrKey) ctx.fail("HexOS couldn't read Seerr's API key yet. Try again once it has started.");
  // Seerr's API key acts as its first admin, who exists only once Seerr is set up with a media server
  const setUp = await fetch(`${ctx.baseUrl}/api/v1/settings/public`, { signal: AbortSignal.timeout(15_000) })
    .then((response) => response.json() as Promise<{ initialized?: boolean }>)
    .catch(() => undefined);
  // The owner skipped the media server's link that sets Seerr up, so trying again can't help
  if (setUp?.initialized === false) {
    const message = `Seerr isn't set up yet. Open Seerr and sign in with your media server, then connect ${manager.name} from Seerr's Connections tab.`;
    if (ctx.skip) ctx.skip(message);
    ctx.fail(message);
  }
  const managerUrl = await ctx.getInstalledAppUrl(managerId);
  if (!managerUrl) ctx.fail(`${manager.name} isn't installed, or HexOS can't find its port`);
  const managerKey = readText(
    `${configMount(await ctx.getInstalledAppMounts(managerId), managerId)?.localPath}/config.xml`,
  )?.match(/<ApiKey>([^<]+)<\/ApiKey>/)?.[1];
  if (!managerKey) ctx.fail(`HexOS couldn't read ${manager.name}'s API key yet. Try again once it has started.`);
  await ctx.emitCheckpoint("locate");

  const managerApi = `${managerUrl}/api/v3`;
  const profiles = await call<Array<{ id: number; name: string }>>(`${managerApi}/qualityprofile`, managerKey);
  const profile = profiles.find((entry) => entry.name === PREFERRED_PROFILE) ?? profiles[0];
  if (!profile) ctx.fail(`${manager.name} has no quality profile yet`);
  let folders = await call<Array<{ path: string }>>(`${managerApi}/rootfolder`, managerKey);
  if (folders.length === 0) {
    await call(`${managerApi}/rootfolder`, managerKey, { method: "POST", body: JSON.stringify({ path: manager.library }) });
    folders = await call<Array<{ path: string }>>(`${managerApi}/rootfolder`, managerKey);
  }
  const directory = folders[0]?.path ?? manager.library;
  await ctx.emitCheckpoint("library");

  const { hostname, port } = new URL(managerUrl);
  const service = {
    name: manager.name,
    hostname,
    port: Number(port),
    apiKey: managerKey,
    useSsl: false,
    baseUrl: "",
    activeProfileId: profile.id,
    activeProfileName: profile.name,
    activeDirectory: directory,
    is4k: false,
    isDefault: true,
    externalUrl: "",
    syncEnabled: true,
    preventSearch: false,
    tags: [],
    ...(managerId === "radarr"
      ? { minimumAvailability: "released" }
      : {
          activeAnimeProfileId: profile.id,
          activeAnimeProfileName: profile.name,
          activeAnimeDirectory: directory,
          animeTags: [],
          enableSeasonFolders: true,
          seriesType: "standard",
          animeSeriesType: "anime",
        }),
  };

  const seerrApi = `${ctx.baseUrl}/api/v1/settings/${manager.path}`;
  try {
    const existing = (await call<Array<Record<string, unknown> & { id: number; hostname: string; port: number }>>(seerrApi, seerrKey)).find(
      (entry) => entry.hostname === hostname && entry.port === Number(port),
    );
    if (existing) {
      // What the owner chose in Seerr stays while the manager still has it
      const kept: Record<string, unknown> = { ...existing };
      delete kept.id;
      const stillThere = (profileId: unknown, folder: unknown) =>
        profiles.some((entry) => entry.id === profileId) && folders.some((entry) => entry.path === folder);
      if (!stillThere(existing.activeProfileId, existing.activeDirectory)) {
        Object.assign(kept, { activeProfileId: profile.id, activeProfileName: profile.name, activeDirectory: directory });
      }
      if (managerId === "sonarr" && !stillThere(existing.activeAnimeProfileId, existing.activeAnimeDirectory)) {
        Object.assign(kept, { activeAnimeProfileId: profile.id, activeAnimeProfileName: profile.name, activeAnimeDirectory: directory });
      }
      const connection = { hostname, port: Number(port), apiKey: managerKey, useSsl: false, baseUrl: "" };
      await call(`${seerrApi}/${existing.id}`, seerrKey, { method: "PUT", body: JSON.stringify({ ...kept, ...connection }) });
    } else {
      await call(seerrApi, seerrKey, { method: "POST", body: JSON.stringify(service) });
    }
  } catch (error) {
    ctx.fail(`Seerr didn't accept ${manager.name}`, [
      { label: "Reason", value: error instanceof Error ? error.message : String(error) },
    ]);
  }
  await ctx.emitCheckpoint("configure");
}

export const radarr = (ctx: HookContext) => connect(ctx, "radarr");
export const sonarr = (ctx: HookContext) => connect(ctx, "sonarr");
