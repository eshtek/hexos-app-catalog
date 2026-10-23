import { readFileSync, statSync } from "node:fs";
import type { HookContext } from "../_lib/hook_context";

// Links Sportarr to the qBittorrent app on the same server: qBittorrent becomes Sportarr's download
// client (category sportarr) and the sports library mount its root folder. Sportarr has its own API
// (plain JSON bodies under /api, X-Api-Key from its config.xml), so this hook does not share the arr one.

const QBITTORRENT_APP_ID = "qbittorrent";
const QBITTORRENT_FALLBACK_PORT = 30024;
const CLIENT_NAME = "qBittorrent (HexOS)";
const CATEGORY = "sportarr";
const ROOT_FOLDER = "/media/sports";
const QBITTORRENT_TYPE = 0;
const ATTEMPTS = 24;
const INTERVAL_MS = 5000;

interface DownloadClient {
  id?: number;
  name: string;
  type: number;
  host: string;
  port: number;
  [key: string]: unknown;
}

export async function connectQbittorrent(ctx: HookContext): Promise<void> {
  await ctx.registerCheckpoints([
    { id: "arrReady", message: "Reaching Sportarr" },
    { id: "qbitFound", message: "Finding qBittorrent" },
    { id: "rootFolderSet", message: "Setting the library folder" },
    { id: "downloadClientSet", message: "Connecting qBittorrent" },
  ]);

  const configMount = ownConfigMount(ctx);
  const apiKey = await readApiKey(ctx, configMount);
  const base = ctx.baseUrl.replace(/\/+$/, "");
  const call = makeCaller(base, apiKey);
  await waitForApi(call, ctx);
  await ctx.emitCheckpoint("arrReady", "Sportarr is up");

  requireHexosInstall(ctx, configMount, QBITTORRENT_APP_ID, "qBittorrent", "qBittorrent/qBittorrent.conf", "Add your qBittorrent as a download client in Sportarr's settings yourself");
  const qbit = await resolveQbittorrent(ctx);
  await ctx.emitCheckpoint("qbitFound", `qBittorrent at ${qbit.host}:${qbit.port}${qbit.note}`);

  await ensureRootFolder(call, base, ctx);
  await ctx.emitCheckpoint("rootFolderSet", `Library folder ${ROOT_FOLDER}`);

  const outcome = await ensureDownloadClient(call, base, apiKey, qbit, ctx);
  await ctx.emitCheckpoint("downloadClientSet", outcome, 99);
}

/** Sportarr's own config mount; every HexOS install has one. */
function ownConfigMount(ctx: HookContext): string {
  const mount = ctx.mounts.find(
    (m) => m.containerPath === "/config" || m.hostPath.replace(/\/+$/, "").endsWith("/sportarr/config"),
  );
  if (!mount) {
    ctx.fail("Sportarr has no config mount on this run", [
      { label: "Mounts", value: ctx.mounts.map((m) => m.hostPath).join(", ") || "none" },
    ]);
  }
  return mount.localPath.replace(/\/+$/, "");
}

/**
 * Every app HexOS installs keeps its settings at <ApplicationsPerformance>/<app>/config: the install
 * scripts fix that shape, so anything a hook needs from another app is read from there and nowhere
 * else, with the location taken from this app's own config mount. No settings file at that path
 * means the app was installed some other way, and it is not touched.
 */
function requireHexosInstall(
  ctx: HookContext,
  ownConfigLocalPath: string,
  appId: string,
  appName: string,
  settingsFile: string,
  nextStep: string,
): string {
  const ownRoot = ownConfigLocalPath.replace(/\/+$/, "").replace(/\/[^/]+\/config$/, "");
  const dir = `${ownRoot}/${appId}/config`;
  if (!isFile(`${dir}/${settingsFile}`)) {
    ctx.fail(`${appName} was not found in the HexOS apps folder`, [
      { label: "Looked in", value: dir.replace(/^\/host/, "") },
      { label: "Why", value: "HexOS links only the apps it installed, and each of those keeps its settings in that folder" },
      { label: "Next step", value: nextStep },
    ]);
  }
  return dir;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Sportarr's API key from config.xml on its config mount. */
async function readApiKey(ctx: HookContext, configMount: string): Promise<string> {
  const configPath = `${configMount}/config.xml`;
  let lastDetail = `no <ApiKey> in ${configPath} yet`;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const match = readFileSync(configPath, "utf-8").match(/<ApiKey>([^<]+)<\/ApiKey>/);
      if (match?.[1]) {
        ctx.log(`API key read from ${configPath}`);
        return match[1].trim();
      }
    } catch (error) {
      lastDetail = `${configPath}: ${error instanceof Error ? error.message : String(error)}`;
    }
    await ctx.updateCheckpointMessage("arrReady", `Waiting for Sportarr to start (${attempt}/${ATTEMPTS})`);
    await ctx.sleep(INTERVAL_MS);
  }
  return ctx.fail("Could not read the Sportarr API key", [
    { label: "Detail", value: lastDetail },
    { label: "Mounts", value: ctx.mounts.map((m) => m.hostPath).join(", ") || "none" },
  ]);
}

type Caller = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;

function makeCaller(base: string, apiKey: string): Caller {
  return async <T = unknown>(path: string, init: RequestInit = {}): Promise<T> => {
    const url = `${base}${path}`;
    const resp = await fetch(url, {
      ...init,
      headers: { "X-Api-Key": apiKey, "Content-Type": "application/json", ...(init.headers ?? {}) },
      signal: init.signal ?? AbortSignal.timeout(20000),
    });
    if (!resp.ok) {
      const body = (await resp.text().catch(() => "")).slice(0, 500);
      throw new Error(`${init.method ?? "GET"} ${url} -> ${resp.status} ${body}`);
    }
    const text = await resp.text();
    return (text ? JSON.parse(text) : undefined) as T;
  };
}

