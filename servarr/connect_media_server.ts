// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

import type { ContextMount, HookContext, HookInputDeclaration } from "../_lib/hook_context";

/**
 * Tells Jellyfin, Emby or Plex what Radarr and Sonarr change, and Plex what Lidarr changes, as it
 * happens: the hook each media server declares per manager (connect-radarr, connect-sonarr,
 * connect-lidarr). Without it a movie Radarr imports, renames or removes shows in the media
 * server only after the server's own scan finds it. The
 * manager gets its own connection to the server ("Emby / Jellyfin" or "Plex Media Server", under
 * Settings, Connect), added through the manager's schema, so a field it renames is still filled,
 * and saved with the manager's own test, so a server it can't reach is refused rather than kept.
 * Read at Radarr 6.4.4, Sonarr 5.0.0 and Lidarr 3.2.1.5196 (MediaBrowser, PlexServer,
 * ProviderControllerBase).
 *
 * Lidarr has a link to Plex alone. Its Plex connection is Radarr's, over Lidarr's own API version
 * (PlexServer.cs, PlexServerService.cs). Its Emby / Jellyfin connection passes its test at
 * 3.2.1.5196, which sends the key in the Authorization header Jellyfin 12 takes
 * (MediaBrowserProxy.cs, line 122). But it has no path mapping, and for a library update it sends
 * the word "music" as the path that changed, for every folder the server has
 * (MediaBrowserService.cs, line 38). Jellyfin 12.4 looks that path up, finds nothing at it and
 * refreshes nothing (FileRefresher.cs, GetAffectedBaseItem). So a connection there would be kept
 * and would never show an album sooner.
 *
 * The link is declared on the media server, since the server's own credential is in its settings:
 * Jellyfin and Emby make the manager an API key named after it, one per copy, and Plex has only its
 * owner's account token, the one the manager's own "Authenticate with Plex.tv" would hold. None of
 * them is ever put in a log, a step's words or a failure's details.
 *
 * Both apps mount a library at the same path (/movies, /shows, /music), so the server finds what the
 * manager names. A later copy keeps its library in a folder of the location, which the server sees
 * one folder down. Jellyfin's and Emby's connection maps the path, and is sent the mapped folder of
 * each title (MediaBrowserService.Update). Plex's can't: it uses the mapping only to pick which of
 * Plex's library folders is the manager's, then names the title's folder under that one
 * (PlexServerService.UpdateSections). Plex's library is the whole location, so the mapped folder
 * matches none, and the manager would name a folder Plex doesn't have. So a manager whose library
 * Plex sees at another path gets no connection, and Plex finds what it adds on Plex's own scan.
 *
 * Run again, the link changes nothing in a connection that works: its events, its name and its
 * other choices are the owner's, and so is one that reaches this server by another name or
 * address, which the server's own public id tells apart from a connection to another server. A
 * connection to this server whose saved key the server no longer takes (the server was
 * reinstalled) gets a new one. One at an address where this server no longer answers moves here
 * when the manager's test proves its saved key is this server's (the box's address or the server's
 * port changed), or with the owner's yes once nothing answers there. A connection to another
 * server is never changed or removed.
 */

/** The events that change what a library holds, turned on where the manager says its connection takes them. */
const MANAGERS = {
  radarr: {
    name: "Radarr",
    api: "v3",
    library: { path: "/movies", name: "Movies" },
    events: ["onDownload", "onUpgrade", "onRename", "onMovieDelete", "onMovieFileDelete", "onMovieFileDeleteForUpgrade"],
  },
  sonarr: {
    name: "Sonarr",
    api: "v3",
    library: { path: "/shows", name: "Shows" },
    events: [
      "onDownload",
      "onUpgrade",
      "onImportComplete",
      "onRename",
      "onSeriesAdd",
      "onSeriesDelete",
      "onEpisodeFileDelete",
      "onEpisodeFileDeleteForUpgrade",
    ],
  },
  lidarr: {
    name: "Lidarr",
    api: "v1",
    library: { path: "/music", name: "Music" },
    events: ["onReleaseImport", "onUpgrade", "onRename", "onArtistAdd", "onArtistDelete", "onAlbumDelete", "onTrackRetag"],
    /** The only connection of Lidarr's that updates a library: see the note at the top. */
    only: "PlexServer",
  },
} as const;

