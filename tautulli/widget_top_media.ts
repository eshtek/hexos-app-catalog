// Type imports only — each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";

import type { WidgetContext, WidgetQueryResult } from "../_lib/widget_context";

/**
 * Poster as a size-capped data URI via Tautulli's image proxy (server-side
 * resize, auth stays on the box). Failures degrade to text-only rows.
 */
async function fetchThumb(base: string, apiKey: string, thumb: string | undefined): Promise<string | undefined> {
  if (!thumb) return undefined;
  try {
    const response = await fetch(
      `${base}/api/v2?apikey=${apiKey}&cmd=pms_image_proxy&img=${encodeURIComponent(thumb)}&width=120&height=180&fallback=poster`,
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

function harvestApiKey(ctx: WidgetContext): string | null {
  const config =
    ctx.mounts.find((m) => m.containerPath === "/config") ??
    ctx.mounts.find((m) => m.hostPath.endsWith("/tautulli/config"));
  if (!config) return null;
  try {
    const ini = readFileSync(`${config.localPath}/config.ini`, "utf-8");
    return ini.match(/^api_key\s*=\s*(\S+)/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

interface StatRow {
  title?: string;
  total_plays?: number;
  thumb?: string;
  grandparent_thumb?: string;
}

interface StatBlock {
  stat_id?: string;
  rows?: StatRow[];
}

export async function run(ctx: WidgetContext): Promise<WidgetQueryResult> {
  const apiKey = harvestApiKey(ctx);
  if (!apiKey) return { needsSetup: true, reason: "Connect Tautulli to Plex to see watch stats here" };

  const base = `http://${ctx.host}:${ctx.port ?? 30181}`;
  const response = await fetch(
    `${base}/api/v2?apikey=${apiKey}&cmd=get_home_stats&time_range=30&stats_type=plays&stats_count=5`,
  );
  if (!response.ok) throw new Error(`Tautulli stats query failed (${response.status})`);
  const body = (await response.json()) as { response?: { result?: string; data?: StatBlock[] } };
  if (body.response?.result !== "success") throw new Error("Tautulli stats query returned an error");

  const blocks = body.response?.data ?? [];
  const media = blocks
    .filter((b) => b.stat_id === "top_movies" || b.stat_id === "top_tv")
    .flatMap((b) => b.rows ?? [])
    .filter((r) => r.title)
    .sort((a, b) => (b.total_plays ?? 0) - (a.total_plays ?? 0))
    .slice(0, 5);

  const images = await Promise.all(media.map((row) => fetchThumb(base, apiKey, row.thumb || row.grandparent_thumb)));

  return {
    fields: {
      top: {
        type: "list",
        entries: media.map((row, i) => ({
          title: row.title ?? "Unknown",
          meta: row.total_plays !== undefined ? `${row.total_plays} plays` : undefined,
          image: images[i],
        })),
      },
    },
  };
}
