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

interface PlexMetadata {
  title: string;
  type?: string;
  year?: number;
  addedAt?: number;
  grandparentTitle?: string;
  parentIndex?: number;
  index?: number;
}

function itemTitle(entry: PlexMetadata): string {
  if (entry.type === "episode" && entry.grandparentTitle) {
    return `${entry.grandparentTitle} — ${entry.title}`;
  }
  return entry.title;
}

function itemSubtitle(entry: PlexMetadata): string | undefined {
  if (entry.type === "episode") {
    const se =
      entry.parentIndex !== undefined && entry.index !== undefined
        ? `S${entry.parentIndex} · E${entry.index}`
        : "Episode";
    return se;
  }
  const kind = entry.type === "movie" ? "Movie" : entry.type === "show" ? "Show" : undefined;
  return [kind, entry.year].filter(Boolean).join(" · ") || undefined;
}

function addedAgo(addedAt?: number): string | undefined {
  if (!addedAt) return undefined;
  const days = Math.floor((Date.now() / 1000 - addedAt) / 86400);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return new Date(addedAt * 1000).toLocaleDateString();
}

export async function run(ctx: WidgetContext): Promise<WidgetQueryResult> {
  const token = harvestPlexToken(ctx);
  if (!token) return { needsSetup: true, reason: "Sign in to Plex to see your library here" };

  const base = `http://${ctx.host}:${ctx.port ?? 32400}`;
  const headers = { Accept: "application/json", "X-Plex-Token": token };

  const response = await fetch(`${base}/library/recentlyAdded?X-Plex-Container-Start=0&X-Plex-Container-Size=8`, {
    headers,
  });
  if (!response.ok) throw new Error(`Plex recentlyAdded query failed (${response.status})`);
  const body = (await response.json()) as { MediaContainer?: { Metadata?: PlexMetadata[] } };
  const metadata = body.MediaContainer?.Metadata ?? [];

  return {
    fields: {
      recent: {
        type: "list",
        entries: metadata.slice(0, 8).map((entry) => ({
          title: itemTitle(entry),
          subtitle: itemSubtitle(entry),
          meta: addedAgo(entry.addedAt),
        })),
      },
    },
  };
}
