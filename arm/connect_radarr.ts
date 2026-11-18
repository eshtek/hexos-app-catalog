import { chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import type { ContextMount, HookContext } from "../_lib/hook_context";

/** The user ARM runs its rips as (ARM_UID in its script). */
const APPS_UID = 568;

/** What ARM's after_rip.py reads: where Radarr answers, and each folder as ARM and as Radarr see it. */
export interface RadarrLink {
  url: string;
  apiKey: string;
  downloads: { arm: string; radarr: string };
  library: { arm: string; radarr: string };
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

export const radarrLink = (arm: Mount[], radarr: Mount[], url: string, apiKey: string): RadarrLink | { missing: "downloads" | "library" } => {
  const media = arm.find((mount) => mount.containerPath === "/home/arm/media");
  const movies = arm.find((mount) => mount.containerPath === "/movies");
  const downloads = media && seenAt(media.hostPath, radarr);
  if (!media || !downloads) return { missing: "downloads" };
  const library = movies && seenAt(movies.hostPath, radarr);
  if (!movies || !library) return { missing: "library" };
  return { url, apiKey, downloads: { arm: "/home/arm/media", radarr: downloads }, library: { arm: "/movies", radarr: library } };
};

/**
 * Radarr's hook: Radarr takes the movies Automatic Ripping Machine rips. ARM's folder in Downloads
 * is a dataset of its own. One made after Radarr started isn't in Radarr's view of Downloads until
 * Radarr restarts (the same as a download client's folder, servarr/connect_download_client.ts), so
 * Radarr is asked whether it sees the folder ARM finishes rips in, and restarted once when it doesn't.
 */
export async function radarr(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "folder", message: "Radarr sees the movies you rip" },
    { id: "link", message: "Movie rips go to Radarr" },
  ]);

  const settings = ctx.mounts.find((mount) => mount.containerPath === "/config") ?? ctx.mounts.find((mount) => /\/radarr(-\d+)?\/config$/.test(mount.hostPath));
  const xml = settings && existsSync(`${settings.localPath}/config.xml`) ? readFileSync(`${settings.localPath}/config.xml`, "utf-8") : "";
  const apiKey = xml.match(/<ApiKey>([^<]+)<\/ApiKey>/)?.[1];
  if (!ctx.baseUrl || !apiKey) ctx.fail("HexOS couldn't read Radarr's address or API key. Start Radarr, then run this again.");

  const arm = await ctx.getInstalledAppMounts("arm");
  const config = arm.find((mount) => mount.containerPath === "/etc/arm/config") ?? arm.find((mount) => /\/arm(-\d+)?\/config$/.test(mount.hostPath));
  if (!config) ctx.fail("HexOS couldn't find Automatic Ripping Machine's settings folder. Start it, then run this again.");

  const link = radarrLink(arm, ctx.mounts, ctx.baseUrl, apiKey);
  if ("missing" in link) {
    ctx.fail(
      link.missing === "downloads"
        ? "Radarr can't reach the folder Automatic Ripping Machine rips into. Update Radarr in HexOS, then run this again."
        : "Radarr and Automatic Ripping Machine don't share a Movies folder. Update both in HexOS, then run this again.",
    );
  }

  const api = async <T>(path: string): Promise<T> => {
    const response = await fetch(`${ctx.baseUrl}/api/v3${path}`, { headers: { "X-Api-Key": apiKey }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Radarr answered ${response.status}`);
    return (await response.json()) as T;
  };
  // ARM makes "completed" in its folder at its first start
  const sees = async () => {
    const listing = await api<{ directories?: { name?: string }[] }>(`/filesystem?${new URLSearchParams({ path: `${link.downloads.radarr}/` })}`).catch(
      () => undefined,
    );
    return Array.isArray(listing?.directories) && listing.directories.some((entry) => entry?.name === "completed");
  };
  if (!(await sees())) {
    await ctx.restartApp?.();
    await ctx.waitForApp("/ping", { maxAttempts: 30, initialDelayMs: 2000 }).catch(() => undefined);
    if (!(await sees())) ctx.fail("Radarr can't see the folder Automatic Ripping Machine rips into. Start Automatic Ripping Machine, then run this again.");
  }
  await ctx.emitCheckpoint("folder");

  let roots: { path?: string }[];
  try {
    roots = await api<{ path?: string }[]>("/rootfolder");
  } catch (error) {
    ctx.fail("Radarr didn't answer. Start Radarr, then run this again.", [{ label: "Reason", value: String(error) }]);
  }
  if (!roots.some((root) => trimmed(root.path ?? "") === link.library.radarr)) {
    ctx.fail("Radarr has no Movies folder yet. Run Pre-configure Radarr, then run this again.");
  }

  const folder = `${config.localPath}/hexos`;
  mkdirSync(folder, { recursive: true, mode: 0o750 });
  chownSync(folder, APPS_UID, APPS_UID);
  // Holds Radarr's API key, so only ARM's own user reads it
  writeFileSync(`${folder}/radarr.json`, JSON.stringify(link), { mode: 0o600 });
  chownSync(`${folder}/radarr.json`, APPS_UID, APPS_UID);
  await ctx.emitCheckpoint("link");
}
