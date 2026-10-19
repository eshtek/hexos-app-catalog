// The flow is non-destructive: the converted file is copied next to the
// original as <name>.mp4 and the original is left untouched.
//
// Every call goes through ctx.partnerRequest("fileflows", ...): FileFlows 26.10 serves its API
// only to signed requests, and this install's partner token (the PARTNER_API_KEY env HexOS wrote,
// see $PARTNER_TOKEN in fileflows.json) signs them. The script never holds the token.
//
// FileFlows' own queue is the one record of what is being converted: a file it is processing or
// holds queued refuses a run before anything is written. FileFlows copies its result into a hidden
// staging folder beside the media, never next to the user's files, and the hook gives the copy its
// final name with a hard link the kernel refuses when a file of that name exists. Nothing beside
// the user's media is ever replaced or deleted, and the only thing the hook removes is the staging
// name of a copy that already carries its final name.
import { existsSync, linkSync, lstatSync, mkdirSync, rmSync, statSync } from "node:fs";

import type { HookContext } from "../_lib/hook_context";

const FLOW_NAME = "HexOS Convert to MP4";
/** The hidden folder beside the media where FileFlows puts the copy before it takes its final name. */
const STAGING_DIR = ".hexos-converting";

/**
 * The staging copy for a source file, as this script sees it: the source's whole name plus `.mp4`,
 * inside the staging folder, so two sources that would share one final name (film.mkv and
 * film.avi) never share a staging copy.
 */
function stagingPathFor(localSourcePath: string): string {
  const slash = localSourcePath.lastIndexOf("/");
  return `${localSourcePath.slice(0, slash)}/${STAGING_DIR}/${localSourcePath.slice(slash + 1)}.mp4`;
}

// Library-file statuses (from /api/library-file/status); the negative ones are queue entries
// FileFlows is holding back, which are work in progress all the same
const STATUS_ON_HOLD = -3;
const STATUS_DISABLED = -2;
const STATUS_OUT_OF_SCHEDULE = -1;
const STATUS_UNPROCESSED = 0;
const STATUS_PROCESSED = 1;
const STATUS_PROCESSING = 2;
const STATUS_FAILED = 4;
const BUSY_STATUSES = [STATUS_ON_HOLD, STATUS_DISABLED, STATUS_OUT_OF_SCHEDULE, STATUS_UNPROCESSED, STATUS_PROCESSING];
/** A list-all page is 500 records unless the server's setting says otherwise; pages are read until one brings nothing new. */
const MAX_PAGES = 200;
/** The longest file name the usual dataset accepts, in bytes; the staging copy's name is the source's plus `.mp4`. */
const MAX_NAME_BYTES = 255;

const POLL_INTERVAL_MS = 15000;
/** Under the declared timeout (24 h) by a margin, so this run stops itself before the platform gives up on it. */
const RUN_DEADLINE_MS = 24 * 60 * 60 * 1000 - 10 * 60 * 1000;
/** No single call to FileFlows waits longer than this. */
const REQUEST_TIMEOUT_MS = 30_000;

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
        // Hardware-first (auto): CPU-only runs ~0.15x realtime. The forced
        // 8-bit output below is what lets hardware encoders take 10-bit
        // sources (no encoder anywhere does 10-bit H.264); if hardware still
        // fails, the executor's error path falls over to CPU.
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
          DestinationPath: `{folder.Orig.FullName}/${STAGING_DIR}`,
          DestinationFile: "{file.Orig.FileName}.mp4",
          CopyFolder: false,
          AdditionalFiles: [],
          AdditionalFilesFromOriginal: false,
          PreserverOriginalDates: false,
        },
      },
    ],
  };
}

/**
 * FileFlows answers every /api route with 404 until it has accepted the HexOS partner token at
 * startup: a build older than 26.10.3, or an install that has not restarted since the token was
 * written. The installed version is not knowable from here (the TrueNAS chart pins an image
 * digest, not the app's version), so this is where the requirement is explained.
 */
function failNotAccepted(ctx: HookContext): never {
  return ctx.fail("FileFlows did not accept HexOS's partner token", [
    { label: "Needs", value: "FileFlows 26.10.3 or newer, restarted since HexOS installed or updated it" },
    { label: "Fix", value: "Update FileFlows in the app's details, then try again" },
  ]);
}

/** A host path as this script can read it, through the app's mounts; undefined when none covers it. */
function localPathFor(ctx: HookContext, hostPath: string): string | undefined {
  const mount = ctx.mounts
    .filter((m) => hostPath === m.hostPath || hostPath.startsWith(`${m.hostPath}/`))
    .sort((a, b) => b.hostPath.length - a.hostPath.length)[0];
  return mount ? `${mount.localPath}${hostPath.slice(mount.hostPath.length)}` : undefined;
}