type ManagerId = keyof typeof MANAGERS;

interface Server {
  name: string;
  /** The manager's connection for it: MediaBrowser is the one it shows as "Emby / Jellyfin". */
  implementation: "MediaBrowser" | "PlexServer";
  /** The connection's field for the server's credential, which the manager shows as ********. */
  secret: "apiKey" | "authToken";
  /** What the step that gets the credential is called. */
  step: (managerName: string) => string;
  /** The credential the manager reaches the server with. `keyName` names a key made for it. */
  credential: (ctx: HookContext, keyName: string) => Promise<string>;
  /**
   * Whether a pass of the manager's test with a connection's saved credential, at this server's
   * address, proves the connection was this server's. A key is made by one server and no other
   * takes it. Plex's is its owner's account token, which every Plex server of theirs takes.
   */
  provesItself: boolean;
  /** Whether the connection reaches a library the server sees at another path than the manager does. */
  mapsPaths: boolean;
  /** Where the server answers its public id without a sign-in, and where the id is in the answer. */
  identity: { path: string; read: (body: unknown) => unknown };
}

interface Field {
  name: string;
  value?: unknown;
}

interface Connection {
  id?: number;
  name: string;
  implementation: string;
  fields: Field[];
  [key: string]: unknown;
}

/** The manager refused a request, with its own words and the fields it blames. */
class Refused extends Error {
  constructor(
    message: string,
    readonly fields: string[] = [],
  ) {
    super(message);
  }
}

function configMount(mounts: ContextMount[], appId: string): ContextMount | undefined {
  return mounts.find((m) => m.containerPath === "/config") ?? mounts.find((m) => new RegExp(`/${appId}(-\\d+)?/config$`).test(m.hostPath));
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

const trimmed = (path: string) => path.replace(/\/+$/, "");

/** Ends the step for a reason trying again won't change: skipped in a collection, failed from the card. */
function stop(ctx: HookContext, message: string, context?: Array<{ label: string; value: string }>): never {
  if (ctx.skip) ctx.skip(message, context);
  ctx.fail(message, context);
}

/** Whether anything answers at this address now. An app that's off, or an address nobody has any more, doesn't. */
async function answering(url: string, timeoutMs = 10_000): Promise<boolean> {
  // Any answer counts, so a certificate made for another name isn't taken for silence; nothing is sent
  const init = { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), tls: { rejectUnauthorized: false } };
  const response = await fetch(url, init as RequestInit).catch(() => undefined);
  await response?.body?.cancel().catch(() => undefined);
  return response !== undefined;
}

/** The owner's answers, or undefined when they skip, the wait runs out, or this HexOS can't ask. */
async function ask(ctx: HookContext, inputs: HookInputDeclaration[], prompt: { title: string; description: string }) {
  if (typeof ctx.askForInputs !== "function") return undefined;
  return ctx.askForInputs(inputs, prompt).catch((error: unknown) => {
    if (error instanceof Error && error.name === "HookInputsUnanswered") return undefined;
    throw error;
  });
}

/**
 * The server that answers at an address now, by its public id, or undefined when none does.
 * Jellyfin and Emby answer `/System/Info/Public` and Plex `/identity`, none with a sign-in.
 */
async function serverIdAt(server: Server, url: string): Promise<string | undefined> {
  // Only the server's public id is read, so a certificate made for another name doesn't count as no
  // answer; nothing is sent
  const init = { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000), tls: { rejectUnauthorized: false } };
  const response = await fetch(`${url}${server.identity.path}`, init as RequestInit).catch(() => undefined);
  if (!response?.ok) {
    await response?.body?.cancel().catch(() => undefined);
    return undefined;
  }
  const id = server.identity.read(await response.json().catch(() => undefined));
  return typeof id === "string" && id ? id : undefined;
}

