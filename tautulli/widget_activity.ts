// Type imports only — each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";

import type { WidgetContext, WidgetQueryResult } from "../_lib/widget_context";

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

/** Poster as a size-capped data URI via Tautulli's image proxy. */
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

interface Session {
  full_title?: string;
  friendly_name?: string;
  player?: string;
  state?: string;
  transcode_decision?: string;
  quality_profile?: string;
  bandwidth?: string | number;
  view_offset?: string | number;
  duration?: string | number;
  thumb?: string;
  grandparent_thumb?: string;
}

function streamLabel(session: Session): string {
  const decision = (session.transcode_decision ?? "").toLowerCase();
  if (decision === "transcode") return "Transcode";
  if (decision === "copy") return "Direct Stream";
  return "Direct Play";
}

function bandwidthLabel(session: Session): string | undefined {
  const kbps = Number(session.bandwidth);
  if (!Number.isFinite(kbps) || kbps <= 0) return undefined;
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`;
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

export async function run(ctx: WidgetContext): Promise<WidgetQueryResult> {
  const apiKey = harvestApiKey(ctx);
  if (!apiKey) return { needsSetup: true, reason: "Connect Tautulli to Plex to see live activity here" };

  const base = `http://${ctx.host}:${ctx.port ?? 30181}`;
  const response = await fetch(`${base}/api/v2?apikey=${apiKey}&cmd=get_activity`);
  if (!response.ok) throw new Error(`Tautulli activity query failed (${response.status})`);
  const body = (await response.json()) as {
    response?: { result?: string; data?: { sessions?: Session[] } };
  };
  if (body.response?.result !== "success") throw new Error("Tautulli activity query returned an error");

  const sessions = (body.response?.data?.sessions ?? []).slice(0, 5);
  const images = await Promise.all(
    sessions.map((s) => fetchThumb(base, apiKey, s.grandparent_thumb || s.thumb)),
  );

  return {
    items: sessions.map((session, i) => {
      const offsetMs = Number(session.view_offset);
      const durationMs = Number(session.duration);
      const hasPosition = Number.isFinite(offsetMs) && Number.isFinite(durationMs) && durationMs > 0;
      const paused = session.state === "paused";
      return {
        title: session.full_title ?? "Unknown",
        subtitle:
          [session.friendly_name, streamLabel(session), bandwidthLabel(session)].filter(Boolean).join(" · ") ||
          undefined,
        // Text floor: static timecode; capable renderers tick via `elapsed`.
        meta: hasPosition
          ? `${paused ? "paused · " : ""}${timecode(offsetMs)} / ${timecode(durationMs)}`
          : undefined,
        elapsed: hasPosition
          ? { ms: offsetMs, ofMs: durationMs, state: paused ? ("paused" as const) : ("running" as const) }
          : undefined,
        image: images[i],
      };
    }),
  };
}
