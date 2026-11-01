// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { readFileSync } from "node:fs";

import type { ContextMount, HookContext } from "../_lib/hook_context";

/**
 * Adds the Sports library Sportarr fills to Plex. Plex sees the whole Media location at /media, and
 * Sportarr's folder is there. It's a link, not part of Plex's setup, so a Plex the owner already has
 * gets the library from its Connections tab. Plex has no library for books, so Chaptarr has no link
 * here. Sportarr's names aren't TV listings, so the library uses Plex's Personal Media Shows agent.
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

export async function sportarr(ctx: HookContext) {
  await ctx.registerCheckpoints([{ id: "sports", message: "Adding your Sports library to Plex" }]);

  const token = plexToken(ctx.mounts);
  if (!token) ctx.skip ? ctx.skip("Plex has no sign-in yet, so HexOS can't add your Sports library") : ctx.fail("Sign in to Plex first, then run this again.");
  const before = await libraryPaths(ctx, token);
  if (!before) ctx.fail("HexOS couldn't read Plex's libraries, so it added none. Try again once Plex is running.");
  if (!ctx.mounts.some((m) => m.containerPath === "/media")) {
    await ctx.skipCheckpoint("sports", "Plex can't see your Media folder, so it has no Sports library to add");
    return;
  }
  if (before.has(SPORTS.location)) {
    await ctx.skipCheckpoint("sports", "Plex already has your Sports library");
    return;
  }

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
  await ctx.emitCheckpoint("sports");
}
