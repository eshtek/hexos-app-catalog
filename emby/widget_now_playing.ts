// Sibling files are type imports only: each script is compiled standalone, so runtime imports of them wouldn't resolve.
import { Database } from "bun:sqlite";
import { Buffer } from "node:buffer";
import { createReadStream, createWriteStream, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import type { WidgetContext, WidgetListEntry, WidgetQueryResult } from "../_lib/widget_context";

// What Emby is playing, one stream at a time on the app card, each with its own artwork.
// The same card Plex and Jellyfin draw, from Emby's sessions.

const DB_RELATIVE = "/data/authentication.db";
/** The device the setup hook signs in as; its sign-in is the first that stands in for a key. */
const SETUP_DEVICE_ID = "hexos-emby-setup";
const SETUP_REASON = "Sign in to Emby to see what's playing here";
/** Emby counts time in ticks of 100 ns. */
const TICKS_PER_MS = 10_000;
const DOCKER_SOCKET = "/var/run/docker.sock";
/** Under the widget's 10 s timeout, so a database too big to copy reads as no token rather than failing the card. */
const DOCKER_TIMEOUT_MS = 8000;
/** The card refreshes every 5 s and a copy is the whole database, so copies are at least this far apart. */
const DOCKER_RETRY_MS = 60_000;

// A token read through Docker, kept while it works. It's replaced at the next copy after a 401.
let dockerToken: string | null = null;
let nextDockerCopy = 0;

/**
 * A token the widget can read sessions with: an API key (a token with no user), else HexOS's setup
 * sign-in, else the most recently used sign-in of any Emby app. Null until someone signs in to Emby.
 */
function tokenIn(db: Database): string | null {
  const token = db
    .query<{ AccessToken: string }, [string]>(
      `SELECT t.AccessToken FROM Tokens_2 t
         LEFT JOIN Devices2 d ON d.Id = t.DeviceId
        WHERE t.IsActive = 1
        ORDER BY (t.UserId IS NULL OR t.UserId = '') DESC, (d.ReportedDeviceId = ?) DESC, t.DateLastActivityInt DESC
        LIMIT 1`,
    )
    .get(SETUP_DEVICE_ID);
  return token?.AccessToken ?? null;
}

/** Where the file in a tar from Docker's archive endpoint sits: after its 512-byte header, and any pax header. */
export function tarFile(head: Uint8Array): { start: number; size: number } | null {
  const text = new TextDecoder();
  for (let at = 0; head[at]; ) {
    const size = Number.parseInt(text.decode(head.subarray(at + 124, at + 136)), 8);
    const type = head[at + 156];
    if (type === 0 || type === 48) return { start: at + 512, size }; // a regular file
    at += 512 + Math.ceil(size / 512) * 512; // a pax header ahead of the file
  }
  return null;
}

/** A GET on Docker's socket. Not fetch: over a unix socket that moves 15 MB/s on Bun 1.4.4, and this 140. */
function dockerGet(path: string, signal: AbortSignal): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    http.get({ socketPath: DOCKER_SOCKET, path, signal }, resolve).on("error", reject);
  });
}

/** Copies a file with anything in it out of the app's container to `to`, through a file: a database can be large. */
async function copyFromContainer(appId: string, path: string, to: string, signal: AbortSignal): Promise<boolean> {
  const response = await dockerGet(
    `/containers/ix-${appId}-${appId}-1/archive?path=${encodeURIComponent(path)}`,
    signal,
  );
  if (response.statusCode !== 200) {
    response.resume();
    return false;
  }
  const tar = `${to}.tar`;
  await pipeline(response, createWriteStream(tar), { signal });
  const file = tarFile(new Uint8Array(await Bun.file(tar).slice(0, 4096).arrayBuffer()));
  if (!file?.size) return false;
  // Not Bun.write of a sliced file: on Bun 1.4.4 that writes the whole of it, header included
  const bytes = createReadStream(tar, { start: file.start, end: file.start + file.size - 1 });
  await pipeline(bytes, createWriteStream(to));
  return true;
}

/**
 * The token from a copy of the database, opened read-write so SQLite can take in the copy's
 * write-ahead log, which holds whatever Emby hasn't written back yet. The live database is only
 * ever read. The copy is removed before this returns.
 */
