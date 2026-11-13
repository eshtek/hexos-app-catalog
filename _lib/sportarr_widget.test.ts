import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import type { WidgetContext } from "./widget_context";
import {
  liveEntry,
  localStart,
  queueEntries,
  quietEntry,
  relativeStart,
  run,
  upNextEntries,
  weekChart,
  type QueueItem,
  type SportarrEvent,
} from "../sportarr/widget_up_next";

// What Sportarr 4.1.11.1121 returned on 2026-11-02 for the owner's server: /api/calendar for the
// next seven days and the first event after them, four /api/queue items (one per status it held)
// and /api/stats. Only the fields the card reads are kept.
const event = (id: number, eventDate: string, sport: string, leagueName: string, title: string, broadcast: string | null, venue: string) => ({
  id,
  title,
  sport,
  leagueName,
  leagueLogoUrl: `https://sportarr.net/static/images/league/${leagueName === "UFC" ? "ufc" : "f1"}/badge.png`,
  homeTeamName: null,
  awayTeamName: null,
  round: null,
  eventDate,
  broadcast,
  venue,
  monitored: true,
  hasFile: false,
  thumbUrl: leagueName === "UFC" ? null : `https://sportarr.net/static/images/event/${id}/thumbnail.jpg?v=g1`,
  homeScore: null,
  awayScore: null,
  status: "scheduled",
});
const DAZN = "DAZN Spain / DAZN F1 Spain";
const DAZN_PLUS = "DAZN Spain / DAZN F1 Spain / Tipik / Canal+ Sport";
const WEEK: SportarrEvent[] = [
  event(536303, "2026-11-06T15:30:00Z", "Motorsport", "Formula 1", "São Paulo Grand Prix - Practice 1", DAZN, "Interlagos Circuit"),
  event(486572, "2026-11-06T19:00:00Z", "Motorsport", "Formula 1", "São Paulo Grand Prix - Practice 2", DAZN, "Interlagos Circuit"),
  event(672086, "2026-11-07T00:00:00Z", "Combat", "UFC", "UFC Fight Night 293 Bonfim vs Brady", null, "UFC APEX"),
  event(486573, "2026-11-07T14:30:00Z", "Motorsport", "Formula 1", "São Paulo Grand Prix - Practice 3", DAZN, "Interlagos Circuit"),
  event(486574, "2026-11-07T18:00:00Z", "Motorsport", "Formula 1", "São Paulo Grand Prix - Qualifying", DAZN_PLUS, "Interlagos Circuit"),
  event(486575, "2026-11-08T17:00:00Z", "Motorsport", "Formula 1", "São Paulo Grand Prix - Race", DAZN_PLUS, "Interlagos Circuit"),
];
const NEXT_AFTER_WEEK = event(672087, "2026-11-14T22:00:00Z", "Combat", "UFC", "UFC 334 Gane vs Hokit", null, "Madison Square Garden");
// The race as Sportarr reports it once it starts (made from the race above)
const LIVE_RACE: SportarrEvent = { ...WEEK[5], status: "in_progress" };
const QUEUE: QueueItem[] = [
  { id: 2262, eventId: 1, title: "UFC 333: Volkanovski vs  Evloev 2026 1080p WEB DL AAC 2 0 H", status: 0, progress: 0, event: { id: 1, title: "UFC 333 Volkanovski vs Evloev" } },
  { id: 2195, eventId: 2, title: "NZ.Rally.Championship.2026.S01E04.Round.4.Hawkes.Bay.Rally.1", status: 9, progress: 99, event: { id: 2, title: "Dana Whites Contender Series season 10 Week 4" } },
  { id: 2014, eventId: 3, title: "UFC Fight Night 281 Prelims WEB DL H264 Fight BB 1080pEN60fp", status: 5, progress: 0, event: { id: 3, title: "UFC Fight Night 281 Du Plessis vs Usman" } },
  { id: 2002, eventId: 4, title: "Formula1 2026 Round07 Spain Barcelona FP3 F1TV WEB DL 2160p", status: 4, progress: 0, event: { id: 4, title: "Barcelona-Catalunya Grand Prix - Practice 3" } },
  // Not from the capture: a grab still downloading, and one Sportarr holds with no event
  { id: 9001, eventId: 5, title: "WRC 2026 Rally Japan Day 1 1080p", status: 1, progress: 42.6, event: { id: 5, title: "Rally Japan - Day 1" } },
  { id: 9002, eventId: 0, title: "Some.Release.With.No.Event.Matched.At.All.And.A.Very.Long.Name.2026.1080p.WEB.H264", status: 1, progress: 7, event: null },
];
const STATS = { wanted: 2331, queued: 30, leagues: 3, events: 2634, monitored: 2634, downloaded: 230, files: 296 };

