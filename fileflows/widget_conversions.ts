// Type imports only — each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { readFileSync, readdirSync, statSync } from "node:fs";

import type { WidgetContext, WidgetQueryResult } from "../_lib/widget_context";

// FileFlows' /api/status is unauthenticated and purpose-built for glances:
// counts plus one row per converting file (name, step, stepPercent). What it
// does NOT say is HOW the file is being converted — the chosen encoder only
// exists in the per-file runner log, which FileFlows writes live to its logs
// mount. So the widget joins the two: status API for the rows, freshest
// runner logs for "h264 → hevc · NVENC".
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
}

/**
 * Read encoder facts for active conversions from the freshest runner logs.
 * Keyed by the source file path the log names in its ffmpeg probe line.
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
        if (now - statSync(path).mtimeMs > 10 * 60_000) continue;
        // Runner logs stay small during encode (a few hundred KB at most).
        const text = readFileSync(path, "utf-8");
        const source = text.match(/Executing: \S*ffmpeg[^\n]* -i (\/[^\n]+)/)?.[1]?.trim();
        if (!source) continue;
        const entry: LogFacts = {
          sourceCodec: text.match(/Codec: (\w+)/)?.[1],
          encoder: text.match(/Encoding Parameters: (\S+)/)?.[1],
        };
        facts.set(source, entry);
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

export async function run(ctx: WidgetContext): Promise<WidgetQueryResult> {
  const base = `http://${ctx.host}:${ctx.port ?? 30200}`;

  const response = await fetch(`${base}/api/status`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`FileFlows status query failed (${response.status})`);
  const status = (await response.json()) as StatusResponse;

  const files = status.processingFiles ?? [];
  const facts = harvestLogFacts(ctx);

  return {
    fields: {
      active: {
        type: "stat",
        label: "Converting",
        value: String(status.processing ?? files.length),
      },
      queued: { type: "stat", label: "Queued", value: String(status.queue ?? 0) },
      files: {
        type: "list",
        entries: files.slice(0, 5).map((file) => {
          const fact = file.name ? facts.get(file.name) : undefined;
          const conversion =
            fact?.encoder !== undefined
              ? `${fact.sourceCodec ?? "?"} → ${encoderCodec(fact.encoder)} · ${encoderKind(fact.encoder)}`
              : file.step;
          return {
            title: basename(file.name ?? "Unknown file"),
            subtitle: conversion || undefined,
            meta: file.stepPercent !== undefined ? `${Math.round(file.stepPercent)}%` : undefined,
          };
        }),
      },
      summary: {
        type: "text",
        text:
          files.length === 0
            ? `Nothing converting · ${status.queue ?? 0} queued`
            : `${files.length} converting · ${status.queue ?? 0} queued`,
      },
    },
  };
}
