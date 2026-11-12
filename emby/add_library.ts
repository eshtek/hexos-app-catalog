// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { type Dirent, existsSync, mkdirSync, readdirSync, rmdirSync } from "node:fs";

import type { ContextMount, HookContext } from "../_lib/hook_context";

/**
 * Adds the libraries a companion fills to Emby: Sports from Sportarr, Books and Audiobooks from
 * Chaptarr. Emby sees the whole Media location at /media, and each lands in its own folder there.
 * It's a link, not part of Emby's setup, so an Emby the owner already has gets the libraries from
 * its Connections tab. Run again, it adds only what's missing.
 */

const DB_RELATIVE = "/data/authentication.db";

interface Library {
  name: string;
  collectionType: string;
  path: string;
}

const SPORTS: Library[] = [{ name: "Sports", collectionType: "tvshows", path: "/media/sports" }];
const BOOKS: Library[] = [
  { name: "Books", collectionType: "books", path: "/media/books" },
  { name: "Audiobooks", collectionType: "audiobooks", path: "/media/audiobooks" },
];

const emby = (ctx: HookContext, path: string) => `${ctx.baseUrl}/emby${path}`;
const headers = (token: string) => ({ "X-Emby-Token": token, "Content-Type": "application/json" });

/** An administrator's token from Emby's own database, read-only: the first that acts as one. */
async function storedAdministratorToken(ctx: HookContext): Promise<string | null> {
  const config: ContextMount | undefined =
    ctx.mounts.find((m) => m.containerPath === "/config") ?? ctx.mounts.find((m) => m.hostPath.endsWith("/emby/config"));
  if (!config) return null;
  let tokens: string[] = [];
  let db: Database | undefined;
  try {
    db = new Database(config.localPath + DB_RELATIVE, { readonly: true });
    tokens = db
      .query<{ AccessToken: string }, []>(
        `SELECT AccessToken FROM Tokens_2
          WHERE IsActive = 1
          ORDER BY (UserId IS NULL OR UserId = '') DESC, DateLastActivityInt DESC
          LIMIT 5`,
      )
      .all()
      .map((row) => row.AccessToken);
  } catch {
    return null;
  } finally {
    db?.close();
  }
  for (const token of tokens) {
    const response = await fetch(emby(ctx, "/System/Configuration"), { headers: headers(token), signal: AbortSignal.timeout(10_000) }).catch(
      () => undefined,
    );
    await response?.body?.cancel();
    if (response?.ok) return token;
  }
  return null;
}

async function libraryPaths(ctx: HookContext, token: string): Promise<Set<string> | null> {
  const response = await fetch(emby(ctx, "/Library/VirtualFolders"), { headers: headers(token), signal: AbortSignal.timeout(15_000) }).catch(
    () => undefined,
  );
  if (!response?.ok) {
    await response?.body?.cancel();
    return null;
  }
  const folders = (await response.json()) as Array<{ Locations?: string[] }>;
  return new Set(folders.flatMap((folder) => folder.Locations ?? []));
}

/**
 * Whether Emby finds this folder: ValidatePath (Emby's EnvironmentService) answers a success when it does
 * and 404 when it doesn't. Undefined when it refuses for another reason or doesn't answer.
 */
async function finds(ctx: HookContext, token: string, path: string): Promise<boolean | undefined> {
  const response = await fetch(emby(ctx, `/Environment/ValidatePath?${new URLSearchParams({ Path: path })}`), {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ Path: path, IsFile: false, ValidateWriteable: false }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
  await response?.body?.cancel().catch(() => undefined);
  if (response?.ok) return true;
  return response?.status === 404 ? false : undefined;
}

/**
 * Makes sure Emby sees inside each library's folder, restarting Emby once when it doesn't.
 * The companion's folder is a dataset of its own, and one made after Emby started is mounted after
 * Emby's bind mount of Media was made, which passes no later mount on (rprivate, the apps
 * library's default). Emby then sees an empty folder there, and never what the companion puts in
 * it, until a restart mounts Media again. The folder is there either way, so HexOS puts an empty
 * folder of its own in it for the check and takes it out after. Only a 404 for that folder, from a
 * Emby that finds the library folder itself, says it's missing. Only Emby restarts, never the
 * companion. A folder the box doesn't have, and a Emby that can't say what it sees, are left as
 * they are.
 */
async function seeFolders(ctx: HookContext, token: string, media: ContextMount, libraries: Library[], companion: string) {
  const marks: Array<{ library: Library; local: string; path: string }> = [];
  try {
    // A restart another link started may be all this one needs, so look once it's done
    await restarting.get(ctx.resourceId);
    for (const library of libraries) {
      const local = `${media.localPath}${library.path.slice("/media".length)}`;
      if (!existsSync(local)) continue;
      clearOldMarks(ctx, local);
      if ((await finds(ctx, token, library.path)) !== true) {
        ctx.log(`Emby couldn't say whether it sees ${library.path}, so HexOS didn't check it`);
        continue;
      }
      const mark = `/${MARK}${randomUUID()}`;
      try {
        mkdirSync(`${local}${mark}`);
      } catch (error) {
        ctx.log(`HexOS couldn't check Emby sees ${library.path}: ${error}`);
        continue;
      }
      marks.push({ library, local: `${local}${mark}`, path: `${library.path}${mark}` });
    }
    const missing: typeof marks = [];
    for (const mark of marks) {
      const found = await finds(ctx, token, mark.path);
      if (found === undefined) ctx.log(`Emby couldn't say whether it sees ${mark.library.path}, so HexOS didn't check it`);
      if (found === false) missing.push(mark);
    }
    if (missing.length === 0) return;

    const first = missing[0].library;
    const stuck = `Emby can't see your ${first.name} folder yet. Stop Emby and start it again, then run Connect to ${companion} again.`;
    if (typeof ctx.restartApp !== "function") ctx.fail(stuck);
    await ctx.updateCheckpointMessage(first.path, `Restarting Emby so it sees your ${first.name} folder`);
    const { refused, answered } = await restartServer(ctx);
    if (refused !== undefined) ctx.fail(stuck, [{ label: "Reason", value: refused instanceof Error ? refused.message : String(refused) }]);
    if (!answered) ctx.fail("Emby didn't answer after HexOS restarted it. Try again once it's running.");
    for (const mark of missing) {
      // Its API answers a little after it starts
      let found: boolean | undefined;
      for (let attempt = 0; attempt < 30 && found === undefined; attempt++) {
        found = await finds(ctx, token, mark.path);
        if (found === undefined) await ctx.sleep(1_000);
      }
      if (!found) {
        ctx.fail(
          `Emby still can't see your ${mark.library.name} folder after HexOS restarted it. Stop Emby and start it again, then run Connect to ${companion} again.`,
        );
      }
    }
  } finally {
    for (const mark of marks) {
      try {
        rmdirSync(mark.local);
      } catch (error) {
        ctx.log(`HexOS couldn't take its check folder out of ${mark.library.path}: ${error}`);
      }
    }
  }
}

/** HexOS's check folders, named for this server so a check Emby runs never touches another server's. */
const MARK = ".hexos-check-emby-";

/**
 * Takes out the empty check folders a run that was stopped partway left behind. rmdir takes out only
 * an empty folder, so one that holds anything stays as it is. A link runs once at a time on Emby
 * (APP_HOOK_ALREADY_RUNNING) and each link has its own folders, so none of these is a live check's.
 */
function clearOldMarks(ctx: HookContext, local: string) {
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(local, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(MARK)) continue;
    try {
      rmdirSync(`${local}/${entry.name}`);
    } catch (error) {
      ctx.log(`HexOS left ${local}/${entry.name} as it is: ${error}`);
    }
  }
}