const NY = "America/New_York";
const MONDAY_EVENING = new Date("2026-11-02T20:00:00Z");

describe("times", () => {
  test("a start shows as the local weekday and time", () => {
    expect(localStart(new Date("2026-11-06T15:30:00Z"), NY)).toBe("Fri 10:30");
  });
  test("a start more than a week out shows its date", () => {
    expect(localStart(new Date("2026-11-14T22:00:00Z"), NY, MONDAY_EVENING)).toBe("Sat 14 Nov");
  });
  test("how long until a start counts minutes, hours, then calendar days", () => {
    const at = (iso: string) => relativeStart(new Date(iso), MONDAY_EVENING, NY);
    expect(at("2026-11-02T20:20:00Z")).toBe("in 20 min");
    expect(at("2026-11-03T01:00:00Z")).toBe("in 5 h");
    expect(at("2026-11-03T20:00:00Z")).toBe("tomorrow");
    expect(at("2026-11-06T15:30:00Z")).toBe("in 4 days");
  });
});

describe("up next", () => {
  test("the next event splits into its name and session, with league, broadcast and start", () => {
    const [first, second] = upNextEntries(WEEK, MONDAY_EVENING, NY);
    expect(first.title).toBe("São Paulo Grand Prix");
    expect(first.subtitle).toBe("Practice 1");
    expect(first.subtitles).toEqual(["Practice 1", "Formula 1 · DAZN Spain / DAZN F1 Spain", "Up next · in 4 days"]);
    expect(first.meta).toBe("Fri 10:30");
    expect(second.subtitles?.[2]).toBe("in 4 days");
  });
  test("an event with no session keeps its whole title and shows its venue when there's no broadcast", () => {
    const ufc = upNextEntries(WEEK, MONDAY_EVENING, NY)[2];
    expect(ufc.title).toBe("UFC Fight Night 293 Bonfim vs Brady");
    expect(ufc.subtitles?.[0]).toBe("UFC · UFC APEX");
    expect(ufc.meta).toBe("Fri 19:00");
  });
  test("a team event reads as home against away", () => {
    const game = { ...WEEK[0], title: "Arsenal vs Liverpool", homeTeamName: "Arsenal", awayTeamName: "Liverpool", sport: "Soccer", leagueName: "Premier League", round: "11" };
    expect(upNextEntries([game], MONDAY_EVENING, NY)[0].title).toBe("Arsenal vs Liverpool");
  });
  test("lines stay within 80 characters", () => {
    const long = { ...WEEK[0], broadcast: "A Very Long Broadcaster List / ".repeat(6) };
    for (const line of upNextEntries([long], MONDAY_EVENING, NY)[0].subtitles ?? []) expect(line.length).toBeLessThanOrEqual(80);
  });
  test("only monitored events still to start are listed, soonest first, six at most as HexOS steps through", () => {
    const shuffled = [WEEK[3], { ...WEEK[1], monitored: false }, WEEK[0], ...WEEK, ...WEEK];
    const entries = upNextEntries(shuffled, MONDAY_EVENING, NY);
    expect(entries.length).toBe(6);
    expect(entries[0].subtitle).toBe("Practice 1");
    expect(upNextEntries(WEEK, new Date("2026-11-08T18:00:00Z"), NY).length).toBe(0);
  });
  test("a postponed or cancelled event is left out", () => {
    const entries = upNextEntries([{ ...WEEK[0], status: "postponed" }, { ...WEEK[1], status: "cancelled" }, WEEK[2]], MONDAY_EVENING, NY);
    expect(entries.map((e) => e.title)).toEqual(["UFC Fight Night 293 Bonfim vs Brady"]);
  });
  test("statuses read as Sportarr's own pages read them, and an unknown one counts as scheduled", () => {
    const over = ["FT", "Match Finished", "PST", "ABANDONED", "canceled"].map((status, i) => ({ ...WEEK[i], status }));
    const kept = [{ ...WEEK[5], status: "NS" }, { ...WEEK[4], status: "" }, { ...WEEK[3], status: 7 as unknown as string }];
    expect(upNextEntries([...over, ...kept], MONDAY_EVENING, NY).map((e) => e.subtitle)).toEqual(["Practice 3", "Qualifying", "Race"]);
  });
});

