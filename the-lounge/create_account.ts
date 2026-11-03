import { chownSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { HookContext } from "../_lib/hook_context";

const APP_UID = 568;
const USERNAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** The Lounge 4.5.2 stores each account in users/<name>.json and watches that directory. */
export async function createAccount(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "ready", message: "Waiting for The Lounge to start" },
    { id: "account", message: "Creating your private account" },
  ]);

  const mount = ctx.mounts.find((item) => item.containerPath === "/var/opt/thelounge")
    ?? ctx.mounts.find((item) => item.hostPath.endsWith("/the-lounge/data"));
  if (!mount) ctx.fail("HexOS couldn't find The Lounge's data folder. Check its storage mount and retry installation.");

  const account = ctx.signIn;
  if (!account) ctx.fail("HexOS didn't provide The Lounge's sign-in. Retry installation and choose an account name and password.");
  const { username, password } = account;
  if (!USERNAME.test(username)) ctx.fail("The Lounge account name must use letters, numbers, dots, underscores or hyphens, and start with a letter or number.");
  if (new TextEncoder().encode(password).length > 72) ctx.fail("The Lounge passwords must be at most 72 UTF-8 bytes. Choose a shorter password and retry.");

  await ctx.waitForApp("/", { maxAttempts: 12, initialDelayMs: 2000 });
  await ctx.emitCheckpoint("ready");

  const users = join(mount.localPath, "users");
  const target = join(users, `${username}.json`);
  const conflicting = readdirSync(users).find((file) => file.endsWith(".json") && file.toLowerCase() === `${username.toLowerCase()}.json` && file !== `${username}.json`);
  if (conflicting) ctx.fail(`The Lounge already has an account named ${conflicting.slice(0, -5)}. Account names are case insensitive; choose a different name.`);
  if (existsSync(target)) {
    await ctx.skipCheckpoint("account", `${username} already exists; its password and chat history were kept`);
    return;
  }

  // The Lounge uses bcryptjs at cost 11. Bun's bcrypt output has the same $2b format.
  const hash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 11 });
  mkdirSync(users, { recursive: true, mode: 0o700 });
  chownSync(users, APP_UID, APP_UID);
  const temporary = join(users, `${username}.json.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify({ password: hash, log: true }, null, "\t"), { mode: 0o600, flag: "wx" });
    chownSync(temporary, APP_UID, APP_UID);
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  await ctx.emitCheckpoint("account", `${username} can now sign in to The Lounge`);
}
