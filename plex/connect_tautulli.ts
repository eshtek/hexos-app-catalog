// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { readFileSync } from "node:fs";

import type { ContextMount, HookContext } from "../_lib/hook_context";

const PREFS_RELATIVE = "/Library/Application Support/Plex Media Server/Preferences.xml";
const DOCKER_SOCKET = "/var/run/docker.sock";
/** Each read is short, and Tautulli's config.ini is waited for in a loop of its own. */
const DOCKER_TIMEOUT_MS = 2000;

/** The file in a tar from Docker's archive endpoint: a 512-byte header, then its bytes. */
export function untar(tar: Uint8Array): string {
  const text = new TextDecoder();
  for (let at = 0; tar[at]; ) {
    const size = Number.parseInt(text.decode(tar.subarray(at + 124, at + 136)), 8);
    const type = tar[at + 156];
    if (type === 0 || type === 48) return text.decode(tar.subarray(at + 512, at + 512 + size)); // a regular file
    at += 512 + Math.ceil(size / 512) * 512; // a pax header ahead of the file
  }
  return "";
}

async function readThroughDocker(appId: string, path: string): Promise<string> {
  const url = `http://docker/containers/ix-${appId}-${appId}-1/archive?path=${encodeURIComponent(path)}`;
  try {
    const response = await fetch(url, { unix: DOCKER_SOCKET, signal: AbortSignal.timeout(DOCKER_TIMEOUT_MS) });
    return response.ok ? untar(new Uint8Array(await response.arrayBuffer())) : "";
  } catch {
    return ""; // a box with no socket yet
  }
}

/**
 * A file from an app's config folder, empty when there's none yet. The folder sits on the app's own
 * dataset, which the HexOS container can't see on a box whose app config predates the pool mounts,
 * so what the mount doesn't give is read out of the app's container over the daemon socket the
 * HexOS container has for its host commands.
 */
async function readConfigFile(appId: string, config: ContextMount, file: string): Promise<string> {
  try {
    return readFileSync(config.localPath + file, "utf-8");
  } catch {
    return readThroughDocker(appId, (config.containerPath ?? "/config") + file);
  }
}

/** Plex's config folder. The chart fixes its container path, so it is matched by host path. */
function plexConfig(mounts: ContextMount[]): ContextMount | undefined {
  return mounts.find((m) => m.containerPath === "/config") ?? mounts.find((m) => m.hostPath.endsWith("/plex/config"));
}

async function readPlex(config: ContextMount): Promise<{ token: string; machineId: string; name?: string } | undefined> {
  const xml = await readConfigFile("plex", config, PREFS_RELATIVE);
  const token = xml.match(/PlexOnlineToken="([^"]+)"/)?.[1];
  const machineId = xml.match(/ProcessedMachineIdentifier="([^"]+)"/)?.[1];
  if (!token || !machineId) return undefined;
  return { token, machineId, name: xml.match(/FriendlyName="([^"]+)"/)?.[1] };
}

/** Tautulli's config folder, from its own mounts wherever it is installed. */
function tautulliConfig(mounts: ContextMount[]): ContextMount | undefined {
  return mounts.find((m) => m.containerPath === "/config") ?? mounts.find((m) => m.hostPath.endsWith("/tautulli/config"));
}

/** Tautulli's config.ini as key/value pairs. */
async function readTautulliIni(tautulli: ContextMount): Promise<Map<string, string>> {
  const settings = new Map<string, string>();
  for (const line of (await readConfigFile("tautulli", tautulli, "/config.ini")).split("\n")) {
    const match = line.match(/^(\w+)\s*=\s*(.*)$/);
    if (match) settings.set(match[1], match[2].trim().replace(/^"(.*)"$/, "$1"));
  }
  return settings;
}

/** Tautulli writes its config.ini at its first start, a little after its container is up. */
async function waitForTautulliIni(ctx: HookContext, tautulli: ContextMount): Promise<Map<string, string> | undefined> {
  for (let attempt = 0; attempt < 24; attempt++) {
    const ini = await readTautulliIni(tautulli);
    if (ini.get("api_key")) return ini;
    await ctx.sleep(5_000);
  }
  return undefined;
}

interface TautulliResponse {
  response?: { result?: string; message?: string; data?: unknown };
}

async function tautulliApi(base: string, apiKey: string, cmd: string): Promise<unknown> {
  const response = await fetch(`${base}/api/v2?apikey=${apiKey}&cmd=${cmd}`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) return undefined;
  const body = (await response.json().catch(() => undefined)) as TautulliResponse | undefined;
  return body?.response?.result === "success" ? body.response.data : undefined;
}

/** The Plex server Tautulli reaches with its saved address and token, and whether it is monitoring it. */
async function tautulliView(base: string, apiKey: string): Promise<{ machineId?: string; connected: boolean }> {
  const [identity, status] = await Promise.all([
    tautulliApi(base, apiKey, "get_server_identity").catch(() => undefined),
    tautulliApi(base, apiKey, "server_status").catch(() => undefined),
  ]);
  const server = (Array.isArray(identity) ? identity[0] : identity) as { machine_identifier?: string } | undefined;
  return {
    machineId: server?.machine_identifier || undefined,
    connected: (status as { connected?: boolean } | undefined)?.connected === true,
  };
}

