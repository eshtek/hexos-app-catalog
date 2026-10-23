// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { randomBytes } from "node:crypto";
import { reverse } from "node:dns/promises";
import { chownSync, existsSync, readFileSync, writeFileSync } from "node:fs";

import type { ContextMount, HookContext } from "../_lib/hook_context";

/** The user the TrueNAS chart runs SABnzbd as. */
const APPS_UID = 568;
/** The Downloads folder HexOS gives SABnzbd, at the path Radarr, Sonarr and Lidarr see it at too. */
const DOWNLOADS = "/downloads/sabnzbd";

function configMount(mounts: ContextMount[]): ContextMount | undefined {
  return mounts.find((m) => m.containerPath === "/config") ?? mounts.find((m) => m.hostPath.endsWith("/sabnzbd/config"));
}

/**
 * The names the home network has for the box. SABnzbd opens to its IP, localhost and .local names,
 * and refuses any other name it hasn't been given.
 */
async function boxNames(host: string | undefined): Promise<string[]> {
  if (!host) return [];
  const names = await Promise.race([
    reverse(host).catch(() => [] as string[]),
    new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 3_000)),
  ]);
  const found = names.map((name) => name.toLowerCase().replace(/\.$/, "")).filter((name) => /^[a-z0-9.-]+$/.test(name));
  return [...new Set(found.flatMap((name) => [name, name.split(".")[0]]))];
}

/** Full web interface, with a sign-in only from outside the home network (interface.py at 5.1.3). */
const SIGN_IN_FROM_OUTSIDE = "5";

/**
 * A value as SABnzbd's settings file (configobj) reads it back: quoted, since a password may hold
 * a `#` (a comment) or a `,` (a list), in the quotes it doesn't contain.
 */
function iniValue(value: string): string {
  for (const quote of ['"', "'", '"""', "'''"]) {
    if (!value.includes(quote)) return `${quote}${value}${quote}`;
  }
  return JSON.stringify(value);
}

/** Sets keys of the file's [misc] section, in place where it has them, else at the section's end. */
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

/** The sign-in the owner chose, with the home network let in without it. */
const signInSettings = (signIn: { username: string; password: string }) => ({
  username: signIn.username,
  password: iniValue(signIn.password),
  inet_exposure: SIGN_IN_FROM_OUTSIDE,
});

/**
 * Before SABnzbd's first start, writes the settings it starts from: an API key for the apps that
 * send it downloads, its folders in the Downloads location where those apps find what it finishes,
 * the box's names, and the sign-in the owner chose for the install or collection, asked for only
 * from outside the home network (External internet access set to the full web interface with a
 * sign-in from outside). SABnzbd fills in the rest, its categories among them (movies, tv, audio,
 * software), as config.py at 5.1.3 does, the version TrueNAS pins. With no sign-in chosen it opens
 * to the home network without one, as it does out of the box. Its Usenet server is the owner's own
 * account, so the setup wizard SABnzbd opens with asks for that and nothing else. A reinstall over
 * settings from before keeps them, with the owner's sign-in put in.
 */
export async function seedSettings(ctx: HookContext) {
  await ctx.registerCheckpoints([{ id: "settings", message: "Setting SABnzbd's folders and API key" }]);

  const config = configMount(ctx.mounts);
  if (!config) ctx.fail("HexOS couldn't find SABnzbd's settings folder");
  const iniPath = `${config.localPath}/sabnzbd.ini`;
  if (existsSync(iniPath)) {
    // Before its install SABnzbd isn't running, so it can't write over the file as it exits
    if (ctx.signIn) {
      writeFileSync(iniPath, setMisc(readFileSync(iniPath, "utf-8"), signInSettings(ctx.signIn)));
      await ctx.emitCheckpoint("settings", "SABnzbd keeps its settings from before, with the sign-in you chose");
      return;
    }
    const ours = readFileSync(iniPath, "utf-8").includes(`complete_dir = ${DOWNLOADS}/complete`);
    await ctx.skipCheckpoint("settings", ours ? "SABnzbd already has its settings" : "SABnzbd keeps the settings it had");
    return;
  }

  const names = await boxNames(ctx.host);
  writeFileSync(
    iniPath,
    [
      "__version__ = 19",
      "__encoding__ = utf-8",
      "[misc]",
      `api_key = ${randomBytes(16).toString("hex")}`,
      `nzb_key = ${randomBytes(16).toString("hex")}`,
      `download_dir = ${DOWNLOADS}/incomplete`,
      `complete_dir = ${DOWNLOADS}/complete`,
      ...(names.length > 0 ? [`host_whitelist = ${names.join(", ")},`] : []),
      ...(ctx.signIn ? Object.entries(signInSettings(ctx.signIn)).map(([key, value]) => `${key} = ${value}`) : []),
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  chownSync(iniPath, APPS_UID, APPS_UID);
  ctx.log("SABnzbd's starting settings are set");
  await ctx.emitCheckpoint("settings", "SABnzbd only needs your Usenet server");
}
