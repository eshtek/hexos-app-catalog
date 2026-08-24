// Type imports only — each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { Buffer } from "node:buffer";
import { Database } from "bun:sqlite";

import type { WidgetContext, WidgetQueryResult } from "../_lib/widget_context";

// Jellyfin has no unauthenticated sessions endpoint, but it writes every
// token it mints into its own SQLite db on the config mount. Prefer real
// API keys (created when apps like Jellystat or Seerr connect — not tied to
// a login session), fall back to the freshest device token.
function harvestJellyfinToken(ctx: WidgetContext): string | null {
  const config =
    ctx.mounts.find((m) => m.containerPath === "/config") ??
    ctx.mounts.find((m) => m.hostPath.endsWith("/jellyfin/config"));
  if (!config) return null;
  try {
    const db = new Database(`${config.localPath}/data/jellyfin.db`, { readonly: true });
    try {
      const apiKey = db.query("SELECT AccessToken FROM ApiKeys LIMIT 1").get() as
        | { AccessToken?: string }
        | null;
      if (apiKey?.AccessToken) return apiKey.AccessToken;
      const device = db
        .query("SELECT AccessToken FROM Devices ORDER BY DateLastActivity DESC LIMIT 1")
        .get() as { AccessToken?: string } | null;
      return device?.AccessToken ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Poster as a size-capped data URI via Jellyfin's image resizer. */
async function fetchPoster(base: string, token: string, itemId: string | undefined): Promise<string | undefined> {
  if (!itemId) return undefined;
  try {
    const response = await fetch(`${base}/Items/${itemId}/Images/Primary?maxWidth=120&quality=80`, {
      headers: { Authorization: `MediaBrowser Token="${token}"` },
    });
    if (!response.ok) return undefined;
    const type = response.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) return undefined;
    const uri = `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
    return uri.length <= 60_000 ? uri : undefined;
  } catch {
    return undefined;
  }
}

interface JellyfinSession {
  UserName?: string;
  Client?: string;
  DeviceName?: string;
  PlayState?: { IsPaused?: boolean; PositionTicks?: number };
  NowPlayingItem?: {
    Id?: string;
    Name?: string;
    Type?: string;
    SeriesName?: string;
    SeriesId?: string;
    RunTimeTicks?: number;
  };
}

function sessionTitle(session: JellyfinSession): string {
  const item = session.NowPlayingItem;
  if (!item?.Name) return "Unknown";
  if (item.Type === "Episode" && item.SeriesName) return `${item.SeriesName} — ${item.Name}`;
  return item.Name;
}

function sessionSubtitle(session: JellyfinSession): string | undefined {
  const where = session.Client || session.DeviceName;
  return [session.UserName, where].filter(Boolean).join(" · ") || undefined;
}

function timecode(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// Jellyfin ticks are 100ns: ticks / 10,000 = milliseconds.
const msFromTicks = (ticks: number | undefined): number | undefined =>
  ticks === undefined ? undefined : Math.floor(ticks / 10_000);

function sessionMeta(session: JellyfinSession): string | undefined {
  const parts: string[] = [];
  if (session.PlayState?.IsPaused) parts.push("paused");
  const position = msFromTicks(session.PlayState?.PositionTicks);
  const duration = msFromTicks(session.NowPlayingItem?.RunTimeTicks);
  if (position !== undefined && duration) parts.push(`${timecode(position)} / ${timecode(duration)}`);
  return parts.join(" · ") || undefined;
}

export async function run(ctx: WidgetContext): Promise<WidgetQueryResult> {
  const token = harvestJellyfinToken(ctx);
  if (!token) return { needsSetup: true, reason: "Sign in to Jellyfin to see playback here" };

  const base = `http://${ctx.host}:${ctx.port ?? 30013}`;
  const headers = { Accept: "application/json", Authorization: `MediaBrowser Token="${token}"` };

  const response = await fetch(`${base}/Sessions?ActiveWithinSeconds=960`, { headers });
  if (!response.ok) throw new Error(`Jellyfin sessions query failed (${response.status})`);
  const all = (await response.json()) as JellyfinSession[];
  const sessions = all.filter((session) => session.NowPlayingItem).slice(0, 5);

  const images = await Promise.all(
    sessions.map((session) =>
      fetchPoster(base, token, session.NowPlayingItem?.SeriesId || session.NowPlayingItem?.Id),
    ),
  );

  const fields: NonNullable<WidgetQueryResult["fields"]> = {
    streams: { type: "stat", label: "Streams", value: String(sessions.length) },
    sessions: {
      type: "list",
      entries: sessions.map((session, i) => {
        const position = msFromTicks(session.PlayState?.PositionTicks);
        const duration = msFromTicks(session.NowPlayingItem?.RunTimeTicks);
        return {
          title: sessionTitle(session),
          subtitle: sessionSubtitle(session),
          // Text floor: a static timecode any renderer can show as-is.
          meta: sessionMeta(session),
          // Enrichment: capable renderers tick this between polls.
          elapsed:
            position !== undefined && duration
              ? { ms: position, ofMs: duration, state: session.PlayState?.IsPaused ? ("paused" as const) : ("running" as const) }
              : undefined,
          image: images[i],
        };
      }),
    },
    summary: {
      type: "text",
      text:
        sessions.length === 0
          ? "Nothing playing"
          : `${sessions.length} active ${sessions.length === 1 ? "stream" : "streams"}`,
    },
  };

  const art = images.find(Boolean);
  if (art) fields.art = { type: "image", image: art, alt: sessionTitle(sessions[images.indexOf(art)]) };

  return { fields };
}
