import { randomUUID } from "node:crypto";
import { closeSync, constants, fchownSync, fstatSync, linkSync, lstatSync, openSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
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
  if (typeof username !== "string" || !USERNAME.test(username)) ctx.fail("The Lounge account name must use letters, numbers, dots, underscores or hyphens, and start with a letter or number.");
  if (typeof password !== "string" || password.length === 0) ctx.fail("Choose a non-empty password for The Lounge.");
  if (new TextEncoder().encode(password).length > 72) ctx.fail("The Lounge passwords must be at most 72 UTF-8 bytes. Choose a shorter password and retry.");

  await ctx.waitForApp("/", { maxAttempts: 12, initialDelayMs: 2000 });
  await ctx.emitCheckpoint("ready");

  const users = join(mount.localPath, "users");
  // The Lounge creates users/ before it starts listening. Hold that directory open
  // so the app cannot redirect a privileged file operation through a symlink.
  let directory: number;
  try {
    directory = openSync(users, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    ctx.fail("The Lounge's users directory is missing or is not a regular directory. Check the data mount and retry.");
  }
  try {
    const checkDirectory = () => {
      const opened = fstatSync(directory);
      let current: ReturnType<typeof lstatSync>;
      try {
        current = lstatSync(users);
      } catch {
        ctx.fail("The Lounge's users directory changed during account setup. Retry after checking the data folder.");
      }
      if (!current.isDirectory() || current.dev !== opened.dev || current.ino !== opened.ino) {
        ctx.fail("The Lounge's users directory changed during account setup. Retry after checking the data folder.");
      }
      if (opened.uid !== APP_UID || (opened.mode & 0o077) !== 0) {
        ctx.fail("The Lounge's users directory must be owned by apps (UID 568) and private (mode 0700).");
      }
    };
    checkDirectory();

    const dir = `/proc/self/fd/${directory}`;
    const filename = `${username}.json`;
    const target = join(dir, filename);
    const checkExisting = () => {
      const existing = lstatSync(target);
      if (!existing.isFile() || existing.uid !== APP_UID || (existing.mode & 0o777) !== 0o600) {
        ctx.fail(`The existing ${username} account is not a private, regular file owned by apps. Check its permissions before retrying.`);
      }
    };
    const names = readdirSync(dir);
    const conflicting = names.find((file) => file.endsWith(".json") && file.toLowerCase() === filename.toLowerCase() && file !== filename);
    if (conflicting) ctx.fail(`The Lounge already has an account named ${conflicting.slice(0, -5)}. Account names are case insensitive; choose a different name.`);
    if (names.includes(filename)) {
      checkExisting();
      await ctx.skipCheckpoint("account", `${username} already exists; its password and chat history were kept`);
      return;
    }

    // The Lounge uses bcryptjs at cost 11. Bun's bcrypt output has the same $2b format.
    const hash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 11 });
    checkDirectory();
    const temporary = join(dir, `.${username}.${randomUUID()}.tmp`);
    const file = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try {
        writeFileSync(file, JSON.stringify({ password: hash, log: true }, null, "\t"));
        fchownSync(file, APP_UID, APP_UID);
      } finally {
        closeSync(file);
      }
      // Linking publishes a complete file and refuses to replace an account
      // created while the hash was being calculated.
      try {
        linkSync(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        checkExisting();
        await ctx.skipCheckpoint("account", `${username} already exists; its password and chat history were kept`);
        return;
      }
    } finally {
      unlinkSync(temporary);
    }
    checkDirectory();
    checkExisting();
    await ctx.emitCheckpoint("account", `${username} can now sign in to The Lounge`);
  } finally {
    closeSync(directory);
  }
}
