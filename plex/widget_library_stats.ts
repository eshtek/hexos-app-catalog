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

export async function run(ctx: WidgetContext): Promise<WidgetQueryResult> {
  const token = harvestPlexToken(ctx);
  if (!token) return { needsSetup: true, reason: "Sign in to Plex to see your library here" };

  const base = `http://${ctx.host}:${ctx.port ?? 32400}`;
  const headers = { Accept: "application/json", "X-Plex-Token": token };

  const sectionsResponse = await fetch(`${base}/library/sections`, { headers });
  if (!sectionsResponse.ok) throw new Error(`Plex sections query failed (${sectionsResponse.status})`);
  const sectionsBody = (await sectionsResponse.json()) as {
    MediaContainer?: { Directory?: Array<{ key: string; title: string }> };
  };
  const sections = sectionsBody.MediaContainer?.Directory ?? [];

  const stats: Array<{ label: string; value: string }> = [];
  for (const section of sections.slice(0, 4)) {
    // Container-Size=0 returns just totalSize — no item payload
    const response = await fetch(
      `${base}/library/sections/${section.key}/all?X-Plex-Container-Start=0&X-Plex-Container-Size=0`,
      { headers },
    );
    if (!response.ok) continue;
    const body = (await response.json()) as { MediaContainer?: { totalSize?: number } };
    stats.push({ label: section.title, value: String(body.MediaContainer?.totalSize ?? 0) });
  }

  return { stats };
}