describe("live", () => {
  test("a race in progress shows a running clock against its sport's usual length", () => {
    const entry = liveEntry(LIVE_RACE, new Date("2026-11-08T17:47:00Z"));
    expect(entry?.title).toBe("São Paulo Grand Prix");
    // HexOS starts the lines over each time the main view returns, so the live line goes first
    expect(entry?.subtitles?.[0]).toBe("Live now");
    expect(entry?.subtitle).toBe("Live now");
    expect(entry?.elapsed).toEqual({ ms: 2_820_000, ofMs: 7_200_000, state: "running" });
    expect(entry?.meta).toBe("0:47 / 2:00");
  });
  test("a scheduled event counts as live from its start until its usual length has passed", () => {
    expect(liveEntry(WEEK[5], new Date("2026-11-08T18:00:00Z"))?.elapsed?.ms).toBe(3_600_000);
    expect(liveEntry(WEEK[5], new Date("2026-11-08T20:00:00Z"))).toBeNull();
  });
  test("an event that isn't live gives nothing", () => {
    expect(liveEntry(WEEK[5], MONDAY_EVENING)).toBeNull();
    expect(liveEntry({ ...WEEK[5], status: "finished" }, new Date("2026-11-08T17:30:00Z"))).toBeNull();
  });
  test("a status stuck at in_progress stops counting as live after twice the usual length", () => {
    expect(liveEntry(LIVE_RACE, new Date("2026-11-08T20:59:00Z"))).not.toBeNull();
    expect(liveEntry(LIVE_RACE, new Date("2026-11-08T21:00:00Z"))).toBeNull();
  });
  test("a live team event shows its score", () => {
    const game = { ...LIVE_RACE, sport: "Soccer", homeTeamName: "Arsenal", awayTeamName: "Liverpool", homeScore: "2", awayScore: "1" };
    const entry = liveEntry(game, new Date("2026-11-08T17:30:00Z"));
    // HexOS writes its own clock over meta while elapsed runs, so the score goes in the status line
    expect(entry?.subtitles?.[0]).toBe("Live now · 2 - 1");
    expect(entry?.meta).toBe("0:30 / 2:00");
  });
  test("a suspended or half-time game still counts as live, as Sportarr's pages show it", () => {
    const at = new Date("2026-11-08T17:30:00Z");
    expect(liveEntry({ ...WEEK[5], status: "SUSPENDED" }, at)?.subtitles?.[0]).toBe("Live now");
    expect(liveEntry({ ...WEEK[5], status: "HT" }, at)).not.toBeNull();
  });
  test("an event Sportarr already has the file for is not live", () => {
    expect(liveEntry({ ...WEEK[5], hasFile: true }, new Date("2026-11-08T18:00:00Z"))).toBeNull();
  });
  test("an in-play status ahead of the start time shows as live from 0:00, not as upcoming", () => {
    const early = new Date("2026-11-08T16:50:00Z");
    expect(liveEntry(LIVE_RACE, early)?.elapsed).toEqual({ ms: 0, ofMs: 7_200_000, state: "running" });
    expect(upNextEntries([LIVE_RACE], early, NY)).toEqual([]);
  });
});

describe("downloading", () => {
  test("items are named by their event and labelled by status, with progress only while downloading", () => {
    const entries = queueEntries(QUEUE);
    expect(entries.map((e) => e.meta)).toEqual(["43%", "7%", "Queued", "Warning", "Not an upgrade", "Failed"]);
    expect(entries[0]).toMatchObject({ title: "Rally Japan - Day 1", progress: 42.6 });
    expect(entries.find((e) => e.meta === "Queued")?.progress).toBeUndefined();
    expect(entries.find((e) => e.meta === "Not an upgrade")?.title).toBe("Dana Whites Contender Series season 10 Week 4");
  });
  test("an item with no event is named by its release, cut to 80 characters", () => {
    const orphan = queueEntries(QUEUE).find((e) => e.meta === "7%");
    expect(orphan?.title.startsWith("Some.Release.With.No.Event")).toBe(true);
    expect(orphan?.title.length).toBeLessThanOrEqual(80);
  });
  test("an imported item is left out, and a progress outside 0 to 100 is dropped", () => {
    const entries = queueEntries([{ ...QUEUE[0], status: 7 }, { ...QUEUE[4], progress: 140 }]);
    expect(entries.length).toBe(1);
    expect(entries[0].progress).toBeUndefined();
  });
  test("a paused item keeps its figure beside the word", () => {
    expect(queueEntries([{ ...QUEUE[4], status: 2 }])[0]).toMatchObject({ meta: "Paused · 43%", progress: 42.6 });
  });
  test("a malformed item is skipped instead of failing the list", () => {
    const entries = queueEntries([null as unknown as QueueItem, { ...QUEUE[0], status: "x" as unknown as number }, QUEUE[0]]);
    expect(entries.length).toBe(1);
  });
});

