// Sibling files are type imports only: each script is compiled standalone, so runtime imports of them wouldn't resolve.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";

import type { WidgetContext, WidgetListEntry, WidgetQueryResult } from "../_lib/widget_context";

// What FileFlows is converting now, and what it finished last, from FileFlows' own database,
// read-only. The install's partner token opens the REST API too (convert_to_mp4.ts uses it), and
// reading the card from the API instead of the database is a follow-up.
//
// The database says which files are converting and when each finished; how far along one is lives
// only in its runner log, which FileFlows names after the file and adds to every few seconds.

/** LibraryFile.Status values (FileFlows.Shared.Models.FileStatus). */
const UNPROCESSED = 0;
const PROCESSED = 1;
const PROCESSING = 2;
const FAILED = 4;

const LIBRARY_TYPE = "FileFlows.Shared.Models.Library";
const SETUP_REASON = "Finish setting up FileFlows to see its conversions here";
const NO_LIBRARY_REASON = "Add a library in FileFlows to see its conversions here";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface FileRow {
  Uid: string;
  Name: string;
  Status: number;
  ProcessingEnded: string;
  FailureReason: string | null;
}

/** The card's notes are one short line; a longer reason is cut, and the full one is in FileFlows. */
const NOTE_MAX = 120;

/** A failure reason as a note: one line, cut to fit, none when FileFlows gave none. */
function noteText(reason: string | null | undefined): string | undefined {
  const line = reason?.replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  return line.length > NOTE_MAX ? `${line.slice(0, NOTE_MAX - 1).trimEnd()}…` : line;
}

/** A chart-fixed folder, matched by its container path or else by where it sits on the host. */
function mountPath(ctx: WidgetContext, containerPath: string, hostSuffix: string): string | undefined {
  const mount =
    ctx.mounts.find((m) => m.containerPath === containerPath) ?? ctx.mounts.find((m) => m.hostPath.endsWith(hostSuffix));
  return mount?.localPath;
}