const MEDIA_BROWSER_ID = { path: "/System/Info/Public", read: (body: unknown) => (body as { Id?: unknown } | undefined)?.Id };

// --- the server's credential -------------------------------------------------

/** An administrator's key from Jellyfin's own database, read-only: HexOS's widget makes one. */
function jellyfinAdministratorToken(ctx: HookContext): string | null {
  const config = ctx.mounts.find((m) => m.containerPath === "/config") ?? ctx.mounts.find((m) => m.hostPath.endsWith("/jellyfin/config"));
  if (!config) return null;
  let db: Database | undefined;
  try {
    db = new Database(`${config.localPath}/data/jellyfin.db`, { readonly: true });
    const key = db.query<{ AccessToken: string }, []>("SELECT AccessToken FROM ApiKeys ORDER BY DateCreated DESC LIMIT 1").get();
    if (key?.AccessToken) return key.AccessToken;
    const session = db
      .query<{ AccessToken: string }, []>(
        `SELECT d.AccessToken FROM Devices d
           JOIN Permissions p ON p.UserId = d.UserId AND p.Kind = 0 AND p.Value = 1
          WHERE d.IsActive = 1
          ORDER BY d.DateLastActivity DESC
          LIMIT 1`,
      )
      .get();
    return session?.AccessToken ?? null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** An administrator's token from Emby's own database, read-only: the first that acts as one. */
async function embyAdministratorToken(ctx: HookContext): Promise<string | null> {
  const config = ctx.mounts.find((m) => m.containerPath === "/config") ?? ctx.mounts.find((m) => m.hostPath.endsWith("/emby/config"));
  if (!config) return null;
  let tokens: string[] = [];
  let db: Database | undefined;
  try {
    db = new Database(`${config.localPath}/data/authentication.db`, { readonly: true });
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
    const response = await fetch(`${ctx.baseUrl}/emby/System/Configuration`, {
      headers: { "X-Emby-Token": token },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
    await response?.body?.cancel();
    if (response?.ok) return token;
  }
  return null;
}

/**
 * The server's API key named for this manager, made when it has none. Both servers list their keys
 * at Auth/Keys and make one with the app's name (Jellyfin's ApiKeyController, Emby's ApiKeyService),
 * and neither answers a new key's value, so the list is read again.
 */
async function namedKey(ctx: HookContext, server: string, keys: { url: string; headers: Record<string, string>; app: string }, name: string) {
  const find = async () => {
    const response = await fetch(keys.url, { headers: keys.headers, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
    if (!response?.ok) {
      await response?.body?.cancel();
      ctx.fail(`${server} didn't list its API keys. Try again once it's running.`, [{ label: "Status", value: String(response?.status ?? "no answer") }]);
    }
    const listed = ((await response.json()) as { Items?: Array<{ AppName?: string; AccessToken?: string; DateCreated?: string }> }).Items ?? [];
    return listed
      .filter((key) => key.AppName === name && key.AccessToken)
      .sort((a, b) => (b.DateCreated ?? "").localeCompare(a.DateCreated ?? ""))[0]?.AccessToken;
  };
  const existing = await find();
  if (existing) return existing;
  const created = await fetch(`${keys.url}?${new URLSearchParams({ [keys.app]: name })}`, {
    method: "POST",
    headers: keys.headers,
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
  await created?.body?.cancel();
  if (!created?.ok) ctx.fail(`${server} didn't make an API key for ${name}`, [{ label: "Status", value: String(created?.status ?? "no answer") }]);
  const made = await find();
  if (!made) ctx.fail(`${server} didn't make an API key for ${name}`);
  return made;
}

const SERVERS: Record<string, Server> = {
  jellyfin: {
    name: "Jellyfin",
    implementation: "MediaBrowser",
    secret: "apiKey",
    provesItself: true,
    mapsPaths: true,
    identity: MEDIA_BROWSER_ID,
    step: (managerName) => `Making ${managerName} a key in Jellyfin`,
    credential: async (ctx: HookContext, keyName: string) => {
      const token = jellyfinAdministratorToken(ctx);
      if (!token) ctx.fail("HexOS couldn't find a Jellyfin administrator's key. Open Jellyfin in HexOS and run Pre-configure Jellyfin, then try again.");
      // Jellyfin 12 has EnableLegacyAuthorization off, which turns away a token in X-Emby-Token (401)
      return namedKey(ctx, "Jellyfin", { url: `${ctx.baseUrl}/Auth/Keys`, headers: { Authorization: `MediaBrowser Token="${token}"` }, app: "app" }, keyName);
    },
  },
  emby: {
    name: "Emby",
    implementation: "MediaBrowser",
    secret: "apiKey",
    provesItself: true,
    mapsPaths: true,
    identity: MEDIA_BROWSER_ID,
    step: (managerName) => `Making ${managerName} a key in Emby`,
    credential: async (ctx: HookContext, keyName: string) => {
      const token = await embyAdministratorToken(ctx);
      if (!token) ctx.fail("HexOS couldn't find an Emby administrator's key. Open Emby in HexOS and run Pre-configure Emby, then try again.");
      return namedKey(ctx, "Emby", { url: `${ctx.baseUrl}/emby/Auth/Keys`, headers: { "X-Emby-Token": token }, app: "App" }, keyName);
    },
  },
  plex: {
    name: "Plex",
    implementation: "PlexServer",
    secret: "authToken",
    provesItself: false,
    mapsPaths: false,
    identity: {
      path: "/identity",
      read: (body) => (body as { MediaContainer?: { machineIdentifier?: unknown } } | undefined)?.MediaContainer?.machineIdentifier,
    },
    step: () => "Reading Plex's sign-in",
    credential: async (ctx: HookContext) => {
      const config = ctx.mounts.find((m) => m.containerPath === "/config") ?? ctx.mounts.find((m) => m.hostPath.endsWith("/plex/config"));
      const token = readText(`${config?.localPath}/Library/Application Support/Plex Media Server/Preferences.xml`)?.match(/PlexOnlineToken="([^"]+)"/)?.[1];
      // Nobody signed in to Plex, so trying again can't help
      if (!token) stop(ctx, "Plex has no sign-in yet. Open Plex in HexOS and run Pre-configure Plex, then run this again.");
      return token;
    },
  },
};

// --- the manager -------------------------------------------------------------

async function managerApi<T>(url: string, apiKey: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${url}/api/${path}`, {
    ...init,
    headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) {
    // Only the manager's own messages: a refused form can echo back what it was sent
    let reason = `${response.status} ${response.statusText}`.trim();
    let fields: string[] = [];
    try {
      const body = JSON.parse(text) as Array<{ propertyName?: string; errorMessage?: string }> | { message?: string };
      if (Array.isArray(body)) {
        reason = body.map((entry) => entry.errorMessage).filter(Boolean).join("; ") || reason;
        fields = body.flatMap((entry) => (entry.propertyName ? [entry.propertyName.toLowerCase()] : []));
      } else reason = body.message || reason;
    } catch {}
    throw new Refused(reason, fields);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * Where the server sees the manager's library, as the path mapping its connection takes: empty when
 * both see it at the same path. Undefined when the server mounts nothing that holds it.
 */
function pathMapping(managerMounts: ContextMount[], serverMounts: ContextMount[], library: string): { mapFrom: string; mapTo: string } | undefined {
  const folder = managerMounts.find((m) => m.containerPath === library);
  if (!folder) return undefined;
  const hostPath = trimmed(folder.hostPath);
  const holder = serverMounts
    .filter((m) => m.containerPath && (hostPath === trimmed(m.hostPath) || hostPath.startsWith(`${trimmed(m.hostPath)}/`)))
    .sort((a, b) => b.hostPath.length - a.hostPath.length)[0];
  if (!holder?.containerPath) return undefined;
  const seen = `${trimmed(holder.containerPath)}${hostPath.slice(trimmed(holder.hostPath).length)}`;
  return seen === library ? { mapFrom: "", mapTo: "" } : { mapFrom: library, mapTo: seen };
}

/**
 * Whether the owner wants a manager's connection moved to this server, once nothing answers at its
 * address. Nothing proves it was this one (it may be another computer that's switched off), so the
 * owner decides. False when they say no, skip the question, or this HexOS can't ask.
 */
async function ownerSwitches(ctx: HookContext, managerName: string, serverName: string, entryName: string, at: string): Promise<boolean> {
  const answers = await ask(
    ctx,
    [
      {
        type: "question",
        id: "switch",
        question: {
          question: `Switch ${managerName} to this ${serverName}`,
          description: `${managerName} keeps its other settings for it.`,
          type: "boolean",
          key: "switch",
          required: true,
        },
      },
    ],
    { title: `Switch ${managerName}'s ${serverName}`, description: `${managerName} tells ${entryName} at ${at} what it changes, and nothing answers there.` },
  );
  return answers?.switch === true;
}

async function connect(ctx: HookContext, managerId: ManagerId) {
  const server = SERVERS[ctx.catalogAppId ?? ctx.resourceId];
  if (!server) ctx.fail(`HexOS can't connect ${ctx.resourceId} this way`);
  const manager = { ...MANAGERS[managerId], name: ctx.linkedApp?.(managerId)?.displayName ?? MANAGERS[managerId].name };
  await ctx.registerCheckpoints([
    { id: "locate", message: `Finding ${manager.name}` },
    { id: "key", message: server.step(manager.name) },
    { id: "connect", message: `Adding ${server.name} to ${manager.name}` },
  ]);

  // A connection that would be kept and update nothing is worse than none
  if ("only" in manager && manager.only !== server.implementation) {
    stop(ctx, `${server.name} finds what ${manager.name} adds when it next scans its library. ${manager.name} can't tell ${server.name} sooner yet.`);
  }
  if (!ctx.baseUrl) ctx.fail(`HexOS can't find ${server.name}'s port`);
  const here = new URL(ctx.baseUrl);
  const address: Record<string, unknown> = { host: here.hostname, port: Number(here.port), useSsl: false, urlBase: "" };
  const managerUrl = await ctx.getInstalledAppUrl(managerId);
  if (!managerUrl) ctx.fail(`${manager.name} isn't installed, or HexOS can't find its port`);
  const managerMounts = await ctx.getInstalledAppMounts(managerId);
  const managerKey = readText(`${configMount(managerMounts, managerId)?.localPath}/config.xml`)?.match(/<ApiKey>([^<]+)<\/ApiKey>/)?.[1];
  if (!managerKey) ctx.fail(`HexOS couldn't read ${manager.name}'s API key yet. Try again once it has started.`);
  // A manager that has only just started answers nothing for a while
  let up = false;
  for (let attempt = 0; attempt < 30 && !up; attempt++) {
    up = await answering(`${managerUrl}/ping`, 2_000);
    if (!up) await ctx.sleep(1_000);
  }
  if (!up) ctx.fail(`${manager.name} isn't answering yet. Try again once it has started.`);
  const mapping = pathMapping(managerMounts, ctx.mounts, manager.library.path);
  // The server has to hold the folder the manager fills, or there is nothing to tell it about
  if (!mapping) stop(ctx, `${server.name} can't see ${manager.name}'s ${manager.library.name} folder, so ${manager.name} has nothing to tell it about.`);
  // A connection that would name folders the server doesn't have is worse than none
  if (mapping.mapTo && !server.mapsPaths) {
    stop(
      ctx,
      `${server.name} finds what ${manager.name} adds when it next scans its library. ${manager.name} can't tell ${server.name} sooner, because the two see ${manager.name}'s ${manager.library.name} folder at different paths.`,
    );
  }
  await ctx.emitCheckpoint("locate");

  const api = <T>(path: string, init?: RequestInit) => managerApi<T>(managerUrl, managerKey, `${manager.api}${path}`, init);
  // No credential ever reaches a step's words or a failure's details
  let secret: string | undefined;
  const reasonOf = (error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    return (secret ? text.replaceAll(secret, "********") : text).replaceAll(managerKey, "********");
  };
  const listed = () =>
    api<Connection[]>("/notification").catch((error: unknown) =>
      ctx.fail(`HexOS couldn't read ${manager.name}'s connections`, [{ label: "Reason", value: reasonOf(error) }]),
    );
  const value = (entry: Connection, field: string) => entry.fields.find((each) => each.name === field)?.value;
  const isHere = (entry: Connection) =>
    entry.implementation === server.implementation && value(entry, "host") === address.host && Number(value(entry, "port")) === address.port;
  /** The entry as it would be at this server's address, with everything else as it is. */
  const moved = (entry: Connection): Connection => ({
    ...entry,
    fields: entry.fields.map((field) => (field.name in address ? { ...field, value: address[field.name] } : field)),
  });
  /**
   * The manager's own test of an entry: undefined when it passes. It shows a credential it holds as
   * ******** and tests an entry sent by its id with the one it holds (SchemaBuilder).
   */
  const test = (entry: Connection) =>
    api("/notification/test", { method: "POST", body: JSON.stringify(entry) }).then(
      () => undefined,
      (error: unknown) => (error instanceof Refused ? error : new Refused(reasonOf(error))),
    );

  const entries = await listed();
  const ofKind = entries.filter((entry) => entry.implementation === server.implementation);
  const urlOf = (entry: Connection) => `${value(entry, "useSsl") === true ? "https" : "http"}://${value(entry, "host")}:${value(entry, "port")}${value(entry, "urlBase") ?? ""}`;
  // A connection at the box's address and the server's port, or one that reaches this server by
  // another name or address: the server that answers there has this server's own id
  let existing = entries.find(isHere);
  /** The server each other connection of this kind reaches now, by its id: undefined where none answers. */
  const reaches = new Map<Connection, string | undefined>();
  if (!existing) {
    const thisServer = await serverIdAt(server, ctx.baseUrl);
    for (const entry of ofKind) {
      reaches.set(entry, await serverIdAt(server, urlOf(entry)));
      if (!thisServer || reaches.get(entry) !== thisServer) continue;
      existing = entry;
      break;
    }
  }
  let outcome: "works" | "moved" | "switched" | "renewed" | "added" = "added";
  if (existing) {
    const refused = await test(existing);
    if (!refused) outcome = "works";
    // Only a credential the server turns away is replaced: a server that didn't answer says nothing of it
    else if (refused.fields.includes(server.secret.toLowerCase())) outcome = "renewed";
    else ctx.fail(`${manager.name} couldn't reach ${server.name}`, [{ label: "Reason", value: reasonOf(refused) }]);
  } else if (server.provesItself) {
    // The box's address or the server's port changed: a saved key this server takes is one it made.
    // A connection another server answers is that server's, and its key is never tried here.
    for (const entry of ofKind) {
      if (reaches.get(entry) !== undefined || (await test(moved(entry)))) continue;
      existing = entry;
      outcome = "moved";
      break;
    }
  }
  if (!existing) {
    // A manager refuses a second connection under a name it has, whatever its case (ProviderControllerBase)
    const named = entries.find((entry) => entry.name.toLowerCase() === server.name.toLowerCase());
    if (named) {
      const at = value(named, "host") === undefined ? undefined : `${value(named, "host")}:${value(named, "port")}`;
      const silent = named.implementation === server.implementation && at !== undefined && !(await answering(urlOf(named)));
      if (silent && at && (await ownerSwitches(ctx, manager.name, server.name, named.name, at))) {
        existing = named;
        outcome = "switched";
      } else {
        // It may be a server the owner chose, so it's theirs to change: trying again can't help
        stop(
          ctx,
          `${manager.name} already has a connection named ${named.name}${at ? `, at ${at}` : ""}. Rename that one in ${manager.name}'s Settings, under Connect, then run this again.`,
          at
            ? [
                { label: `${manager.name}'s ${named.name}`, value: at },
                { label: `This ${server.name}`, value: here.host },
              ]
            : undefined,
        );
      }
    }
  }

  if (existing && outcome === "works") {
    await ctx.skipCheckpoint("key", `${manager.name}'s connection to ${server.name} works as it is`);
    const updates = value(existing, "updateLibrary") === true && manager.events.some((event) => existing[event] === true);
    await ctx.skipCheckpoint(
      "connect",
      updates
        ? `${manager.name} already tells ${server.name} what it changes`
        : `${manager.name} already has ${server.name}, with its library updates turned off. Turn them on in ${manager.name}'s Settings, under Connect.`,
    );
    return;
  }

  let definition: Connection;
  if (existing && outcome === "moved") {
    // Its saved key is this server's, so only where it reaches the server changes
    await ctx.skipCheckpoint("key", `${manager.name} already has a key ${server.name} takes`);
    definition = moved(existing);
  } else {
    secret = await server.credential(ctx, manager.name);
    await ctx.emitCheckpoint("key");
    const credential = secret;
    if (existing) {
      // A connection that reaches this server keeps its address; one the owner switched moves here
      const base = outcome === "switched" ? moved(existing) : existing;
      definition = { ...base, fields: base.fields.map((field) => (field.name === server.secret ? { ...field, value: credential } : field)) };
    } else {
      const template = (await api<Connection[]>("/notification/schema").catch(() => [])).find((entry) => entry.implementation === server.implementation);
      const events = manager.events.filter((event) => template?.[`supportsOn${event.slice(2)}`] === true);
      if (!template || events.length === 0) stop(ctx, `${manager.name} doesn't offer a connection to ${server.name}`);
      // Only what HexOS sets: the address, the credential, library updates and the path mapping
      const wanted: Record<string, unknown> = { host: address.host, port: address.port, useSsl: false, [server.secret]: credential, updateLibrary: true, notify: false, ...mapping };
      definition = {
        ...template,
        name: server.name,
        ...Object.fromEntries(events.map((event) => [event, true])),
        fields: template.fields.map((field) => (field.name in wanted ? { ...field, value: wanted[field.name] } : field)),
      };
    }
  }

  // Saved with the manager's own test, which refuses a server it can't reach or a credential it turns away
  let saved: Connection | undefined;
  try {
    saved =
      existing?.id !== undefined
        ? await api<Connection>(`/notification/${existing.id}`, { method: "PUT", body: JSON.stringify(definition) })
        : await api<Connection>("/notification", { method: "POST", body: JSON.stringify(definition) });
  } catch (error) {
    // One added since the list was read: a run again finds it
    if (/should be unique/i.test(reasonOf(error))) {
      ctx.fail(`${manager.name} already has a connection named ${definition.name}. Run this again to check it.`);
    }
    ctx.fail(`${manager.name} couldn't connect to ${server.name}`, [{ label: "Reason", value: reasonOf(error) }]);
  }
  const id = existing?.id ?? saved?.id;
  const kept = (await listed()).find((entry) => entry.implementation === server.implementation && (id === undefined ? isHere(entry) : entry.id === id));
  if (!kept || (outcome !== "renewed" && !isHere(kept))) ctx.fail(`${manager.name} saved ${server.name}, but HexOS couldn't find it there. Run this again.`);
  const newAddress = `${manager.name} reaches ${server.name} at its new address`;
  const words = { added: undefined, works: undefined, moved: newAddress, switched: newAddress, renewed: `${manager.name} reaches ${server.name} again` };
  await ctx.emitCheckpoint("connect", words[outcome]);
}

export const radarr = (ctx: HookContext) => connect(ctx, "radarr");
export const sonarr = (ctx: HookContext) => connect(ctx, "sonarr");
export const lidarr = (ctx: HookContext) => connect(ctx, "lidarr");
