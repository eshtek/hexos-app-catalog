// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import type { ContextMount, HookContext } from "../_lib/hook_context";

/**
 * Plex's apps (a TV, a phone) find a server by the addresses the server gives plex.tv, and a server
 * knows nothing of its Anywhere address. So an owner away from home got the app's "unavailable"
 * while the same address opened in a browser. This keeps the app's Anywhere addresses among Plex's
 * custom server access URLs, and while it has one turns off Plex's own two ways in from outside:
 * Remote Access (a forwarded port) and Relay (plex.tv's 2 Mbps fallback), which the apps would
 * otherwise try first or settle for.
 *
 * The URLs live in the ADVERTISE_IP env, not in Plex's settings: Plex's image writes that env over
 * customConnections whenever a container is made (40-plex-first-run, pms-docker), and TrueNAS makes
 * one on every restart and update. HEXOS_ANYWHERE_URLS holds the ones HexOS put there, so a URL the
 * owner added stays. What the two switches were is kept in hexos/anywhere.json beside Plex's
 * settings, and put back when the last Anywhere address goes.
 */

const ADVERTISE = "ADVERTISE_IP";
const OURS = "HEXOS_ANYWHERE_URLS";
const HOSTNAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;
const PREFS_RELATIVE = "/Library/Application Support/Plex Media Server/Preferences.xml";
/** Plex's settings for Remote Access and Relay (Settings, Remote Access and Network). */
const SWITCHES = ["PublishServerOnPlexOnlineKey", "RelayEnabled"] as const;

interface Env {
  name: string;
  value: string;
}

const split = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);

/** Puts the names' URLs among the addresses Plex gives out, in place of the ones put there before. */
export function withAnywhereUrls(values: Record<string, unknown>, names: readonly string[]) {
  const app = (values.plex ??= {}) as { additional_envs?: Env[] };
  const envs = Array.isArray(app.additional_envs) ? app.additional_envs : [];
  const valueOf = (name: string) => envs.find((env) => env.name === name)?.value;
  const before = split(valueOf(OURS));
  const urls = names.filter((name) => HOSTNAME.test(name)).map((name) => `https://${name}:443`);
  const advertised = [...split(valueOf(ADVERTISE)).filter((url) => !before.includes(url) && !urls.includes(url)), ...urls];
  // The env keeps its place, so the app's values change only when an address does
  const next: Env[] = [];
  let placed = false;
  for (const env of envs) {
    if (env.name === OURS) continue;
    if (env.name !== ADVERTISE) next.push(env);
    else if (advertised.length > 0 && !placed) {
      next.push({ name: ADVERTISE, value: advertised.join(",") });
      placed = true;
    }
  }
  if (advertised.length > 0 && !placed) next.push({ name: ADVERTISE, value: advertised.join(",") });
  if (urls.length > 0) next.push({ name: OURS, value: urls.join(",") });
  app.additional_envs = next;
}

type Switches = Partial<Record<(typeof SWITCHES)[number], boolean>>;

/** What to set each switch to, and what to remember: off while an address is there, as they were once none is. */
export function switchPlan(hasAddress: boolean, now: Switches, kept: Switches | undefined): { set: Switches; keep: Switches | undefined } {
  if (hasAddress) {
    // Kept once: a second run reads the switches HexOS already turned off
    const keep = kept ?? now;
    return { set: Object.fromEntries(SWITCHES.filter((name) => now[name] !== false).map((name) => [name, false])), keep };
  }
  if (!kept) return { set: {}, keep: undefined };
  return { set: Object.fromEntries(SWITCHES.filter((name) => kept[name] !== undefined && kept[name] !== now[name]).map((name) => [name, kept[name]])), keep: undefined };
}

const configMount = (mounts: ContextMount[]) =>
  mounts.find((mount) => mount.containerPath === "/config") ?? mounts.find((mount) => /\/plex(-\d+)?\/config$/.test(mount.hostPath));

