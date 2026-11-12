// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync } from "node:fs";

import type { ContextMount, HookContext } from "../_lib/hook_context";

/**
 * Adds the libraries a companion fills to Emby: Sports from Sportarr, Books and Audiobooks from
 * Chaptarr. Emby sees the whole Media location at /media, and each lands in its own folder there.
 * It's a link, not part of Emby's setup, so an Emby the owner already has gets the libraries from
 * its Connections tab. Run again, it adds only what's missing. Sportarr's link then adds
 * Emby to Sportarr, so what Sportarr imports shows in the library right away.
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

// --- Sportarr's own connection -------------------------------------------------

/** Where Sportarr keeps what it imports, in its own container. */
const SPORTS_FOLDER = "/media/sports";
/** The step that adds Emby to Sportarr. */
const TELLS = "sportarr";
/** The events Sportarr names a folder for, so Emby looks at that folder alone. */
const SPORTARR_EVENTS = ["onDownload", "onUpgrade", "onRename"];

/** One of Sportarr's connections, as its API keeps it: the settings are a JSON string. */
interface SportarrConnection {
  id?: number;
  name: string;
  implementation: string;
  enabled?: boolean;
  configJson?: string;
  [field: string]: unknown;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

const trimmed = (path: string) => path.replace(/\/+$/, "");

/** Whether anything answers at this address now. */
async function answering(url: string, timeoutMs: number): Promise<boolean> {
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) }).catch(() => undefined);
  await response?.body?.cancel().catch(() => undefined);
  return response !== undefined;
}

/** The Emby that answers at an address now, by its public id, which it gives without a sign-in. Undefined when none does. */
async function serverIdAt(url: string): Promise<string | undefined> {
  const response = await fetch(`${url}/emby/System/Info/Public`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) }).catch(
    () => undefined,
  );
  if (!response?.ok) {
    await response?.body?.cancel().catch(() => undefined);
    return undefined;
  }
  const id = ((await response.json().catch(() => undefined)) as { Id?: unknown } | undefined)?.Id;
  return typeof id === "string" && id ? id : undefined;
}

/**
 * Emby's API key named Sportarr, made when it has none. Emby answers no new key's value, so the list
 * is read again.
 */