/** Every record of a status, page by page: list-all answers one page (500 by default), and a busy library has more. */
async function listByStatus(ctx: HookContext, base: string, status: number): Promise<LibraryFileRecord[]> {
  const seen = new Map<string, LibraryFileRecord>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const records = await ctx.partnerRequestJson<LibraryFileRecord[]>(
      "fileflows",
      `${base}/api/library-file/list-all?status=${status}&page=${page}`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    if (!Array.isArray(records)) break;
    let fresh = 0;
    for (const record of records) {
      if (seen.has(record.u)) continue;
      seen.set(record.u, record);
      fresh++;
    }
    if (fresh === 0) return [...seen.values()];
  }
  // Past the cap the list is not known whole, and an unseen record could be one of these files
  ctx.fail("FileFlows holds more records than this action can check", [
    { label: "Details", value: `More than ${MAX_PAGES} pages of files with one status` },
    { label: "Fix", value: "Clear finished files from FileFlows' library, then try again" },
  ]);
}

/**
 * Whether a record is one of the selected files: its name is the file's container path, which is
 * how manually-add records a file. A library's own record names the file relative to the library
 * and is not matched: a like-named file elsewhere must not refuse this one, and a library
 * converting the same file at the same time writes its own output where the library says, never
 * where this flow does.
 */
function recordMatches(paths: Set<string>, record: LibraryFileRecord): boolean {
  return paths.has(record.dn);
}

/** FileFlows answers a refused request with the reason as text ("Unauthorized: Invalid signature"). */
async function reason(response: Response): Promise<string> {
  const text = (await response.text().catch(() => "")).trim();
  return text ? `: ${text.slice(0, 120)}` : "";
}

