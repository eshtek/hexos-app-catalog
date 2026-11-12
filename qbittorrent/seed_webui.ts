// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { chownSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import type { ContextMount, HookContext } from "../_lib/hook_context";

/** The user the TrueNAS chart runs qBittorrent as. */
const APPS_UID = 568;
/** The sign-in qBittorrent gets when the owner chose none. */
const DEFAULT_SIGN_IN = { username: "admin", password: "admin" };

/**
 * What the qBittorrent image TrueNAS pins (home-operations 5.3.0) starts with, from its
 * /defaults/qBittorrent.conf. The image copies it in only when there's no settings file, so the
 * one HexOS writes starts from it. Its subnet whitelist and LocalHostAuth let the home network into
 * the WebUI without the password; QBT_WEBUI_PORT and QBT_TORRENTING_PORT still set the ports.
 */
const IMAGE_DEFAULTS: Record<string, string[]> = {
  AutoRun: ["enabled=false", "program="],
  LegalNotice: ["Accepted=true"],
  BitTorrent: [
    "Session\\AsyncIOThreadsCount=10",
    "Session\\DiskCacheSize=-1",
    "Session\\DiskIOReadMode=DisableOSCache",
    "Session\\DiskIOType=SimplePreadPwrite",
    "Session\\DiskIOWriteMode=EnableOSCache",
    "Session\\DiskQueueSize=4194304",
    "Session\\FilePoolSize=40",
    "Session\\HashingThreadsCount=2",
    "Session\\Port=50413",
    "Session\\ResumeDataStorageType=SQLite",
    "Session\\UseOSCache=true",
  ],
  Preferences: [
    "Connection\\PortRangeMin=6881",
    "Connection\\UPnP=false",
    "General\\Locale=en",
    "General\\UseRandomPort=false",
    "WebUI\\Address=*",
    "WebUI\\AuthSubnetWhitelist=10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16",
    "WebUI\\AuthSubnetWhitelistEnabled=true",
    "WebUI\\CSRFProtection=false",
    "WebUI\\HostHeaderValidation=false",
    "WebUI\\LocalHostAuth=false",
    "WebUI\\Port=8080",
    "WebUI\\ServerDomains=*",
    "WebUI\\UseUPnP=false",
  ],
};

/**
 * Where downloads go in qBittorrent's container: its own folder of the Downloads location, which
 * Radarr, Sonarr and Lidarr see at the same path. A download stays in `incomplete` until it's done.
 */
const FOLDERS = ["Session\\DefaultSavePath=/config/Downloads/complete/", "Session\\TempPath=/config/Downloads/incomplete/", "Session\\TempPathEnabled=true"];

/** The image's lines that let the home network in. */
const HOME_NETWORK = IMAGE_DEFAULTS.Preferences.filter((line) => /^WebUI\\(AuthSubnetWhitelist|LocalHostAuth)/.test(line));

function configMount(mounts: ContextMount[]): ContextMount | undefined {
  return mounts.find((m) => m.containerPath === "/config") ?? mounts.find((m) => m.hostPath.endsWith("/qbittorrent/config"));
}

function savedSignIn(path: string): { username: string; password: string } | undefined {
  try {
    const saved = JSON.parse(readFileSync(path, "utf-8")) as { username?: string; password?: string };
    return saved.username && saved.password ? { username: saved.username, password: saved.password } : undefined;
  } catch {
    return undefined;
  }
}

const escapeKey = (key: string) => key.replaceAll("\\", "\\\\");

/** Adds the lines whose keys the file doesn't set yet, under the section's header. */
function fillSection(conf: string, section: string, lines: string[]): string {
  const missing = lines.filter((line) => !new RegExp(`^${escapeKey(line.split("=")[0])}=`, "m").test(conf));
  if (missing.length === 0) return conf;
  const header = new RegExp(`^\\[${section}\\]\\r?\\n`, "m");
  if (!header.test(conf)) return `${conf.replace(/\n*$/, "\n")}\n[${section}]\n${missing.join("\n")}\n`;
  return conf.replace(header, (match) => `${match}${missing.join("\n")}\n`);
}

/** Sets each line's key to its value, in place where the file has it, else under the section. */
function setSection(conf: string, section: string, lines: string[]): string {
  let next = conf;
  for (const line of lines) {
    const key = line.split("=")[0];
    const existing = new RegExp(`^${escapeKey(key)}=.*$`, "m");
    next = existing.test(next) ? next.replace(existing, () => line) : fillSection(next, section, [line]);
  }
  return next;
}

