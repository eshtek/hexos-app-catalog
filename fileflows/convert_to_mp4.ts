// The flow is non-destructive: the converted file is copied next to the
// original as <name>.mp4 and the original is left untouched.
import type { HookContext } from "../_lib/hook_context";

const FLOW_NAME = "HexOS Convert to MP4";

// Library-file statuses (from /api/library-file/status)
const STATUS_UNPROCESSED = 0;
const STATUS_PROCESSED = 1;
const STATUS_PROCESSING = 2;
const STATUS_FAILED = 4;

const POLL_INTERVAL_MS = 15000;

interface LibraryFileRecord {
  /** uid */
  u: string;
  /** display name — the full path we enqueued */
  dn: string;
  /** status */
  s: number;
  /** original size in bytes */
  os?: number;
  /** flow uid */
  fu?: string;
}

// The blessed flow, as the FileFlows API accepts it: Video File -> FFmpeg
// Builder (H.264 encode, remux to MP4) -> copy the result next to the
// original. A zero Uid means "create"; part uids are only node ids within
// the flow graph.
function flowDefinition(): Record<string, unknown> {
  const nInput = "b6d7d4a1-0001-4e00-9000-000000000001";
  const nStart = "b6d7d4a1-0002-4e00-9000-000000000002";
  const nEncode = "b6d7d4a1-0003-4e00-9000-000000000003";
  const nRemux = "b6d7d4a1-0004-4e00-9000-000000000004";
  const nExec = "b6d7d4a1-0005-4e00-9000-000000000005";
  const nCopy = "b6d7d4a1-0006-4e00-9000-000000000006";
  const nFailEncode = "b6d7d4a1-0007-4e00-9000-000000000007";
  const nFailExec = "b6d7d4a1-0008-4e00-9000-000000000008";
  const nCustom = "b6d7d4a1-0009-4e00-9000-000000000009";
  const nNoAttach = "b6d7d4a1-000a-4e00-9000-00000000000a";
  return {
    Uid: "00000000-0000-0000-0000-000000000000",
    Name: FLOW_NAME,
    Type: 0,
    Enabled: true,
    Description:
      "Created by HexOS. Converts a video to H.264 MP4 and places the result next to the original file. The original is not modified.",
    Icon: "fas fa-video:#7F35B2",
    Properties: { Fields: [], Variables: {} },
    Parts: [
      {
        Uid: nInput,
        Name: "",
        FlowElementUid: "FileFlows.VideoNodes.VideoFile",
        xPos: 230,
        yPos: 70,
        Icon: "fas fa-video",
        Label: "Video File",
        Inputs: 0,
        Outputs: 1,
        Type: 0,
        OutputConnections: [{ Input: 1, Output: 1, InputNode: nStart }],
      },
      {
        Uid: nStart,
        Name: "",
        FlowElementUid: "FileFlows.VideoNodes.FfmpegBuilderNodes.FfmpegBuilderStart",
        xPos: 230,
        yPos: 200,
        Icon: "far fa-file-video",
        Label: "FFMPEG Builder: Start",
        Inputs: 1,
        Outputs: 1,
        Type: 4,
        OutputConnections: [{ Input: 1, Output: 1, InputNode: nEncode }],
      },
      {
        Uid: nEncode,
        Name: "H.264",
        FlowElementUid: "FileFlows.VideoNodes.FfmpegBuilderNodes.FfmpegBuilderVideoEncodeSimple",
        xPos: 230,
        yPos: 330,
        Icon: "far fa-file-video",
        Label: "FFMPEG Builder: Video Encode",
        Inputs: 1,
        Outputs: 1,
        Type: 6,
        OutputConnections: [{ Input: 1, Output: 1, InputNode: nCustom }],
        // Hardware-first (auto): CPU-only proved ~0.15x realtime — a 24-min
        // episode took an hour. The forced 8-bit output below is what lets
        // hardware encoders take 10-bit sources (no encoder anywhere does
        // 10-bit H.264); if hardware still fails, the executor's error path
        // falls over to CPU.
        Model: { Codec: "h264", Encoder: "", Quality: 6, Speed: 3 },
      },
      {
        Uid: nCustom,
        Name: "8-bit output",
        FlowElementUid: "FileFlows.VideoNodes.FfmpegBuilderNodes.FfmpegBuilderCustomParameters",
        xPos: 230,
        yPos: 395,
        Icon: "far fa-file-video",
        Label: "FFMPEG Builder: Custom Parameters",
        Inputs: 1,
        Outputs: 1,
        Type: 6,
        OutputConnections: [{ Input: 1, Output: 1, InputNode: nNoAttach }],
        // 10-bit sources otherwise negotiate a High-10 encode, which both
        // breaks (x264 pipeline error) and yields a less-compatible file.
        Model: { Parameters: "-pix_fmt:v:0 yuv420p", ForceEncode: false },
      },
      {
        Uid: nNoAttach,
        Name: "",
        FlowElementUid: "FileFlows.VideoNodes.FfmpegBuilderNodes.FfmpegBuilderRemoveAttachments",
        xPos: 230,
        yPos: 425,
        Icon: "far fa-file-video",
        Label: "Remove Attachments",
        Inputs: 1,
        Outputs: 1,
        Type: 6,
        OutputConnections: [{ Input: 1, Output: 1, InputNode: nRemux }],
        // MKV font attachments (OTF/TTF for styled subs) cannot exist in MP4 —
        // the muxer fails writing the header if they're mapped through.
        Model: {},
      },
      {
        Uid: nRemux,
        Name: "",
        FlowElementUid: "FileFlows.VideoNodes.FfmpegBuilderNodes.FfmpegBuilderRemuxToMP4",
        xPos: 230,
        yPos: 460,
        Icon: "far fa-file-video",
        Label: "Remux to MP4",
        Inputs: 1,
        Outputs: 1,
        Type: 6,
        OutputConnections: [{ Input: 1, Output: 1, InputNode: nExec }],
        Model: { UseHvc1: false },
      },
      {
        Uid: nExec,
        Name: "",
        FlowElementUid: "FileFlows.VideoNodes.FfmpegBuilderNodes.FfmpegBuilderExecutor",
        xPos: 230,
        yPos: 590,
        Icon: "far fa-file-video",
        Label: "FFMPEG Builder: Executor",
        Inputs: 1,
        Outputs: 2,
        Type: 5,
        OutputConnections: [{ Input: 1, Output: 1, InputNode: nCopy }],
        // Hardware encode can fail on sources the GPU can't handle (e.g.
        // NVENC has no 10-bit H.264); the error path re-encodes on CPU —
        // same pattern as FileFlows' own convert templates.
        ErrorConnection: { Input: 1, Output: -1, InputNode: nFailEncode },
        Model: { HardwareDecoding: "auto", Strictness: "experimental" },
      },
      {
        Uid: nFailEncode,
        Name: "CPU Fail-over Encode",
        FlowElementUid: "FileFlows.VideoNodes.FfmpegBuilderNodes.FfmpegBuilderVideoEncodeSimple",
        xPos: 450,
        yPos: 590,
        Icon: "far fa-file-video",
        Label: "FFMPEG Builder: Video Encode",
        Inputs: 1,
        Outputs: 1,
        Type: 6,
        OutputConnections: [{ Input: 1, Output: 1, InputNode: nFailExec }],
        Model: { Codec: "h264", Encoder: "CPU", Quality: 6, Speed: 3 },
      },
      // (fail-over keeps CPU too — it exists as belt-and-braces for future
      // hardware-primary variants of this flow)
      {
        Uid: nFailExec,
        Name: "CPU Fail-over Executor",
        FlowElementUid: "FileFlows.VideoNodes.FfmpegBuilderNodes.FfmpegBuilderExecutor",
        xPos: 450,
        yPos: 720,
        Icon: "far fa-file-video",
        Label: "FFMPEG Builder: Executor",
        Inputs: 1,
        Outputs: 2,
        Type: 5,
        OutputConnections: [{ Input: 1, Output: 1, InputNode: nCopy }],
        Model: { HardwareDecoding: false, Strictness: "experimental" },
      },
      {
        Uid: nCopy,
        Name: "",
        FlowElementUid: "FileFlows.BasicNodes.File.CopyFile",
        xPos: 230,
        yPos: 720,
        Icon: "fas fa-copy",
        Label: "Copy next to original",
        Inputs: 1,
        Outputs: 1,
        Type: 2,
        Model: {
          InputFile: "",
          DestinationPath: "{folder.Orig.FullName}",
          DestinationFile: "{file.Orig.FileNameNoExtension}.mp4",
          CopyFolder: false,
          AdditionalFiles: [],
          AdditionalFilesFromOriginal: false,
          PreserverOriginalDates: false,
        },
      },
    ],
  };
}

