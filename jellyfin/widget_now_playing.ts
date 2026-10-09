// Sibling files are type imports only: each script is compiled standalone, so runtime imports of them wouldn't resolve.
import { Database } from "bun:sqlite";
import { Buffer } from "node:buffer";

import type { WidgetContext, WidgetListEntry, WidgetQueryResult } from "../_lib/widget_context";

// What Jellyfin is playing, one stream at a time on the app card, each with its own artwork.
// The same card Plex draws, from Jellyfin's sessions.

const DB_RELATIVE = "/data/jellyfin.db";
/** The name the setup hook gives the API key it creates. */
const KEY_NAME = "HexOS";
/** The device the setup hook signs in as; its session is the first that stands in for the key. */
const SETUP_DEVICE_ID = "hexos-jellyfin-setup";
/** Jellyfin's PermissionKind.IsAdministrator. Only an administrator sees every session. */
const IS_ADMINISTRATOR = 0;
const SETUP_REASON = "Sign in to Jellyfin to see what's playing here";
/** Jellyfin counts time in ticks of 100 ns. */
const TICKS_PER_MS = 10_000;

/**
 * A token the widget can read sessions with, from Jellyfin's own database, read-only, so the owner
 * never has to hand HexOS one: the API key HexOS's setup made, else any API key, else the session
 * of an administrator signed in to any Jellyfin app (HexOS's setup sign-in first, then the most
 * recently used). Only an administrator sees every stream. Null when no administrator has ever
 * signed in, which signing in fixes.
 */
