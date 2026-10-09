// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";

import type { WidgetContext, WidgetQueryResult } from "../_lib/widget_context";

const PREFS_RELATIVE = "/Library/Application Support/Plex Media Server/Preferences.xml";

function harvestPlexToken(ctx: WidgetContext): string | null {
  const config =
    ctx.mounts.find((m) => m.containerPath === "/config") ??
    ctx.mounts.find((m) => m.hostPath.endsWith("/plex/config"));
  if (!config) return null;
  try {
    const xml = readFileSync(config.localPath + PREFS_RELATIVE, "utf-8");
    return xml.match(/PlexOnlineToken="([^"]+)"/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** A Plex photo-transcoder crop of `path` as a data URI, or undefined when it is over the size cap. */
async function transcodeImage(
  base: string,
  token: string,
  path: string,
  width: number,
  height: number,
): Promise<string | undefined> {
  const response = await fetch(
    `${base}/photo/:/transcode?width=${width}&height=${height}&minSize=1&format=jpeg&url=${encodeURIComponent(path)}&X-Plex-Token=${token}`,
  );
  if (!response.ok) return undefined;
  const type = response.headers.get("content-type") ?? "";
  if (!type.startsWith("image/")) return undefined;
  const uri = `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
  return uri.length <= 60_000 ? uri : undefined;
}

/**
 * The session's wide artwork as a size-capped data URI, for the app card's background while the
 * card shows this session. A card is about 330x130, so the transcoder is asked for a landscape
 * crop near twice that for a sharp picture, then near the card's own size when the sharp one is
 * over the cap. An item with no wide artwork falls back to its poster, cropped the same way.
 */
// A stream's artwork does not change while it plays, and the card asks every few seconds, so each
// picture is fetched once and kept: the box reuses this module between runs until the script
// changes. Only pictures that arrived are kept, so a failed one is tried again on the next run.
const ARTWORK_CACHE_SIZE = 20;

/** Streams the last run saw, kept like the artwork: an empty answer is retried only after a busy one. */
let lastActiveCount = 0;
const artworkCache = new Map<string, string>();

function rememberArtwork(key: string, image: string): void {
  artworkCache.delete(key);
  artworkCache.set(key, image);
  const oldest = artworkCache.keys().next().value;
  if (artworkCache.size > ARTWORK_CACHE_SIZE && oldest !== undefined) artworkCache.delete(oldest);
}

async function fetchArtwork(base: string, token: string, session: PlexSession): Promise<string | undefined> {
  const path = session.art || session.grandparentArt || session.grandparentThumb || session.thumb;
  if (!path) return undefined;
  const key = `${base}${path}`;
  const kept = artworkCache.get(key);
  if (kept) return kept;
  try {
    const image =
      (await transcodeImage(base, token, path, 660, 260)) ?? (await transcodeImage(base, token, path, 480, 190));
    if (image) rememberArtwork(key, image);
    return image;
  } catch {
    return undefined;
  }
}

interface PlexSession {
  title: string;
  type?: string;
  grandparentTitle?: string;
  parentIndex?: number;
  index?: number;
  viewOffset?: number;
  duration?: number;
  thumb?: string;
  grandparentThumb?: string;
  art?: string;
  grandparentArt?: string;
  User?: { title?: string };
  Player?: { title?: string; product?: string; state?: string };
  // The TranscodeSession is the authoritative decision signal; absent means
  // direct play. Session.bandwidth is the reserved stream bandwidth in kbps.
  Session?: { bandwidth?: number };
  TranscodeSession?: { videoDecision?: string; audioDecision?: string };
}

/** SxxExx when both indices are known. */
function episodeCode(season: number | undefined, episode: number | undefined): string | undefined {
  if (season === undefined || episode === undefined) return undefined;
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

/** A movie's title; an episode's show and code ("The Pitt · S01E12"), which is what fits a line. */
function sessionTitle(session: PlexSession): string {
  if (session.type === "episode" && session.grandparentTitle) {
    const code = episodeCode(session.parentIndex, session.index);
    return `${session.grandparentTitle} · ${code ?? session.title}`;
  }
  return session.title;
}

/**
 * What the server does to the picture, the one thing about serving a stream an
 * owner weighs: Transcode when the video is re-encoded, DirectPlay otherwise
 * (no TranscodeSession, or one that copies the video, remuxing or converting
 * only the audio, which costs little). Decided by videoDecision, the per-stream
 * decision; Part.decision cannot tell a remux from a transcode, and reading
 * Media[0] misreports multi-version items.
 */
function videoMethod(session: PlexSession): string {
  return session.TranscodeSession?.videoDecision === "transcode" ? "Transcode" : "DirectPlay";
}

/** kbps → human bitrate; drops non-positive/unknown. */
function bandwidthLabel(kbps: number | undefined): string | undefined {
  const n = Number(kbps);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n >= 1000 ? `${(n / 1000).toFixed(1)} Mbps` : `${Math.round(n)} kbps`;
}

/**
 * The lines that take turns under the stream: who is watching where, then how
 * the picture is served and at what bitrate. Either is left out when Plex says
 * nothing for it.
 */
function sessionLines(session: PlexSession): string[] {
  const who = [session.User?.title, session.Player?.product || session.Player?.title].filter(Boolean).join(" · ");
  const how = [videoMethod(session), bandwidthLabel(session.Session?.bandwidth)].filter(Boolean).join(" · ");
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

function sessionMeta(session: PlexSession): string | undefined {
  const parts: string[] = [];
  if (session.Player?.state === "paused") parts.push("paused");
  if (session.viewOffset !== undefined && session.duration) {
    parts.push(`${timecode(session.viewOffset)} / ${timecode(session.duration)}`);
  }
  return parts.join(" · ") || undefined;
}

export async function run(ctx: WidgetContext): Promise<WidgetQueryResult> {
  const token = harvestPlexToken(ctx);
  if (!token) return { needsSetup: true, reason: "Sign in to Plex to see your library here" };

  const base = `http://${ctx.host}:${ctx.port ?? 32400}`;
  const headers = { Accept: "application/json", "X-Plex-Token": token };

  const fetchActive = async (signal?: AbortSignal): Promise<PlexSession[]> => {
    const response = await fetch(`${base}/status/sessions`, { headers, signal });
    if (!response.ok) throw new Error(`Plex sessions query failed (${response.status})`);
    const body = (await response.json()) as { MediaContainer?: { Metadata?: PlexSession[] } };
    return body.MediaContainer?.Metadata ?? [];
  };
  // /status/sessions has brief empty windows mid-playback (a missed client
  // timeline ping): retry before believing a 0, or a blip gets cached for a
  // whole refresh cycle. Only when the last run saw streams, though: with
  // nothing playing before, an empty answer is simply true, and retrying it
  // would hold every poll of an idle server for 1.4 s. Retries are bounded (a
  // slow app can't eat the timeout) and a retry failure keeps the
  // confirmed-good empty answer.
  let active = await fetchActive();
  for (let i = 0; active.length === 0 && lastActiveCount > 0 && i < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    try {
      active = await fetchActive(AbortSignal.timeout(2000));
    } catch {
      break;
    }
  }
  lastActiveCount = active.length;
  // The count reflects every active stream; the card steps through the first few, one dot each.
  const total = active.length;
  const sessions = active.slice(0, 5);

  const artwork = await Promise.all(sessions.map((session) => fetchArtwork(base, token, session)));

  return {
    fields: {
      streams: { type: "stat", label: total === 1 ? "Stream" : "Streams", value: String(total) },
      // Each entry carries its own artwork: the card's background names this list, so the
      // picture behind the card is the one for the stream on screen.
      sessions: {
        type: "list",
        entries: sessions.map((session, i) => ({
          title: sessionTitle(session),
          // The floor shows the first line; the card takes turns with all of them.
          subtitle: sessionLines(session)[0],
          subtitles: sessionLines(session),
          // Text floor: a static timecode any renderer can show as-is.
          meta: sessionMeta(session),
          // Enrichment: capable renderers tick this between polls.
          elapsed:
            session.viewOffset !== undefined && session.duration
              ? {
                  ms: session.viewOffset,
                  ofMs: session.duration,
                  state: session.Player?.state === "paused" ? ("paused" as const) : ("running" as const),
                }
              : undefined,
          image: artwork[i],
        })),
      },
      summary: {
        type: "text",
        text:
          total === 0
            ? "Nothing playing"
            : `${total} stream${total === 1 ? "" : "s"} · ${sessionTitle(sessions[0])}`,
      },
    },
  };
}