describe("this week", () => {
  test("events per day in the server's time zone", () => {
    expect(weekChart(WEEK, MONDAY_EVENING, NY)).toEqual({
      type: "chart",
      axis: "time",
      unit: "events",
      points: [
        { label: "Fri", value: 3 },
        { label: "Sat", value: 2 },
        { label: "Sun", value: 1 },
      ],
    });
  });
  test("a single day gets the next day beside it, and no events gives no chart", () => {
    const one = weekChart([WEEK[0]], MONDAY_EVENING, NY);
    expect(one && "points" in one ? one.points : []).toEqual([
      { label: "Fri", value: 1 },
      { label: "Sat", value: 0 },
    ]);
    expect(weekChart([], MONDAY_EVENING, NY)).toBeUndefined();
  });
  test("the week is today and the six days after it, so no weekday shows twice", () => {
    const nextMonday = { ...WEEK[0], id: 1, eventDate: "2026-11-09T15:00:00Z" };
    const chart = weekChart([...WEEK, nextMonday], MONDAY_EVENING, NY);
    expect(chart && "points" in chart ? chart.points.map((p) => p.label) : []).toEqual(["Fri", "Sat", "Sun"]);
  });
});

describe("nothing this week", () => {
  test("says so and names the next event", () => {
    const entry = quietEntry(NEXT_AFTER_WEEK, NY, MONDAY_EVENING);
    expect(entry.title).toBe("Nothing monitored in the next 7 days");
    expect(entry.subtitle).toBe("Next: UFC 334 Gane vs Hokit · Sat 14 Nov");
    expect(quietEntry(undefined, NY, MONDAY_EVENING).subtitle).toBeUndefined();
  });
});