/** The sign-in as qBittorrent stores it: PBKDF2-SHA512, 100,000 rounds, salt and hash in base64. */
function signInLines(signIn: { username: string; password: string }): string[] {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(signIn.password, salt, 100_000, 64, "sha512");
  return [`WebUI\\Password_PBKDF2="@ByteArray(${salt.toString("base64")}:${hash.toString("base64")})"`, `WebUI\\Username=${signIn.username}`];
}

/**
 * qBittorrent makes up a WebUI password at its first start and only prints it to its log, so the
 * apps that send it downloads could never sign in. Before that first start this writes the sign-in
 * the owner chose into qBittorrent's settings the way qBittorrent stores it, with the home network
 * let in without it, as the image has it, and a folder for downloads in progress. A reinstall over
 * settings from before gets the owner's sign-in in them; with none chosen it keeps what it had,
 * though one HexOS set up that says nothing about the home network lets it in.
 */
export async function seedWebUi(ctx: HookContext) {
  await ctx.registerCheckpoints([{ id: "signIn", message: "Setting qBittorrent's sign-in" }]);

  const config = configMount(ctx.mounts);
  if (!config) ctx.fail("HexOS couldn't find qBittorrent's settings folder");
  const confDir = `${config.localPath}/qBittorrent`;
  const confPath = `${confDir}/qBittorrent.conf`;
  const credentialsDir = `${config.localPath}/hexos`;
  const credentialsPath = `${credentialsDir}/webui.json`;

  // Before its install qBittorrent isn't running, so it can't write over the file as it exits
  if (existsSync(confPath)) {
    const conf = readFileSync(confPath, "utf-8");
    if (ctx.signIn) {
      let next = setSection(conf, "Preferences", signInLines(ctx.signIn));
      // A whitelist switch already in the file is the owner's choice, on or off
      if (!/^WebUI\\AuthSubnetWhitelistEnabled=/m.test(next)) next = fillSection(next, "Preferences", HOME_NETWORK);
      writeFileSync(confPath, next);
      rmSync(credentialsPath, { force: true });
      ctx.log("qBittorrent has the sign-in the owner chose");
      await ctx.emitCheckpoint("signIn", "qBittorrent uses the sign-in you chose");
      return;
    }
    if (!existsSync(credentialsPath)) {
      await ctx.skipCheckpoint("signIn", "qBittorrent keeps the sign-in it had");
      return;
    }
    const filled = /^WebUI\\AuthSubnetWhitelistEnabled=/m.test(conf) ? conf : fillSection(conf, "Preferences", HOME_NETWORK);
    if (filled === conf) {
      await ctx.skipCheckpoint("signIn", "qBittorrent already has its sign-in");
      return;
    }
    writeFileSync(confPath, filled);
    ctx.log("qBittorrent lets the home network in");
    await ctx.emitCheckpoint("signIn", "qBittorrent opens without a password on your home network");
    return;
  }

  let signIn = ctx.signIn;
  if (signIn) {
    rmSync(credentialsPath, { force: true });
  } else {
    // Kept beside the settings, so the links know qBittorrent has HexOS's default
    signIn = savedSignIn(credentialsPath);
    if (!signIn) {
      signIn = DEFAULT_SIGN_IN;
      mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
      writeFileSync(credentialsPath, JSON.stringify(signIn), { mode: 0o600 });
    }
  }
  const sections: Record<string, string[]> = {
    ...IMAGE_DEFAULTS,
    BitTorrent: [...IMAGE_DEFAULTS.BitTorrent, ...FOLDERS],
    Preferences: [...IMAGE_DEFAULTS.Preferences, ...signInLines(signIn)],
  };
  mkdirSync(confDir, { recursive: true });
  writeFileSync(
    confPath,
    Object.entries(sections)
      .map(([section, lines]) => [`[${section}]`, ...lines, ""].join("\n"))
      .join("\n"),
    { mode: 0o600 },
  );
  chownSync(confDir, APPS_UID, APPS_UID);
  chownSync(confPath, APPS_UID, APPS_UID);
  ctx.log("qBittorrent's WebUI sign-in is set");
  await ctx.emitCheckpoint("signIn");
}
