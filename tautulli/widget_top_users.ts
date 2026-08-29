// Type imports only — each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
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

interface StatRow {
  friendly_name?: string;
  user?: string;
  total_plays?: number;
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
    `${base}/api/v2?apikey=${apiKey}&cmd=get_home_stats&time_range=30&stats_type=plays&stats_count=6`,
  );
  if (!response.ok) throw new Error(`Tautulli stats query failed (${response.status})`);
  const body = (await response.json()) as { response?: { result?: string; data?: StatBlock[] } };
  if (body.response?.result !== "success") throw new Error("Tautulli stats query returned an error");

  const users = (body.response?.data ?? [])
    .filter((b) => b.stat_id === "top_users")
    .flatMap((b) => b.rows ?? [])
    .filter((r) => r.friendly_name || r.user)
    .slice(0, 6);

  // Usernames are dynamic, so per-user stat fields have no stable names —
  // the ranking rides as one list field.
  return {
    fields: {
      top: {
        type: "list",
        entries: users.map((row) => ({
          title: row.friendly_name || row.user || "Unknown",
          meta: `${row.total_plays ?? 0} plays`,
        })),
      },
    },
  };
}