async function sportarrKey(ctx: HookContext, token: string): Promise<string> {
  const find = async () => {
    const response = await fetch(`${ctx.baseUrl}/emby/Auth/Keys`, { headers: headers(token), signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
    if (!response?.ok) {
      await response?.body?.cancel();
      ctx.fail("Emby didn't list its API keys. Try again once it's running.", [{ label: "Status", value: String(response?.status ?? "no answer") }]);
    }
    const keys = ((await response.json()) as { Items?: Array<{ AppName?: string; AccessToken?: string; DateCreated?: string }> }).Items ?? [];
    return keys
      .filter((key) => key.AppName === "Sportarr" && key.AccessToken)
      .sort((a, b) => (b.DateCreated ?? "").localeCompare(a.DateCreated ?? ""))[0]?.AccessToken;
  };
  const existing = await find();
  if (existing) return existing;
  const created = await fetch(`${ctx.baseUrl}/emby/Auth/Keys?App=Sportarr`, { method: "POST", headers: headers(token), signal: AbortSignal.timeout(15_000) }).catch(
    () => undefined,
  );
  await created?.body?.cancel();
  if (!created?.ok) ctx.fail("Emby didn't make an API key for Sportarr", [{ label: "Status", value: String(created?.status ?? "no answer") }]);
  const made = await find();
  if (!made) ctx.fail("Emby didn't make an API key for Sportarr");
  return made;
}

/**
 * Where Emby sees Sportarr's Sports folder, as the path mapping Sportarr's connection takes: empty
 * when both see it at the same path. Undefined when Emby mounts nothing that holds it.
 */
function sportsMapping(sportarrMounts: ContextMount[], serverMounts: ContextMount[]): { pathMapFrom?: string; pathMapTo?: string } | undefined {
  const folder = sportarrMounts.find((m) => m.containerPath === SPORTS_FOLDER);
  if (!folder) return undefined;
  const hostPath = trimmed(folder.hostPath);
  const holder = serverMounts
    .filter((m) => m.containerPath && (hostPath === trimmed(m.hostPath) || hostPath.startsWith(`${trimmed(m.hostPath)}/`)))
    .sort((a, b) => b.hostPath.length - a.hostPath.length)[0];
  if (!holder?.containerPath) return undefined;
  const seen = `${trimmed(holder.containerPath)}${hostPath.slice(trimmed(holder.hostPath).length)}`;
  return seen === SPORTS_FOLDER ? {} : { pathMapFrom: SPORTS_FOLDER, pathMapTo: seen };
}

/**
 * Adds Emby to Sportarr as a connection (Settings, Notifications), so Sportarr tells Emby of each
 * file it imports or renames and it shows in the Sports library right away. Sportarr has its own
 * API (RootFolderAndNotificationEndpoints.cs and NotificationService.cs, read at 4.1.12.1122): one
 * flat record per connection with its settings as a JSON string, no schema, and a save that tests
 * nothing. So the link runs Sportarr's own test first and saves only a connection that passes.
 * Only imports, upgrades and renames are turned on. Sportarr names the file's folder for those. For
 * a delete it names none, and has the server scan every library it has.
 *
 * Run again, a connection that works is left as it is, with its name and its choices. So is one
 * that reaches this Emby by another name or address, which Emby's public id tells apart from a
 * connection to another server. One whose key Emby no longer takes (Emby was reinstalled) gets a
 * new one. One at an address nothing answers at moves here when Sportarr's test proves its saved
 * key is this Emby's (the box's address or Emby's port changed). A connection to another server is
 * never changed.
 */
async function tellSportarr(ctx: HookContext, token: string) {
  const sportarr = await ctx.getInstalledAppUrl("sportarr");
  if (!sportarr) ctx.fail("Sportarr isn't installed, or HexOS can't find its port");
  const mounts = await ctx.getInstalledAppMounts("sportarr");
  const config = mounts.find((m) => m.containerPath === "/config") ?? mounts.find((m) => m.hostPath.endsWith("/sportarr/config"));
  const apiKey = readText(`${config?.localPath}/config.xml`)?.match(/<ApiKey>([^<]+)<\/ApiKey>/)?.[1];
  if (!apiKey) ctx.fail("HexOS couldn't read Sportarr's API key yet. Try again once it has started.");
  // Sportarr answers nothing for a while after it starts
  let up = false;
  for (let attempt = 0; attempt < 30 && !up; attempt++) {
    up = await answering(`${sportarr}/ping`, 2_000);
    if (!up) await ctx.sleep(1_000);
  }
  if (!up) ctx.fail("Sportarr isn't answering yet. Try again once it has started.");
  const mapping = sportsMapping(mounts, ctx.mounts);
  if (!mapping) {
    await ctx.skipCheckpoint(TELLS, "Emby can't see Sportarr's Sports folder, so Sportarr has nothing to tell it about");
    return;
  }

  // No key or token ever reaches a step's words or a failure's details
  let secret: string | undefined;
  const reasonOf = (error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    return (secret ? text.replaceAll(secret, "********") : text).replaceAll(apiKey, "********").replaceAll(token, "********");
  };
  const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetch(`${sportarr}/api${path}`, {
      ...init,
      headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    if (!response.ok) {
      // Only Sportarr's own message: a refused record can echo back what it was sent
      let reason = `${response.status} ${response.statusText}`.trim();
      try {
        const body = JSON.parse(text) as { message?: string; error?: string };
        reason = body.message || body.error || reason;
      } catch {}
      throw new Error(reason);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  };
  const listed = async () =>
    (
      await api<SportarrConnection[]>("/notification").catch((error: unknown) =>
        ctx.fail("HexOS couldn't read Sportarr's connections", [{ label: "Reason", value: reasonOf(error) }]),
      )
    ).filter((entry) => entry.implementation === "Emby");
  const settings = (entry: SportarrConnection): Record<string, unknown> => {
    try {
      const parsed: unknown = JSON.parse(entry.configJson ?? "{}");
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  /** The entry with these settings changed, and everything else as it is. */
  const changed = (entry: SportarrConnection, changes: Record<string, unknown>): SportarrConnection => ({
    ...entry,
    configJson: JSON.stringify({ ...settings(entry), ...changes }),
  });
  const addressOf = (entry: SportarrConnection) => trimmed(String(settings(entry).host ?? ""));
  /** Sportarr's own test of an entry: undefined when it passes, else Sportarr's reason. */
  const test = (entry: SportarrConnection) =>
    api("/notification/test", { method: "POST", body: JSON.stringify(entry) }).then(
      () => undefined,
      (error: unknown) => reasonOf(error) || "Sportarr's test failed",
    );

  const here = trimmed(ctx.baseUrl);
  const ofKind = await listed();
  // A connection at the box's address and Emby's port, or one that reaches this Emby by another name
  // or address: the server that answers there has this Emby's own id
  let existing = ofKind.find((entry) => addressOf(entry) === here);
  /** The server each other connection reaches now, by its id: undefined where none answers. */
  const reaches = new Map<SportarrConnection, string | undefined>();
  if (!existing) {
    const thisServer = await serverIdAt(here);
    for (const entry of ofKind) {
      reaches.set(entry, await serverIdAt(addressOf(entry)));
      if (!thisServer || reaches.get(entry) !== thisServer) continue;
      existing = entry;
      break;
    }
  }
  let outcome: "works" | "moved" | "renewed" | "added" = "added";
  if (existing) {
    const refused = await test(existing);
    if (!refused) outcome = "works";
    // Only a key Emby turns away is replaced: a server that didn't answer says nothing of it
    else if (refused.startsWith("Authentication failed")) outcome = "renewed";
    else ctx.fail("Sportarr couldn't reach Emby", [{ label: "Reason", value: refused }]);
  } else {
    // The box's address or Emby's port changed: a saved key this Emby takes is one it made. A
    // connection another server answers is that server's, and its key is never tried here.
    for (const entry of ofKind) {
      if (reaches.get(entry) !== undefined || (await test(changed(entry, { host: here })))) continue;
      existing = entry;
      outcome = "moved";
      break;
    }
  }

  if (existing && outcome === "works") {
    const kept = settings(existing);
    const updates = existing.enabled !== false && kept.updateLibrary !== false && SPORTARR_EVENTS.some((event) => kept[event] === true);
    await ctx.skipCheckpoint(
      TELLS,
      updates
        ? "Sportarr already tells Emby what it adds"
        : "Sportarr already has Emby, with its library updates turned off. Turn them on in Sportarr's Settings, under Notifications.",
    );
    return;
  }

  let record: SportarrConnection;
  if (existing && outcome === "moved") {
    // Its saved key is this Emby's, so only where it reaches Emby changes
    record = changed(existing, { host: here });
  } else {
    secret = await sportarrKey(ctx, token);
    record = existing
      ? changed(existing, { apiKey: secret })
      : {
          name: "Emby",
          implementation: "Emby",
          enabled: true,
          tags: [],
          // Only what HexOS sets: the address, the key, library updates and the path mapping
          configJson: JSON.stringify({
            host: here,
            apiKey: secret,
            updateLibrary: true,
            usePartialScan: true,
            ...Object.fromEntries(SPORTARR_EVENTS.map((event) => [event, true])),
            ...mapping,
          }),
        };
  }
  // Sportarr saves a connection it never tested, so only one its own test passes is saved
  const refused = await test(record);
  if (refused) ctx.fail("Sportarr couldn't connect to Emby", [{ label: "Reason", value: refused }]);
  const id = existing?.id;
  await (
    id === undefined
      ? api("/notification", { method: "POST", body: JSON.stringify(record) })
      : api(`/notification/${id}`, { method: "PUT", body: JSON.stringify(record) })
  ).catch((error: unknown) => ctx.fail("Sportarr couldn't connect to Emby", [{ label: "Reason", value: reasonOf(error) }]));
  const saved = (await listed()).find((entry) => (id === undefined ? addressOf(entry) === here : entry.id === id));
  if (!saved || (outcome !== "renewed" && addressOf(saved) !== here)) ctx.fail("Sportarr saved Emby, but HexOS couldn't find it there. Run this again.");
  const words = { added: undefined, works: undefined, moved: "Sportarr reaches Emby at its new address", renewed: "Sportarr reaches Emby again" };
  await ctx.emitCheckpoint(TELLS, words[outcome]);
}

async function add(ctx: HookContext, libraries: Library[], companion: string) {
  await ctx.registerCheckpoints([
    ...libraries.map((library) => ({ id: library.path, message: `Adding your ${library.name} library to Emby` })),
    ...(companion === "Sportarr" ? [{ id: TELLS, message: "Adding Emby to Sportarr" }] : []),
  ]);

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
  if (companion === "Sportarr") await tellSportarr(ctx, token);
}

export const sportarr = (ctx: HookContext) => add(ctx, SPORTS, "Sportarr");
export const chaptarr = (ctx: HookContext) => add(ctx, BOOKS, "Chaptarr");
