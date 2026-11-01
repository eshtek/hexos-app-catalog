// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { Database } from "bun:sqlite";

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

async function add(ctx: HookContext, libraries: Library[]) {
  await ctx.registerCheckpoints(libraries.map((library) => ({ id: library.path, message: `Adding your ${library.name} library to Jellyfin` })));

  const token = storedAdministratorToken(ctx);
  if (!token) ctx.fail("HexOS couldn't find a Jellyfin administrator's key. Run Pre-configure Jellyfin from this tab, then try again.");
  const before = await libraryPaths(ctx, token);
  if (!before) ctx.fail("HexOS couldn't read Jellyfin's libraries, so it added none. Try again once Jellyfin is running.");

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

export const sportarr = (ctx: HookContext) => add(ctx, SPORTS);
export const chaptarr = (ctx: HookContext) => add(ctx, BOOKS);