async function recordsFor(ctx: HookContext, base: string, paths: Set<string>): Promise<LibraryFileRecord[]> {
  const all: LibraryFileRecord[] = [];
  for (const status of [...BUSY_STATUSES, STATUS_PROCESSED, STATUS_FAILED]) {
    for (const record of await listByStatus(ctx, base, status)) {
      if (recordMatches(paths, record)) all.push(record);
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

async function fetchLogText(ctx: HookContext, base: string, uid: string): Promise<string | null> {
  try {
    const response = await ctx.partnerRequest("fileflows", `${base}/api/library-file/${uid}/log`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    // the endpoint serves HTML-wrapped lines; strip tags, keep text
    return (await response.text()).replace(/<[^>]+>/g, "");
  } catch {
    return null;
  }
}

/** A converted file's places on this script's view of the folder. */
interface Output {
  /** where FileFlows copies the result */
  staging: string;
  /** the copy's final name beside the source */
  final: string;
}

/**
 * The staging folder beside a file's folder, made if absent. It must be a plain directory this
 * script can trust: a symlink or a file of that name would send FileFlows' copy, and the removal
 * below, somewhere else, so either fails the run naming it.
 */
function ensureStagingDir(ctx: HookContext, staging: string): void {
  const dir = staging.slice(0, staging.lastIndexOf("/"));
  let kind: ReturnType<typeof lstatSync> | undefined;
  try {
    kind = lstatSync(dir);
  } catch {
    mkdirSync(dir);
    return;
  }
  if (kind.isDirectory() && !kind.isSymbolicLink()) return;
  ctx.fail("Something other than a folder sits where HexOS stages conversions", [
    { label: "Path", value: `${dir.split("/").slice(-2).join("/")}` },
    { label: "Fix", value: "Move or remove it, then try again" },
  ]);
}

/**
 * Nothing at a staging path is ever removed on the strength of its name: a copy an earlier run left
 * there, or anything else, refuses the run naming it, since this run cannot tell its own flow's
 * output from a file someone put there.
 */
function refuseIfStaged(ctx: HookContext, staging: string): void {
  if (!existsSync(staging) && !isLink(staging)) return;
  ctx.fail("A file already sits where HexOS would stage this conversion", [
    { label: "Path", value: `${STAGING_DIR}/${staging.split("/").pop()}` },
    { label: "Fix", value: "Move or remove it (an earlier conversion may have left it), then try again" },
  ]);
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The one removal this script makes: the staging name of a copy that now also carries its final
 * name, the same inode under both, checked right before the unlink. The data stays under the final
 * name; only the extra name goes.
 */
function dropStagingName(staging: string, final: string): void {
  try {
    const a = lstatSync(staging);
    const b = lstatSync(final);
    if (!a.isFile() || a.ino !== b.ino || a.dev !== b.dev) return;
  } catch {
    return;
  }
  rmSync(staging, { force: true });
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

  // Refuse before anything is queued when the copy would land on a file that exists: an .mp4
  // already beside the source, or two selected files that would share one output name. An .mp4
  // of that name that appears later, while FileFlows converts, is safe too: the copy lands in the
  // staging folder and takes its final name through a hard link the kernel refuses if the name is
  // taken, so the run then fails naming the file instead of replacing it.
  const taken = new Map<string, string>();
  const collisions: string[] = [];
  /** container path -> the copy's staging and final names on this script's view of the folder */
  const outputs = new Map<string, Output>();
  for (const file of files) {
    const target = `${file.path.replace(/\.[^./]+$/, "")}.mp4`;
    const earlier = taken.get(target);
    if (earlier) collisions.push(`${file.name} and ${earlier} would both become ${target.split("/").pop()}`);
    taken.set(target, file.name);
    const local = localPathFor(ctx, target);
    if (!local) {
      ctx.fail("HexOS cannot see the folder the converted copy would go to", [
        { label: "File", value: file.name },
        { label: "Fix", value: "The folder must be one of the app's mounted media folders" },
      ]);
    }
    if (existsSync(local)) collisions.push(`${file.name}: ${target.split("/").pop()} already exists next to it`);
    if (Buffer.byteLength(`${file.name}.mp4`) > MAX_NAME_BYTES) {
      ctx.fail("A file's name is too long for its converted copy to be staged", [
        { label: "File", value: file.name },
        { label: "Fix", value: "Shorten the file's name, then try again" },
      ]);
    }
    outputs.set(file.containerPath as string, { final: local, staging: stagingPathFor(localPathFor(ctx, file.path) as string) });
  }
  if (collisions.length > 0) {
    ctx.fail("A converted copy would overwrite an existing file", [
      { label: "Files", value: collisions.join("; ") },
      { label: "Fix", value: "Rename or move the existing .mp4 first, or convert one file at a time" },
    ]);
  }

  // The first call to FileFlows says whether it accepts HexOS's credential at all: every /api route
  // answers 404 until it has, so that case is explained here, before any other request can fail on it.
  const probe = await ctx.partnerRequest("fileflows", `${base}/api/status`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (probe.status === 404) failNotAccepted(ctx);
  if (!probe.ok) throw new Error(`Could not reach FileFlows (${probe.status}${await reason(probe)})`);

  // FileFlows' queue is the record of work in progress: a file it is processing or has queued (for
  // any flow, an earlier run of this one included) refuses the run here, before anything is
  // written, so a copy in progress is never disturbed. Two runs started on the same file inside
  // the moment between this check and the enqueue both proceed; the first to finish names the copy
  // and the other reports it, and nothing is lost either way.
  const containerPaths = files.map((f) => f.containerPath as string);
  const pathSet = new Set(containerPaths);
  const existingRecords = await recordsFor(ctx, base, pathSet);
  const busy = existingRecords.filter((r) => BUSY_STATUSES.includes(r.s));
  if (busy.length > 0) {
    ctx.fail("FileFlows is already working on some of these files", [
      { label: "Files", value: busy.map((r) => r.dn.split("/").pop() ?? r.dn).join(", ") },
      { label: "Fix", value: "Wait for FileFlows to finish them, or remove them from its queue in the FileFlows app" },
    ]);
  }

  // The action's own deadline, applied from inside: the platform's timeout abandons an entrypoint
  // without stopping it, so a run past the deadline stops itself before it touches a file again.
  const deadline = Date.now() + RUN_DEADLINE_MS;
  const assertInTime = (): void => {
    if (Date.now() <= deadline) return;
    ctx.fail("The conversion ran past its deadline", [
      { label: "Details", value: "FileFlows may still finish it; run the conversion again later" },
    ]);
  };

  // 1. Write the blessed flow (over the existing one of that name, or as a new one)
  const flowsResponse = await ctx.partnerRequest("fileflows", `${base}/api/flow`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (flowsResponse.status === 404) failNotAccepted(ctx);
  if (!flowsResponse.ok) throw new Error(`Could not reach FileFlows (${flowsResponse.status}${await reason(flowsResponse)})`);
  const flows = (await flowsResponse.json()) as Array<{ Uid: string; Name: string }>;
  const existing = flows.find((f) => f.Name === FLOW_NAME);
  // The flow that runs is exactly the one this script defines, every time: the definition is
  // written back over the existing flow (same Uid) before any file is queued. A flow of that name
  // someone edited in FileFlows (a Delete Source added, a Copy File pointed at the original's own
  // name, a connection rewired) would turn a copy into a loss, and comparing a subset of it is a
  // bet on which fields matter. Rewriting it is not. The definition is the same for every run, so
  // two runs writing it at once write the same thing.
  const blessed = flowDefinition();
  const saved = await ctx.partnerRequestJson<{ Uid: string }>("fileflows", `${base}/api/flow`, {
    method: "PUT",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: existing ? { ...blessed, Uid: existing.Uid } : blessed,
  });
  const flowUid = saved?.Uid;
  if (!flowUid) throw new Error("FileFlows saved the convert flow without a Uid");
  await ctx.emitCheckpoint("flow");

  // 2. Clear this flow's finished records for these paths so a re-run converts again. A record
  // another flow owns is left alone, and a file FileFlows is processing or has queued for any
  // flow (this one from an earlier run included) was refused above: deleting that record would cut
  // across work in progress.
  const stale = existingRecords.filter((r) => r.fu === flowUid && (r.s === STATUS_PROCESSED || r.s === STATUS_FAILED));
  if (stale.length > 0) {
    await ctx.partnerRequestJson("fileflows", `${base}/api/library-file`, {
      method: "DELETE",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: { Uids: stale.map((r) => r.u) },
    });
  }

  // 3. Make the staging folder, and refuse a staging path something already sits at (a copy a run
  // abandoned at its deadline left there, or anything else): nothing is removed to make room.
  assertInTime();
  for (const out of outputs.values()) {
    ensureStagingDir(ctx, out.staging);
    refuseIfStaged(ctx, out.staging);
  }

  // 4. Enqueue
  await ctx.partnerRequestJson("fileflows", `${base}/api/library-file/manually-add`, {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: { FlowUid: flowUid, Files: containerPaths },
  });
  await ctx.emitCheckpoint("enqueue");

  // 5. Poll until every file reaches a terminal status. The progress bar is
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

  const handedOver = new Set<string>();
  const blocked: string[] = [];
  const missing: string[] = [];
  /**
   * The finished copy takes its final name once, through a link the kernel refuses if the name is
   * taken (the same copy already linked there, by an overlapping run, counts as done). Once the
   * copy carries its final name, its staging name goes. A copy refused its final name stays in the
   * staging folder and is named to the user, never removed. A staging copy that is not there when
   * FileFlows says the file is done is a failure, never a silent success.
   */
  const handOver = (containerPath: string): void => {
    if (handedOver.has(containerPath)) return;
    assertInTime(); // right before the file is touched; the poll's awaits are behind us
    const out = outputs.get(containerPath);
    const name = out?.final.split("/").pop() ?? containerPath;
    if (!out || !existsSync(out.staging)) {
      if (!missing.includes(name)) missing.push(name);
      return;
    }
    try {
      linkSync(out.staging, out.final);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const sameFile = (() => {
        try {
          return statSync(out.final).ino === statSync(out.staging).ino;
        } catch {
          return false;
        }
      })();
      if (!sameFile) {
        if (!blocked.includes(name)) blocked.push(name);
        handedOver.add(containerPath);
        return;
      }
    }
    handedOver.add(containerPath);
    dropStagingName(out.staging, out.final);
  };

  for (;;) {
    await sleep(POLL_INTERVAL_MS);
    assertInTime();
    const records = (await recordsFor(ctx, base, pathSet)).filter((r) => r.fu === flowUid);
    const done = records.filter((r) => r.s === STATUS_PROCESSED);
    const failed = records.filter((r) => r.s === STATUS_FAILED);

    for (const record of records) {
      if (record.s === STATUS_PROCESSED) {
        fractions.set(record.dn, 1);
        handOver(record.dn);
        continue;
      }
      if (record.s === STATUS_FAILED) {
        fractions.set(record.dn, 1);
        continue;
      }
      if (record.s !== STATUS_PROCESSING) continue;
      const logText = await fetchLogText(ctx, base, record.u);
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
      for (const record of done) handOver(record.dn);
      if (missing.length > 0) {
        ctx.fail("FileFlows reported a conversion done but its output is not there", [
          { label: "Files", value: missing.join(", ") },
          { label: "Details", value: "Open the FileFlows app and check the file's processing log, then run the conversion again" },
        ]);
      }
      if (blocked.length > 0) {
        ctx.fail("A file of the converted copy's name appeared while converting; the copy is waiting in the staging folder", [
          { label: "Files", value: blocked.join(", ") },
          { label: "Fix", value: `Find the copy in ${STAGING_DIR} beside the original and move it to the name you want` },
        ]);
      }
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
