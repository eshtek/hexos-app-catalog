import { readFileSync, statSync } from "node:fs";
import type { HookContext } from "../_lib/hook_context";

// Links an arr app (Radarr, Sonarr, or Lidarr) to the qBittorrent app on the same server: the arr gets
// qBittorrent as its download client and its library mount as a root folder. The arr's own API
// key is read from its config file on the config mount; qBittorrent's address comes from the
// platform. Converges: a rerun updates the entries it made instead of adding more.

interface ArrProfile {
  name: string;
  rootFolder: string;
  category: string;
  categoryFields: string[];
  apiRoot: string;
  /** Lidarr's root folder carries default profiles; Radarr's and Sonarr's take a bare path. */
  rootFolderNeedsProfiles?: boolean;
}

const PROFILES: Record<string, ArrProfile> = {
  radarr: {
    name: "Radarr",
    rootFolder: "/movies",
    category: "radarr",
    categoryFields: ["movieCategory", "category"],
    apiRoot: "/api/v3",
  },
  sonarr: {
    name: "Sonarr",
    rootFolder: "/shows",
    category: "tv-sonarr",
    categoryFields: ["tvCategory", "category"],
    apiRoot: "/api/v3",
  },
  lidarr: {
    name: "Lidarr",
    rootFolder: "/music",
    category: "lidarr",
    categoryFields: ["musicCategory", "category"],
    apiRoot: "/api/v1",
    rootFolderNeedsProfiles: true,
  },
};

const QBITTORRENT_APP_ID = "qbittorrent";
const QBITTORRENT_FALLBACK_PORT = 30024;
const CLIENT_NAME = "qBittorrent (HexOS)";
const KEY_ATTEMPTS = 24;
const KEY_INTERVAL_MS = 5000;

interface ArrClient {
  baseUrl: string;
  apiRoot: string;
  apiKey: string;
  call: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
}

interface SchemaField {
  name: string;
  value?: unknown;
}

interface DownloadClient {
  id?: number;
  name: string;
  enable?: boolean;
  protocol?: string;
  priority?: number;
  implementation: string;
  configContract?: string;
  fields: SchemaField[];
  [key: string]: unknown;
}

export async function connectQbittorrent(ctx: HookContext): Promise<void> {
  const profile = PROFILES[ctx.resourceId];
  if (!profile) ctx.fail(`No link profile for ${ctx.resourceId}`);

  await ctx.registerCheckpoints([
    { id: "arrReady", message: `Reaching ${profile.name}` },
    { id: "qbitFound", message: "Finding qBittorrent" },
    { id: "rootFolderSet", message: "Setting the library folder" },
    { id: "downloadClientSet", message: "Connecting qBittorrent" },
  ]);

  const configMount = ownConfigMount(ctx);
  const apiKey = await readApiKey(ctx, profile, configMount);
  const arr = makeClient(ctx.baseUrl.replace(/\/+$/, ""), profile.apiRoot, apiKey);
  await waitForApi(arr, ctx, profile);
  await ctx.emitCheckpoint("arrReady", `${profile.name} is up`);

  requireHexosInstall(ctx, configMount.localPath, QBITTORRENT_APP_ID, "qBittorrent", "qBittorrent/qBittorrent.conf", `Add your qBittorrent as a download client in ${profile.name}'s settings yourself`);
  const qbit = await resolveQbittorrent(ctx);
  await ctx.emitCheckpoint("qbitFound", `qBittorrent at ${qbit.host}:${qbit.port}${qbit.note}`);

  await ensureRootFolder(arr, profile, ctx);
  await ctx.emitCheckpoint("rootFolderSet", `Library folder ${profile.rootFolder}`);

  const outcome = await ensureDownloadClient(arr, profile, qbit, ctx);
  await ctx.emitCheckpoint("downloadClientSet", outcome, 99);
}

interface ConfigMount {
  localPath: string;
  hostPath: string;
}

