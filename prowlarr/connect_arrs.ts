import { readFileSync, statSync } from "node:fs";
import type { HookContext } from "../_lib/hook_context";

// Links Prowlarr to an arr app on the same server: the arr becomes a Prowlarr application with full
// indexer sync. Prowlarr's own API key comes from its config.xml; the arr's key comes from the arr's
// config.xml next to it (the catalog keeps every app's config at <ApplicationsPerformance>/<app>/config,
// so the sibling folder is derived from Prowlarr's own config mount). Converges: a rerun updates the
// application entry it made (named "<App> (HexOS)") instead of adding more; an entry someone else
// made for the same arr counts as done.

interface Target {
  id: string;
  name: string;
  implementation: string;
  configContract: string;
  fallbackPort: number;
}

const TARGETS: Record<string, Target> = {
  radarr: { id: "radarr", name: "Radarr", implementation: "Radarr", configContract: "RadarrSettings", fallbackPort: 30025 },
  sonarr: { id: "sonarr", name: "Sonarr", implementation: "Sonarr", configContract: "SonarrSettings", fallbackPort: 30113 },
  lidarr: { id: "lidarr", name: "Lidarr", implementation: "Lidarr", configContract: "LidarrSettings", fallbackPort: 30071 },
};

const ATTEMPTS = 24;
const INTERVAL_MS = 5000;

interface SchemaField {
  name: string;
  value?: unknown;
}

interface Application {
  id?: number;
  name: string;
  implementation: string;
  configContract?: string;
  syncLevel?: string;
  fields: SchemaField[];
  tags?: number[];
  [key: string]: unknown;
}

export async function connectRadarr(ctx: HookContext): Promise<void> {
  await connectArr(ctx, TARGETS.radarr);
}

export async function connectSonarr(ctx: HookContext): Promise<void> {
  await connectArr(ctx, TARGETS.sonarr);
}

export async function connectLidarr(ctx: HookContext): Promise<void> {
  await connectArr(ctx, TARGETS.lidarr);
}

async function connectArr(ctx: HookContext, target: Target): Promise<void> {
  await ctx.registerCheckpoints([
    { id: "prowlarrReady", message: "Reaching Prowlarr" },
    { id: "targetFound", message: `Finding ${target.name}` },
    { id: "applicationSet", message: `Connecting ${target.name}` },
  ]);

  const configMount = ownConfigMount(ctx);
  const ownKey = await readKey(ctx, `${configMount.localPath}/config.xml`, "Prowlarr", "prowlarrReady");
  const base = ctx.baseUrl.replace(/\/+$/, "");
  const prowlarr = makeClient(base, "/api/v1", ownKey);
  await waitForApi(prowlarr, ctx, "Prowlarr", "prowlarrReady");
  await ctx.emitCheckpoint("prowlarrReady", "Prowlarr is up");

  const targetUrl = await resolveTargetUrl(ctx, target);

  // Existing applications first: someone else's entry for this arr means nothing to do, and no
  // config of theirs needs reading for that.
  const applications = await prowlarr.call<Application[]>("/applications");
  const managedName = `${target.name} (HexOS)`;
  const existing = applications.find((app) => app.name === managedName);
  if (!existing) {
    const theirs = applications.find(
      (app) =>
        app.implementation === target.implementation &&
        String(app.fields.find((f) => f.name === "baseUrl")?.value ?? "").replace(/\/+$/, "") === targetUrl,
    );
    if (theirs) {
      ctx.log(`${target.name} is already set up in Prowlarr as "${theirs.name}"; nothing changed`);
      await ctx.emitCheckpoint("targetFound", `${target.name} at ${targetUrl}`);
      await ctx.emitCheckpoint("applicationSet", `${target.name} already set up as "${theirs.name}"`, 99);
      return;
    }
  }

  const targetDir = requireHexosInstall(ctx, configMount.localPath, target.id, target.name, "config.xml", `Add ${target.name} in Prowlarr under Settings, Apps, with its API key from its own settings page`);
  const targetKey = await readKey(ctx, `${targetDir}/config.xml`, target.name, "targetFound");
  await ctx.emitCheckpoint("targetFound", `${target.name} at ${targetUrl}`);

  const outcome = await ensureApplication(prowlarr, base, target, targetUrl, targetKey, existing, managedName, ctx);
  await ctx.emitCheckpoint("applicationSet", outcome, 99);
}

function ownConfigMount(ctx: HookContext): { localPath: string; hostPath: string } {
  const mount = ctx.mounts.find(
    (m) => m.containerPath === "/config" || m.hostPath.replace(/\/+$/, "").endsWith("/prowlarr/config"),
  );
  if (!mount) {
    ctx.fail("Prowlarr has no config mount on this run", [
      { label: "Mounts", value: ctx.mounts.map((m) => m.hostPath).join(", ") || "none" },
    ]);
  }
  return { localPath: mount.localPath.replace(/\/+$/, ""), hostPath: mount.hostPath };
}

