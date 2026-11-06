// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { readFileSync } from "node:fs";

import type { ContextMount, HookContext, PlexOAuthResult } from "../_lib/hook_context";

/**
 * Sets Seerr up with this Plex server, as Seerr's own setup does (connect-seerr). It signs in to
 * Seerr with the owner's Plex account, which makes that account Seerr's administrator, points Seerr
 * at this server, turns on the movie and show libraries, starts a scan and finishes Seerr's setup.
 * The Plex sign-in is the one Pre-configure Plex was given (requiresHooks), so an install never asks
 * for it twice. Seerr's links to Radarr and Sonarr act as that administrator, so they need this one
 * first. Run again, it moves Seerr to this server when Seerr's own is gone: Plex reinstalled (a new
 * server at the same address), or this server at an address that no longer reaches it. Read at Seerr
 * 3.5.1, the version TrueNAS pins.
 */

/** Seerr's MediaServerType (server/constants/server.ts). */
const PLEX = 1;
const NOT_CONFIGURED = 4;

interface SeerrLibrary {
  id: string;
  name: string;
  enabled: boolean;
  type: "movie" | "show";
}

interface PublicSettings {
  initialized?: boolean;
  mediaServerType?: number;
}

interface PlexSettings {
  name?: string;
  ip?: string;
  port?: number;
  useSsl?: boolean;
  machineId?: string;
}

function configMount(mounts: ContextMount[]): ContextMount | undefined {
  return (
    mounts.find((m) => m.containerPath === "/app/config" || m.containerPath === "/config") ??
    mounts.find((m) => m.hostPath.endsWith("/seerr/config"))
  );
}

function readSeerrKey(mounts: ContextMount[]): string | undefined {
  try {
    const settings = JSON.parse(readFileSync(`${configMount(mounts)?.localPath}/settings.json`, "utf-8"));
    return (settings as { main?: { apiKey?: string } }).main?.apiKey;
  } catch {
    return undefined;
  }
}

/** Seerr's error code (`SYNC_ERROR_NO_LIBRARIES`) or message from a refused call. */
async function reason(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { message?: string; error?: string };
    return body.message ?? body.error ?? text.slice(0, 300);
  } catch {
    return text.slice(0, 300) || `${response.status} ${response.statusText}`;
  }
}

async function call<T>(url: string, apiKey: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(await reason(response));
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const publicSettings = (seerr: string) =>
  fetch(`${seerr}/api/v1/settings/public`, { signal: AbortSignal.timeout(15_000) })
    .then((response) => (response.ok ? (response.json() as Promise<PublicSettings>) : undefined))
    .catch(() => undefined);

/** Seerr writes its settings on first start, a little after its container is up. */
async function waitForSeerr(ctx: HookContext, seerr: string): Promise<{ apiKey: string; before: PublicSettings }> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const apiKey = readSeerrKey(await ctx.getInstalledAppMounts("seerr"));
    const before = await publicSettings(seerr);
    if (apiKey && before) return { apiKey, before };
    await ctx.sleep(5_000);
  }
  ctx.fail("Seerr didn't answer. Try again once it has started.");
}

/**
 * This server's id, read with the owner's sign-in. Plex refuses an account it doesn't know, which is
 * found out here, before Seerr is changed.
 */