async function waitForApi(call: Caller, ctx: HookContext): Promise<void> {
  let lastError = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      await call("/api/rootfolder");
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await ctx.updateCheckpointMessage("arrReady", `Waiting for the Sportarr API (${attempt}/${ATTEMPTS})`);
    await ctx.sleep(INTERVAL_MS);
  }
  ctx.fail("Sportarr did not answer its API", [{ label: "Detail", value: lastError }]);
}

async function resolveQbittorrent(ctx: HookContext): Promise<{ host: string; port: number; note: string }> {
  let host = ctx.host ?? "";
  let port = QBITTORRENT_FALLBACK_PORT;
  let note = "";
  try {
    const url = await ctx.getInstalledAppUrl(QBITTORRENT_APP_ID);
    if (url) {
      const parsed = new URL(url);
      host = parsed.hostname;
      port = Number(parsed.port) || QBITTORRENT_FALLBACK_PORT;
    } else {
      note = " (address not reported by the platform; using the default port)";
    }
  } catch (error) {
    ctx.log(`getInstalledAppUrl failed: ${error instanceof Error ? error.message : String(error)}`);
    note = " (address lookup failed; using the default port)";
  }
  if (!host) ctx.fail("The server's LAN address is unknown, so qBittorrent cannot be reached");
  return { host, port, note };
}

async function ensureRootFolder(call: Caller, base: string, ctx: HookContext): Promise<void> {
  const existing = await call<Array<{ path: string }>>("/api/rootfolder");
  if (existing.some((folder) => folder.path.replace(/\/+$/, "") === ROOT_FOLDER)) {
    ctx.log(`Root folder already present: ${ROOT_FOLDER}`);
    return;
  }
  try {
    await call("/api/rootfolder", { method: "POST", body: JSON.stringify({ path: ROOT_FOLDER }) });
    ctx.log(`Root folder added: ${ROOT_FOLDER}`);
  } catch (error) {
    ctx.fail(`Could not add ${ROOT_FOLDER} as a root folder`, [
      { label: "Endpoint", value: `POST ${base}/api/rootfolder` },
      { label: "Detail", value: error instanceof Error ? error.message : String(error) },
    ]);
  }
}

/**
 * Sportarr's download client for qBittorrent. Only the entry this hook made (by its name) is ever
 * updated; a client someone else made that already points at the same qBittorrent counts as done.
 */
async function ensureDownloadClient(
  call: Caller,
  base: string,
  apiKey: string,
  qbit: { host: string; port: number },
  ctx: HookContext,
): Promise<string> {
  const clients = await call<DownloadClient[]>("/api/downloadclient");
  const managed = clients.find((client) => client.name === CLIENT_NAME);
  if (!managed) {
    const theirs = clients.find((client) => client.type === QBITTORRENT_TYPE && client.host === qbit.host && Number(client.port) === qbit.port);
    if (theirs) {
      ctx.log(`qBittorrent is already set up in Sportarr as "${theirs.name}"; nothing changed`);
      return `qBittorrent already set up as "${theirs.name}"`;
    }
  }
  const payload: DownloadClient = {
    ...(managed ?? {}),
    name: CLIENT_NAME,
    type: QBITTORRENT_TYPE,
    host: qbit.host,
    port: qbit.port,
    useSsl: false,
    urlBase: "",
    username: typeof managed?.username === "string" ? managed.username : "",
    password: typeof managed?.password === "string" ? managed.password : "",
    category: CATEGORY,
    enabled: true,
    priority: typeof managed?.priority === "number" ? managed.priority : 1,
  };

  // Test first; a failed test is reported with Sportarr's own reason and nothing is saved.
  const test = await fetch(`${base}/api/downloadclient/test`, {
    method: "POST",
    headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  }).catch((error: unknown) => {
    ctx.fail("Sportarr could not run its qBittorrent test", [
      { label: "Detail", value: error instanceof Error ? error.message : String(error) },
    ]);
  });
  const testBody = await resp_text(test);
  if (!test.ok) {
    let reason = testBody.slice(0, 400) || "no detail";
    try {
      const parsed = JSON.parse(testBody) as { message?: string };
      if (parsed?.message) reason = String(parsed.message).slice(0, 400);
    } catch {
      // not JSON
    }
    ctx.fail("Sportarr could not connect to qBittorrent", [
      { label: "qBittorrent", value: `${qbit.host}:${qbit.port}` },
      { label: "Sportarr said", value: reason },
      { label: "Next step", value: "Open Sportarr's download client settings, add qBittorrent with its web UI login, or fix the reason above and run this again" },
    ]);
  }

  const verb = managed?.id ? "updated" : "added";
  await call(managed?.id ? `/api/downloadclient/${managed.id}` : "/api/downloadclient", {
    method: managed?.id ? "PUT" : "POST",
    body: JSON.stringify(payload),
  });
  ctx.log(`Download client ${verb}: ${CLIENT_NAME} -> ${qbit.host}:${qbit.port} (category ${CATEGORY})`);
  return `qBittorrent ${verb} (${qbit.host}:${qbit.port}, category ${CATEGORY})`;
}

async function resp_text(resp: Response): Promise<string> {
  return resp.text().catch(() => "");
}
