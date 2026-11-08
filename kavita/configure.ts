// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import type { HookContext } from "../_lib/hook_context";

/**
 * Sets Kavita up as HexOS ships it. Fresh, Kavita opens on a screen that makes the owner create an
 * administrator, so HexOS makes that account from the sign-in the owner chose (`ctx.signIn`) and
 * adds the Books, Comics and Manga folders it mounts. A Kavita that already has an account keeps it:
 * Kavita's API needs that account's own password, which the owner gives in a collection's walk for a
 * Kavita they already had (`ctx.existingSignIns`), and a run with nothing to sign in with stops
 * quietly rather than ask. Read at Kavita 0.9.1, the version TrueNAS pins.
 */

/** Kavita's LibraryType (API/Entities/Enums/LibraryType.cs). */
const LIBRARIES = [
  { name: "Books", type: 2, folder: "/books" },
  { name: "Comics", type: 1, folder: "/comics" },
  { name: "Manga", type: 0, folder: "/manga" },
];

interface Account {
  token: string;
}

async function kavita<T>(ctx: HookContext, path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const response = await fetch(`${ctx.baseUrl}/api${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json", ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text.slice(0, 200) || `${response.status} ${response.statusText}`);
  try {
    return (text ? JSON.parse(text) : undefined) as T;
  } catch {
    return text as T;
  }
}

/** Whether the server has an account yet, once it answers. */
async function hasAccount(ctx: HookContext): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const answer = await kavita<boolean | string>(ctx, "/Admin/exists").catch(() => undefined);
    if (answer !== undefined) return answer === true || answer === "true";
    await ctx.sleep(5_000);
  }
  ctx.fail("Kavita didn't start. Try again once it's running.");
}

export async function configure(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "start", message: "Waiting for Kavita to start" },
    { id: "signIn", message: "Setting Kavita's sign-in" },
    ...LIBRARIES.map((library) => ({ id: library.folder, message: `Adding your ${library.name} library to Kavita` })),
  ]);

  const exists = await hasAccount(ctx);
  await ctx.emitCheckpoint("start");

  const given = ctx.existingSignIns?.[ctx.resourceId];
  const own = given?.username && given.password ? given : undefined;
  // One with no account makes the one chosen, else the one the owner gave; one with an account signs in as theirs
  const wanted = exists ? (own ?? ctx.signIn) : (ctx.signIn ?? own);
  let account: Account | undefined;
  if (!exists) {
    if (!wanted) {
      await ctx.skipCheckpoint("signIn", "Kavita asks you to create your account the first time you open it");
      for (const library of LIBRARIES) await ctx.skipCheckpoint(library.folder, "Add your libraries once you've created your account");
      return;
    }
    try {
      account = await kavita<Account>(ctx, "/Account/register", {
        body: { username: wanted.username, password: wanted.password, email: ctx.signIn?.email },
      });
    } catch (error) {
      ctx.fail("Kavita didn't take your sign-in", [{ label: "Reason", value: error instanceof Error ? error.message : String(error) }]);
    }
    await ctx.emitCheckpoint("signIn");
  } else {
    account = wanted
      ? await kavita<Account>(ctx, "/Account/login", { body: { username: wanted.username, password: wanted.password } }).catch(() => undefined)
      : undefined;
    if (!account && own) {
      ctx.fail("Kavita didn't accept the sign-in you gave for it, so HexOS left it as it is. Check it, then run this again from Kavita's Connections tab.");
    }
    if (!account) {
      await ctx.skipCheckpoint("signIn", "Kavita keeps the account it has");
      for (const library of LIBRARIES) await ctx.skipCheckpoint(library.folder, "Kavita keeps the libraries it has");
      return;
    }
    await ctx.skipCheckpoint("signIn", own ? "Kavita keeps the account it has" : "Kavita already uses the sign-in you chose");
  }

  const token = account.token;
  const present = await kavita<Array<{ folders?: string[] }>>(ctx, "/Library/libraries", { token });
  const folders = new Set(present.flatMap((library) => library.folders ?? []).map((folder) => folder.replace(/\/+$/, "")));
  for (const library of LIBRARIES) {
    if (folders.has(library.folder)) {
      await ctx.skipCheckpoint(library.folder, `Kavita already has your ${library.name} library`);
      continue;
    }
    try {
      // Kavita refuses a library with no metadata provider, and which it takes depends on the type
      const providers = await kavita<number[]>(ctx, `/library/metadata-providers?libraryType=${library.type}`, { token });
      await kavita(ctx, "/Library/create", {
        token,
        body: {
          id: 0,
          name: library.name,
          type: library.type,
          folders: [library.folder],
          folderWatching: true,
          includeInDashboard: true,
          includeInRecommended: true,
          includeInSearch: true,
          manageCollections: false,
          manageReadingLists: false,
          allowScrobbling: false,
          allowMetadataMatching: true,
          collapseSeriesRelationships: false,
          enableMetadata: true,
          removePrefixForSortName: false,
          inheritWebLinksFromFirstChapter: false,
          defaultLanguage: "",
          metadataProvider: providers[0] ?? 0,
          fileGroupTypes: [1, 2, 3, 4],
          excludePatterns: [],
        },
      });
    } catch (error) {
      ctx.fail(`Kavita didn't add your ${library.name} library`, [{ label: "Reason", value: error instanceof Error ? error.message : String(error) }]);
    }
    await ctx.emitCheckpoint(library.folder);
  }
}
