// Type imports only — each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { readFileSync, readdirSync, statSync } from "node:fs";

import type { WidgetContext, WidgetQueryResult } from "../_lib/widget_context";

// FileFlows' /api/status gives the counts and one row per converting file, but
// its stepPercent is per-STEP (resets each flow step) and the encoder only
// exists in the per-file runner log. So the widget joins the status rows with
// the freshest runner logs and derives the convert hook's own frame-based
// 5–95 progress, so the percent matches the file browser and notifications.
interface StatusFile {
  name?: string;
  library?: string;
  step?: string;
  stepPercent?: number;
}

interface StatusResponse {
  queue?: number;
  processing?: number;
  processed?: number;
  processingFiles?: StatusFile[];
}

const ENCODER_KINDS: Array<[RegExp, string]> = [
  [/nvenc/i, "NVENC"],
  [/qsv/i, "QuickSync"],
  [/vaapi/i, "VAAPI"],
  [/amf/i, "AMF"],
  [/videotoolbox/i, "VideoToolbox"],
  [/^lib|^copy$/i, "software"],
];

function encoderKind(encoder: string): string {
  for (const [pattern, kind] of ENCODER_KINDS) if (pattern.test(encoder)) return kind;
  return "software";
}

/** Codec family from an encoder name: h264_nvenc → h264, libx265 → hevc. */
function encoderCodec(encoder: string): string {
  const lowered = encoder.toLowerCase();
  if (lowered.includes("265") || lowered.includes("hevc")) return "hevc";
  if (lowered.includes("264")) return "h264";
  if (lowered.includes("av1")) return "av1";
  if (lowered.includes("vp9")) return "vp9";
  return encoder;
}

interface LogFacts {
  sourceCodec?: string;
  encoder?: string;
  /** Overall progress 0..1 from frames encoded / total frames. */
  fraction?: number;
  /** Seconds remaining, from the live encode fps and frames left. */
  etaSeconds?: number;
  /** Log freshness — a re-convert writes a new log for the same source. */
  mtimeMs: number;
}

/** Total frames in the source, from the log header (Duration + stream fps). */
function parseTotalFrames(logText: string): number | null {
  const duration = logText.match(/Duration: (\d+):(\d+):(\d+)\.(\d+)/);
  const fps = logText.match(/(\d+(?:\.\d+)?) fps/);
  if (!duration || !fps) return null;
  const seconds =
    Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) + Number(duration[4]) / 100;
  const frames = seconds * Number(fps[1]);
  return frames > 0 ? frames : null;
}

/** Latest encoded frame count from ffmpeg's periodic stats lines. */
function parseCurrentFrame(logText: string): number | null {
  const matches = logText.match(/frame=\s*(\d+)/g);
  if (!matches || matches.length === 0) return null;
  const last = matches[matches.length - 1].match(/(\d+)/);
  return last ? Number(last[1]) : null;
}

/** Live encode rate (fps= in the stats line) — the moving one, not the source fps. */
function parseEncodeFps(logText: string): number | null {
  const matches = logText.match(/fps=\s*(\d+(?:\.\d+)?)/g);
  if (!matches || matches.length === 0) return null;
  const last = matches[matches.length - 1].match(/(\d+(?:\.\d+)?)/);
  const value = last ? Number(last[1]) : 0;
  return value > 0 ? value : null;
}

/**
 * Read encoder + progress facts for active conversions from the freshest runner
 * logs. Keyed by the source file path the log names in its ffmpeg probe line.
 */