export async function run(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "locate", message: "Finding Tautulli" },
    { id: "credentials", message: "Reading Plex and Tautulli settings" },
    { id: "configure", message: "Pointing Tautulli at this Plex server" },
    { id: "verify", message: "Checking Tautulli can see Plex" },
  ]);

  const base = await ctx.getInstalledAppUrl("tautulli");
  if (!base) ctx.fail("Tautulli isn't installed, or HexOS can't find its port");
  if (!ctx.host || !ctx.port) ctx.fail("HexOS couldn't find this Plex server's address");
  await ctx.emitCheckpoint("locate");

  const config = plexConfig(ctx.mounts);
  const plex = config && (await readPlex(config));
  // The owner skipped Plex's sign-in, so trying again can't help
  if (!plex) {
    const message = "Plex isn't signed in yet. Run Pre-configure Plex, then connect Tautulli from Plex's Connections tab.";
    if (ctx.skip) ctx.skip(message);
    ctx.fail(message);
  }
  const tautulli = tautulliConfig(await ctx.getInstalledAppMounts("tautulli"));
  if (!tautulli) ctx.fail("HexOS couldn't find Tautulli's settings folder");
  const ini = await waitForTautulliIni(ctx, tautulli);
  const apiKey = ini?.get("api_key");
  if (!ini || !apiKey) ctx.fail("HexOS couldn't read Tautulli's settings yet. Try again once it has started.");
  if (ini.get("http_password") || ini.get("http_username")) {
    ctx.fail("Tautulli has a sign-in set, so HexOS can't change its settings. Add this Plex server in Tautulli's own settings.");
  }
  await ctx.emitCheckpoint("credentials");

  // Plex answers Tautulli on the LAN without a token, so a server Tautulli can see is not proof it
  // has one. Without it Tautulli can't read Plex's users, and it never stops opening another
  // websocket every 30 seconds, each of which then logs every play again.
  const before = await tautulliView(base, apiKey);
  if (before.machineId === plex.machineId && before.connected && ini.get("pms_token") === plex.token) {
    await ctx.skipCheckpoint("configure", "Tautulli already watches this Plex server");
    await ctx.emitCheckpoint("verify");
    return;
  }

  // The settings page is guarded by a CSRF token, which a caller holding the API key skips by
  // sending it as X-Api-Key. The settings form leaves the token alone, so it goes first, the way
  // Tautulli's setup wizard sends it after a Plex sign-in.
  const headers = { "Content-Type": "application/x-www-form-urlencoded", "X-Api-Key": apiKey };
  const saved = await fetch(`${base}/save_pms_token`, {
    method: "POST",
    headers,
    body: new URLSearchParams({ token: plex.token }),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (saved.status >= 300 && saved.status < 400) {
    ctx.fail("Tautulli asked HexOS to sign in. Add this Plex server in Tautulli's own settings.");
  }
  if (!saved.ok) {
    ctx.fail("Tautulli didn't accept the Plex sign-in", [{ label: "Status", value: String(saved.status) }]);
  }

  // configUpdate is the handler behind Tautulli's settings page, and a checkbox setting missing
  // from its form is saved as off. Every setting that is on now is sent back on, or the API this
  // connection and the Tautulli widgets read through would be switched off with the rest.
  const form = new URLSearchParams();
  for (const [key, value] of ini) {
    if (value === "1") form.set(key, "1");
  }
  form.set("pms_ip", ctx.host);
  form.set("pms_port", String(ctx.port));
  form.set("pms_identifier", plex.machineId);
  form.set("pms_ssl", "0");
  form.set("pms_is_remote", "0");
  if (plex.name) form.set("pms_name", plex.name);
  // A fresh Tautulli takes the setup wizard's path, which finishes setup and starts monitoring.
  // One that was set up before only needs to hear that its server changed.
  form.set(ini.get("first_run_complete") === "1" ? "server_changed" : "first_run", "1");

  // The wizard's path restarts Tautulli's web server, which can drop the reply. Whether the
  // settings took is what the check below finds out.
  const response = await fetch(`${base}/configUpdate`, {
    method: "POST",
    headers,
    body: form,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  }).catch((error) => {
    ctx.log(`configUpdate reply lost: ${error}`);
    return undefined;
  });
  if (response && response.status >= 300 && response.status < 400) {
    ctx.fail("Tautulli asked HexOS to sign in. Add this Plex server in Tautulli's own settings.");
  }
  if (response && !response.ok) {
    ctx.fail("Tautulli didn't accept the Plex server", [
      { label: "Status", value: String(response.status) },
      { label: "Response", value: (await response.text()).slice(0, 300) },
    ]);
  }
  // A Tautulli that was already watching a server keeps the websockets it opened, and a reconnect
  // can race one of them back to life, so it starts over with the new settings instead.
  // It answers for a few seconds more before it goes down, so the check waits that out.
  if (before.connected) {
    await tautulliApi(base, apiKey, "restart").catch(() => undefined);
    await ctx.sleep(5000);
  }
  await ctx.emitCheckpoint("configure");

  let after = { connected: false } as { machineId?: string; connected: boolean };
  for (let attempt = 0; attempt < 30; attempt++) {
    after = await tautulliView(base, apiKey).catch(() => ({ connected: false }));
    if (after.machineId === plex.machineId && after.connected) break;
    await ctx.sleep(3000);
  }
  const tokenSaved = (await readTautulliIni(tautulli)).get("pms_token") === plex.token;
  if (after.machineId !== plex.machineId || !after.connected || !tokenSaved) {
    ctx.fail("Tautulli saved this Plex server but hasn't connected to it", [
      { label: "Plex server", value: plex.machineId },
      { label: "Tautulli sees", value: after.machineId ?? "no server" },
      { label: "Monitoring", value: after.connected ? "yes" : "no" },
      { label: "Plex sign-in saved", value: tokenSaved ? "yes" : "no" },
    ]);
  }
  await ctx.emitCheckpoint("verify");
}
