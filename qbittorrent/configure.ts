import type { HookContext } from "../_lib/hook_context";

// Points qBittorrent at the Downloads folder through its own settings: the default save path is
// the Downloads mount as the container sees it, and automatic torrent management is on so each
// app that sends downloads (by category) gets its own subfolder. Converges: a rerun re-reads the
// settings and only writes when they differ.

const PREFERRED_MOUNT = "/downloads";
const READY_ATTEMPTS = 24;
const READY_INTERVAL_MS = 5000;

interface Prefs {
  save_path?: string;
  auto_tmm_enabled?: boolean;
  category_changed_tmm_enabled?: boolean;
}

export async function configure(ctx: HookContext): Promise<void> {
  await ctx.registerCheckpoints([
    { id: "qbitReady", message: "Reaching qBittorrent" },
    { id: "savePathSet", message: "Setting the download folder" },
  ]);

  const savePath = downloadsMountPath(ctx);
  await waitForWebUi(ctx);
  await ctx.emitCheckpoint("qbitReady", "qBittorrent is up");

  const wanted: Prefs = { save_path: savePath, auto_tmm_enabled: true, category_changed_tmm_enabled: true };
  const current = await readPrefs(ctx);
  if (matches(current, wanted)) {
    ctx.log(`Download folder already ${savePath} with automatic management on`);
    await ctx.emitCheckpoint("savePathSet", `Downloads go to ${savePath} (already set)`, 99);
    return;
  }

  await writePrefs(ctx, wanted);
  await ctx.sleep(1000);
  const after = await readPrefs(ctx);
  if (!matches(after, wanted)) {
    ctx.fail("qBittorrent did not keep the download folder setting", [
      { label: "Wanted", value: JSON.stringify(wanted) },
      { label: "Read back", value: JSON.stringify(after) },
    ]);
  }
  ctx.log(`Download folder set to ${savePath}, automatic management on`);
  await ctx.emitCheckpoint("savePathSet", `Downloads go to ${savePath}, one subfolder per app`, 99);
}

/** The Downloads folder as qBittorrent sees it: the /downloads mount, else the mount of the qbittorrent subfolder. */
function downloadsMountPath(ctx: HookContext): string {
  const preferred = ctx.mounts.find((m) => m.containerPath === PREFERRED_MOUNT);
  if (preferred) return PREFERRED_MOUNT;
  const bySubfolder = ctx.mounts.find((m) => m.containerPath && m.hostPath.replace(/\/+$/, "").endsWith("/qbittorrent"));
  if (bySubfolder?.containerPath) return bySubfolder.containerPath;
  return ctx.fail("qBittorrent has no Downloads folder mounted", [
    { label: "Mounts", value: ctx.mounts.map((m) => `${m.hostPath} -> ${m.containerPath ?? "(fixed)"}`).join("; ") || "none" },
  ]);
}

async function waitForWebUi(ctx: HookContext): Promise<void> {
  let last = "";
  for (let attempt = 1; attempt <= READY_ATTEMPTS; attempt++) {
    let status: number | null = null;
    try {
      status = (await fetch(`${ctx.baseUrl}/api/v2/app/version`, { signal: AbortSignal.timeout(5000) })).status;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (status === 200) return;
    if (status === 403 || status === 401) {
      // Outside the try above on purpose: this is the answer, not a transient failure.
      ctx.fail("qBittorrent's web UI asks for a login, so its settings cannot be written from here", [
        { label: "Status", value: String(status) },
        { label: "Next step", value: "Set the download folder in qBittorrent's settings, under Downloads" },
      ]);
    }
    if (status !== null) last = `status ${status}`;
    await ctx.updateCheckpointMessage("qbitReady", `Waiting for qBittorrent to start (${attempt}/${READY_ATTEMPTS})`);
    await ctx.sleep(READY_INTERVAL_MS);
  }
  ctx.fail("qBittorrent did not answer its web UI", [{ label: "Detail", value: last }]);
}

async function readPrefs(ctx: HookContext): Promise<Prefs> {
  const resp = await fetch(`${ctx.baseUrl}/api/v2/app/preferences`, {
    headers: { Referer: ctx.baseUrl },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) {
    ctx.fail("Could not read qBittorrent's settings", [{ label: "Status", value: String(resp.status) }]);
  }
  const data = (await resp.json()) as Prefs;
  return {
    save_path: data.save_path,
    auto_tmm_enabled: data.auto_tmm_enabled,
    category_changed_tmm_enabled: data.category_changed_tmm_enabled,
  };
}

async function writePrefs(ctx: HookContext, prefs: Prefs): Promise<void> {
  const resp = await fetch(`${ctx.baseUrl}/api/v2/app/setPreferences`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: ctx.baseUrl },
    body: new URLSearchParams({ json: JSON.stringify(prefs) }).toString(),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) {
    ctx.fail("qBittorrent refused the settings change", [
      { label: "Endpoint", value: `POST ${ctx.baseUrl}/api/v2/app/setPreferences` },
      { label: "Status", value: `${resp.status} ${(await resp.text().catch(() => "")).slice(0, 300)}` },
    ]);
  }
}

function matches(current: Prefs, wanted: Prefs): boolean {
  const trim = (p?: string) => (p ?? "").replace(/\/+$/, "");
  return (
    trim(current.save_path) === trim(wanted.save_path) &&
    current.auto_tmm_enabled === wanted.auto_tmm_enabled &&
    current.category_changed_tmm_enabled === wanted.category_changed_tmm_enabled
  );
}
