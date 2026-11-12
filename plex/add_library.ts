// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { readFileSync } from "node:fs";

import type { ContextMount, HookContext } from "../_lib/hook_context";

/**
 * Adds the Sports library Sportarr fills to Plex. Plex sees the whole Media location at /media, and
 * Sportarr's folder is there. It's a link, not part of Plex's setup, so a Plex the owner already has
 * gets the library from its Connections tab. Plex has no library for books, so Chaptarr has no link
 * here. Sportarr's names aren't TV listings, so the library uses Plex's Personal Media Shows agent.
 * The same link then adds Plex to Sportarr, so what Sportarr imports shows in the library right away.
 */

const PREFS_RELATIVE = "/Library/Application Support/Plex Media Server/Preferences.xml";
const SPORTS = { name: "Sports", location: "/media/sports" };

function plexToken(mounts: ContextMount[]): string | undefined {
  const config = mounts.find((m) => m.containerPath === "/config") ?? mounts.find((m) => m.hostPath.endsWith("/plex/config"));
  if (!config) return undefined;
  try {
    return readFileSync(config.localPath + PREFS_RELATIVE, "utf-8").match(/PlexOnlineToken="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

async function libraryPaths(ctx: HookContext, token: string): Promise<Set<string> | null> {
  const response = await fetch(`${ctx.baseUrl}/library/sections?X-Plex-Token=${encodeURIComponent(token)}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
  if (!response?.ok) {
    await response?.body?.cancel();
    return null;
  }
  const data = (await response.json()) as { MediaContainer?: { Directory?: Array<{ Location?: Array<{ path?: string }> }> } };
  return new Set((data.MediaContainer?.Directory ?? []).flatMap((directory) => (directory.Location ?? []).flatMap((entry) => entry.path ?? [])));
}

// --- Sportarr's own connection -------------------------------------------------

/** Where Sportarr keeps what it imports, in its own container. */
const SPORTS_FOLDER = "/media/sports";
/** The step that adds Plex to Sportarr. */
const TELLS = "sportarr";
/** The events Sportarr names a folder for, so Plex looks at that folder alone. */
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

/** The Plex that answers at an address now, by its public id, which it gives without a sign-in. Undefined when none does. */
async function serverIdAt(url: string): Promise<string | undefined> {
  const response = await fetch(`${url}/identity`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) }).catch(
    () => undefined,
  );
  if (!response?.ok) {
    await response?.body?.cancel().catch(() => undefined);
    return undefined;
  }
  const id = ((await response.json().catch(() => undefined)) as { MediaContainer?: { machineIdentifier?: unknown } } | undefined)?.MediaContainer?.machineIdentifier;
  return typeof id === "string" && id ? id : undefined;
}

/**
 * Where Plex sees Sportarr's Sports folder, as the path mapping Sportarr's connection takes: empty
 * when both see it at the same path. Undefined when Plex mounts nothing that holds it.
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
 * Adds Plex to Sportarr as a connection (Settings, Notifications), so Sportarr tells Plex of each
 * file it imports or renames and it shows in the Sports library right away. Sportarr has its own
 * API (RootFolderAndNotificationEndpoints.cs and NotificationService.cs, read at 4.1.12.1122): one
 * flat record per connection with its settings as a JSON string, no schema, and a save that tests
 * nothing. So the link runs Sportarr's own test first and saves only a connection that passes.
 * Only imports, upgrades and renames are turned on. Sportarr names the file's folder for those. For
 * a delete it names none, and has the server scan every library it has.
 *
 * Run again, a connection that works is left as it is, with its name and its choices. So is one
 * that reaches this Plex by another name or address, which Plex's public id tells apart from a
 * connection to another server. One whose token Plex no longer takes gets the one Plex holds
 * now. Plex's token is its owner's, which every Plex server of theirs takes, so it proves no
 * server: a connection at an address nothing answers at is left as it is, and this Plex's is added
 * beside it. A connection to another server is never changed.
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
    await ctx.skipCheckpoint(TELLS, "Plex can't see Sportarr's Sports folder, so Sportarr has nothing to tell it about");
    return;
  }

  // No key or token ever reaches a step's words or a failure's details
  const reasonOf = (error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    return text.replaceAll(apiKey, "********").replaceAll(token, "********");
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
    ).filter((entry) => entry.implementation === "Plex");
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
  // A connection at the box's address and Plex's port, or one that reaches this Plex by another name
  // or address: the server that answers there has this Plex's own id
  let existing = ofKind.find((entry) => addressOf(entry) === here);
  if (!existing) {
    const thisServer = await serverIdAt(here);
    for (const entry of thisServer ? ofKind : []) {
      if ((await serverIdAt(addressOf(entry))) !== thisServer) continue;
      existing = entry;
      break;
    }
  }
  let outcome: "works" | "renewed" | "added" = "added";
  if (existing) {
    const refused = await test(existing);
    if (!refused) outcome = "works";
    // Only a token Plex turns away is replaced: a server that didn't answer says nothing of it
    else if (refused.startsWith("Authentication failed")) outcome = "renewed";
    else ctx.fail("Sportarr couldn't reach Plex", [{ label: "Reason", value: refused }]);
  }

  if (existing && outcome === "works") {
    const kept = settings(existing);
    const updates = existing.enabled !== false && kept.updateLibrary !== false && SPORTARR_EVENTS.some((event) => kept[event] === true);
    await ctx.skipCheckpoint(
      TELLS,
      updates
        ? "Sportarr already tells Plex what it adds"
        : "Sportarr already has Plex, with its library updates turned off. Turn them on in Sportarr's Settings, under Notifications.",
    );
    return;
  }

  const record: SportarrConnection = existing
    ? changed(existing, { apiKey: token })
    : {
        name: "Plex",
        implementation: "Plex",
        enabled: true,
        tags: [],
        // Only what HexOS sets: the address, the token, library updates and the path mapping
        configJson: JSON.stringify({
          host: here,
          apiKey: token,
          updateLibrary: true,
          usePartialScan: true,
          ...Object.fromEntries(SPORTARR_EVENTS.map((event) => [event, true])),
          ...mapping,
        }),
      };
  // Sportarr saves a connection it never tested, so only one its own test passes is saved
  const refused = await test(record);
  if (refused) ctx.fail("Sportarr couldn't connect to Plex", [{ label: "Reason", value: refused }]);
  const id = existing?.id;
  await (
    id === undefined
      ? api("/notification", { method: "POST", body: JSON.stringify(record) })
      : api(`/notification/${id}`, { method: "PUT", body: JSON.stringify(record) })
  ).catch((error: unknown) => ctx.fail("Sportarr couldn't connect to Plex", [{ label: "Reason", value: reasonOf(error) }]));
  const saved = (await listed()).find((entry) => (id === undefined ? addressOf(entry) === here : entry.id === id));
  if (!saved || (outcome === "added" && addressOf(saved) !== here)) ctx.fail("Sportarr saved Plex, but HexOS couldn't find it there. Run this again.");
  await ctx.emitCheckpoint(TELLS, outcome === "renewed" ? "Sportarr reaches Plex again" : undefined);
}

export async function sportarr(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "sports", message: "Adding your Sports library to Plex" },
    { id: TELLS, message: "Adding Plex to Sportarr" },
  ]);

  const token = plexToken(ctx.mounts);
  if (!token) {
    if (ctx.skip) ctx.skip("Plex has no sign-in yet, so HexOS can't add your Sports library");
    ctx.fail("Sign in to Plex first, then run this again.");
  }
  const before = await libraryPaths(ctx, token);
  if (!before) ctx.fail("HexOS couldn't read Plex's libraries, so it added none. Try again once Plex is running.");
  if (!ctx.mounts.some((m) => m.containerPath === "/media")) {
    await ctx.skipCheckpoint("sports", "Plex can't see your Media folder, so it has no Sports library to add");
  } else if (before.has(SPORTS.location)) {
    await ctx.skipCheckpoint("sports", "Plex already has your Sports library");
  } else {
    await addLibrary(ctx, token);
    await ctx.emitCheckpoint("sports");
  }
  await tellSportarr(ctx, token);
}

async function addLibrary(ctx: HookContext, token: string) {
  const params = new URLSearchParams({
    "X-Plex-Token": token,
    name: SPORTS.name,
    type: "show",
    agent: "tv.plex.agents.none",
    scanner: "Plex TV Series",
    language: "xn",
    location: SPORTS.location,
  });
  const response = await fetch(`${ctx.baseUrl}/library/sections?${params}`, { method: "POST", signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  if (!response.ok) {
    ctx.fail("Plex didn't add your Sports library", [{ label: "Reason", value: `${response.status} ${text.slice(0, 200)}` }]);
  }
  if (!(await libraryPaths(ctx, token))?.has(SPORTS.location)) {
    ctx.fail("Plex answered, but your Sports library isn't there. Run this again.");
  }
}
