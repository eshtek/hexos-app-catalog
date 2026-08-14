// Type imports only — each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
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

interface PlexSession {
  title: string;
  type?: string;
  grandparentTitle?: string;
  parentIndex?: number;
  index?: number;
  viewOffset?: number;
  duration?: number;
  User?: { title?: string };
  Player?: { title?: string; product?: string; state?: string };
}

function sessionTitle(session: PlexSession): string {
  if (session.type === "episode" && session.grandparentTitle) {
    return `${session.grandparentTitle} — ${session.title}`;
  }
  return session.title;
}

function sessionSubtitle(session: PlexSession): string | undefined {
  const who = session.User?.title;
  const where = session.Player?.product || session.Player?.title;
  return [who, where].filter(Boolean).join(" · ") || undefined;
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

  const response = await fetch(`${base}/status/sessions`, { headers });
  if (!response.ok) throw new Error(`Plex sessions query failed (${response.status})`);
  const body = (await response.json()) as { MediaContainer?: { Metadata?: PlexSession[] } };
  const sessions = body.MediaContainer?.Metadata ?? [];

  return {
    items: sessions.slice(0, 5).map((session) => ({
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
    })),
  };
}
