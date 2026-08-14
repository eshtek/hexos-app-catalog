// Type imports only — each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";

import type { WidgetContext, WidgetQueryResult } from "../_lib/widget_context";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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

interface HistoryRow {
  full_title?: string;
  friendly_name?: string;
  player?: string;
  date?: number;
  thumb?: string;
  grandparent_thumb?: string;
}

function dayLabel(epochSeconds: number | undefined): string | undefined {
  if (!epochSeconds) return undefined;
  const d = new Date(epochSeconds * 1000);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export async function run(ctx: WidgetContext): Promise<WidgetQueryResult> {
  const apiKey = harvestApiKey(ctx);
  if (!apiKey) return { needsSetup: true, reason: "Connect Tautulli to Plex to see watch history here" };

  const base = `http://${ctx.host}:${ctx.port ?? 30181}`;
  const response = await fetch(`${base}/api/v2?apikey=${apiKey}&cmd=get_history&length=5`);
  if (!response.ok) throw new Error(`Tautulli history query failed (${response.status})`);
  const body = (await response.json()) as {
    response?: { result?: string; data?: { data?: HistoryRow[] } };
  };
  if (body.response?.result !== "success") throw new Error("Tautulli history query returned an error");
  const rows = body.response?.data?.data ?? [];

  const top = rows.slice(0, 5);
  const images = await Promise.all(
    top.map((row) => fetchThumb(base, apiKey, row.grandparent_thumb || row.thumb)),
  );

  return {
    items: top.map((row, i) => ({
      title: row.full_title ?? "Unknown",
      subtitle: [row.friendly_name, row.player].filter(Boolean).join(" · ") || undefined,
      meta: dayLabel(row.date),
      image: images[i],
    })),
  };
}