function harvestLogFacts(ctx: WidgetContext): Map<string, LogFacts> {
  const facts = new Map<string, LogFacts>();
  const logsMount = ctx.mounts.find((m) => m.hostPath.endsWith("/fileflows/logs"));
  if (!logsMount) return facts;
  const dir = `${logsMount.localPath}/LibraryFiles`;
  try {
    const now = Date.now();
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".log")) continue;
      const path = `${dir}/${file}`;
      try {
        const mtimeMs = statSync(path).mtimeMs;
        if (now - mtimeMs > 10 * 60_000) continue;
        // Runner logs stay small during encode (a few hundred KB at most).
        const text = readFileSync(path, "utf-8");
        // FileFlows quotes the -i path when it contains spaces — tolerate the
        // quote and stop the capture at it, or real media paths never match.
        const source = text.match(/Executing: \S*ffmpeg[^\n]* -i "?(\/[^"\n]+)"?/)?.[1]?.trim();
        if (!source) continue;
        // Freshest log wins per source — a finished log inside the 10-minute
        // window must not shadow a live re-convert with its stale ~100%.
        const prev = facts.get(source);
        if (prev && prev.mtimeMs >= mtimeMs) continue;
        const total = parseTotalFrames(text);
        const current = parseCurrentFrame(text);
        const fraction = total && current !== null ? Math.min(Math.max(current / total, 0), 0.999) : undefined;
        const fps = parseEncodeFps(text);
        const etaSeconds =
          total && current !== null && fps ? Math.max(0, Math.round((total - current) / fps)) : undefined;
        facts.set(source, {
          // The probed input stream is the source; the "Codec:" line is the
          // encode node's TARGET config and must not be read here.
          sourceCodec: text.match(/Video: (\w+)/)?.[1],
          encoder: text.match(/Encoding Parameters: (\S+)/)?.[1],
          fraction,
          etaSeconds,
          mtimeMs,
        });
      } catch {
        // One unreadable log never blanks the widget.
      }
    }
  } catch {
    return facts;
  }
  return facts;
}

const basename = (path: string): string => path.split("/").pop() || path;

/** Facts by the log's -i path, falling back to basename only when UNAMBIGUOUS —
 *  two shows both converting an "S01E01.mkv" must not swap progress rows. */
function factsFor(facts: Map<string, LogFacts>, name: string): LogFacts | undefined {
  const direct = facts.get(name);
  if (direct) return direct;
  const base = basename(name);
  const matches = [...facts.entries()].filter(([key]) => basename(key) === base);
  return matches.length === 1 ? matches[0][1] : undefined;
}

/** The convert hook's 5–95 band, so the same file shows the same percent. */
function bandedPercent(fraction: number): number {
  return Math.round(5 + fraction * 90);
}

/** "~4m" / "~45s" / ">1h" — a compact glance ETA, never false precision. */
function formatEta(seconds: number): string {
  if (seconds >= 3600) return ">1h";
  if (seconds >= 60) return `~${Math.round(seconds / 60)}m`;
  return `~${Math.max(5, Math.round(seconds / 5) * 5)}s`;
}

export async function run(ctx: WidgetContext): Promise<WidgetQueryResult> {
  const base = `http://${ctx.host}:${ctx.port ?? 30200}`;

  const response = await fetch(`${base}/api/status`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`FileFlows status query failed (${response.status})`);
  const status = (await response.json()) as StatusResponse;

  const files = status.processingFiles ?? [];
  const facts = harvestLogFacts(ctx);
  // Authoritative count for the stat AND the summary, so they never disagree.
  const converting = status.processing ?? files.length;
  const queued = status.queue ?? 0;

  return {
    fields: {
      active: { type: "stat", label: "Converting", value: String(converting) },
      queued: { type: "stat", label: "Queued", value: String(queued) },
      files: {
        type: "list",
        entries: files.slice(0, 5).map((file) => {
          const fact = file.name ? factsFor(facts, file.name) : undefined;
          const conversion =
            fact?.encoder !== undefined
              ? `${fact.sourceCodec ?? "?"} → ${encoderCodec(fact.encoder)} · ${encoderKind(fact.encoder)}`
              : file.step;
          // Frame-based overall percent; per-step stepPercent only when the
          // log carries no frame lines.
          const percent =
            fact?.fraction !== undefined
              ? bandedPercent(fact.fraction)
              : file.stepPercent !== undefined
                ? Math.round(file.stepPercent)
                : undefined;
          // ETA only while it's still meaningful — drop it in the final seconds.
          const eta = fact?.etaSeconds !== undefined && fact.etaSeconds >= 10 ? formatEta(fact.etaSeconds) : undefined;
          const meta = [percent !== undefined ? `${percent}%` : undefined, eta].filter(Boolean).join(" · ");
          return {
            title: basename(file.name ?? "Unknown file"),
            subtitle: conversion || undefined,
            meta: meta || undefined,
          };
        }),
      },
      summary: {
        type: "text",
        text:
          converting === 0
            ? queued > 0
              ? `Nothing converting · ${queued} queued`
              : "Nothing converting"
            : `${converting} converting · ${queued} queued`,
      },
    },
  };
}