/** An arr's API key from its config.xml; waits while the app writes it on first start. */
async function readKey(ctx: HookContext, path: string, appName: string, checkpoint: string): Promise<string> {
  let lastDetail = `no <ApiKey> in ${path} yet`;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const match = readFileSync(path, "utf-8").match(/<ApiKey>([^<]+)<\/ApiKey>/);
      if (match?.[1]) {
        ctx.log(`${appName} API key read from ${path}`);
        return match[1].trim();
      }
    } catch (error) {
      lastDetail = `${path}: ${error instanceof Error ? error.message : String(error)}`;
    }
    await ctx.updateCheckpointMessage(checkpoint, `Waiting for ${appName}'s config (${attempt}/${ATTEMPTS})`);
    await ctx.sleep(INTERVAL_MS);
  }
  return ctx.fail(`Could not read the ${appName} API key`, [
    { label: "Detail", value: lastDetail },
    { label: "Next step", value: `Add ${appName} in Prowlarr under Settings, Apps, with its API key from its own settings page` },
  ]);
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

interface ArrClient {
  baseUrl: string;
  apiRoot: string;
  apiKey: string;
  call: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
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

async function waitForApi(arr: ArrClient, ctx: HookContext, appName: string, checkpoint: string): Promise<void> {
  let lastError = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      await arr.call("/system/status");
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await ctx.updateCheckpointMessage(checkpoint, `Waiting for the ${appName} API (${attempt}/${ATTEMPTS})`);
    await ctx.sleep(INTERVAL_MS);
  }
  ctx.fail(`${appName} did not answer its API`, [{ label: "Detail", value: lastError }]);
}

async function resolveTargetUrl(ctx: HookContext, target: Target): Promise<string> {
  try {
    const url = await ctx.getInstalledAppUrl(target.id);
    if (url) return url.replace(/\/+$/, "");
  } catch (error) {
    ctx.log(`getInstalledAppUrl(${target.id}) failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!ctx.host) ctx.fail(`The server's LAN address is unknown, so ${target.name} cannot be reached`);
  ctx.log(`${target.name} address not reported by the platform; using the default port ${target.fallbackPort}`);
  return `http://${ctx.host}:${target.fallbackPort}`;
}

async function ensureApplication(
  prowlarr: ArrClient,
  base: string,
  target: Target,
  targetUrl: string,
  targetKey: string,
  existing: Application | undefined,
  managedName: string,
  ctx: HookContext,
): Promise<string> {
  const schemas = await prowlarr.call<Application[]>("/applications/schema");
  const schema = schemas.find((entry) => entry.implementation === target.implementation);
  if (!schema) ctx.fail(`${target.name} is not among the applications this Prowlarr offers`);

  const fields = JSON.parse(JSON.stringify(existing?.fields ?? schema.fields)) as SchemaField[];
  const setField = (name: string, value: unknown) => {
    const field = fields.find((entry) => entry.name === name);
    if (field) field.value = value;
    else ctx.log(`No ${name} field among ${fields.map((f) => f.name).join(", ")}`);
  };
  setField("prowlarrUrl", base);
  setField("baseUrl", targetUrl);
  setField("apiKey", targetKey);

  const payload: Application = {
    ...(existing ?? schema),
    name: managedName,
    implementation: target.implementation,
    configContract: target.configContract,
    syncLevel: "fullSync",
    fields,
    tags: existing?.tags ?? [],
  };
  if (!existing) delete payload.id;

  let testDetail = "";
  try {
    const test = await fetch(`${prowlarr.baseUrl}${prowlarr.apiRoot}/applications/test`, {
      method: "POST",
      headers: { "X-Api-Key": prowlarr.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    if (!test.ok) testDetail = `${test.status} ${(await test.text().catch(() => "")).slice(0, 400)}`;
  } catch (error) {
    testDetail = error instanceof Error ? error.message : String(error);
  }
  if (testDetail) {
    ctx.fail(`Prowlarr could not reach ${target.name} with the key it read`, [
      { label: target.name, value: targetUrl },
      { label: "Test result", value: testDetail },
      { label: "Next step", value: `Check that ${target.name} is running, then run this again` },
    ]);
  }

  const verb = existing?.id ? "updated" : "added";
  await prowlarr.call(existing?.id ? `/applications/${existing.id}` : "/applications", {
    method: existing?.id ? "PUT" : "POST",
    body: JSON.stringify(payload),
  });
  ctx.log(`Application ${verb}: ${target.name} -> ${targetUrl} (full sync)`);
  return `${target.name} ${verb} with full indexer sync`;
}
