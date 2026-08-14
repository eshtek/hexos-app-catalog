import { readFileSync, readdirSync } from "node:fs";

import type { HookContext } from "../_lib/hook_context";

const MOUNT_ROOT = "/host/mnt";
const PLEX_PREFS_RELATIVE = "Applications/plex/config/Library/Application Support/Plex Media Server/Preferences.xml";
const TAUTULLI_CONFIG_RELATIVE = "Applications/tautulli/config/config.ini";

function pools(): string[] {
  return readdirSync(MOUNT_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function findPlexCredentials(): { token: string; machineId: string } {
  for (const pool of pools()) {
    let xml: string;
    try {
      xml = readFileSync(`${MOUNT_ROOT}/${pool}/${PLEX_PREFS_RELATIVE}`, "utf-8");
    } catch {
      continue;
    }
    const token = xml.match(/PlexOnlineToken="([^"]+)"/)?.[1];
    const machineId = xml.match(/ProcessedMachineIdentifier="([^"]+)"/)?.[1];
    if (token && machineId) return { token, machineId };
  }
  throw new Error(
    "Could not read the Plex token from Preferences.xml — is Plex set up and claimed on this server?",
  );
}

function findTautulliApiKey(): string {
  for (const pool of pools()) {
    let ini: string;
    try {
      ini = readFileSync(`${MOUNT_ROOT}/${pool}/${TAUTULLI_CONFIG_RELATIVE}`, "utf-8");
    } catch {
      continue;
    }
    const key = ini.match(/^api_key\s*=\s*(\S+)/m)?.[1];
    if (key) return key;
  }
  throw new Error("Could not read Tautulli's API key from config.ini — has Tautulli finished starting up?");
}

/** Recursively search a settings payload for a key's string value. */
function findSetting(node: unknown, wanted: string): string | undefined {
  if (node === null || typeof node !== "object") return undefined;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === wanted && typeof value === "string") return value;
    const nested = findSetting(value, wanted);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

async function connectedMachineId(base: string, apiKey: string): Promise<string | undefined> {
  const response = await fetch(`${base}/api/v2?apikey=${apiKey}&cmd=get_settings`).catch(() => null);
  if (!response?.ok) return undefined;
  const body = (await response.json().catch(() => undefined)) as
    | { response?: { result?: string; data?: unknown } }
    | undefined;
  if (body?.response?.result !== "success") return undefined;
  return findSetting(body.response.data, "pms_identifier") || undefined;
}

export async function run(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "locate", message: "Locating Tautulli" },
    { id: "credentials", message: "Reading Plex and Tautulli credentials" },
    { id: "configure", message: "Pointing Tautulli at this Plex server" },
    { id: "verify", message: "Verifying the connection" },
  ]);

  const tautulliUrl = await ctx.getInstalledAppUrl("tautulli");
  if (!tautulliUrl) throw new Error("Tautulli is not installed or has no reachable port");
  if (!ctx.host || !ctx.port) throw new Error("Missing Plex host/port in action context");
  await ctx.emitCheckpoint("locate");

  const plex = findPlexCredentials();
  const apiKey = findTautulliApiKey();
  await ctx.emitCheckpoint("credentials");

  // ASCII arrow on purpose: main's apps.installScript column chokes on
  // non-cp1252 characters and the catalog sync wipes the app on failure.
  const already = await connectedMachineId(tautulliUrl, apiKey);
  if (already === plex.machineId) {
    ctx.log("Tautulli is already connected to this Plex server");
    await ctx.emitCheckpoint("configure");
    await ctx.emitCheckpoint("verify");
    return;
  }

  // A fresh Tautulli has no HTTP auth yet, so the settings endpoint is open.
  const form = new URLSearchParams({
    pms_ip: ctx.host,
    pms_port: String(ctx.port),
    pms_identifier: plex.machineId,
    pms_token: plex.token,
    pms_is_remote: "0",
    pms_ssl: "0",
    first_run_complete: "1",
  });
  const configure = await fetch(`${tautulliUrl}/configUpdate`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (configure.status === 401 || configure.status === 403) {
    throw new Error(
      "Tautulli has a password set, so it can't be connected automatically — open Tautulli and add this Plex server in its settings.",
    );
  }
  if (!configure.ok) {
    throw new Error(`Tautulli rejected the configuration (${configure.status}): ${await configure.text()}`);
  }
  await ctx.emitCheckpoint("configure");

  let verified: string | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    verified = await connectedMachineId(tautulliUrl, apiKey);
    if (verified === plex.machineId) break;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  if (verified !== plex.machineId) {
    throw new Error(
      `Tautulli did not confirm the Plex connection (reports "${verified ?? "none"}", expected "${plex.machineId}")`,
    );
  }
  await ctx.emitCheckpoint("verify");
}
