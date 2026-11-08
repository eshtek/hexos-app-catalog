// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmdirSync } from "node:fs";

import type { ContextMount, HookContext } from "../_lib/hook_context";

/**
 * Adds the libraries a companion fills to Jellyfin: Sports from Sportarr, Books and Audiobooks from
 * Chaptarr. Jellyfin sees the whole Media location at /media, and each lands in its own folder
 * there. It's a link, not part of Jellyfin's setup, so a Jellyfin the owner already has gets the
 * libraries from its Connections tab. Run again, it adds only what's missing.
 */

const DB_RELATIVE = "/data/jellyfin.db";
/** The PermissionKind Jellyfin stores for an administrator. */
const IS_ADMINISTRATOR = 0;

interface Library {
  name: string;
  collectionType: string;
  path: string;
}

const SPORTS: Library[] = [{ name: "Sports", collectionType: "tvshows", path: "/media/sports" }];
const BOOKS: Library[] = [
  { name: "Books", collectionType: "books", path: "/media/books" },
  { name: "Audiobooks", collectionType: "books", path: "/media/audiobooks" },
];

/** An administrator's key from Jellyfin's own database, read-only: HexOS's widget makes one. */
function storedAdministratorToken(ctx: HookContext): string | null {
  const config: ContextMount | undefined =
    ctx.mounts.find((m) => m.containerPath === "/config") ?? ctx.mounts.find((m) => m.hostPath.endsWith("/jellyfin/config"));
  if (!config) return null;
  let db: Database | undefined;
  try {
    db = new Database(config.localPath + DB_RELATIVE, { readonly: true });
    const key = db.query<{ AccessToken: string }, []>("SELECT AccessToken FROM ApiKeys ORDER BY DateCreated DESC LIMIT 1").get();
    if (key?.AccessToken) return key.AccessToken;
    const session = db
      .query<{ AccessToken: string }, [number]>(
        `SELECT d.AccessToken FROM Devices d
           JOIN Permissions p ON p.UserId = d.UserId AND p.Kind = ? AND p.Value = 1
          WHERE d.IsActive = 1
          ORDER BY d.DateLastActivity DESC
          LIMIT 1`,
      )
      .get(IS_ADMINISTRATOR);
    return session?.AccessToken ?? null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

const headers = (token: string) => ({ Authorization: `MediaBrowser Token="${token}"`, "Content-Type": "application/json" });

/** The server's library folders, or null when they can't be read. */
async function libraryPaths(ctx: HookContext, token: string): Promise<Set<string> | null> {
  const response = await fetch(`${ctx.baseUrl}/Library/VirtualFolders`, { headers: headers(token), signal: AbortSignal.timeout(15_000) }).catch(
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
 * Whether Jellyfin finds this folder: ValidatePath (EnvironmentController at 10.11.0) answers 204 when it does
 * and 404 when it doesn't. Undefined when it refuses for another reason or doesn't answer.
 */
async function finds(ctx: HookContext, token: string, path: string): Promise<boolean | undefined> {
  const response = await fetch(`${ctx.baseUrl}/Environment/ValidatePath`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ Path: path, IsFile: false, ValidateWritable: false }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
  await response?.body?.cancel().catch(() => undefined);
  if (response?.ok) return true;
  return response?.status === 404 ? false : undefined;
}

/**
 * Makes sure Jellyfin sees inside each library's folder, restarting Jellyfin once when it doesn't.
 * The companion's folder is a dataset of its own, and one made after Jellyfin started is mounted after
 * Jellyfin's bind mount of Media was made, which passes no later mount on (rprivate, the apps
 * library's default). Jellyfin then sees an empty folder there, and never what the companion puts in
 * it, until a restart mounts Media again. The folder is there either way, so HexOS puts an empty
 * folder of its own in it for the check and takes it out after: rmdir removes only an empty folder.
 * Only Jellyfin restarts, never the companion. A folder the box doesn't have, and a Jellyfin that can't
 * say what it sees, are left as they are.
 */
async function seeFolders(ctx: HookContext, token: string, media: ContextMount, libraries: Library[], companion: string) {
  const marks: Array<{ library: Library; local: string; path: string }> = [];
  try {
    for (const library of libraries) {
      const local = `${media.localPath}${library.path.slice("/media".length)}`;
      if (!existsSync(local)) continue;
      const mark = `/.hexos-check-${randomUUID()}`;
      try {
        mkdirSync(`${local}${mark}`);
      } catch (error) {
        ctx.log(`HexOS couldn't check Jellyfin sees ${library.path}: ${error}`);
        continue;
      }
      marks.push({ library, local: `${local}${mark}`, path: `${library.path}${mark}` });
    }
    const missing: typeof marks = [];
    for (const mark of marks) {
      const found = await finds(ctx, token, mark.path);
      if (found === undefined) ctx.log(`Jellyfin couldn't say whether it sees ${mark.library.path}, so HexOS didn't check it`);
      if (found === false) missing.push(mark);
    }
    if (missing.length === 0) return;

    const first = missing[0].library;
    const stuck = `Jellyfin can't see your ${first.name} folder yet. Stop Jellyfin and start it again, then run Connect to ${companion} again.`;
    if (typeof ctx.restartApp !== "function") ctx.fail(stuck);
    await ctx.updateCheckpointMessage(first.path, `Restarting Jellyfin so it sees your ${first.name} folder`);
    const refused = await ctx.restartApp().then(
      () => undefined,
      (error: unknown) => error,
    );
    if (refused !== undefined) ctx.fail(stuck, [{ label: "Reason", value: refused instanceof Error ? refused.message : String(refused) }]);
    let up = false;
    for (let attempt = 0; attempt < 90 && !up; attempt++) {
      const response = await fetch(`${ctx.baseUrl}/System/Info/Public`, { signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
      await response?.body?.cancel().catch(() => undefined);
      up = response?.ok === true;
      if (!up) await ctx.sleep(2_000);
    }
    if (!up) ctx.fail("Jellyfin didn't answer after HexOS restarted it. Try again once it's running.");
    for (const mark of missing) {
      // Its API answers a little after it starts
      let found: boolean | undefined;
      for (let attempt = 0; attempt < 30 && found === undefined; attempt++) {
        found = await finds(ctx, token, mark.path);
        if (found === undefined) await ctx.sleep(1_000);
      }
      if (!found) {
        ctx.fail(
          `Jellyfin still can't see your ${mark.library.name} folder after HexOS restarted it. Stop Jellyfin and start it again, then run Connect to ${companion} again.`,
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

async function add(ctx: HookContext, libraries: Library[], companion: string) {
  await ctx.registerCheckpoints(libraries.map((library) => ({ id: library.path, message: `Adding your ${library.name} library to Jellyfin` })));

  const token = storedAdministratorToken(ctx);
  if (!token) ctx.fail("HexOS couldn't find a Jellyfin administrator's key. Run Pre-configure Jellyfin from this tab, then try again.");
  const before = await libraryPaths(ctx, token);
  if (!before) ctx.fail("HexOS couldn't read Jellyfin's libraries, so it added none. Try again once Jellyfin is running.");
  const media = ctx.mounts.find((m) => m.containerPath === "/media");
  if (media) await seeFolders(ctx, token, media, libraries, companion);

  for (const library of libraries) {
    if (!ctx.mounts.some((m) => m.containerPath === "/media")) {
      await ctx.skipCheckpoint(library.path, `Jellyfin can't see your Media folder, so it has no ${library.name} library to add`);
      continue;
    }
    if (before.has(library.path)) {
      await ctx.skipCheckpoint(library.path, `Jellyfin already has your ${library.name} library`);
      continue;
    }
    const params = new URLSearchParams({
      name: library.name,
      collectionType: library.collectionType,
      paths: library.path,
      refreshLibrary: "true",
    });
    const response = await fetch(`${ctx.baseUrl}/Library/VirtualFolders?${params}`, {
      method: "POST",
      headers: headers(token),
      // As Jellyfin's setup above makes the others: what lands in the folder shows up at once
      body: JSON.stringify({ LibraryOptions: { EnableRealtimeMonitor: true } }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) {
      ctx.fail(`Jellyfin didn't add your ${library.name} library`, [{ label: "Reason", value: `${response.status} ${text.slice(0, 200)}` }]);
    }
    if (!(await libraryPaths(ctx, token))?.has(library.path)) {
      ctx.fail(`Jellyfin answered, but your ${library.name} library isn't there. Run this again.`);
    }
    await ctx.emitCheckpoint(library.path);
  }
}

export const sportarr = (ctx: HookContext) => add(ctx, SPORTS, "Sportarr");
export const chaptarr = (ctx: HookContext) => add(ctx, BOOKS, "Chaptarr");
