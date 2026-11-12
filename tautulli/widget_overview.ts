// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { readFileSync } from "node:fs";

import type { WidgetContext, WidgetListEntry, WidgetQueryResult } from "../_lib/widget_context";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The days the stats cover: Tautulli's own default for its home stats and graphs. */
const STATS_DAYS = 30;

const CONFIG_FILE = "/config.ini";
const DOCKER_SOCKET = "/var/run/docker.sock";
/** Under the widget's 10 s timeout, so a stuck daemon reads as nothing rather than failing the card. */
const DOCKER_TIMEOUT_MS = 2000;

/** The file in a tar from Docker's archive endpoint: a 512-byte header, then its bytes. */
export function untar(tar: Uint8Array): string {
  const text = new TextDecoder();
  for (let at = 0; tar[at]; ) {
    const size = Number.parseInt(text.decode(tar.subarray(at + 124, at + 136)), 8);
    const type = tar[at + 156];
    if (type === 0 || type === 48) return text.decode(tar.subarray(at + 512, at + 512 + size)); // a regular file
    at += 512 + Math.ceil(size / 512) * 512; // a pax header ahead of the file
  }
  return "";
}

async function readThroughDocker(appId: string, path: string): Promise<string> {
  const url = `http://docker/containers/ix-${appId}-${appId}-1/archive?path=${encodeURIComponent(path)}`;
  try {
    const response = await fetch(url, { unix: DOCKER_SOCKET, signal: AbortSignal.timeout(DOCKER_TIMEOUT_MS) });
    return response.ok ? untar(new Uint8Array(await response.arrayBuffer())) : "";
  } catch {
    return ""; // a box with no socket yet
  }
}

/**
 * Tautulli's config file. It sits on the app's own dataset, which the HexOS container can't see on
 * a box whose app config predates the pool mounts, so what the mount doesn't give is read out of
 * the app's container over the daemon socket the HexOS container has for its host commands.
 */
async function readConfig(ctx: WidgetContext, mount: WidgetContext["mounts"][number] | undefined): Promise<string> {
  if (mount) {
    try {
      return readFileSync(mount.localPath + CONFIG_FILE, "utf-8");
    } catch {
      // Not written yet, or the dataset isn't visible from here
    }
  }
  return readThroughDocker(ctx.appId, (mount?.containerPath ?? "/config") + CONFIG_FILE);
}

/** Tautulli's settings. The chart fixes the config folder's container path, so it is matched by host path. */
async function readSettings(ctx: WidgetContext): Promise<Map<string, string>> {
  const config =
    ctx.mounts.find((m) => m.containerPath === "/config") ??
    ctx.mounts.find((m) => m.hostPath.endsWith("/tautulli/config"));
  const settings = new Map<string, string>();
  for (const line of (await readConfig(ctx, config)).split("\n")) {
    const match = line.match(/^(\w+)\s*=\s*(.*)$/);
    if (match) settings.set(match[1], match[2].trim().replace(/^"(.*)"$/, "$1"));
  }
  return settings;
}

interface RecentItem {
  media_type?: string;
  title?: string;
  parent_title?: string;
  grandparent_title?: string;
  media_index?: string | number;
  parent_media_index?: string | number;
  added_at?: string | number;
}

interface TopUser {
  friendly_name?: string;
  user?: string;
  total_plays?: number;
}

interface PlaysByDay {
  categories?: string[];
  series?: Array<{ name?: string; data?: number[] }>;
}

/** SxxExx when both indices are known. */
function episodeCode(season: string | number | undefined, episode: string | number | undefined): string | undefined {
  if (season === undefined || season === "" || episode === undefined || episode === "") return undefined;
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

/** What fits a line: a movie's title, an episode's show and code, a season's show and name, an album's artist and title. */
function itemTitle(item: RecentItem): string {
  const show = item.grandparent_title;
  switch (item.media_type) {
    case "episode":
      return show ? `${show} · ${episodeCode(item.parent_media_index, item.media_index) ?? item.title}` : item.title || "Unknown";
    case "season":
      return item.parent_title ? `${item.parent_title} · ${item.title}` : item.title || "Unknown";
    case "track":
      return show ? `${show} · ${item.title}` : item.title || "Unknown";
    case "album":
      return item.parent_title ? `${item.parent_title} · ${item.title}` : item.title || "Unknown";
    default:
      return item.title || "Unknown";
  }
}

/** How long ago, as far back as a glance needs. */
function ago(epochSeconds: number, nowMs: number): string | undefined {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return undefined;
  const minutes = Math.floor((nowMs / 1000 - epochSeconds) / 60);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const date = new Date(epochSeconds * 1000);
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

export async function run(ctx: WidgetContext): Promise<WidgetQueryResult> {
  const settings = await readSettings(ctx);
  const apiKey = settings.get("api_key");
  if (!apiKey) return { needsSetup: true, reason: "Tautulli is still starting up" };
  if (!settings.get("pms_identifier")) {
    return { needsSetup: true, reason: "Run Connect to Tautulli to see your Plex stats here" };
  }

  const base = `http://${ctx.host}:${ctx.port ?? 30047}`;
  const api = async <T>(cmd: string, params: string): Promise<T> => {
    const response = await fetch(`${base}/api/v2?apikey=${apiKey}&cmd=${cmd}${params}`);
    if (!response.ok) throw new Error(`Tautulli ${cmd} failed (${response.status})`);
    const body = (await response.json()) as { response?: { result?: string; message?: string; data?: T } };
    if (body.response?.result !== "success") {
      throw new Error(`Tautulli ${cmd} failed: ${body.response?.message ?? "no reason given"}`);
    }
    return body.response.data as T;
  };

  // One query: the three slides' sources at once.
  const [recent, topUsers, byDay] = await Promise.all([
    api<{ recently_added?: RecentItem[] }>("get_recently_added", "&count=3"),
    api<{ rows?: TopUser[] }>("get_home_stats", `&stat_id=top_users&stats_type=plays&stats_count=3&time_range=${STATS_DAYS}`),
    api<PlaysByDay>("get_plays_by_dayofweek", `&y_axis=plays&time_range=${STATS_DAYS}`),
  ]);
  const now = Date.now();

  const added = (recent.recently_added ?? []).slice(0, 3).map(
    (item): WidgetListEntry => ({ title: itemTitle(item), meta: ago(Number(item.added_at), now) }),
  );

  const users = (topUsers.rows ?? []).slice(0, 3).map((user): WidgetListEntry => {
    const plays = user.total_plays ?? 0;
    return { title: user.friendly_name || user.user || "Unknown", meta: `${plays} play${plays === 1 ? "" : "s"}` };
  });

  // Tautulli counts each kind of media apart (TV, Movies, Music, Live TV); a day's bar is all of them.
  const days = (byDay.categories ?? []).slice(0, 7).map((day, i) => ({
    label: day.slice(0, 3),
    value: (byDay.series ?? []).reduce((sum, series) => sum + (Number(series.data?.[i]) || 0), 0),
  }));

  return {
    fields: {
      added: { type: "list", entries: added },
      users: { type: "list", entries: users },
      // A week with no plays says nothing, so the chart's slide is passed over.
      ...(days.length >= 2 && days.some((day) => day.value > 0)
        ? { days: { type: "chart" as const, points: days, unit: "plays", axis: "time" as const } }
        : {}),
    },
  };
}
