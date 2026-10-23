import { readFileSync, statSync } from "node:fs";
import type { HookContext } from "../_lib/hook_context";

// Links Bazarr to Radarr or Sonarr on the same server through Bazarr's settings API. Bazarr's own key
// comes from config/config.yaml on its config mount; the arr's key from the arr's config.xml next to
// it (every app's config sits at <ApplicationsPerformance>/<app>/config). Bazarr's library mounts use
// the same container paths as the arrs (/movies, /shows), so no path mapping is written. Converges:
// a rerun re-reads the settings and only writes when they differ; a connection someone made to a
// different arr is left alone.

interface Target {
  id: string;
  name: string;
  section: "radarr" | "sonarr";
  fallbackPort: number;
}

const TARGETS: Record<string, Target> = {
  radarr: { id: "radarr", name: "Radarr", section: "radarr", fallbackPort: 30025 },
  sonarr: { id: "sonarr", name: "Sonarr", section: "sonarr", fallbackPort: 30113 },
};

const ATTEMPTS = 24;
const INTERVAL_MS = 5000;

export async function connectRadarr(ctx: HookContext): Promise<void> {
  await connectArr(ctx, TARGETS.radarr);
}

export async function connectSonarr(ctx: HookContext): Promise<void> {
  await connectArr(ctx, TARGETS.sonarr);
}

