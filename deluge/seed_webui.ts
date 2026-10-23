// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { createHash, randomBytes } from "node:crypto";
import { chownSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import type { ContextMount, HookContext } from "../_lib/hook_context";

/** The user the TrueNAS chart runs Deluge as. */
const APPS_UID = 568;
/** Where Deluge's daemon listens inside its container. */
const DAEMON_PORT = 58846;
/**
 * Deluge's web page asks for a password and nothing else, and has no way to let the home network in
 * without one. It gets the owner's chosen password, or this one when they chose none, and the apps
 * that send it downloads sign in the same way.
 */
const DEFAULT_PASSWORD = "admin";

function configMount(mounts: ContextMount[]): ContextMount | undefined {
  return mounts.find((m) => m.containerPath === "/config") ?? mounts.find((m) => m.hostPath.endsWith("/deluge/config"));
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

/** A Deluge settings file is two JSON objects: its version, then the settings. */
function readDelugeConfig<T>(path: string): T | undefined {
  const text = readText(path);
  try {
    return text ? (JSON.parse(text.slice(text.indexOf("}") + 1)) as T) : undefined;
  } catch {
    return undefined;
  }
}

function writeDelugeConfig(path: string, fileVersion: number, config: Record<string, unknown>) {
  writeFileSync(path, `${JSON.stringify({ file: fileVersion, format: 1 }, null, 4)}${JSON.stringify(config, null, 4)}`, {
    mode: 0o600,
  });
  chownSync(path, APPS_UID, APPS_UID);
}

/** The web page's password as Deluge keeps it (ui/web/auth.py at 2.2.0): a salted SHA-1. */
function passwordFields(password: string) {
  const salt = createHash("sha1").update(randomBytes(32)).digest("hex");
  return { pwd_salt: salt, pwd_sha1: createHash("sha1").update(salt).update(password).digest("hex") };
}

/**
 * Before Deluge's first start, sets the password its web page and the apps that send it downloads
 * use, and points the page at Deluge's own daemon, so it never asks which one to connect to. The
 * files are the ones Deluge 2.2.0 reads (ui/web/server.py, ui/hostlist.py, the daemon's auth file),
 * the version TrueNAS pins. A reinstall over settings from before gets the owner's password in
 * them; with none chosen it keeps what it had.
 */
export async function seedWebUi(ctx: HookContext) {
  await ctx.registerCheckpoints([{ id: "signIn", message: "Setting Deluge's sign-in" }]);

  const config = configMount(ctx.mounts);
  if (!config) ctx.fail("HexOS couldn't find Deluge's settings folder");
  const webPath = `${config.localPath}/web.conf`;
  const authPath = `${config.localPath}/auth`;
  const hostlistPath = `${config.localPath}/hostlist.conf`;
  const credentialsDir = `${config.localPath}/hexos`;
  const credentialsPath = `${credentialsDir}/webui.json`;

  // Before its install Deluge isn't running, so it can't write over the file as it exits
  if (existsSync(webPath)) {
    const web = readDelugeConfig<Record<string, unknown>>(webPath);
    if (ctx.signIn && web) {
      const version = readText(webPath)?.match(/"file":\s*(\d+)/)?.[1];
      writeDelugeConfig(webPath, Number(version ?? 2), { ...web, ...passwordFields(ctx.signIn.password), first_login: false });
      rmSync(credentialsPath, { force: true });
      ctx.log("Deluge's web page has the password the owner chose");
      await ctx.emitCheckpoint("signIn", "Deluge uses the password you chose");
      return;
    }
    await ctx.skipCheckpoint(
      "signIn",
      existsSync(credentialsPath) ? "Deluge already has its sign-in" : "Deluge keeps the sign-in it had",
    );
    return;
  }

  // The web page reaches the daemon as localclient, with the password in the daemon's auth file
  let localPassword = readText(authPath)?.match(/^localclient:([^:\n]+)/m)?.[1];
  if (!existsSync(authPath)) {
    localPassword = randomBytes(20).toString("hex");
    writeFileSync(authPath, `localclient:${localPassword}:10\n`, { mode: 0o600 });
    chownSync(authPath, APPS_UID, APPS_UID);
  }
  let hostId = readDelugeConfig<{ hosts?: unknown[][] }>(hostlistPath)?.hosts?.find(
    (host) => host[1] === "127.0.0.1" && host[2] === DAEMON_PORT,
  )?.[0];
  if (!existsSync(hostlistPath) && localPassword) {
    hostId = randomBytes(16).toString("hex");
    writeDelugeConfig(hostlistPath, 3, { hosts: [[hostId, "127.0.0.1", DAEMON_PORT, "localclient", localPassword]] });
  }

  let password = ctx.signIn?.password;
  if (password) {
    rmSync(credentialsPath, { force: true });
  } else {
    // Kept beside the settings, so the links know Deluge has HexOS's default
    password = DEFAULT_PASSWORD;
    mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
    writeFileSync(credentialsPath, JSON.stringify({ password }), { mode: 0o600 });
  }
  writeDelugeConfig(webPath, 2, {
    ...passwordFields(password),
    // Its first sign-in asks to change the password, which would sign the other apps out
    first_login: false,
    ...(typeof hostId === "string" ? { default_daemon: hostId } : {}),
  });
  ctx.log("Deluge's web sign-in is set");
  await ctx.emitCheckpoint("signIn", ctx.signIn ? "Deluge uses the password you chose" : "Deluge's web page password is admin");
}