async function listByStatus(base: string, status: number): Promise<LibraryFileRecord[]> {
  const response = await fetch(`${base}/api/library-file/list-all?status=${status}`);
  if (!response.ok) return [];
  return (await response.json()) as LibraryFileRecord[];
}

async function recordsFor(base: string, paths: Set<string>): Promise<LibraryFileRecord[]> {
  const all: LibraryFileRecord[] = [];
  for (const status of [STATUS_UNPROCESSED, STATUS_PROCESSING, STATUS_PROCESSED, STATUS_FAILED]) {
    for (const record of await listByStatus(base, status)) {
      if (paths.has(record.dn)) all.push(record);
    }
  }
  return all;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- real conversion progress -----------------------------------------------
// FileFlows serves a file's processing log DURING the run; ffmpeg writes a
// stats line into it every few seconds. Frames done / frames total is the
// truthful travel signal (the time= field freezes when subtitle streams are
// being converted — frame= keeps moving).

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

async function fetchLogText(base: string, uid: string): Promise<string | null> {
  try {
    const response = await fetch(`${base}/api/library-file/${uid}/log`);
    if (!response.ok) return null;
    // the endpoint serves HTML-wrapped lines; strip tags, keep text
    return (await response.text()).replace(/<[^>]+>/g, "");
  } catch {
    return null;
  }
}

export async function run(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "flow", message: "Checking the FileFlows convert flow" },
    { id: "enqueue", message: "Sending files to FileFlows" },
    { id: "convert", message: "Converting" },
  ]);

  if (!ctx.host || !ctx.port) throw new Error("Missing FileFlows host/port in action context");
  const base = `http://${ctx.host}:${ctx.port}`;

  const files = ctx.target?.files ?? [];
  if (files.length === 0) throw new Error("No files were selected");
  // The engine only offers this action for mounted files; this guards direct calls.
  const unmapped = files.filter((f) => !f.containerPath);
  if (unmapped.length > 0) {
    ctx.fail("Some files are not in a folder FileFlows can access", [
      { label: "Files", value: unmapped.map((f) => f.name).join(", ") },
      { label: "Fix", value: "Move them into a media folder (Movies, Shows, Media…) and try again" },
    ]);
  }

  // 1. Ensure the blessed flow exists (find by name, create via API if missing)
  const flowsResponse = await fetch(`${base}/api/flow`);
  if (!flowsResponse.ok) throw new Error(`Could not reach FileFlows (${flowsResponse.status})`);
  const flows = (await flowsResponse.json()) as Array<{ Uid: string; Name: string }>;
  let flowUid = flows.find((f) => f.Name === FLOW_NAME)?.Uid;
  if (!flowUid) {
    const createResponse = await fetch(`${base}/api/flow`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(flowDefinition()),
    });
    if (!createResponse.ok) throw new Error(`Could not create the convert flow (${createResponse.status})`);
    flowUid = ((await createResponse.json()) as { Uid: string }).Uid;
  }
  await ctx.emitCheckpoint("flow");

  // 2. Clear stale queue records for these paths so a re-run converts again
  const containerPaths = files.map((f) => f.containerPath as string);
  const pathSet = new Set(containerPaths);
  const stale = await recordsFor(base, pathSet);
  if (stale.length > 0) {
    await fetch(`${base}/api/library-file`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Uids: stale.map((r) => r.u) }),
    });
  }

  // 3. Enqueue
  const addResponse = await fetch(`${base}/api/library-file/manually-add`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ FlowUid: flowUid, Files: containerPaths }),
  });
  if (!addResponse.ok) throw new Error(`FileFlows rejected the files (${addResponse.status})`);
  await ctx.emitCheckpoint("enqueue");

  // 4. Poll until every file reaches a terminal status. The progress bar is
  // real conversion travel: frames encoded / total frames per file (from the
  // live processing log), size-weighted across files, mapped into a 5-95
  // band — the edges cover queue pickup and the final remux/copy-back.
  // Monotonic: a CPU fail-over restarts ffmpeg's frame count mid-file, so
  // the bar plateaus during the retry instead of jumping backwards.
  await ctx.setProgress(2);
  const totalFiles = files.length;
  const sourceFrames = new Map<string, number>(); // record uid -> total frames
  const fractions = new Map<string, number>(); // container path -> best-known travel
  let reported = 2;

  for (;;) {
    await sleep(POLL_INTERVAL_MS);
    const records = await recordsFor(base, pathSet);
    const done = records.filter((r) => r.s === STATUS_PROCESSED);
    const failed = records.filter((r) => r.s === STATUS_FAILED);

    for (const record of records) {
      if (record.s === STATUS_PROCESSED || record.s === STATUS_FAILED) {
        fractions.set(record.dn, 1);
        continue;
      }
      if (record.s !== STATUS_PROCESSING) continue;
      const logText = await fetchLogText(base, record.u);
      if (!logText) continue;
      if (!sourceFrames.has(record.u)) {
        const parsed = parseTotalFrames(logText);
        if (parsed) sourceFrames.set(record.u, parsed);
      }
      const frameTotal = sourceFrames.get(record.u);
      const frame = parseCurrentFrame(logText);
      if (frameTotal && frame !== null) {
        const fraction = Math.min(frame / frameTotal, 0.99);
        if (fraction > (fractions.get(record.dn) ?? 0)) fractions.set(record.dn, fraction);
      }
    }

    let weightTotal = 0;
    let weightDone = 0;
    for (const file of files) {
      const containerPath = file.containerPath as string;
      const record = records.find((r) => r.dn === containerPath);
      const weight = record?.os || file.size || 1;
      weightTotal += weight;
      weightDone += weight * (fractions.get(containerPath) ?? 0);
    }
    const overall = weightTotal > 0 ? Math.round(5 + (weightDone / weightTotal) * 90) : 5;
    if (overall > reported) {
      reported = overall;
      await ctx.setProgress(overall);
    }

    if (done.length + failed.length >= totalFiles) {
      if (failed.length > 0) {
        ctx.fail(`FileFlows could not convert ${failed.length} of ${totalFiles} file(s)`, [
          { label: "Failed", value: failed.map((r) => r.dn).join(", ") },
          { label: "Details", value: "Open the FileFlows app and check the file's processing log" },
        ]);
      }
      break;
    }

    await ctx.updateCheckpointMessage(
      "convert",
      totalFiles > 1
        ? `Converting — ${overall}% (${done.length + failed.length} of ${totalFiles} files done)`
        : `Converting — ${overall}%`,
    );
  }

  await ctx.emitCheckpoint("convert", `Converted ${totalFiles} file(s) to MP4`, 99);
}
