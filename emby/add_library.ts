// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { Database } from "bun:sqlite";

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

async function add(ctx: HookContext, libraries: Library[]) {
  await ctx.registerCheckpoints(libraries.map((library) => ({ id: library.path, message: `Adding your ${library.name} library to Emby` })));

  const token = await storedAdministratorToken(ctx);
  if (!token) ctx.fail("HexOS couldn't find an Emby administrator's key. Run Pre-configure Emby from this tab, then try again.");
  const before = await libraryPaths(ctx, token);
  if (!before) ctx.fail("HexOS couldn't read Emby's libraries, so it added none. Try again once Emby is running.");

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

export const sportarr = (ctx: HookContext) => add(ctx, SPORTS);
export const chaptarr = (ctx: HookContext) => add(ctx, BOOKS);