/** This app's own config mount; every HexOS install has one. */
function ownConfigMount(ctx: HookContext): ConfigMount {
  const mount = ctx.mounts.find(
    (m) => m.containerPath === "/config" || m.hostPath.replace(/\/+$/, "").endsWith(`/${ctx.resourceId}/config`),
  );
  if (!mount) {
    ctx.fail(`${ctx.resourceId} has no config mount on this run`, [
      { label: "Mounts", value: ctx.mounts.map((m) => m.hostPath).join(", ") || "none" },
    ]);
  }
  return { localPath: mount.localPath.replace(/\/+$/, ""), hostPath: mount.hostPath };
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

/** The arr's API key, from config.xml on its config mount; initialize.json is the fallback. */
async function readApiKey(ctx: HookContext, profile: ArrProfile, configMount: ConfigMount): Promise<string> {
  const configPath = `${configMount.localPath}/config.xml`;
  let lastDetail = `no <ApiKey> in ${configPath} yet`;
  for (let attempt = 1; attempt <= KEY_ATTEMPTS; attempt++) {
    try {
      const xml = readFileSync(configPath, "utf-8");
      const match = xml.match(/<ApiKey>([^<]+)<\/ApiKey>/);
      if (match?.[1]) {
        ctx.log(`API key read from ${configPath}`);
        return match[1].trim();
      }
    } catch (error) {
      lastDetail = `${configPath}: ${error instanceof Error ? error.message : String(error)}`;
    }
    try {
      const resp = await fetch(`${ctx.baseUrl}/initialize.json`, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        const init = (await resp.json()) as { apiKey?: string };
        if (init.apiKey) {
          ctx.log("API key read from initialize.json");
          return init.apiKey;
        }
      }
    } catch {
      // the app is still starting; the loop waits
    }
    await ctx.updateCheckpointMessage("arrReady", `Waiting for ${profile.name} to start (${attempt}/${KEY_ATTEMPTS})`);
    await ctx.sleep(KEY_INTERVAL_MS);
  }
  return ctx.fail(`Could not read the ${profile.name} API key`, [
    { label: "Detail", value: lastDetail },
    { label: "Mounts", value: ctx.mounts.map((m) => m.hostPath).join(", ") || "none" },
  ]);
}

function makeClient(baseUrl: string, apiRoot: string, apiKey: string): ArrClient {
  const call = async <T = unknown>(path: string, init: RequestInit = {}): Promise<T> => {
    const url = `${baseUrl}${apiRoot}${path.startsWith("/") ? path : `/${path}`}`;
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
  return { baseUrl, apiRoot, apiKey, call };
}

async function waitForApi(arr: ArrClient, ctx: HookContext, profile: ArrProfile): Promise<void> {
  let lastError = "";
  for (let attempt = 1; attempt <= KEY_ATTEMPTS; attempt++) {
    try {
      const status = await arr.call<{ version?: string }>("/system/status");
      ctx.log(`${profile.name} ${status.version ?? ""} answered`);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await ctx.updateCheckpointMessage("arrReady", `Waiting for the ${profile.name} API (${attempt}/${KEY_ATTEMPTS})`);
    await ctx.sleep(KEY_INTERVAL_MS);
  }
  ctx.fail(`${profile.name} did not answer its API`, [{ label: "Detail", value: lastError }]);
}

/** qBittorrent's address from the platform, with the chart's default port as the fallback. */
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
  try {
    const resp = await fetch(`http://${host}:${port}/api/v2/app/version`, { signal: AbortSignal.timeout(5000) });
    ctx.log(`qBittorrent /api/v2/app/version -> ${resp.status} (200 means its web UI trusts this network)`);
    if (resp.status === 403) note += " (its web UI asks for a login)";
  } catch (error) {
    ctx.log(`qBittorrent probe failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { host, port, note };
}

async function ensureRootFolder(arr: ArrClient, profile: ArrProfile, ctx: HookContext): Promise<void> {
  const path = profile.rootFolder;
  const existing = await arr.call<Array<{ path: string }>>("/rootfolder");
  const trimmed = path.replace(/\/+$/, "");
  if (existing.some((folder) => folder.path.replace(/\/+$/, "") === trimmed)) {
    ctx.log(`Root folder already present: ${path}`);
    return;
  }
  const body = profile.rootFolderNeedsProfiles ? await lidarrRootFolderBody(arr, path, ctx) : { path };
  try {
    await arr.call("/rootfolder", { method: "POST", body: JSON.stringify(body) });
    ctx.log(`Root folder added: ${path}`);
  } catch (error) {
    ctx.fail(`Could not add ${path} as a root folder`, [
      { label: "Endpoint", value: `POST ${arr.baseUrl}${arr.apiRoot}/rootfolder` },
      { label: "Detail", value: error instanceof Error ? error.message : String(error) },
    ]);
  }
}

/** Lidarr's root folder names the quality and metadata profiles new artists get; the first of each is Lidarr's own default. */
async function lidarrRootFolderBody(arr: ArrClient, path: string, ctx: HookContext): Promise<Record<string, unknown>> {
  const quality = await arr.call<Array<{ id: number; name: string }>>("/qualityprofile");
  const metadata = await arr.call<Array<{ id: number; name: string }>>("/metadataprofile");
  const qualityProfile = quality[0];
  const metadataProfile = metadata[0];
  if (!qualityProfile || !metadataProfile) {
    ctx.fail("Lidarr has no quality or metadata profile yet, so a root folder cannot be added", [
      { label: "Quality profiles", value: String(quality.length) },
      { label: "Metadata profiles", value: String(metadata.length) },
    ]);
  }
  return {
    name: "Music",
    path,
    defaultQualityProfileId: qualityProfile.id,
    defaultMetadataProfileId: metadataProfile.id,
    defaultMonitorOption: "all",
    defaultNewItemMonitorOption: "all",
    defaultTags: [],
  };
}

/**
 * The arr's download client for qBittorrent. Only the entry this hook made (by its name) is ever
 * updated; a client someone else made that already points at the same qBittorrent is left alone and
 * counts as done; any other client is left alone and ours is added beside it.
 */
async function ensureDownloadClient(
  arr: ArrClient,
  profile: ArrProfile,
  qbit: { host: string; port: number },
  ctx: HookContext,
): Promise<string> {
  const clients = await arr.call<DownloadClient[]>("/downloadclient");
  const managed = clients.find((client) => client.name === CLIENT_NAME);
  if (!managed) {
    const theirs = clients.find((client) => client.implementation === "QBittorrent" && pointsAt(client, qbit));
    if (theirs) {
      ctx.log(`qBittorrent is already set up in ${profile.name} as "${theirs.name}"; nothing changed`);
      return `qBittorrent already set up as "${theirs.name}"`;
    }
  }

  const schemas = await arr.call<DownloadClient[]>("/downloadclient/schema");
  const schema = schemas.find((entry) => entry.implementation === "QBittorrent");
  if (!schema) ctx.fail("qBittorrent is not among the download clients this version offers");

  const fields = JSON.parse(JSON.stringify(managed?.fields ?? schema.fields)) as SchemaField[];
  const setField = (name: string, value: unknown): boolean => {
    const field = fields.find((entry) => entry.name === name);
    if (!field) return false;
    field.value = value;
    return true;
  };
  setField("host", qbit.host);
  setField("port", qbit.port);
  setField("useSsl", false);
  setField("urlBase", "");
  const categoryField = profile.categoryFields.find((name) => setField(name, profile.category));
  if (!categoryField) ctx.log(`No category field among ${fields.map((f) => f.name).join(", ")}`);

  // Start from the arr's own template (or the saved client) so every top-level field it
  // validates, such as priority and the remove-on-completion flags, is present.
  const base: DownloadClient = managed ? { ...managed } : { ...schema };
  if (!managed) delete base.id;
  const payload: DownloadClient = {
    ...base,
    enable: true,
    protocol: "torrent",
    priority: typeof base.priority === "number" && base.priority > 0 ? base.priority : 1,
    name: CLIENT_NAME,
    implementation: "QBittorrent",
    configContract: "QBittorrentSettings",
    fields,
  };

  // The arr tests a client before it saves one, so a failed test means nothing would be saved:
  // report the arr's own reason and the manual fix instead of claiming a save.
  const test = await fetch(`${arr.baseUrl}${arr.apiRoot}/downloadclient/test`, {
    method: "POST",
    headers: { "X-Api-Key": arr.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  }).catch((error: unknown) => {
    ctx.fail(`${profile.name} could not run its qBittorrent test`, [
      { label: "Detail", value: error instanceof Error ? error.message : String(error) },
    ]);
  });
  if (!test.ok) {
    const body = await test.text().catch(() => "");
    ctx.fail(`${profile.name} could not connect to qBittorrent`, [
      { label: "qBittorrent", value: `${qbit.host}:${qbit.port}` },
      { label: `${profile.name} said`, value: testReason(body) },
      { label: "Next step", value: `Open ${profile.name}'s download client settings, add qBittorrent with its web UI login, or fix the reason above and run this again` },
    ]);
  }

  const verb = managed?.id ? "updated" : "added";
  await arr.call(managed?.id ? `/downloadclient/${managed.id}` : "/downloadclient", {
    method: managed?.id ? "PUT" : "POST",
    body: JSON.stringify(payload),
  });
  ctx.log(`Download client ${verb}: ${CLIENT_NAME} -> ${qbit.host}:${qbit.port} (category ${profile.category})`);
  return `qBittorrent ${verb} (${qbit.host}:${qbit.port}, category ${profile.category})`;
}

function pointsAt(client: DownloadClient, qbit: { host: string; port: number }): boolean {
  const field = (name: string) => client.fields.find((entry) => entry.name === name)?.value;
  return String(field("host") ?? "") === qbit.host && Number(field("port")) === qbit.port;
}

/** The arr's validation response is a list of {propertyName, errorMessage}; show the messages. */
function testReason(body: string): string {
  try {
    const parsed = JSON.parse(body) as Array<{ errorMessage?: string }> | { message?: string };
    if (Array.isArray(parsed)) {
      const messages = parsed.map((entry) => entry.errorMessage).filter(Boolean);
      if (messages.length) return messages.join("; ").slice(0, 400);
    } else if (parsed && typeof parsed === "object" && parsed.message) {
      return String(parsed.message).slice(0, 400);
    }
  } catch {
    // not JSON; fall through to the raw text
  }
  return body.slice(0, 400) || "no detail";
}
