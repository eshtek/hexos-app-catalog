// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";

import type { WidgetContext, WidgetFieldValue, WidgetListEntry, WidgetQueryResult } from "../_lib/widget_context";

/**
 * Sportarr's dashboard card. The main view shows the events that run now, each with a running
 * clock, then the next monitored events. While the slides have data, HexOS shows only the first
 * of them. One slide shows the download queue. One shows the library and how many events fall on
 * each day this week. With nothing on this week and nothing downloading, the card stays plain.
 * The picture is the league's badge. Sportarr's API key comes from its
 * settings file, through the app's mount, or through the Docker socket on a box that can't see
 * the mount, as Plex's card does. Read at Sportarr 4.1.11, the version TrueNAS pins.
 */

export interface SportarrEvent {
  id: number;
  title: string;
  sport?: string | null;
  leagueName?: string | null;
  leagueLogoUrl?: string | null;
  homeTeamName?: string | null;
  awayTeamName?: string | null;
  round?: string | null;
  eventDate: string;
  broadcast?: string | null;
  venue?: string | null;
  monitored?: boolean;
  hasFile?: boolean;
  thumbUrl?: string | null;
  homeScore?: string | number | null;
  awayScore?: string | number | null;
  status?: string | null;
}

export interface QueueItem {
  id: number;
  eventId?: number;
  title?: string | null;
  status: number;
  progress?: number | null;
  event?: { id?: number; title?: string | null } | null;
}

interface Stats {
  wanted?: number;
  queued?: number;
  downloaded?: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** Longest line the card takes under an entry. */
const LINE_MAX = 80;
/** Most entries the main view steps through. HexOS steps through six at most. */
const ENTRIES_MAX = 6;
/** Longest wait for one answer. */
const FETCH_TIMEOUT_MS = 3000;
/** The run stops waiting at this time, before the widget's 10 s timeout. */
const RUN_BUDGET_MS = 8500;
const DOCKER_SOCKET = "/var/run/docker.sock";
const DOCKER_TIMEOUT_MS = 2000;
/** The limit on a widget's data URI on a box too old to send its own. One over it fails the whole result. */
const OLD_IMAGE_LIMIT = 60_000;

export const DEFAULT_DURATION = 2 * HOUR;
/** How long an event of each sport usually runs. Sportarr keeps no end time, so the live clock measures against this. */
export const DURATIONS: Record<string, number> = {
  Motorsport: 2 * HOUR,
  Combat: 5 * HOUR,
  Soccer: 2 * HOUR,
  "American Football": 3.5 * HOUR,
  Basketball: 2.5 * HOUR,
  "Ice Hockey": 2.5 * HOUR,
  Baseball: 3 * HOUR,
  Rugby: 2 * HOUR,
  Tennis: 3 * HOUR,
  Golf: 6 * HOUR,
  Cycling: 5 * HOUR,
  Cricket: 8 * HOUR,
};
/** An in-play status that outlives this many usual lengths is stuck, not live. */
const STUCK_FACTOR = 2;
/** How far back the card asks for events: as far back as one can still be live. */
const LOOK_BACK_MS = STUCK_FACTOR * Math.max(...Object.values(DURATIONS));

/** Statuses as Sportarr's own pages read them (frontend/src/utils/eventStatus.ts at 4.1.11). */
const OVER = new Set(["CANCELLED", "CANCELED", "CANC", "ABANDONED", "POSTPONED", "PST", "COMPLETED", "FINISHED", "FT", "AET", "AOT", "AP", "MATCH FINISHED"]);
const IN_PLAY = new Set(["LIVE", "IN_PROGRESS", "IN PROGRESS", "PLAYING", "1H", "2H", "HT", "ET", "SUSPENDED", "SUSP"]);

/** Download statuses in Sportarr's order (DownloadStatus at 4.1.11). */
const QUEUED = 0;
const DOWNLOADING = 1;
const PAUSED = 2;
const IMPORTED = 7;
const STATUS_LABELS: Record<number, string> = {
  0: "Queued",
  2: "Paused",
  3: "Done",
  4: "Failed",
  5: "Warning",
  6: "Importing",
  8: "Waiting to import",
  9: "Not an upgrade",
};
/** What the slide shows first: downloads in motion, then waiting ones, then ones that need a look. */
const STATUS_ORDER = [DOWNLOADING, 6, PAUSED, QUEUED, 8, 5, 9, 4, 3];

const IMAGE_TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

const cut = (text: string, max = LINE_MAX) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** An event the card can show: one element with no title or date doesn't fail the rest. */
const isEvent = (event: SportarrEvent | null | undefined): event is SportarrEvent =>
  !!event && typeof event.title === "string" && typeof event.eventDate === "string" && !Number.isNaN(Date.parse(event.eventDate));
/** An event with its file is over. Any status Sportarr's pages don't know, or none, counts as scheduled. */
function phaseOf(event: SportarrEvent): "over" | "in play" | "scheduled" {
  const status = typeof event.status === "string" ? event.status.trim().toUpperCase() : "";
  if (OVER.has(status) || event.hasFile) return "over";
  return IN_PLAY.has(status) ? "in play" : "scheduled";
}
const byStart = (a: SportarrEvent, b: SportarrEvent) => Date.parse(a.eventDate) - Date.parse(b.eventDate);

function parts(date: Date, tz: string, options: Intl.DateTimeFormatOptions): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...options }).formatToParts(date).map((part) => [part.type, part.value]),
  );
}