export async function anywhere(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "names", message: "Reading this app's Anywhere addresses" },
    { id: "update", message: "Giving Plex's apps the Anywhere address" },
    { id: "switches", message: "Setting Remote Access and Relay" },
  ]);
  const read = await ctx.readRemoteAddresses?.();
  if (!read || typeof ctx.updateAppValues !== "function") {
    ctx.fail("This server's HexOS needs an update before Plex's apps can use an Anywhere address. Try again after it updates.");
  }
  await ctx.emitCheckpoint("names");

  const changed = await ctx.updateAppValues((values) => withAnywhereUrls(values, read.names));
  if (changed) await ctx.emitCheckpoint("update");
  else await ctx.skipCheckpoint("update", "Plex already gives out these addresses");

  const config = configMount(ctx.mounts);
  const token = config && readText(config.localPath + PREFS_RELATIVE)?.match(/PlexOnlineToken="([^"]+)"/)?.[1];
  if (!config || !token) {
    // A server nobody signed in to Plex with has no remote access to set
    await ctx.skipCheckpoint("switches", "Plex isn't linked to a Plex account yet");
    return;
  }
  // The new values restart Plex
  await ctx.waitForApp("/identity", { maxAttempts: 40, initialDelayMs: 3000 }).catch(() => undefined);

  const note = `${config.localPath}/hexos/anywhere.json`;
  const kept = existsSync(note) ? (JSON.parse(readText(note) || "{}") as Switches) : undefined;
  let now: Switches;
  try {
    now = await readSwitches(ctx, token);
  } catch (error) {
    ctx.fail("Plex didn't answer with its settings. Start Plex, then run this again.", [{ label: "Reason", value: String(error) }]);
  }
  const plan = switchPlan(read.names.length > 0, now, kept);
  // The note goes down before a switch moves, so what the owner had is never lost to a run that stops halfway
  if (plan.keep) {
    mkdirSync(`${config.localPath}/hexos`, { recursive: true, mode: 0o700 });
    writeFileSync(note, JSON.stringify(plan.keep), { mode: 0o600 });
  }
  for (const [name, value] of Object.entries(plan.set) as Array<[keyof Switches, boolean]>) {
    if (!(await setSwitch(ctx, token, name, value))) {
      ctx.fail("Plex didn't take its Remote Access and Relay settings. Run this again.", [{ label: "Setting", value: name }]);
    }
  }
  if (!plan.keep) rmSync(note, { force: true });
  if (Object.keys(plan.set).length > 0) await ctx.emitCheckpoint("switches");
  else await ctx.skipCheckpoint("switches", "Remote Access and Relay are already set");
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Sets one switch and reads it back. A Plex signed in to an account can take well over 10 seconds to
 * answer a change of Remote Access, above all just after it restarted, and it applies the change
 * anyway: a run that went by the answer alone failed while the switch was already off (2026-11-24).
 * So the value Plex reads back counts, not whether it answered in time.
 */
export async function setSwitch(
  ctx: Pick<HookContext, "baseUrl" | "sleep">,
  token: string,
  name: keyof Switches,
  value: boolean,
  { attempts = 4, waitMs = 5000, timeoutMs = 30000 } = {},
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await fetch(`${ctx.baseUrl}/:/prefs?X-Plex-Token=${encodeURIComponent(token)}&${name}=${value ? 1 : 0}`, {
      method: "PUT",
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => undefined);
    if (response?.ok) return true;
    await ctx.sleep(waitMs);
    const now = await readSwitches(ctx, token).catch(() => undefined);
    if (now?.[name] === value) return true;
  }
  return false;
}

async function readSwitches(ctx: Pick<HookContext, "baseUrl">, token: string): Promise<Switches> {
  const response = await fetch(`${ctx.baseUrl}/:/prefs?X-Plex-Token=${encodeURIComponent(token)}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Plex answered ${response.status}`);
  const settings = ((await response.json()) as { MediaContainer?: { Setting?: Array<{ id?: string; value?: unknown }> } }).MediaContainer?.Setting ?? [];
  const found: Switches = {};
  for (const name of SWITCHES) {
    const value = settings.find((setting) => setting.id === name)?.value;
    if (typeof value === "boolean") found[name] = value;
  }
  return found;
}