async function connectArr(ctx: HookContext, target: Target): Promise<void> {
  await ctx.registerCheckpoints([
    { id: "bazarrReady", message: "Reaching Bazarr" },
    { id: "targetFound", message: `Finding ${target.name}` },
    { id: "settingsSet", message: `Connecting ${target.name}` },
  ]);

  const configMount = ownConfigMount(ctx);
  const ownKey = await readBazarrKey(ctx, `${configMount}/config/config.yaml`);
  const base = ctx.baseUrl.replace(/\/+$/, "");
  await waitForApi(base, ownKey, ctx);
  await ctx.emitCheckpoint("bazarrReady", "Bazarr is up");

  const targetUrl = await resolveTargetUrl(ctx, target);
  const parsed = new URL(targetUrl);
  const port = parsed.port || "80";

  // Bazarr holds one connection per arr. A connection someone else filled in (its key is set) that
  // points elsewhere is theirs, enabled or not: leave it alone and say so.
  const current = await readSettings(base, ownKey, ctx);
  const section = current[target.section] ?? {};
  const theirs = typeof section.apikey === "string" && section.apikey !== "" &&
    (section.ip !== parsed.hostname || String(section.port) !== port);
  if (theirs) {
    ctx.log(`Bazarr is already connected to a ${target.name} at ${section.ip}:${section.port}; nothing changed`);
    await ctx.emitCheckpoint("targetFound", `${target.name} at ${targetUrl}`);
    await ctx.emitCheckpoint("settingsSet", `${target.name} already set up at ${section.ip}:${section.port}`, 99);
    return;
  }

  const targetDir = requireHexosInstall(ctx, configMount, target.id, target.name, "config.xml", `Enter ${target.name}'s address and API key in Bazarr under Settings, ${target.name}`);
  const targetKey = await readArrKey(ctx, `${targetDir}/config.xml`, target.name);
  await verifyArrKey(ctx, target, targetUrl, targetKey);
  await ctx.emitCheckpoint("targetFound", `${target.name} at ${targetUrl}`);

  const wanted: Wanted = { ip: parsed.hostname, port, base_url: "/", ssl: false, apikey: targetKey };
  if (settingsMatch(current, target, wanted)) {
    ctx.log(`${target.name} already set in Bazarr`);
    await ctx.emitCheckpoint("settingsSet", `${target.name} already connected`, 99);
    return;
  }
  const form = {
    [`settings-general-use_${target.section}`]: "true",
    [`settings-${target.section}-ip`]: wanted.ip,
    [`settings-${target.section}-port`]: wanted.port,
    [`settings-${target.section}-base_url`]: wanted.base_url,
    [`settings-${target.section}-ssl`]: "false",
    [`settings-${target.section}-apikey`]: wanted.apikey,
  };
  const resp = await fetch(`${base}/api/system/settings`, {
    method: "POST",
    headers: { "X-API-KEY": ownKey, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) {
    ctx.fail(`Bazarr refused the ${target.name} settings`, [
      { label: "Endpoint", value: `POST ${base}/api/system/settings` },
      { label: "Status", value: `${resp.status} ${(await resp.text().catch(() => "")).slice(0, 300)}` },
    ]);
  }
  await ctx.sleep(1500);
  const after = await readSettings(base, ownKey, ctx);
  const mismatched = mismatchedFields(after, target, wanted);
  if (mismatched.length) {
    ctx.fail(`Bazarr did not keep the ${target.name} settings`, [
      { label: "Fields not kept", value: mismatched.join(", ") },
    ]);
  }
  ctx.log(`${target.name} set in Bazarr: ${wanted.ip}:${wanted.port}`);
  await ctx.emitCheckpoint("settingsSet", `${target.name} connected (${wanted.ip}:${wanted.port})`, 99);
}

interface Wanted {
  ip: string;
  port: string;
  base_url: string;
  ssl: boolean;
  apikey: string;
}

/** The key read off disk must open the arr's API, or Bazarr would store a stale key and call it connected. */
async function verifyArrKey(ctx: HookContext, target: Target, targetUrl: string, key: string): Promise<void> {
  let detail = "";
  try {
    const resp = await fetch(`${targetUrl}/api/v3/system/status`, { headers: { "X-Api-Key": key }, signal: AbortSignal.timeout(10000) });
    if (resp.ok) return;
    detail = `status ${resp.status}`;
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  }
  ctx.fail(`${target.name} did not accept the key read from its config`, [
    { label: target.name, value: targetUrl },
    { label: "Detail", value: detail },
    { label: "Next step", value: `Check that ${target.name} is running and its config folder is the one this install made, then run this again` },
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

function ownConfigMount(ctx: HookContext): string {
  const mount = ctx.mounts.find(
    (m) => m.containerPath === "/config" || m.hostPath.replace(/\/+$/, "").endsWith("/bazarr/config"),
  );
  if (!mount) {
    ctx.fail("Bazarr has no config mount on this run", [
      { label: "Mounts", value: ctx.mounts.map((m) => m.hostPath).join(", ") || "none" },
    ]);
  }
  return mount.localPath.replace(/\/+$/, "");
}

/** Bazarr's API key: the apikey under the auth section of config.yaml. */
async function readBazarrKey(ctx: HookContext, path: string): Promise<string> {
  let lastDetail = `no auth apikey in ${path} yet`;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const text = readFileSync(path, "utf-8");
      const authAt = text.search(/^auth:\s*$/m);
      if (authAt >= 0) {
        const match = text.slice(authAt).match(/^\s+apikey:\s*['"]?([A-Za-z0-9]+)['"]?\s*$/m);
        if (match?.[1]) {
          ctx.log(`Bazarr API key read from ${path}`);
          return match[1];
        }
      }
    } catch (error) {
      lastDetail = `${path}: ${error instanceof Error ? error.message : String(error)}`;
    }
    await ctx.updateCheckpointMessage("bazarrReady", `Waiting for Bazarr's config (${attempt}/${ATTEMPTS})`);
    await ctx.sleep(INTERVAL_MS);
  }
  return ctx.fail("Could not read the Bazarr API key", [{ label: "Detail", value: lastDetail }]);
}

async function readArrKey(ctx: HookContext, path: string, appName: string): Promise<string> {
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
    await ctx.updateCheckpointMessage("targetFound", `Waiting for ${appName}'s config (${attempt}/${ATTEMPTS})`);
    await ctx.sleep(INTERVAL_MS);
  }
  return ctx.fail(`Could not read the ${appName} API key`, [
    { label: "Detail", value: lastDetail },
    { label: "Next step", value: `Enter ${appName}'s address and API key in Bazarr under Settings, ${appName}` },
  ]);
}

async function waitForApi(base: string, key: string, ctx: HookContext): Promise<void> {
  let last = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(`${base}/api/system/status`, { headers: { "X-API-KEY": key }, signal: AbortSignal.timeout(5000) });
      if (resp.ok) return;
      last = `status ${resp.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await ctx.updateCheckpointMessage("bazarrReady", `Waiting for the Bazarr API (${attempt}/${ATTEMPTS})`);
    await ctx.sleep(INTERVAL_MS);
  }
  ctx.fail("Bazarr did not answer its API", [{ label: "Detail", value: last }]);
}

async function resolveTargetUrl(ctx: HookContext, target: Target): Promise<string> {
  try {
    const url = await ctx.getInstalledAppUrl(target.id);
    if (url) return url.replace(/\/+$/, "");
  } catch (error) {
    ctx.log(`getInstalledAppUrl(${target.id}) failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!ctx.host) ctx.fail(`The server's LAN address is unknown, so ${target.name} cannot be reached`);
  return `http://${ctx.host}:${target.fallbackPort}`;
}

type Settings = Record<string, Record<string, unknown>>;

async function readSettings(base: string, key: string, ctx: HookContext): Promise<Settings> {
  const resp = await fetch(`${base}/api/system/settings`, { headers: { "X-API-KEY": key }, signal: AbortSignal.timeout(15000) });
  if (!resp.ok) ctx.fail("Could not read Bazarr's settings", [{ label: "Status", value: String(resp.status) }]);
  return (await resp.json()) as Settings;
}

const trimSlashes = (value: unknown) => String(value ?? "").replace(/^\/+|\/+$/g, "");

/** Every field the hook writes, by name, that Bazarr does not currently hold as wanted. */
function mismatchedFields(settings: Settings, target: Target, wanted: Wanted): string[] {
  const section = settings[target.section] ?? {};
  const general = settings.general ?? {};
  const bad: string[] = [];
  if (general[`use_${target.section}`] !== true) bad.push(`use_${target.section}`);
  if (section.ip !== wanted.ip) bad.push("ip");
  if (String(section.port) !== wanted.port) bad.push("port");
  if (trimSlashes(section.base_url) !== trimSlashes(wanted.base_url)) bad.push("base_url");
  if (Boolean(section.ssl) !== wanted.ssl) bad.push("ssl");
  if (section.apikey !== wanted.apikey) bad.push("apikey");
  return bad;
}

function settingsMatch(settings: Settings, target: Target, wanted: Wanted): boolean {
  return mismatchedFields(settings, target, wanted).length === 0;
}
