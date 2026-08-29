// Type imports only — each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { Database } from "bun:sqlite";

import type { WidgetContext, WidgetQueryResult } from "../_lib/widget_context";

// Same harvest as the now-playing widget: freshest active token from
// authentication.db, minted by Emby itself on the config mount.
function harvestEmbyToken(ctx: WidgetContext): string | null {
  const config =
    ctx.mounts.find((m) => m.containerPath === "/config") ??
    ctx.mounts.find((m) => m.hostPath.endsWith("/emby/config"));
  if (!config) return null;
  try {
    const db = new Database(`${config.localPath}/data/authentication.db`, { readonly: true });
    try {
      const token = db
        .query("SELECT AccessToken FROM Tokens_2 WHERE IsActive = 1 ORDER BY DateLastActivityInt DESC LIMIT 1")
        .get() as { AccessToken?: string } | null;
      return token?.AccessToken ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

interface EmbyCounts {
  MovieCount?: number;
  SeriesCount?: number;
  EpisodeCount?: number;
  SongCount?: number;
  AlbumCount?: number;
  BookCount?: number;
}

export async function run(ctx: WidgetContext): Promise<WidgetQueryResult> {
  const token = harvestEmbyToken(ctx);
  if (!token) return { needsSetup: true, reason: "Sign in to Emby to see your library here" };

  const base = `http://${ctx.host}:${ctx.port ?? 9096}/emby`;
  const response = await fetch(`${base}/Items/Counts`, {
    headers: { Accept: "application/json", "X-Emby-Token": token },
  });
  if (!response.ok) throw new Error(`Emby counts query failed (${response.status})`);
  const counts = (await response.json()) as EmbyCounts;

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