async function tokenThroughDocker(appId: string, path: string): Promise<string | null> {
  if (dockerToken || Date.now() < nextDockerCopy) return dockerToken;
  nextDockerCopy = Date.now() + DOCKER_RETRY_MS;
  const dir = mkdtempSync(join(tmpdir(), "hexos-emby-"));
  const copy = join(dir, "authentication.db");
  let db: Database | undefined;
  try {
    const signal = AbortSignal.timeout(DOCKER_TIMEOUT_MS);
    if (await copyFromContainer(appId, path, copy, signal)) {
      await copyFromContainer(appId, `${path}-wal`, `${copy}-wal`, signal);
      db = new Database(copy);
      dockerToken = tokenIn(db);
    }
  } catch {
    // A box with no socket yet, a database too big to copy in time, or one caught mid-write
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return dockerToken;
}

/**
 * A token from Emby's own database, so the owner never has to hand HexOS one. The database sits on
 * the app's own dataset, which the HexOS container can't see on a box whose app config predates the
 * pool mounts; Docker always can, over the daemon socket the HexOS container has for its host
 * commands.
 */
async function harvestToken(ctx: WidgetContext): Promise<string | null> {
  const config =
    ctx.mounts.find((m) => m.containerPath === "/config") ??
    ctx.mounts.find((m) => m.hostPath.endsWith("/emby/config"));
  if (config) {
    let db: Database | undefined;
    try {
      db = new Database(config.localPath + DB_RELATIVE, { readonly: true });
      return tokenIn(db);
    } catch {
      // Not written yet, or the dataset isn't visible from here
    } finally {
      db?.close();
    }
  }
  return tokenThroughDocker(ctx.appId, (config?.containerPath ?? "/config") + DB_RELATIVE);
}

interface EmbyItem {
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

interface EmbySession {
  UserName?: string;
  Client?: string;
  DeviceName?: string;
  NowPlayingItem?: EmbyItem;
  PlayState?: { PositionTicks?: number; IsPaused?: boolean; PlayMethod?: string };
  TranscodingInfo?: { Bitrate?: number; IsVideoDirect?: boolean; IsAudioDirect?: boolean };
}

/** SxxExx when both indices are known. */
function episodeCode(season: number | undefined, episode: number | undefined): string | undefined {
  if (season === undefined || episode === undefined) return undefined;
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

/** A movie's title; an episode's show and code ("The Pitt · S01E12"), which is what fits a line. */
function sessionTitle(item: EmbyItem): string {
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
 * converted, costs little). Emby's PlayMethod says Transcode whenever any stream is re-encoded,
 * so the transcoding flags decide.
 */
function videoMethod(session: EmbySession): string {
  const method = session.PlayState?.PlayMethod;
  if (method !== "Transcode") return "DirectPlay";
  return session.TranscodingInfo?.IsVideoDirect ? "DirectPlay" : "Transcode";
}

/**
 * The lines that take turns under the stream: who is watching where, then how the picture is
 * served and, while the server is producing the stream, at what bitrate.
 */
function sessionLines(session: EmbySession): string[] {
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
function artworkPath(item: EmbyItem): string | undefined {
  if (item.BackdropImageTags?.length) return `/emby/Items/${item.Id}/Images/Backdrop/0`;
  if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.length) {
    return `/emby/Items/${item.ParentBackdropItemId}/Images/Backdrop/0`;
  }
  if (item.ImageTags?.Thumb) return `/emby/Items/${item.Id}/Images/Thumb`;
  if (item.ParentThumbItemId) return `/emby/Items/${item.ParentThumbItemId}/Images/Thumb`;
  if (item.ImageTags?.Primary) return `/emby/Items/${item.Id}/Images/Primary`;
  return undefined;
}

/** The image cropped to `width` x `height`, as a data URI, or undefined when over the cap. */
async function fetchImage(
  base: string,
  headers: Record<string, string>,
  path: string,
  width: number,
  height: number,
): Promise<string | undefined> {
  const response = await fetch(`${base}${path}?width=${width}&height=${height}&quality=80&format=jpg`, { headers });
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

async function fetchArtwork(base: string, headers: Record<string, string>, item: EmbyItem): Promise<string | undefined> {
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
  const token = await harvestToken(ctx);
  if (!token) return { needsSetup: true, reason: SETUP_REASON };

  const base = `http://${ctx.host}:${ctx.port ?? 9096}`;
  const headers = { Accept: "application/json", "X-Emby-Token": token };

  const response = await fetch(`${base}/emby/Sessions?ActiveWithinSeconds=960`, { headers });
  // A sign-in's token dies when its device signs out; the next run picks another.
  if (response.status === 401) {
    dockerToken = null;
    return { needsSetup: true, reason: SETUP_REASON };
  }
  if (!response.ok) throw new Error(`Emby sessions query failed (${response.status})`);
  const sessions = ((await response.json()) as EmbySession[]).filter(
    (session): session is EmbySession & { NowPlayingItem: EmbyItem } => !!session.NowPlayingItem,
  );

  // The count reflects every active stream; the card steps through the first few, one dot each.
  const total = sessions.length;
  const shown = sessions.slice(0, 5);
  const artwork = await Promise.all(shown.map((session) => fetchArtwork(base, headers, session.NowPlayingItem)));

  const entries: WidgetListEntry[] = shown.map((session, i) => {
    const item = session.NowPlayingItem;
    const paused = session.PlayState?.IsPaused === true;
    const positionMs =
      session.PlayState?.PositionTicks !== undefined ? Math.floor(session.PlayState.PositionTicks / TICKS_PER_MS) : undefined;
    const durationMs = item.RunTimeTicks ? Math.floor(item.RunTimeTicks / TICKS_PER_MS) : undefined;
    const timed = positionMs !== undefined && durationMs !== undefined && durationMs > 0;
    return {
      title: sessionTitle(item),
      // The floor shows the first line; the card takes turns with all of them.
      subtitle: sessionLines(session)[0],
      subtitles: sessionLines(session),
      // Text floor: a static timecode any renderer can show as-is.
      meta:
        [paused ? "paused" : undefined, timed ? `${timecode(positionMs)} / ${timecode(durationMs)}` : undefined]
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
