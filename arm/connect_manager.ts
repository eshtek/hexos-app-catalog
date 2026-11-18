import { chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import type { ContextMount, HookContext } from "../_lib/hook_context";

/** The user ARM runs its rips as (ARM_UID in its script). */
const APPS_UID = 568;

const MANAGERS = {
  radarr: { name: "Radarr", library: "Movies", setup: "Pre-configure Radarr", what: "movie" },
  sonarr: { name: "Sonarr", library: "Shows", setup: "Pre-configure Sonarr", what: "show" },
} as const;

/** What ARM's after_rip.py reads: where the manager answers, ARM's folder as each sees it, and the library folder to file in. */
export interface ManagerLink {
  url: string;
  apiKey: string;
  downloads: { arm: string; manager: string };
  rootFolder: string;
}

type Mount = Pick<ContextMount, "hostPath" | "containerPath">;

const trimmed = (path: string) => path.replace(/\/+$/, "");

/** A host folder as an app sees it: through the mount that holds it most closely. */
export const seenAt = (hostPath: string, mounts: Mount[]): string | undefined => {
  const wanted = trimmed(hostPath);
  const holding = mounts
    .filter((mount) => mount.containerPath && (wanted === trimmed(mount.hostPath) || wanted.startsWith(`${trimmed(mount.hostPath)}/`)))
    .sort((a, b) => trimmed(b.hostPath).length - trimmed(a.hostPath).length)[0];
  return holding ? `${trimmed(holding.containerPath as string)}${wanted.slice(trimmed(holding.hostPath).length)}` : undefined;
};

/** Where the manager sees the folder ARM rips into, or undefined when it has no mount that holds it. */
export const downloadsAs = (arm: Mount[], manager: Mount[]): ManagerLink["downloads"] | undefined => {
  const media = arm.find((mount) => mount.containerPath === "/home/arm/media");
  const seen = media && seenAt(media.hostPath, manager);
  return seen ? { arm: "/home/arm/media", manager: seen } : undefined;
};

/**
 * The manager's hook: it takes what Automatic Ripping Machine rips. ARM's folder in Downloads is a
 * dataset of its own. One made after the manager started isn't in its view of Downloads until it
 * restarts (the same as a download client's folder, servarr/connect_download_client.ts), so the
 * manager is asked whether it sees the folder ARM finishes rips in, and restarted once when it doesn't.
 */
async function connect(ctx: HookContext, id: keyof typeof MANAGERS) {
  const manager = MANAGERS[id];
  await ctx.registerCheckpoints([
    { id: "folder", message: `${manager.name} sees what you rip` },
    { id: "link", message: `Each ${manager.what} you rip goes to ${manager.name}` },
  ]);

  const settings = ctx.mounts.find((mount) => mount.containerPath === "/config") ?? ctx.mounts.find((mount) => new RegExp(`/${id}(-\\d+)?/config$`).test(mount.hostPath));
  const xml = settings && existsSync(`${settings.localPath}/config.xml`) ? readFileSync(`${settings.localPath}/config.xml`, "utf-8") : "";
  const apiKey = xml.match(/<ApiKey>([^<]+)<\/ApiKey>/)?.[1];
  if (!ctx.baseUrl || !apiKey) ctx.fail(`HexOS couldn't read ${manager.name}'s address or API key. Start ${manager.name}, then run this again.`);

  const arm = await ctx.getInstalledAppMounts("ripping-machine");
  const config = arm.find((mount) => mount.containerPath === "/etc/arm/config") ?? arm.find((mount) => /\/ripping-machine(-\d+)?\/config$/.test(mount.hostPath));
  if (!config) ctx.fail("HexOS couldn't find Automatic Ripping Machine's settings folder. Start it, then run this again.");
  const downloads = downloadsAs(arm, ctx.mounts);
  if (!downloads) ctx.fail(`${manager.name} can't reach the folder Automatic Ripping Machine rips into. Update ${manager.name} in HexOS, then run this again.`);

  const api = async <T>(path: string): Promise<T> => {
    const response = await fetch(`${ctx.baseUrl}/api/v3${path}`, { headers: { "X-Api-Key": apiKey }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`${manager.name} answered ${response.status}`);
    return (await response.json()) as T;
  };
  // ARM makes "completed" in its folder at its first start
  const sees = async () => {
    const listing = await api<{ directories?: { name?: string }[] }>(`/filesystem?${new URLSearchParams({ path: `${downloads.manager}/` })}`).catch(() => undefined);
    return Array.isArray(listing?.directories) && listing.directories.some((entry) => entry?.name === "completed");
  };
  if (!(await sees())) {
    await ctx.restartApp?.();
    await ctx.waitForApp("/ping", { maxAttempts: 30, initialDelayMs: 2000 }).catch(() => undefined);
    if (!(await sees())) ctx.fail(`${manager.name} can't see the folder Automatic Ripping Machine rips into. Start Automatic Ripping Machine, then run this again.`);
  }
  await ctx.emitCheckpoint("folder");

  let roots: { path?: string }[];
  try {
    roots = await api<{ path?: string }[]>("/rootfolder");
  } catch (error) {
    ctx.fail(`${manager.name} didn't answer. Start ${manager.name}, then run this again.`, [{ label: "Reason", value: String(error) }]);
  }
  const rootFolder = roots.map((root) => trimmed(root.path ?? "")).find(Boolean);
  if (!rootFolder) ctx.fail(`${manager.name} has no ${manager.library} folder yet. Run ${manager.setup}, then run this again.`);

  const link: ManagerLink = { url: ctx.baseUrl, apiKey, downloads, rootFolder };
  const folder = `${config.localPath}/hexos`;
  mkdirSync(folder, { recursive: true, mode: 0o750 });
  chownSync(folder, APPS_UID, APPS_UID);
  // Holds the manager's API key, so only ARM's own user reads it
  writeFileSync(`${folder}/${id}.json`, JSON.stringify(link), { mode: 0o600 });
  chownSync(`${folder}/${id}.json`, APPS_UID, APPS_UID);
  await ctx.emitCheckpoint("link");
}

export const radarr = (ctx: HookContext) => connect(ctx, "radarr");
export const sonarr = (ctx: HookContext) => connect(ctx, "sonarr");