/** A file's name without its folder or extension: what a person calls it. */
function fileTitle(path: string): string {
  const name = path.split("/").pop() || path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** FileFlows stores times as UTC text ("2026-10-13 19:36:10"); its "never" is 1970. */
function utcMs(text: string | null | undefined): number | undefined {
  const ms = text ? Date.parse(`${text.replace(" ", "T")}Z`) : Number.NaN;
  return Number.isFinite(ms) && ms > Date.UTC(2000, 0, 1) ? ms : undefined;
}

/** How long ago, as far back as a glance needs. */
function ago(ms: number, nowMs: number): string {
  const minutes = Math.floor((nowMs - ms) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const date = new Date(ms);
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

const seconds = (h: string, m: string, s: string): number => Number(h) * 3600 + Number(m) * 60 + Number(s);

interface Encode {
  /** 0 to 1 through the encode running now. */
  fraction?: number;
  /** Seconds left at the encode's present speed. */
  etaSeconds?: number;
  /** "h264 → hevc", once the encode node has chosen its encoder. */
  conversion?: string;
  /** An earlier encode of this file failed and this one is the flow's next try: on the CPU when `software`. */
  retry?: { software: boolean };
}

/** Where each run of FFmpeg's executor starts in a runner log. A flow that falls back runs it again. */
const EXECUTOR_START = /Executing Flow Element \d+: [^\n]*\[FileFlows\.VideoNodes\.FfmpegBuilderNodes\.FfmpegBuilderExecutor\]/g;
/** A flow element that left by its failure output. */
const ELEMENT_FAILED = /Flow Element output: -1\b/;
/** Encoders that run on a graphics card or media engine; any other runs on the CPU. */
const HARDWARE_ENCODER = /nvenc|qsv|vaapi|amf|videotoolbox|v4l2m2m|rkmpp/i;

/** Codec family from an encoder name: libx265 → hevc, h264_nvenc → h264. */
function encoderCodec(encoder: string): string {
  const lowered = encoder.toLowerCase();
  if (lowered.includes("265") || lowered.includes("hevc")) return "hevc";
  if (lowered.includes("264")) return "h264";
  if (lowered.includes("av1")) return "av1";
  if (lowered.includes("vp9")) return "vp9";
  return encoder;
}

/**
 * How far an encode has got, from the file's runner log: the media position ffmpeg's stats lines
 * have reached against the source's duration, and its speed for the time left. When the flow ran
 * the encode again after one failed (a hardware encode falling back to the CPU), only the run in
 * progress counts, so the bar starts over with it.
 */
function readEncode(logsDir: string | undefined, uid: string): Encode {
  if (!logsDir) return {};
  let text: string;
  try {
    text = readFileSync(`${logsDir}/LibraryFiles/${uid}.log`, "utf-8");
  } catch {
    return {};
  }
  const runs = [...text.matchAll(EXECUTOR_START)];
  const runStart = runs.at(-1)?.index ?? 0;
  const run = text.slice(runStart);

  // The executor prints the command it runs; an encode node without one says so itself.
  const encoder = [...run.matchAll(/-c:v(?::\d+)? (\S+)/g)].at(-1)?.[1] ?? text.match(/Encoding Parameters: (\S+)/)?.[1];
  const source = text.match(/Video: (\w+)/)?.[1];
  const conversion = encoder ? `${source ?? "?"} → ${encoderCodec(encoder)}` : undefined;
  const retry =
    runs.length > 1 && ELEMENT_FAILED.test(text.slice(0, runStart))
      ? { software: encoder !== undefined && !HARDWARE_ENCODER.test(encoder) }
      : undefined;

  const duration = text.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  const position = [...run.matchAll(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/g)].at(-1);
  if (!duration || !position) return { conversion, retry };
  const total = seconds(duration[1], duration[2], duration[3]);
  const done = seconds(position[1], position[2], position[3]);
  if (!(total > 0)) return { conversion, retry };

  const speed = Number([...run.matchAll(/speed=\s*(\d+(?:\.\d+)?)x/g)].at(-1)?.[1]);
  return {
    // Short of done until FileFlows says so: the flow still has steps after the encode.
    fraction: Math.min(Math.max(done / total, 0), 0.99),
    etaSeconds: speed > 0 ? Math.max(0, Math.round((total - done) / speed)) : undefined,
    conversion,
    retry,
  };
}

/** "~4m" / "~40s" / ">1h": a glance, not a countdown, and short, so the file's name keeps the row. */
function formatEta(secondsLeft: number): string {
  if (secondsLeft >= 3600) return ">1h";
  if (secondsLeft >= 60) return `~${Math.round(secondsLeft / 60)}m`;
  return `~${Math.max(5, Math.round(secondsLeft / 5) * 5)}s`;
}

export async function run(ctx: WidgetContext): Promise<WidgetQueryResult> {
  const dataDir = mountPath(ctx, "/app/Data", "/fileflows/data");
  const dbPath = dataDir ? `${dataDir}/Data/FileFlows.sqlite` : undefined;
  // FileFlows writes its database when its first-run page is done.
  if (!dbPath || !existsSync(dbPath)) return { needsSetup: true, reason: SETUP_REASON };
  const logsDir = mountPath(ctx, "/app/Logs", "/fileflows/logs");

  const db = new Database(dbPath, { readonly: true });
  try {
    // FileFlows writes as it goes; wait out a write rather than fail the poll.
    db.exec("PRAGMA busy_timeout = 2000");

    const active = db
      .query<FileRow, [number]>(
        "SELECT Uid, Name, Status, ProcessingEnded, FailureReason FROM LibraryFile WHERE Status = ? ORDER BY ProcessingStarted LIMIT 2",
      )
      .all(PROCESSING);
    const recent = db
      .query<FileRow, [number, number]>(
        `SELECT Uid, Name, Status, ProcessingEnded, FailureReason FROM LibraryFile
          WHERE Status IN (?, ?) AND ProcessingEnded > '2000'
          ORDER BY ProcessingEnded DESC LIMIT 3`,
      )
      .all(PROCESSED, FAILED);

    const queued =
      db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM LibraryFile WHERE Status = ?").get(UNPROCESSED)?.n ?? 0;
    // Work queued by hand (the Convert action's manual library) is work, library or no library.
    if (active.length === 0 && recent.length === 0 && queued === 0) {
      const libraries = db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM DbObject WHERE Type = ?")
        .get(LIBRARY_TYPE);
      if (!libraries?.n) return { needsSetup: true, reason: NO_LIBRARY_REASON };
    }

    const now = Date.now();
    const converting = active.map((file): WidgetListEntry => {
      const { fraction, etaSeconds, conversion, retry } = readEncode(logsDir, file.Uid);
      // Every running conversion has a bar: at 0 and "Starting…" until the encode reports its first position.
      const percent = fraction === undefined ? 0 : Math.round(fraction * 100);
      // The time left only while it means something: not in the encode's last seconds.
      const eta = etaSeconds !== undefined && etaSeconds >= 10 ? formatEta(etaSeconds) : undefined;
      return {
        title: fileTitle(file.Name),
        subtitle: conversion,
        meta: [`${percent}%`, fraction === undefined ? "Starting…" : eta].filter(Boolean).join(" · "),
        // Says why the bar started over.
        note: retry ? (retry.software ? "Retrying with CPU" : "Retrying") : undefined,
        progress: percent,
      };
    });

    const finished = recent.map((file): WidgetListEntry => {
      const when = utcMs(file.ProcessingEnded);
      const time = when === undefined ? undefined : ago(when, now);
      const failed = file.Status === FAILED;
      return {
        title: fileTitle(file.Name),
        meta: failed ? (time ? `Failed · ${time}` : "Failed") : time,
        // FileFlows' own words for why, or the flow's: a flow's Fail Flow step names its reason.
        note: failed ? noteText(file.FailureReason) : undefined,
      };
    });

    return {
      fields: {
        converting: { type: "list", entries: converting },
        finished: { type: "list", entries: finished },
        // Whenever nothing is converting, so a quiet card says why and a waiting queue is never hidden
        // behind the history slide.
        ...(converting.length === 0
          ? {
              idle: {
                type: "text" as const,
                text:
                  queued > 0
                    ? `Nothing converting · ${queued} waiting`
                    : finished.length > 0
                      ? "Nothing converting"
                      : "Nothing converting yet",
              },
            }
          : {}),
      },
    };
  } finally {
    db.close();
  }
}