async function plexServerId(ctx: HookContext, token: string): Promise<string> {
  // In the query, as Pre-configure Plex sends it: Bun's fetch sends header names in lowercase, and
  // Plex was seen to skip a lowercase token header
  const response = await fetch(`${ctx.baseUrl}/?X-Plex-Token=${encodeURIComponent(token)}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
  if (!response) ctx.fail("Plex didn't answer. Try again once it has started.");
  // A token Plex can't check with plex.tv gets a 400, one without access to this server a 401
  if (response.status >= 400 && response.status < 500) {
    ctx.fail(
      "This Plex server didn't accept your Plex sign-in. Run Connect to Seerr from Plex and sign in with the Plex account that owns this server.",
      [{ label: "Status", value: String(response.status) }],
    );
  }
  const id = response.ok
    ? ((await response.json().catch(() => undefined)) as { MediaContainer?: { machineIdentifier?: string } } | undefined)
        ?.MediaContainer?.machineIdentifier
    : undefined;
  if (!id) ctx.fail("HexOS couldn't read this Plex server's details", [{ label: "Status", value: String(response.status) }]);
  return id;
}

/**
 * The Plex server that answers at an address now, by its machine identifier, or undefined when
 * nothing does. Plex answers `/identity` without a sign-in.
 */
async function identityAt(ip: string, port: number | undefined, useSsl: boolean | undefined): Promise<string | undefined> {
  // Only the server's public identifier is read, so a certificate made for another name (a Plex
  // reached by its IP over TLS) doesn't count as no answer; nothing is sent
  const init = { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000), tls: { rejectUnauthorized: false } };
  const response = await fetch(`${useSsl ? "https" : "http"}://${ip}:${port ?? 32400}/identity`, init as RequestInit).catch(() => undefined);
  if (!response?.ok) return undefined;
  const body = (await response.json().catch(() => undefined)) as { MediaContainer?: { machineIdentifier?: string } } | undefined;
  return body?.MediaContainer?.machineIdentifier || undefined;
}

/**
 * Whether the owner wants Seerr moved off a server that no longer answers. Nothing proves that server
 * is gone for good (it may be another computer that's switched off), so the owner decides. False when
 * they say no, skip the question, or the box can't ask.
 */
async function ownerSwitches(ctx: HookContext, current: PlexSettings): Promise<boolean> {
  if (typeof ctx.askForInputs !== "function") return false;
  const name = current.name ? `${current.name} at ${current.ip}:${current.port}` : `${current.ip}:${current.port}`;
  const answers = await ctx
    .askForInputs(
      [
        {
          type: "question",
          id: "switch",
          question: {
            question: "Switch Seerr to this Plex server",
            description: "Seerr keeps its requests and users.",
            type: "boolean",
            key: "switch",
            required: true,
          },
        },
      ],
      { title: "Switch Seerr's Plex server", description: `Seerr uses ${name}, which isn't answering.` },
    )
    .catch((error: unknown) => {
      if (error instanceof Error && error.name === "HookInputsUnanswered") return undefined;
      throw error;
    });
  return answers?.switch === true;
}

export async function run(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "locate", message: "Finding Seerr" },
    { id: "signin", message: "Signing in to Seerr with Plex" },
    { id: "server", message: "Pointing Seerr at this Plex server" },
    { id: "libraries", message: "Turning on Seerr's movie and show libraries" },
    { id: "finish", message: "Finishing Seerr's setup" },
  ]);

  const seerr = await ctx.getInstalledAppUrl("seerr");
  if (!seerr) ctx.fail("Seerr isn't installed, or HexOS can't find its port");
  if (!ctx.host || !ctx.port) ctx.fail("HexOS couldn't find this Plex server's address");
  const token = ctx.getInput<PlexOAuthResult>("plex_login")?.authToken;
  if (!token) {
    const message = "HexOS has no Plex sign-in for this server. Run Connect to Seerr from Plex and sign in to Plex.";
    if (ctx.skip) ctx.skip(message);
    ctx.fail(message);
  }
  const { apiKey, before } = await waitForSeerr(ctx, seerr);
  const machineId = await plexServerId(ctx, token);
  await ctx.emitCheckpoint("locate");

  if (before.mediaServerType === NOT_CONFIGURED) {
    // Seerr's first Plex sign-in makes that account its administrator and Plex its media server
    const response = await fetch(`${seerr}/api/v1/auth/plex`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authToken: token }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const code = await reason(response);
      ctx.fail("Seerr couldn't sign in to Plex. Run Connect to Seerr from Plex and sign in to Plex again.", [
        { label: "Status", value: String(response.status) },
        { label: "Reason", value: code },
      ]);
    }
    // A Seerr that already had a user takes the sign-in without choosing Plex
    if ((await publicSettings(seerr))?.mediaServerType !== PLEX) {
      ctx.fail("Seerr took the Plex sign-in but didn't set Plex up. Finish Seerr's setup in Seerr itself.");
    }
    await ctx.emitCheckpoint("signin");
  } else if (before.mediaServerType === PLEX) {
    await ctx.skipCheckpoint("signin", "Seerr already uses Plex");
  } else {
    // Seerr keeps one media server, and switching it is the owner's to do: trying again can't help
    const message = "Seerr is already set up with another media server. Change it in Seerr's own settings, then run Connect to Seerr from Plex.";
    if (ctx.skip) ctx.skip(message);
    ctx.fail(message);
  }

  // Seerr keeps one Plex server. It's left alone while it still answers as another server, which the
  // owner chose. It moves to this one when its own is this server at an address that no longer
  // reaches it (the box's address or Plex's port changed), when its address now answers as this
  // server (Plex was reinstalled, which gives it a new identifier), or when its server doesn't answer
  // at all and the owner says so.
  const current = await call<PlexSettings>(`${seerr}/api/v1/settings/plex`, apiKey);
  const answering = current.ip ? await identityAt(current.ip, current.port, current.useSsl) : undefined;
  let switched = false;
  if (current.machineId === machineId && answering === machineId) {
    await ctx.skipCheckpoint("server", "Seerr already uses this Plex server");
  } else {
    if (current.ip && current.machineId !== machineId && answering !== machineId) {
      // Seerr keeps one media server, and switching it is the owner's to do: trying again can't help
      const message = "Seerr is already set up with another Plex server. Change it in Seerr's own settings, then run Connect to Seerr from Plex.";
      const context = [{ label: "Seerr uses", value: `${current.ip}:${current.port}` }];
      if (answering || !(await ownerSwitches(ctx, current))) {
        if (ctx.skip) ctx.skip(message, context);
        ctx.fail(message, context);
      }
    }
    // Seerr checks the server answers its administrator before it keeps the address. An address
    // that now answers as this server stays as the owner wrote it; anything else becomes this one's.
    const address = answering === machineId ? { ip: current.ip, port: current.port, useSsl: current.useSsl } : { ip: ctx.host, port: ctx.port, useSsl: false };
    let saved: PlexSettings | undefined;
    try {
      saved = await call<PlexSettings>(`${seerr}/api/v1/settings/plex`, apiKey, { method: "POST", body: JSON.stringify(address) });
    } catch (error) {
      ctx.fail("Seerr couldn't reach this Plex server with your Plex account. Check Plex is running, then run Connect to Seerr from Plex again.", [
        { label: "Address", value: `${address.ip}:${address.port}` },
        { label: "Reason", value: error instanceof Error ? error.message : String(error) },
      ]);
    }
    if (saved?.machineId !== machineId) {
      ctx.fail("Seerr reached a different Plex server at this address", [{ label: "Address", value: `${address.ip}:${address.port}` }]);
    }
    switched = !!current.machineId && current.machineId !== machineId;
    await ctx.emitCheckpoint("server", switched ? "Seerr moved to this Plex server" : undefined);
  }

  // The libraries the owner chose in Seerr are theirs: only a Seerr with none on, or one that just
  // moved to this server, gets them turned on.
  // Seerr lists only Plex's movie and show libraries that have a metadata agent. Seerr 3.5's sync
  // fails on a Plex with no library at all (it reads a list Plex leaves out), so that one is left for
  // later rather than failing the link.
  const plexLibraries = await fetch(`${ctx.baseUrl}/library/sections?X-Plex-Token=${encodeURIComponent(token)}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  })
    .then((response) => (response.ok ? (response.json() as Promise<{ MediaContainer?: { Directory?: unknown[] } }>) : undefined))
    .catch(() => undefined);
  let libraries: SeerrLibrary[] = [];
  try {
    if (plexLibraries?.MediaContainer && !plexLibraries.MediaContainer.Directory?.length) libraries = [];
    else libraries = await call<SeerrLibrary[]>(`${seerr}/api/v1/settings/plex/library/sync`, apiKey, { method: "POST" });
  } catch (error) {
    ctx.fail("Seerr couldn't read Plex's libraries. Check the Plex address in Seerr's settings, then run Connect to Seerr from Plex again.", [
      { label: "Reason", value: error instanceof Error ? error.message : String(error) },
    ]);
  }
  const media = libraries.filter((library) => library.type === "movie" || library.type === "show");
  if (media.length === 0) {
    await ctx.skipCheckpoint("libraries", "Plex has no movie or show library yet");
  } else if (!switched && libraries.some((library) => library.enabled)) {
    await ctx.skipCheckpoint("libraries", "Seerr's libraries are already chosen");
  } else {
    // A server Seerr just moved to gets what a new Seerr does: what it picked on its old server
    // belonged to that server's libraries
    for (const library of media.filter((each) => !each.enabled)) {
      await call(`${seerr}/api/v1/settings/plex/library/${encodeURIComponent(library.id)}`, apiKey, {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
      });
    }
    // The scan fills Seerr with what's already in the libraries; a scan that doesn't start now runs
    // on Seerr's own schedule
    await call(`${seerr}/api/v1/settings/plex/sync`, apiKey, {
      method: "POST",
      body: JSON.stringify({ start: true }),
    }).catch((error) => ctx.log(`Seerr's library scan didn't start: ${error}`));
    await ctx.emitCheckpoint("libraries");
  }

  if (before.initialized) {
    await ctx.skipCheckpoint("finish", "Seerr's setup was already finished");
    return;
  }
  await call(`${seerr}/api/v1/settings/initialize`, apiKey, { method: "POST" });
  const after = await publicSettings(seerr);
  if (!after?.initialized || after.mediaServerType !== PLEX) {
    ctx.fail("Seerr didn't finish its setup. Run Connect to Seerr from Plex again.");
  }
  await ctx.emitCheckpoint("finish");
}