function harvestToken(ctx: WidgetContext): string | null {
  const config =
    ctx.mounts.find((m) => m.containerPath === "/config") ??
    ctx.mounts.find((m) => m.hostPath.endsWith("/jellyfin/config"));
  if (!config) return null;
  let db: Database | undefined;
  try {
    db = new Database(config.localPath + DB_RELATIVE, { readonly: true });
    const key = db
      .query<{ AccessToken: string }, [string]>(
        "SELECT AccessToken FROM ApiKeys ORDER BY (Name = ?) DESC, DateCreated DESC LIMIT 1",
      )
      .get(KEY_NAME);
    if (key?.AccessToken) return key.AccessToken;
    const session = db
      .query<{ AccessToken: string }, [number, string]>(
        `SELECT d.AccessToken FROM Devices d
           JOIN Permissions p ON p.UserId = d.UserId AND p.Kind = ? AND p.Value = 1
          WHERE d.IsActive = 1
          ORDER BY (d.DeviceId = ?) DESC, d.DateLastActivity DESC
          LIMIT 1`,
      )
      .get(IS_ADMINISTRATOR, SETUP_DEVICE_ID);
    return session?.AccessToken ?? null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

interface JellyfinItem {
  Id: string;
  Name?: string;
  Type?: string;
  SeriesName?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  RunTimeTicks?: number;
  BackdropImageTags?: string[];
  ParentBackdropItemId?: string;
  ParentBackdropImageTags?: string[];
  ImageTags?: { Primary?: string; Thumb?: string };
  ParentThumbItemId?: string;
}

interface JellyfinSession {
  UserName?: string;
  Client?: string;
  DeviceName?: string;
  NowPlayingItem?: JellyfinItem;
  PlayState?: { PositionTicks?: number; IsPaused?: boolean; PlayMethod?: string };
  TranscodingInfo?: { Bitrate?: number; IsVideoDirect?: boolean; IsAudioDirect?: boolean };
}

/** SxxExx when both indices are known. */
function episodeCode(season: number | undefined, episode: number | undefined): string | undefined {
  if (season === undefined || episode === undefined) return undefined;
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

/** A movie's title; an episode's show and code ("The Pitt · S01E12"), which is what fits a line. */
function sessionTitle(item: JellyfinItem): string {
  const name = item.Name || "Untitled";
  if (item.Type === "Episode" && item.SeriesName) {
    return `${item.SeriesName} · ${episodeCode(item.ParentIndexNumber, item.IndexNumber) ?? name}`;
  }
  return name;
}

/** bps → human bitrate; drops non-positive/unknown. */
function bitrateLabel(bps: number | undefined): string | undefined {
  const n = Number(bps);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} Mbps` : `${Math.round(n / 1000)} kbps`;
}

/**
 * What the server does to the picture, the one thing about serving a stream an owner weighs:
 * Transcode when the video is re-encoded, DirectPlay otherwise (a remux, or only the audio
 * converted, costs little). Jellyfin's PlayMethod says Transcode whenever any stream is
 * re-encoded, so the transcoding flags decide.
 */
function videoMethod(session: JellyfinSession): string {
  const method = session.PlayState?.PlayMethod;
  if (method !== "Transcode") return "DirectPlay";
  return session.TranscodingInfo?.IsVideoDirect ? "DirectPlay" : "Transcode";
}

/**
 * The lines that take turns under the stream: who is watching where, then how the picture is
 * served and, while the server is producing the stream, at what bitrate.
 */
function sessionLines(session: JellyfinSession): string[] {
  const who = [session.UserName, session.DeviceName || session.Client].filter(Boolean).join(" · ");
  const how = [videoMethod(session), bitrateLabel(session.TranscodingInfo?.Bitrate)].filter(Boolean).join(" · ");
  return [who, how].filter(Boolean);
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

/**
 * Which picture of the item is its wide artwork: its own backdrop, its series' backdrop for an
 * episode, else its thumb, else its primary image (an episode's primary is a 16:9 still).
 */
function artworkPath(item: JellyfinItem): string | undefined {
  if (item.BackdropImageTags?.length) return `/Items/${item.Id}/Images/Backdrop/0`;
  if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.length) {
    return `/Items/${item.ParentBackdropItemId}/Images/Backdrop/0`;
  }
  if (item.ImageTags?.Thumb) return `/Items/${item.Id}/Images/Thumb`;
  if (item.ParentThumbItemId) return `/Items/${item.ParentThumbItemId}/Images/Thumb`;
  if (item.ImageTags?.Primary) return `/Items/${item.Id}/Images/Primary`;
  return undefined;
}

/** A crop of the image filling `width` x `height`, as a data URI, or undefined when over the cap. */
async function fetchImage(
  base: string,
  headers: Record<string, string>,
  path: string,
  width: number,
  height: number,
): Promise<string | undefined> {
  const response = await fetch(`${base}${path}?fillWidth=${width}&fillHeight=${height}&quality=80&format=Jpg`, {
    headers,
  });
  if (!response.ok) return undefined;
  const type = response.headers.get("content-type") ?? "";
  if (!type.startsWith("image/")) return undefined;
  const uri = `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
  return uri.length <= 60_000 ? uri : undefined;
}

/**
 * The item's wide artwork as a size-capped data URI, for the app card's background while the
 * card shows this stream. Near twice the card's size for a sharp picture, then near its own size
 * when the sharp one is over the cap.
 */
// A stream's artwork does not change while it plays, and the card asks every few seconds, so each
// picture is fetched once and kept: the box reuses this module between runs until the script
// changes. Only pictures that arrived are kept, so a failed one is tried again on the next run.
const ARTWORK_CACHE_SIZE = 20;
const artworkCache = new Map<string, string>();

function rememberArtwork(key: string, image: string): void {
  artworkCache.delete(key);
  artworkCache.set(key, image);
  const oldest = artworkCache.keys().next().value;
  if (artworkCache.size > ARTWORK_CACHE_SIZE && oldest !== undefined) artworkCache.delete(oldest);
}

async function fetchArtwork(
  base: string,
  headers: Record<string, string>,
  item: JellyfinItem,
): Promise<string | undefined> {
  const path = artworkPath(item);
  if (!path) return undefined;
  const key = `${base}${path}`;
  const kept = artworkCache.get(key);
  if (kept) return kept;
  try {
    const image =
      (await fetchImage(base, headers, path, 660, 260)) ?? (await fetchImage(base, headers, path, 480, 190));
    if (image) rememberArtwork(key, image);
    return image;
  } catch {
    return undefined;
  }
}

export async function run(ctx: WidgetContext): Promise<WidgetQueryResult> {
  const token = harvestToken(ctx);
  if (!token) return { needsSetup: true, reason: SETUP_REASON };

  const base = `http://${ctx.host}:${ctx.port ?? 30013}`;
  const headers = { Accept: "application/json", Authorization: `MediaBrowser Token="${token}"` };

  const response = await fetch(`${base}/Sessions?activeWithinSeconds=960`, { headers });
  // A session token dies when its device signs out; the next run picks another.
  if (response.status === 401) return { needsSetup: true, reason: SETUP_REASON };
  if (!response.ok) throw new Error(`Jellyfin sessions query failed (${response.status})`);
  const sessions = ((await response.json()) as JellyfinSession[]).filter(
    (session): session is JellyfinSession & { NowPlayingItem: JellyfinItem } => !!session.NowPlayingItem,
  );

  // The count reflects every active stream; the card steps through the first few, one dot each.
  const total = sessions.length;
  const shown = sessions.slice(0, 5);
  const artwork = await Promise.all(shown.map((session) => fetchArtwork(base, headers, session.NowPlayingItem)));

  const entries: WidgetListEntry[] = shown.map((session, i) => {
    const item = session.NowPlayingItem;
    const paused = session.PlayState?.IsPaused === true;
    const positionMs = session.PlayState?.PositionTicks !== undefined
      ? Math.floor(session.PlayState.PositionTicks / TICKS_PER_MS)
      : undefined;
    const durationMs = item.RunTimeTicks ? Math.floor(item.RunTimeTicks / TICKS_PER_MS) : undefined;
    const timed = positionMs !== undefined && durationMs !== undefined && durationMs > 0;
    return {
      title: sessionTitle(item),
      // The floor shows the first line; the card takes turns with all of them.
      subtitle: sessionLines(session)[0],
      subtitles: sessionLines(session),
      // Text floor: a static timecode any renderer can show as-is.
      meta: [paused ? "paused" : undefined, timed ? `${timecode(positionMs)} / ${timecode(durationMs)}` : undefined]
        .filter(Boolean)
        .join(" · ") || undefined,
      // Enrichment: capable renderers tick this between polls.
      elapsed: timed
        ? { ms: Math.min(positionMs, durationMs), ofMs: durationMs, state: paused ? "paused" : "running" }
        : undefined,
      image: artwork[i],
    };
  });

  return {
    fields: {
      streams: { type: "stat", label: total === 1 ? "Stream" : "Streams", value: String(total) },
      // Each entry carries its own artwork: the card's background names this list, so the
      // picture behind the card is the one for the stream on screen.
      sessions: { type: "list", entries },
      summary: {
        type: "text",
        text: total === 0 ? "Nothing playing" : `${total} stream${total === 1 ? "" : "s"} · ${entries[0].title}`,
      },
    },
  };
}