/**
 * A restart of Emby in flight. Connect to Sportarr and Connect to Chaptarr
 * run in this one module and may run at once from Emby's card, so a link that finds a folder
 * missing while the other restarts Emby waits for that restart rather than queue a second one
 * (app.redeploy takes a lock per app), which would stop Emby under the other link.
 */
const restarting = new Map<string, Promise<{ refused?: unknown; answered: boolean }>>();

/** Restarts Emby once for every link that needs it now, and waits until it answers again. */
function restartServer(ctx: HookContext) {
  const key = ctx.resourceId;
  const running = restarting.get(key);
  if (running) return running;
  const restart = (async () => {
    const refused = await ctx.restartApp?.().then(
      () => undefined,
      (error: unknown) => error ?? new Error("The restart failed"),
    );
    if (refused !== undefined) return { refused, answered: false };
    for (let attempt = 0; attempt < 90; attempt++) {
      const response = await fetch(emby(ctx, "/System/Info/Public"), { signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
      await response?.body?.cancel().catch(() => undefined);
      if (response?.ok) return { answered: true };
      await ctx.sleep(2_000);
    }
    return { answered: false };
  })().finally(() => {
    restarting.delete(key);
  });
  restarting.set(key, restart);
  return restart;
}

async function add(ctx: HookContext, libraries: Library[], companion: string) {
  await ctx.registerCheckpoints(libraries.map((library) => ({ id: library.path, message: `Adding your ${library.name} library to Emby` })));

  const token = await storedAdministratorToken(ctx);
  if (!token) ctx.fail("HexOS couldn't find an Emby administrator's key. Run Pre-configure Emby from this tab, then try again.");
  const before = await libraryPaths(ctx, token);
  if (!before) ctx.fail("HexOS couldn't read Emby's libraries, so it added none. Try again once Emby is running.");
  const media = ctx.mounts.find((m) => m.containerPath === "/media");
  if (media) await seeFolders(ctx, token, media, libraries, companion);

  for (const library of libraries) {
    if (!ctx.mounts.some((m) => m.containerPath === "/media")) {
      await ctx.skipCheckpoint(library.path, `Emby can't see your Media folder, so it has no ${library.name} library to add`);
      continue;
    }
    if (before.has(library.path)) {
      await ctx.skipCheckpoint(library.path, `Emby already has your ${library.name} library`);
      continue;
    }
    const params = new URLSearchParams({ Name: library.name, CollectionType: library.collectionType, Paths: library.path, RefreshLibrary: "true" });
    const response = await fetch(emby(ctx, `/Library/VirtualFolders?${params}`), {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ LibraryOptions: { EnableRealtimeMonitor: true } }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) {
      ctx.fail(`Emby didn't add your ${library.name} library`, [{ label: "Reason", value: `${response.status} ${text.slice(0, 200)}` }]);
    }
    if (!(await libraryPaths(ctx, token))?.has(library.path)) {
      ctx.fail(`Emby answered, but your ${library.name} library isn't there. Run this again.`);
    }
    await ctx.emitCheckpoint(library.path);
  }
}

export const sportarr = (ctx: HookContext) => add(ctx, SPORTS, "Sportarr");
export const chaptarr = (ctx: HookContext) => add(ctx, BOOKS, "Chaptarr");
