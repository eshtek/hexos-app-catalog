// Type imports only — each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
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

/** Poster as a size-capped data URI via Plex's photo transcoder. */
async function fetchThumb(
  base: string,
  token: string,
  thumb: string | undefined,
): Promise<string | undefined> {
  if (!thumb) return undefined;
  try {
    const response = await fetch(
      `${base}/photo/:/transcode?width=120&height=180&minSize=1&url=${encodeURIComponent(thumb)}&X-Plex-Token=${token}`,
    );
    if (!response.ok) return undefined;
    const type = response.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) return undefined;
    const uri = `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
    return uri.length <= 60_000 ? uri : undefined;
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

function sessionTitle(session: PlexSession): string {
  if (session.type === "episode" && session.grandparentTitle) {
    const code = episodeCode(session.parentIndex, session.index);
    return code
      ? `${session.grandparentTitle} — ${code} · ${session.title}`
      : `${session.grandparentTitle} — ${session.title}`;
  }
  return session.title;
}

/**
 * Direct Play / Direct Stream (remux) / Transcode. No TranscodeSession =
 * direct play; one whose streams all "copy" = remux (Direct Stream); any
 * stream re-encoding = Transcode. (Part.decision only ever says
 * directplay/transcode — it cannot express remux — and reading Media[0]
 * misreports multi-version items, so neither is used.)
 */
function streamLabel(session: PlexSession): string {
  const transcode = session.TranscodeSession;
  if (!transcode) return "Direct Play";
  if (transcode.videoDecision === "transcode" || transcode.audioDecision === "transcode") return "Transcode";
  return "Direct Stream";
}

/** kbps → human bitrate; drops non-positive/unknown. */
function bandwidthLabel(kbps: number | undefined): string | undefined {
  const n = Number(kbps);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n >= 1000 ? `${(n / 1000).toFixed(1)} Mbps` : `${Math.round(n)} kbps`;
}

function sessionSubtitle(session: PlexSession): string | undefined {
  const who = session.User?.title;
  const where = session.Player?.product || session.Player?.title;
  const method = streamLabel(session);
  // Identity for a plain direct play; the load story (method · bitrate) when
  // it isn't — the tight subtitle only fits two short facts.
  if (method === "Direct Play") return [who, where].filter(Boolean).join(" · ") || undefined;
  return [method, bandwidthLabel(session.Session?.bandwidth)].filter(Boolean).join(" · ") || undefined;
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
  // timeline ping) — retry before believing a 0, or a blip gets cached for a
  // whole refresh cycle. Retries are bounded (a slow app can't eat the 10s
  // budget) and a retry failure keeps the confirmed-good empty answer.
  let active = await fetchActive();
  for (let i = 0; active.length === 0 && i < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    try {
      active = await fetchActive(AbortSignal.timeout(2000));
    } catch {
      break;
    }
  }
  // The count reflects every active stream; the list shows the first few.
  const total = active.length;
  const sessions = active.slice(0, 5);

  const images = await Promise.all(
    sessions.map((session) => fetchThumb(base, token, session.grandparentThumb || session.thumb)),
  );

  const fields: NonNullable<WidgetQueryResult["fields"]> = {
    streams: { type: "stat", label: total === 1 ? "Stream" : "Streams", value: String(total) },
    sessions: {
      type: "list",
      entries: sessions.map((session, i) => ({
        title: sessionTitle(session),
        subtitle: sessionSubtitle(session),
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
        image: images[i],
      })),
    },
    summary: {
      type: "text",
      text:
        total === 0
          ? "Nothing playing"
          : `${total} stream${total === 1 ? "" : "s"} · ${sessionTitle(sessions[0])}`,
    },
  };

  // The media slot's source: the first session with a poster — its own title
  // labels the art.
  const art = images.find((image) => image !== undefined);
  if (art) fields.art = { type: "image", image: art, alt: sessionTitle(sessions[images.indexOf(art)]) };

  return { fields };
}
