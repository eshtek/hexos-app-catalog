// Type imports only — each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { Database } from "bun:sqlite";

import type { WidgetContext, WidgetQueryResult } from "../_lib/widget_context";

// Same harvest as the now-playing widget: API keys first, freshest device
// token as fallback — both minted by Jellyfin itself on the config mount.
function harvestJellyfinToken(ctx: WidgetContext): string | null {
  const config = ctx.mounts.find((m) => m.containerPath === "/config");
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

interface JellyfinCounts {
  MovieCount?: number;
  SeriesCount?: number;
  EpisodeCount?: number;
  SongCount?: number;
  AlbumCount?: number;
  BookCount?: number;
}

export async function run(ctx: WidgetContext): Promise<WidgetQueryResult> {
  const token = harvestJellyfinToken(ctx);
  if (!token) return { needsSetup: true, reason: "Sign in to Jellyfin to see your library here" };

  const base = `http://${ctx.host}:${ctx.port ?? 30013}`;
  const response = await fetch(`${base}/Items/Counts`, {
    headers: { Accept: "application/json", Authorization: `MediaBrowser Token="${token}"` },
  });
  if (!response.ok) throw new Error(`Jellyfin counts query failed (${response.status})`);
  const counts = (await response.json()) as JellyfinCounts;

  // Playable media units — episodes and songs count, their containers don't.
  const total = (counts.MovieCount ?? 0) + (counts.EpisodeCount ?? 0) + (counts.SongCount ?? 0) + (counts.BookCount ?? 0);

  const kinds: Array<[string, number | undefined]> = [
    ["Movies", counts.MovieCount],
    ["Shows", counts.SeriesCount],
    ["Episodes", counts.EpisodeCount],
    ["Albums", counts.AlbumCount],
    ["Songs", counts.SongCount],
    ["Books", counts.BookCount],
  ];

  return {
    fields: {
      total: { type: "stat", label: "Library items", value: String(total) },
      kinds: {
        type: "list",
        entries: kinds
          .filter(([, count]) => (count ?? 0) > 0)
          .map(([title, count]) => ({ title, meta: String(count) })),
      },
    },
  };
}