/** The local calendar day, as a count of days, so two dates compare by day. */
function localDay(date: Date, tz: string): number {
  const p = parts(date, tz, { year: "numeric", month: "2-digit", day: "2-digit" });
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / DAY;
}

/** "Fri 10:30", or "Sat 14 Nov" for a start a week or more away. */
export function localStart(date: Date, tz: string, now?: Date): string {
  if (now && date.getTime() - now.getTime() >= WEEK) {
    const p = parts(date, tz, { weekday: "short", day: "numeric", month: "short" });
    return `${p.weekday} ${p.day} ${p.month}`;
  }
  const p = parts(date, tz, { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${p.weekday} ${p.hour}:${p.minute}`;
}

/** "in 20 min" or "in 5 h" today, "tomorrow", then "in 4 days", by the local calendar. */
export function relativeStart(start: Date, now: Date, tz: string): string {
  const days = localDay(start, tz) - localDay(now, tz);
  if (days === 1) return "tomorrow";
  if (days > 1) return `in ${days} days`;
  const ms = Math.max(0, start.getTime() - now.getTime());
  if (ms < HOUR) return `in ${Math.max(1, Math.round(ms / MINUTE))} min`;
  return `in ${Math.round(ms / HOUR)} h`;
}

const clock = (ms: number) => `${Math.floor(ms / HOUR)}:${String(Math.floor((ms % HOUR) / MINUTE)).padStart(2, "0")}`;
const hasTeams = (event: SportarrEvent) => !!(event.homeTeamName && event.awayTeamName);

/** A team event reads as home against away. Other titles split at " - " into the event and its session. */
function nameAndSession(event: SportarrEvent): { name: string; session?: string } {
  if (hasTeams(event)) return { name: `${event.homeTeamName} vs ${event.awayTeamName}`, session: event.round ? `Round ${event.round}` : undefined };
  const at = event.title.indexOf(" - ");
  return at > 0 ? { name: event.title.slice(0, at), session: event.title.slice(at + 3) } : { name: event.title };
}

/** The league, then the broadcast, or the venue when Sportarr knows no broadcast. */
function placeLine(event: SportarrEvent): string | undefined {
  return [event.leagueName, event.broadcast || event.venue].filter(Boolean).join(" · ") || undefined;
}

function entryFor(event: SportarrEvent, statusLine: string, statusFirst = false): WidgetListEntry {
  const { name, session } = nameAndSession(event);
  const details = [session, placeLine(event)];
  const lines = (statusFirst ? [statusLine, ...details] : [...details, statusLine])
    .filter((line): line is string => !!line)
    .map((line) => cut(line));
  return { title: cut(name), subtitle: lines[0], subtitles: lines };
}

/** The monitored, scheduled events still to start, soonest first. */
function upcoming(events: SportarrEvent[], now: Date): SportarrEvent[] {
  return events
    .filter(isEvent)
    .filter((event) => event.monitored !== false && phaseOf(event) === "scheduled" && Date.parse(event.eventDate) > now.getTime())
    .sort(byStart);
}

export function upNextEntries(events: SportarrEvent[], now: Date, tz: string): WidgetListEntry[] {
  return upcoming(events, now)
    .slice(0, ENTRIES_MAX)
    .map((event, i) => {
      const start = new Date(event.eventDate);
      const when = relativeStart(start, now, tz);
      return { ...entryFor(event, i === 0 ? `Up next · ${when}` : when), meta: localStart(start, tz) };
    });
}

/**
 * The event as it runs, or null when it isn't running. An in-play status counts as live until it
 * outlives twice its sport's usual length. A scheduled event counts from its start until its usual
 * length has passed, since the status can lag. An event that is over is never live.
 */
export function liveEntry(event: SportarrEvent, now: Date): WidgetListEntry | null {
  const length = DURATIONS[event.sport ?? ""] ?? DEFAULT_DURATION;
  const phase = phaseOf(event);
  const since = now.getTime() - Date.parse(event.eventDate);
  // An in-play status before the start time means the start time is wrong, so the clock starts at 0
  const ms = phase === "in play" ? Math.max(0, since) : since;
  const until = phase === "in play" ? STUCK_FACTOR * length : phase === "scheduled" ? length : 0;
  if (ms < 0 || ms >= until) return null;
  const ofMs = Math.max(length, ms);
  // HexOS writes its own clock over meta while elapsed runs, so the score goes in the status line.
  // HexOS starts the lines over each time the main view returns, so that line goes first.
  const score = hasTeams(event) && event.homeScore != null && event.awayScore != null ? ` · ${event.homeScore} - ${event.awayScore}` : "";
  return {
    ...entryFor(event, `Live now${score}`, true),
    meta: `${clock(ms)} / ${clock(ofMs)}`,
    elapsed: { ms, ofMs, state: "running" },
  };
}

/** The queue as the slide shows it, named by event, labelled by status, imported items left out. */
export function queueEntries(items: QueueItem[]): WidgetListEntry[] {
  const rank = (status: number) => {
    const at = STATUS_ORDER.indexOf(status);
    return at < 0 ? STATUS_ORDER.length : at;
  };
  return items
    .filter((item): item is QueueItem => !!item && typeof item.status === "number" && item.status !== IMPORTED)
    .sort((a, b) => rank(a.status) - rank(b.status))
    .map((item) => {
      const moving = item.status === DOWNLOADING || item.status === PAUSED;
      const progress = moving && typeof item.progress === "number" && item.progress >= 0 && item.progress <= 100 ? item.progress : undefined;
      const figure = progress !== undefined ? `${Math.round(progress)}%` : undefined;
      const meta =
        item.status === DOWNLOADING
          ? (figure ?? "Downloading")
          : item.status === PAUSED && figure
            ? `Paused · ${figure}`
            : (STATUS_LABELS[item.status] ?? "Waiting");
      return { title: cut(item.event?.title || item.title || "Unknown"), meta, ...(progress !== undefined ? { progress } : {}) };
    });
}

/** How many monitored events still to start fall on today and each of the six local days after it, days with none left out. */
export function weekChart(events: SportarrEvent[], now: Date, tz: string): WidgetFieldValue | undefined {
  const today = localDay(now, tz);
  const counts = new Map<number, { label: string; value: number }>();
  for (const event of upcoming(events, now)) {
    const start = new Date(event.eventDate);
    const day = localDay(start, tz);
    if (day - today > 6) continue;
    const entry = counts.get(day) ?? { label: parts(start, tz, { weekday: "short" }).weekday, value: 0 };
    entry.value += 1;
    counts.set(day, entry);
  }
  const days = [...counts.entries()].sort(([a], [b]) => a - b);
  if (days.length === 0) return undefined;
  // A chart takes two points at least, so a lone day gets the day after it
  if (days.length === 1) {
    const next = new Date((days[0][0] + 1) * DAY + 12 * HOUR);
    days.push([days[0][0] + 1, { label: parts(next, "UTC", { weekday: "short" }).weekday, value: 0 }]);
  }
  return { type: "chart", axis: "time", unit: "events", points: days.map(([, point]) => point) };
}

/** What the main view says when nothing monitored starts in the coming week. */
export function quietEntry(next: SportarrEvent | undefined, tz: string, now: Date): WidgetListEntry {
  const line = next ? cut(`Next: ${next.title} · ${localStart(new Date(next.eventDate), tz, now)}`) : undefined;
  return { title: "Nothing monitored in the next 7 days", subtitle: line, ...(line ? { subtitles: [line] } : {}) };
}

// --- reading Sportarr ----------------------------------------------------------

/** A signal for one wait: its own timeout, cut short at `deadline`, the time in ms when the run stops waiting. */
const within = (deadline: number, ms = FETCH_TIMEOUT_MS) => AbortSignal.timeout(Math.max(1, Math.min(ms, deadline - Date.now())));

/** The file in a tar from Docker's archive endpoint: a 512-byte header, then its bytes. */
function untar(tar: Uint8Array): string {
  const text = new TextDecoder();
  for (let at = 0; tar[at]; ) {
    const size = Number.parseInt(text.decode(tar.subarray(at + 124, at + 136)), 8);
    const type = tar[at + 156];
    if (type === 0 || type === 48) return text.decode(tar.subarray(at + 512, at + 512 + size)); // a regular file
    at += 512 + Math.ceil(size / 512) * 512; // a pax header ahead of the file
  }
  return "";
}

async function readThroughDocker(appId: string, path: string, deadline: number): Promise<string> {
  const url = `http://docker/containers/ix-${appId}-${appId}-1/archive?path=${encodeURIComponent(path)}`;
  try {
    const response = await fetch(url, { unix: DOCKER_SOCKET, signal: within(deadline, DOCKER_TIMEOUT_MS) } as RequestInit);
    return response.ok ? untar(new Uint8Array(await response.arrayBuffer())) : "";
  } catch {
    return ""; // a box with no socket yet
  }
}

/** Sportarr's API key from config.xml, through the mount when HexOS can see it, else out of the app's container. */
async function apiKey(ctx: WidgetContext, deadline: number): Promise<string | undefined> {
  const mount =
    ctx.mounts.find((m) => m.containerPath === "/config") ?? ctx.mounts.find((m) => m.hostPath.replace(/\/+$/, "").endsWith("/sportarr/config"));
  let xml = "";
  if (mount) {
    try {
      xml = readFileSync(`${mount.localPath}/config.xml`, "utf-8");
    } catch {
      // Not written yet, or the dataset isn't visible from here
    }
  }
  if (!xml) xml = await readThroughDocker(ctx.appId, "/config/config.xml", deadline);
  return xml.match(/<ApiKey>([^<]+)<\/ApiKey>/)?.[1];
}

// Artwork does not change between refreshes and the card asks every 30 s, so each picture is kept by
// address and limit. A picture too large, or one the host says it doesn't have, is kept as a miss for
// an hour, since the hub makes its size variants later. One that failed to arrive is not kept, so the
// next run tries it again.
const ARTWORK_CACHE_SIZE = 32;
const MISS_TTL_MS = HOUR;
const artworkCache = new Map<string, { image: string; at: number }>();
const inFlight = new Map<string, Promise<string | undefined>>();

function remember(key: string, image: string, at: number): void {
  artworkCache.delete(key);
  artworkCache.set(key, { image, at });
  const oldest = artworkCache.keys().next().value;
  if (artworkCache.size > ARTWORK_CACHE_SIZE && oldest !== undefined) artworkCache.delete(oldest);
}

/** The sportarr.net size variant beside an image: its 600 px WebP, where the hub has made it. */
function mediumVariant(url: string): string {
  return url.split("?")[0].replace(/\.[A-Za-z0-9]+$/, "_medium.webp");
}

/** The type from the file name: the hub serves WebP as text/plain, so its header can't be trusted. */
function imageType(url: string): string | undefined {
  return IMAGE_TYPES[url.split("?")[0].split(".").pop()?.toLowerCase() ?? ""];
}

/** One picture as a data URI within `limit`: "" when it can't be used, undefined when it didn't arrive. */
function picture(url: string, limit: number, deadline: number, now: number): Promise<string | undefined> {
  const key = `${url}|${limit}`;
  const kept = artworkCache.get(key);
  if (kept && (kept.image || now - kept.at < MISS_TTL_MS)) return Promise.resolve(kept.image);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const type = imageType(url);
  const load = (async () => {
    if (!type) return "";
    try {
      const response = await fetch(url, { signal: within(deadline) });
      if (!response.ok) {
        await response.body?.cancel();
        return response.status === 404 || response.status === 410 ? "" : undefined;
      }
      // Base64 makes 4 characters of each 3 bytes, so a size that can't fit is known before the body comes
      const size = Number(response.headers.get("content-length"));
      if (size > 0 && Math.ceil(size / 3) * 4 > limit) {
        await response.body?.cancel();
        return "";
      }
      const image = `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
      return image.length > limit ? "" : image;
    } catch {
      return undefined;
    }
  })().then((image) => {
    inFlight.delete(key);
    if (image !== undefined) remember(key, image, now);
    return image;
  });
  inFlight.set(key, load);
  return load;
}

/**
 * The picture for an event, within `limit`. It is the league's badge. When the league has no badge
 * the card can use, the event's own picture stands in. The card asks for the hub's 600 px variant
 * and the full thumbnail at once. A badge that didn't arrive gets no stand-in, so a host that doesn't
 * answer costs one timeout. The next run asks for the badge again.
 */
export async function artworkFor(
  event: SportarrEvent,
  limit: number,
  deadline: number = Date.now() + RUN_BUDGET_MS,
  now: number = Date.now(),
): Promise<string | undefined> {
  const badge = event.leagueLogoUrl ? await picture(event.leagueLogoUrl, limit, deadline, now) : "";
  if (badge !== "") return badge;
  const thumb = event.thumbUrl ?? undefined;
  const candidates = [thumb && mediumVariant(thumb), thumb].filter((url): url is string => !!url);
  const images = await Promise.all(candidates.map((url) => picture(url, limit, deadline, now)));
  return images.find((image) => !!image);
}

export async function run(ctx: WidgetContext, now: Date = new Date()): Promise<WidgetQueryResult> {
  const deadline = Date.now() + RUN_BUDGET_MS;
  const key = await apiKey(ctx, deadline);
  if (!key) return { needsSetup: true, reason: "HexOS can't read Sportarr's API key yet. The card fills in once Sportarr has started." };

  const base = `http://${ctx.host}:${ctx.port ?? 1867}/api`;
  const get = (path: string): Promise<unknown> =>
    fetch(`${base}${path}`, { headers: { "X-Api-Key": key }, signal: within(deadline) })
      .then((response) => (response.ok ? response.json() : undefined))
      .catch(() => undefined);
  const iso = (ms: number) => encodeURIComponent(new Date(ms).toISOString());
  const [calendar, queue, stats] = await Promise.all([
    get(`/calendar?start=${iso(now.getTime() - LOOK_BACK_MS)}&end=${iso(now.getTime() + WEEK)}`),
    get("/queue"),
    get("/stats") as Promise<Stats | undefined>,
  ]);
  // Without the calendar the card can't tell what's on, so it fails rather than say nothing is
  if (!Array.isArray(calendar)) throw new Error("Sportarr didn't answer with its calendar");
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const limit = ctx.imageLimit ?? OLD_IMAGE_LIMIT;
  const events = (calendar as SportarrEvent[]).filter((event) => isEvent(event) && event.monitored !== false);

  const running = events.filter((event) => liveEntry(event, now)).sort(byStart);
  let first: SportarrEvent | undefined = running[0] ?? upcoming(events, now)[0];
  let entries: WidgetListEntry[] = [
    ...running.map((event) => liveEntry(event, now) as WidgetListEntry),
    ...upNextEntries(events, now, tz),
  ].slice(0, ENTRIES_MAX);
  const queueItems = Array.isArray(queue)
    ? (queue as QueueItem[])
    : Array.isArray((queue as { records?: unknown } | undefined)?.records)
      ? ((queue as { records: QueueItem[] }).records)
      : undefined;
  const queued = typeof stats?.queued === "number" ? stats.queued : queueItems ? queueEntries(queueItems).length : undefined;
  // HexOS opens the card for any field with content, so a week with nothing on and nothing
  // downloading sends none and the card stays the plain one
  if (entries.length === 0 && !queued && !(queueItems && queueEntries(queueItems).length)) return { fields: {} };
  if (entries.length === 0) {
    const later = await get(`/calendar?start=${iso(now.getTime() + WEEK)}&end=${iso(now.getTime() + 60 * DAY)}`);
    first = upcoming(Array.isArray(later) ? (later as SportarrEvent[]) : [], now)[0];
    entries = [quietEntry(first, tz, now)];
  }
  // While the slides have data, HexOS shows only the first entry, so only that one carries a picture
  const image = first && (await artworkFor(first, limit, deadline, now.getTime()));
  if (image) entries[0] = { ...entries[0], image };

  const count = (n: number) => new Intl.NumberFormat("en-US").format(n);
  const fields: Record<string, WidgetFieldValue> = { events: { type: "list", entries } };
  if (queueItems) fields.queue = { type: "list", entries: queueEntries(queueItems).slice(0, 3) };
  if (queued !== undefined) fields.queued = { type: "stat", label: "In queue", value: count(queued) };
  if (typeof stats?.downloaded === "number") fields.downloaded = { type: "stat", label: "Downloaded", value: count(stats.downloaded) };
  if (typeof stats?.wanted === "number") fields.wanted = { type: "stat", label: "Wanted", value: count(stats.wanted) };
  const week = weekChart(events, now, tz);
  if (week) fields.week = week;
  return { fields };
}
