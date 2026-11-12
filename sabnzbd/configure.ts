// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { readFileSync, writeFileSync } from "node:fs";

import type { ContextMount, HookContext } from "../_lib/hook_context";

/**
 * Once SABnzbd is up (configure-sabnzbd), gives it the sign-in the owner chose for the install or
 * collection, with "External internet access" set to the full web interface with a sign-in only
 * from outside the home network (inet_exposure 5, interface.py at 5.1.3, the version TrueNAS pins):
 * the home network opens SABnzbd without it, as it did before it had one, and a VPN or HexOS's
 * mesh is asked for it. A SABnzbd HexOS just installed has both from seed-settings, so this checks
 * them. SABnzbd's API won't change External internet access (it's protected in config.py), so a
 * SABnzbd the owner already had gets it in its settings file and a restart, then the sign-in
 * through its API. The links reach SABnzbd with its API key, so the sign-in changes nothing for
 * them. With no sign-in chosen (a run from the app's card) SABnzbd stays as it is.
 */

/** Full web interface, with a sign-in only from outside the home network. */
const SIGN_IN_FROM_OUTSIDE = "5";

function configMount(mounts: ContextMount[]): ContextMount | undefined {
  return mounts.find((m) => m.containerPath === "/config") ?? mounts.find((m) => m.hostPath.endsWith("/sabnzbd/config"));
}

/** Sets keys of the settings file's [misc] section, in place where it has them, else at the section's end. */
function setMisc(ini: string, values: Record<string, string>): string {
  const lines = ini.split("\n");
  const start = lines.findIndex((line) => line.trim() === "[misc]");
  if (start === -1) return `${ini.replace(/\n*$/, "\n")}[misc]\n${Object.entries(values).map(([key, value]) => `${key} = ${value}`).join("\n")}\n`;
  let end = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
  if (end === -1) end = lines.length;
  const missing: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const at = lines.findIndex((line, index) => index > start && index < end && new RegExp(`^${key}\\s*=`).test(line));
    if (at === -1) missing.push(`${key} = ${value}`);
    else lines[at] = `${key} = ${value}`;
  }
  while (end > start + 1 && lines[end - 1].trim() === "") end--;
  lines.splice(end, 0, ...missing);
  return lines.join("\n");
}

async function sabnzbdApi<T>(url: string, apiKey: string, params: Record<string, string>): Promise<T> {
  const query = new URLSearchParams({ ...params, apikey: apiKey, output: "json" });
  const response = await fetch(`${url}/api?${query}`, { signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let body: T & { error?: string };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${response.status} ${text.slice(0, 200)}`);
  }
  if (!response.ok || body.error) throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  return body;
}

/** What the home network gets at SABnzbd's front page: the page itself, or a sign-in. */
async function frontPage(url: string): Promise<"open" | "signIn" | undefined> {
  const response = await fetch(`${url}/`, { redirect: "manual", signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
  await response?.body?.cancel();
  if (!response) return undefined;
  const location = response.headers.get("location") ?? "";
  if (response.status >= 300 && response.status < 400 && location.includes("/login")) return "signIn";
  return "open";
}

export async function configure(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "start", message: "Waiting for SABnzbd to start" },
    { id: "signIn", message: "Setting SABnzbd's sign-in" },
  ]);
  const config = configMount(ctx.mounts);
  if (!config) ctx.fail("HexOS couldn't find SABnzbd's settings folder");

  let apiKey: string | undefined;
  for (let attempt = 0; attempt < 60 && !apiKey; attempt++) {
    const key = (() => {
      try {
        return readFileSync(`${config.localPath}/sabnzbd.ini`, "utf-8").match(/^api_key\s*=\s*(\S+)/m)?.[1];
      } catch {
        return undefined;
      }
    })();
    if (key && (await sabnzbdApi(ctx.baseUrl, key, { mode: "version" }).then(() => true, () => false))) apiKey = key;
    else await ctx.sleep(5_000);
  }
  if (!apiKey) ctx.fail("SABnzbd didn't start. Try again once it's running.");
  await ctx.emitCheckpoint("start");

  const wanted = ctx.signIn;
  if (!wanted) {
    await ctx.skipCheckpoint("signIn", "SABnzbd keeps the sign-in it has");
    return;
  }
  const iniPath = `${config.localPath}/sabnzbd.ini`;
  const answers = () => sabnzbdApi(ctx.baseUrl, apiKey, { mode: "version" }).then(() => true, () => false);
  if (readFileSync(iniPath, "utf-8").match(/^inet_exposure\s*=\s*(\d+)/m)?.[1] !== SIGN_IN_FROM_OUTSIDE) {
    // Written while SABnzbd runs, read at the restart that follows: SABnzbd writes its file only after a change of its own
    writeFileSync(iniPath, setMisc(readFileSync(iniPath, "utf-8"), { inet_exposure: SIGN_IN_FROM_OUTSIDE }));
    await sabnzbdApi(ctx.baseUrl, apiKey, { mode: "restart" }).catch(() => undefined);
    let down = false;
    for (let attempt = 0; attempt < 15 && !down; attempt++) {
      await ctx.sleep(1_000);
      down = !(await answers());
    }
    let up = false;
    for (let attempt = 0; attempt < 60 && !up; attempt++) {
      await ctx.sleep(2_000);
      up = await answers();
    }
    if (!up) ctx.fail("SABnzbd didn't come back after HexOS restarted it. Try again once it's running.");
  }
  const set = (keyword: string, value: string) => sabnzbdApi(ctx.baseUrl, apiKey, { mode: "set_config", section: "misc", keyword, value });
  try {
    await set("username", wanted.username);
    await set("password", wanted.password);
  } catch (error) {
    ctx.fail("SABnzbd didn't take the sign-in you chose. Run this again.", [
      { label: "Reason", value: error instanceof Error ? error.message : String(error) },
    ]);
  }
  const { misc } = (await sabnzbdApi<{ config: { misc: Record<string, unknown> } }>(ctx.baseUrl, apiKey, {
    mode: "get_config",
    section: "misc",
  })).config;
  if (misc.username !== wanted.username || String(misc.inet_exposure) !== SIGN_IN_FROM_OUTSIDE) {
    ctx.fail("SABnzbd didn't keep the sign-in you chose. Run this again.");
  }
  if ((await frontPage(ctx.baseUrl)) !== "open") {
    ctx.fail('SABnzbd asks for a sign-in on your home network. Set External internet access to "Full Web interface - Only external access requires login" in its General settings.');
  }
  await ctx.emitCheckpoint("signIn", "SABnzbd uses the sign-in you chose, and opens on your home network without it");
}