describe("run", () => {
  const configDir = () => {
    const dir = mkdtempSync(`${tmpdir()}/sportarr-widget-`);
    dirs.push(dir);
    writeFileSync(`${dir}/config.xml`, "<Config>\n  <ApiKey>test-key</ApiKey>\n</Config>\n");
    return dir;
  };
  const dirs: string[] = [];
  const context = (dir: string | null, imageLimit?: number): WidgetContext => ({
    appId: "sportarr",
    host: "10.0.0.49",
    port: 1867,
    mounts: dir ? [{ hostPath: "/mnt/pool/Applications/sportarr/config", containerPath: null, localPath: dir }] : [],
    imageLimit,
    log: () => {},
  });
  const bytes = (n: number, fill = 7) => new Uint8Array(new ArrayBuffer(n)).fill(fill);
  const answer = (body: unknown, type = "application/json") =>
    new Response(body instanceof Uint8Array ? new Blob([body as Uint8Array<ArrayBuffer>]) : JSON.stringify(body), { headers: { "Content-Type": type } });
  // Each test gives its events their own image addresses, since the card keeps artwork between runs
  const tagged = (events: SportarrEvent[], tag: string) =>
    events.map((e) => ({
      ...e,
      leagueLogoUrl: e.leagueLogoUrl?.replace("badge.png", `badge-${tag}.png`),
      thumbUrl: e.thumbUrl?.replace("thumbnail.jpg", `thumbnail-${tag}.jpg`),
    }));
  interface Fake {
    badgeBytes?: number;
    week?: SportarrEvent[];
    later?: SportarrEvent[];
    calendar?: () => Response;
    queue?: () => Response;
    stats?: () => Response;
    badge?: () => Promise<Response>;
    docker?: () => Promise<Response>;
  }
  const fetched: string[] = [];
  // A Sportarr and an image host as the card meets them: the 600 px variant not made yet, a
  // thumbnail over 60,000 characters as a data URI, and a small league badge, different per league
  const fake = (f: Fake = {}) => (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    fetched.push(url);
    if (url.startsWith("http://docker/")) return f.docker ? f.docker() : Promise.reject(new Error("no socket"));
    if (url.includes("/api/calendar")) {
      if (f.calendar) return Promise.resolve(f.calendar());
      if (url.includes("start=2026-11-09")) return Promise.resolve(answer(f.later ?? [NEXT_AFTER_WEEK]));
      // Sportarr answers only events that start at or after `start` (SearchAndCalendarEndpoints.cs:387 at 4.1.11)
      const start = Date.parse(new URL(url).searchParams.get("start") ?? "");
      return Promise.resolve(answer((f.week ?? WEEK).filter((e) => Date.parse(e.eventDate) >= start)));
    }
    if (url.includes("/api/queue")) return Promise.resolve(f.queue ? f.queue() : answer(QUEUE));
    if (url.includes("/api/stats")) return Promise.resolve(f.stats ? f.stats() : answer(STATS));
    if (url.includes("_medium.webp")) return Promise.resolve(new Response("not found", { status: 404 }));
    if (url.includes("thumbnail")) return Promise.resolve(answer(bytes(100_000), "image/jpeg"));
    if (url.includes("badge")) return f.badge ? f.badge() : Promise.resolve(answer(bytes(f.badgeBytes ?? 9_000, url.includes("/ufc/") ? 9 : 7), "text/plain"));
    return Promise.resolve(new Response("", { status: 404 }));
  };
  /** A wait that ends after `ms`, or fails when the request's signal aborts first. */
  const wait = (ms: number, init?: RequestInit) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    });
  /** A tar holding one file, as Docker's archive endpoint sends it. */
  const tar = (name: string, text: string) => {
    const body = new TextEncoder().encode(text);
    const out = new Uint8Array(new ArrayBuffer(512 + Math.ceil(body.length / 512) * 512 + 1024));
    out.set(new TextEncoder().encode(name), 0);
    out.set(new TextEncoder().encode(body.length.toString(8).padStart(11, "0")), 124);
    out[156] = 48;
    out.set(body, 512);
    return out;
  };
  const entriesOf = (result: Awaited<ReturnType<typeof run>>, field = "events") => {
    const value = result.fields?.[field];
    return value && "entries" in value ? value.entries : [];
  };
  let spy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => {
    spy?.mockRestore();
    fetched.length = 0;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("the league's badge is the picture, typed by its file", async () => {
    spy = spyOn(globalThis, "fetch").mockImplementation(fake() as typeof fetch);
    const result = await run(context(configDir()), MONDAY_EVENING);
    const fields = result.fields ?? {};
    const events = fields.events;
    expect(events?.type).toBe("list");
    const first = events && "entries" in events ? events.entries[0] : undefined;
    expect(first?.title).toBe("São Paulo Grand Prix");
    expect(first?.image?.startsWith("data:image/png;base64,")).toBe(true);
    expect(Object.keys(fields).sort()).toEqual(["downloaded", "events", "queue", "queued", "wanted", "week"]);
    expect(fields.wanted).toEqual({ type: "stat", label: "Wanted", value: "2,331" });
    expect(fields.queued).toEqual({ type: "stat", label: "In queue", value: "30" });
  });
  test("a badge over the limit leaves the card with no picture, and the rest still comes", async () => {
    spy = spyOn(globalThis, "fetch").mockImplementation(fake({ badgeBytes: 70_000, week: tagged(WEEK, "big") }) as typeof fetch);
    const result = await run(context(configDir(), 50_000), MONDAY_EVENING);
    const first = entriesOf(result)[0];
    expect(first?.title).toBe("São Paulo Grand Prix");
    expect(first?.image).toBeUndefined();
  });
  test("with no settings to read, the card asks for setup", async () => {
    spy = spyOn(globalThis, "fetch").mockImplementation(fake() as typeof fetch);
    const result = await run(context(null), MONDAY_EVENING);
    expect(result.needsSetup).toBe(true);
    expect(result.reason).toBeTruthy();
  });
  test("with no mount, the key comes out of the app's container through Docker", async () => {
    const config = tar("config.xml", "<Config>\n  <ApiKey>docker-key</ApiKey>\n</Config>\n");
    spy = spyOn(globalThis, "fetch").mockImplementation(fake({ docker: () => Promise.resolve(answer(config, "application/x-tar")) }) as typeof fetch);
    const result = await run(context(null), MONDAY_EVENING);
    expect(result.needsSetup).toBeUndefined();
    expect(entriesOf(result)[0]?.title).toBe("São Paulo Grand Prix");
  });
  test("only the first entry carries a picture, the one HexOS shows while the slides have data", async () => {
    spy = spyOn(globalThis, "fetch").mockImplementation(fake({ week: tagged(WEEK, "first") }) as typeof fetch);
    const entries = entriesOf(await run(context(configDir()), MONDAY_EVENING));
    expect(entries[0]?.image?.startsWith("data:image/png;base64,")).toBe(true);
    expect(entries.slice(1).map((e) => e.image)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(fetched.filter((url) => url.includes("f1/badge-first.png")).length).toBe(1);
  });
  test("the league's badge wins even when the event's own picture would fit", async () => {
    spy = spyOn(globalThis, "fetch").mockImplementation(fake({ week: tagged(WEEK, "wins") }) as typeof fetch);
    const first = entriesOf(await run(context(configDir(), 200_000), MONDAY_EVENING))[0];
    expect(first?.image?.startsWith("data:image/png;base64,")).toBe(true);
    expect(fetched.filter((url) => url.includes("thumbnail-wins")).length).toBe(0);
  });
  test("the event's picture stands in when the league has no badge, or its badge is missing", async () => {
    spy = spyOn(globalThis, "fetch").mockImplementation(fake({ week: tagged([{ ...WEEK[0], leagueLogoUrl: null }], "nobadge") }) as typeof fetch);
    expect(entriesOf(await run(context(configDir(), 200_000), MONDAY_EVENING))[0]?.image?.startsWith("data:image/jpeg;base64,")).toBe(true);
    spy.mockRestore();
    const badge = () => Promise.resolve(new Response("not found", { status: 404 }));
    spy = spyOn(globalThis, "fetch").mockImplementation(fake({ week: tagged(WEEK, "gone"), badge }) as typeof fetch);
    expect(entriesOf(await run(context(configDir(), 200_000), MONDAY_EVENING))[0]?.image?.startsWith("data:image/jpeg;base64,")).toBe(true);
  });
  test("a picture that failed to arrive is tried again on the next run", async () => {
    let fail = true;
    const badge = () => (fail ? Promise.reject(new Error("network down")) : Promise.resolve(answer(bytes(9_000), "image/png")));
    spy = spyOn(globalThis, "fetch").mockImplementation(fake({ week: tagged(WEEK, "retry"), badge }) as typeof fetch);
    expect(entriesOf(await run(context(configDir()), MONDAY_EVENING))[0]?.image).toBeUndefined();
    fail = false;
    expect(entriesOf(await run(context(configDir()), MONDAY_EVENING))[0]?.image).toBeTruthy();
  });
  test("an image host that never answers costs one fetch timeout, not one per picture", async () => {
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const base = fake({ week: tagged(WEEK, "hang") });
    spy = spyOn(globalThis, "fetch").mockImplementation(((input: string, init?: RequestInit) =>
      String(input).includes("/api/") ? base(input) : hang(String(input), init)) as typeof fetch);
    const started = Date.now();
    const entries = entriesOf(await run(context(configDir()), MONDAY_EVENING));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(entries[0]?.title).toBe("São Paulo Grand Prix");
    expect(entries[0]?.image).toBeUndefined();
  }, 15_000);
  test("a calendar that fails to answer fails the card instead of claiming nothing is on", async () => {
    spy = spyOn(globalThis, "fetch").mockImplementation(fake({ calendar: () => new Response("starting", { status: 503 }) }) as typeof fetch);
    await expect(run(context(configDir()), MONDAY_EVENING)).rejects.toThrow();
    spy.mockRestore();
    spy = spyOn(globalThis, "fetch").mockImplementation(fake({ calendar: () => answer({ error: "unexpected" }) }) as typeof fetch);
    await expect(run(context(configDir()), MONDAY_EVENING)).rejects.toThrow();
  });
  test("an empty week says so and names the next event", async () => {
    spy = spyOn(globalThis, "fetch").mockImplementation(fake({ week: [], later: tagged([NEXT_AFTER_WEEK], "quiet") }) as typeof fetch);
    const first = entriesOf(await run(context(configDir()), MONDAY_EVENING))[0];
    expect(first?.title).toBe("Nothing monitored in the next 7 days");
    expect(first?.subtitle?.startsWith("Next: UFC 334 Gane vs Hokit")).toBe(true);
    expect(first?.image).toBeTruthy();
  });
  test("with nothing on this week and nothing downloading, the card sends no fields and stays plain", async () => {
    const idle = { week: [], queue: () => answer([]), stats: () => answer({ queued: 0, downloaded: 0, wanted: 0 }) };
    spy = spyOn(globalThis, "fetch").mockImplementation(fake(idle) as typeof fetch);
    expect(await run(context(configDir()), MONDAY_EVENING)).toEqual({ fields: {} });
    // A library with files in it and an event past the week don't open the card either
    spy.mockRestore();
    fetched.length = 0;
    spy = spyOn(globalThis, "fetch").mockImplementation(
      fake({ ...idle, later: tagged([NEXT_AFTER_WEEK], "idle"), stats: () => answer({ queued: 0, downloaded: 40, wanted: 3 }) }) as typeof fetch,
    );
    expect(await run(context(configDir()), MONDAY_EVENING)).toEqual({ fields: {} });
    expect(fetched.filter((url) => url.includes("/api/calendar")).length).toBe(1);
  });
  test("a download with nothing on this week still opens the card", async () => {
    spy = spyOn(globalThis, "fetch").mockImplementation(
      fake({ week: [], later: [], stats: () => answer({ queued: 0 }) }) as typeof fetch,
    );
    const result = await run(context(configDir()), MONDAY_EVENING);
    expect(entriesOf(result)[0]?.title).toBe("Nothing monitored in the next 7 days");
    expect(entriesOf(result, "queue").length).toBeGreaterThan(0);
    // The stats alone say something is queued when the queue call fails
    spy.mockRestore();
    spy = spyOn(globalThis, "fetch").mockImplementation(
      fake({ week: [], later: [], queue: () => new Response("", { status: 500 }), stats: () => answer({ queued: 2 }) }) as typeof fetch,
    );
    expect((await run(context(configDir()), MONDAY_EVENING)).fields?.queued).toEqual({ type: "stat", label: "In queue", value: "2" });
  });
  test("an event this week opens the card with nothing downloading", async () => {
    spy = spyOn(globalThis, "fetch").mockImplementation(
      fake({ week: tagged(WEEK, "busy"), queue: () => answer([]), stats: () => answer({ queued: 0 }) }) as typeof fetch,
    );
    expect(entriesOf(await run(context(configDir()), MONDAY_EVENING)).length).toBeGreaterThan(0);
  });
  test("every running event shows first, soonest start first, and the list stays at six", async () => {
    const at = new Date("2026-11-08T17:30:00Z");
    const ufc = WEEK[2].leagueLogoUrl;
    const matchA = { ...WEEK[5], id: 11, title: "Match A", status: "in_progress", eventDate: "2026-11-08T17:15:00Z", leagueLogoUrl: ufc };
    const matchB = { ...WEEK[5], id: 12, title: "Match B", status: "in_progress", eventDate: "2026-11-08T17:00:00Z", leagueLogoUrl: ufc };
    const later = Array.from({ length: 10 }, (_, i) => ({ ...WEEK[0], id: 100 + i, eventDate: `2026-11-0${9}T1${i}:00:00Z` }));
    spy = spyOn(globalThis, "fetch").mockImplementation(fake({ week: tagged([matchA, matchB, ...later], "live") }) as typeof fetch);
    const entries = entriesOf(await run(context(configDir()), at));
    expect(entries.slice(0, 2).map((e) => e.title)).toEqual(["Match B", "Match A"]);
    expect(entries.length).toBe(6);
    expect(entries[0]?.image).toBe(`data:image/png;base64,${Buffer.from(bytes(9_000, 9)).toString("base64")}`);
  });
  test("the queue count comes from the stats even when the queue call fails", async () => {
    spy = spyOn(globalThis, "fetch").mockImplementation(
      fake({ queue: () => new Response("", { status: 500 }), stats: () => answer({ queued: 30, wanted: 5 }) }) as typeof fetch,
    );
    const fields = (await run(context(configDir()), MONDAY_EVENING)).fields ?? {};
    expect(fields.queued).toEqual({ type: "stat", label: "In queue", value: "30" });
    expect(fields.queue).toBeUndefined();
    expect(fields.downloaded).toBeUndefined();
    expect(fields.wanted).toEqual({ type: "stat", label: "Wanted", value: "5" });
  });
  test("a paged queue answer is read too, and malformed events are skipped", async () => {
    const broken = { ...WEEK[1], title: null as unknown as string };
    spy = spyOn(globalThis, "fetch").mockImplementation(
      fake({ week: tagged([broken, ...WEEK], "paged"), queue: () => answer({ records: QUEUE }) }) as typeof fetch,
    );
    const result = await run(context(configDir()), MONDAY_EVENING);
    expect(entriesOf(result, "queue").length).toBe(3);
    expect(entriesOf(result)[0]?.title).toBe("São Paulo Grand Prix");
  });
  test("the first entry carries its own league's badge", async () => {
    spy = spyOn(globalThis, "fetch").mockImplementation(fake({ week: tagged([WEEK[2], WEEK[3]], "own") }) as typeof fetch);
    const images = entriesOf(await run(context(configDir()), MONDAY_EVENING)).map((e) => e.image);
    const badge = (fill: number) => `data:image/png;base64,${Buffer.from(bytes(9_000, fill)).toString("base64")}`;
    expect(images).toEqual([badge(9), undefined]);
  });
  test("a picture whose size says it won't fit is dropped unread, and not asked for again", async () => {
    const base = fake({ week: tagged([{ ...WEEK[0], leagueLogoUrl: null }], "length") });
    spy = spyOn(globalThis, "fetch").mockImplementation(((input: string, init?: RequestInit) => {
      if (!String(input).includes("thumbnail-length.jpg")) return base(input);
      fetched.push(String(input));
      // A body that never ends: reading it takes the whole fetch timeout
      const body = new ReadableStream({ start: (c) => init?.signal?.addEventListener("abort", () => c.error(new Error("aborted"))) });
      return Promise.resolve(new Response(body, { headers: { "Content-Type": "image/jpeg", "Content-Length": "100000" } }));
    }) as typeof fetch);
    const thumbs = () => fetched.filter((url) => url.includes("thumbnail-length.jpg")).length;
    const started = Date.now();
    const first = entriesOf(await run(context(configDir()), MONDAY_EVENING))[0];
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(first?.title).toBe("São Paulo Grand Prix");
    expect(first?.image).toBeUndefined();
    await run(context(configDir()), MONDAY_EVENING);
    expect(thumbs()).toBe(1);
  });
  test("a picture the host doesn't have yet is asked for again an hour later", async () => {
    spy = spyOn(globalThis, "fetch").mockImplementation(fake({ week: tagged([{ ...WEEK[0], leagueLogoUrl: null }], "ttl") }) as typeof fetch);
    const medium = () => fetched.filter((url) => url.includes("thumbnail-ttl_medium.webp")).length;
    await run(context(configDir()), MONDAY_EVENING);
    await run(context(configDir()), new Date(MONDAY_EVENING.getTime() + 30 * 60_000));
    expect(medium()).toBe(1);
    await run(context(configDir()), new Date(MONDAY_EVENING.getTime() + 61 * 60_000));
    expect(medium()).toBe(2);
  });
  test("a long event still in play is asked for, though it started more than half a day ago", async () => {
    const day = { ...WEEK[5], id: 21, title: "Australia vs England - Day 1", sport: "Cricket", status: "in_progress", eventDate: "2026-11-08T04:00:00Z" };
    spy = spyOn(globalThis, "fetch").mockImplementation(fake({ week: tagged([day], "cricket") }) as typeof fetch);
    const first = entriesOf(await run(context(configDir()), new Date("2026-11-08T17:30:00Z")))[0];
    expect(first?.title).toBe("Australia vs England");
    expect(first?.subtitles?.[0]).toBe("Live now");
  });
  test("a slow Sportarr and image host still finish inside the widget's 10 s", async () => {
    const config = tar("config.xml", "<Config>\n  <ApiKey>docker-key</ApiKey>\n</Config>\n");
    const base = fake({ week: [], later: tagged([NEXT_AFTER_WEEK], "slow") });
    // Each answer comes just inside its own timeout, so only the run's limit can stop the run in time
    spy = spyOn(globalThis, "fetch").mockImplementation(((input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://docker/")) return wait(1_900, init).then(() => answer(config, "application/x-tar"));
      if (url.includes("/api/")) return wait(2_900, init).then(() => base(input));
      return wait(60_000, init).then(() => answer(bytes(9_000), "image/png"));
    }) as typeof fetch);
    const started = Date.now();
    const result = await run(context(null), MONDAY_EVENING);
    expect(Date.now() - started).toBeLessThan(9_500);
    expect(entriesOf(result)[0]?.title).toBe("Nothing monitored in the next 7 days");
  }, 20_000);
  test("a runtime without AbortSignal.any still fills the card", async () => {
    const any = AbortSignal.any;
    Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true, writable: true });
    try {
      spy = spyOn(globalThis, "fetch").mockImplementation(fake({ week: tagged(WEEK, "noany") }) as typeof fetch);
      expect(entriesOf(await run(context(configDir()), MONDAY_EVENING))[0]?.title).toBe("São Paulo Grand Prix");
    } finally {
      Object.defineProperty(AbortSignal, "any", { value: any, configurable: true, writable: true });
    }
  });
});
