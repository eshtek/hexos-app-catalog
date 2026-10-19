// The flow is non-destructive: the converted file is copied next to the
// original as <name>.mp4 and the original is left untouched.
//
// Every call goes through ctx.partnerRequest("fileflows", ...): FileFlows 26.10 serves its API
// only to signed requests, and this install's partner token (the PARTNER_API_KEY env HexOS wrote,
// see $PARTNER_TOKEN in fileflows.json) signs them. The script never holds the token.
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";

import type { HookContext } from "../_lib/hook_context";

const FLOW_NAME = "HexOS Convert to MP4";
/**
 * Each selected file gets a reservation: a directory beside it, created exclusively by this run
 * (mkdir is atomic, exactly one contender creates it) and marked with an `owner` file holding the
 * run's id. FileFlows copies its result INTO that directory, as `output.mp4`, so the only file the
 * copy ever writes sits in a place this run made; the hook then gives the copy its final name
 * beside the source with a hard link, which the kernel refuses when a file of that name exists
 * (EEXIST). Nothing next to the user's media is ever replaced, and nothing is deleted on the
 * strength of its name: a reservation is taken over only when it carries the owner marker or is
 * empty, and is stale after the action's own deadline.
 */
/** The hidden folder beside the media that holds one reservation directory per source file, named after the file. */
const RESERVATIONS_DIR = ".hexos-converting";

/** The reservation directory for a source file as this script sees it: a name the file system already accepts. */
function reservationDirFor(localSourcePath: string): string {
  const slash = localSourcePath.lastIndexOf("/");
  return `${localSourcePath.slice(0, slash)}/${RESERVATIONS_DIR}/${localSourcePath.slice(slash + 1)}`;
}

/** A short sibling name for a reservation moved aside, never derived from the file name, so it fits however long that is. */
const asideFor = (lockDir: string, kind: "stale" | "released", owner: string) =>
  `${lockDir.slice(0, lockDir.lastIndexOf("/"))}/.${kind}-${owner}`;
const OUTPUT_NAME = "output.mp4";
const LOCK_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * True when this run now holds the file's reservation; false when another run holds it. The
 * reservation is a directory (mkdir is atomic: exactly one contender creates it) holding an
 * `owner` file with this run's id. Taking a stale one over is a rename to a name only this run
 * uses (atomic: exactly one contender moves it), so two contenders never both think they won; the
 * run that held it checks `holds` before every step that touches the file and stands down.
 */
type Reservation = "ours" | "held" | "unknown";

function reserve(lockDir: string, owner: string): Reservation {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      mkdirSync(lockDir.slice(0, lockDir.lastIndexOf("/")), { recursive: true });
      mkdirSync(lockDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Age by the owner file, or by the directory itself when a run died between creating it and
      // claiming it: an ownerless reservation is fresh for a moment (another run mid-claim) and
      // stale after the deadline like any other, never held forever.
      let ageMs: number;
      try {
        ageMs = Date.now() - statSync(`${lockDir}/owner`).mtimeMs;
      } catch {
        try {
          ageMs = Date.now() - statSync(lockDir).mtimeMs;
        } catch {
          continue; // removed by another run between the mkdir and the stat: look again
        }
      }
      const abandoned = existsSync(`${lockDir}/abandoned`);
      if (ageMs < LOCK_STALE_MS && !abandoned) return "held";
      // Stale. Taken over only when it is recognisably a reservation: it carries the owner marker
      // (a dead run's, with at most its own output beside it) or it is empty (a run that died
      // between the mkdir and the marker). Anything else is not ours to remove.
      if (!recognisedReservation(lockDir)) return "unknown";
      const taken = asideFor(lockDir, "stale", owner);
      try {
        renameSync(lockDir, taken); // only one contender's rename succeeds
      } catch {
        return "held";
      }
      rmSync(taken, { recursive: true, force: true });
      continue;
    }
    try {
      writeFileSync(`${lockDir}/owner`, owner);
      return "ours";
    } catch (error) {
      // Created but not claimed: not a reservation anyone can trust, so it does not stay.
      rmSync(lockDir, { recursive: true, force: true });
      throw error;
    }
  }
  return "held";
}

/**
 * Whether a directory is one of ours and nothing else: empty, or an `owner` regular file holding a
 * run id (a UUID) with at most a regular `output.mp4` and an `abandoned` marker beside it. Anything
 * else is not ours to remove, whatever its name.
 */
function recognisedReservation(lockDir: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(lockDir);
  } catch {
    return false;
  }
  if (entries.length === 0) return true;
  if (!entries.every((e) => e === "owner" || e === OUTPUT_NAME || e === "abandoned")) return false;
  try {
    if (!lstatSync(`${lockDir}/owner`).isFile()) return false;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(readFileSync(`${lockDir}/owner`, "utf8").trim()))
      return false;
    for (const e of entries) if (e !== "owner" && !lstatSync(`${lockDir}/${e}`).isFile()) return false;
  } catch {
    return false;
  }
  return true;
}

/** Whether the reservation still names this run. */
function holds(lockDir: string, owner: string): boolean {
  try {
    return readFileSync(`${lockDir}/owner`, "utf8") === owner;
  } catch {
    return false;
  }
}

/**
 * Removes a reservation this run owns. The directory is moved aside first (atomic), then its
 * owner is read: this run's goes; another run's, moved by mistake because that run took over
 * between the check and the rename, is put back, and if that fails (a third run reserved in
 * between) the other run's next `holds` check makes it stand down, so at no point do two runs
 * both believe they own the file.
 */
function releaseOwn(lockDir: string, owner: string): void {
  if (!holds(lockDir, owner)) return;
  const aside = asideFor(lockDir, "released", owner);
  try {
    renameSync(lockDir, aside);
  } catch {
    return; // already gone
  }
  if (holds(aside, owner)) {
    rmSync(aside, { recursive: true, force: true });
    return;
  }
  try {
    renameSync(aside, lockDir);
  } catch {
    rmSync(aside, { recursive: true, force: true });
  }
}

// Library-file statuses (from /api/library-file/status)
const STATUS_UNPROCESSED = 0;
const STATUS_PROCESSED = 1;
const STATUS_PROCESSING = 2;
const STATUS_FAILED = 4;

const POLL_INTERVAL_MS = 15000;
/** Under the declared timeout (24 h) by a margin, so this run stops itself before the platform gives up on it. */
const RUN_DEADLINE_MS = 24 * 60 * 60 * 1000 - 10 * 60 * 1000;
/** No single call to FileFlows waits longer than this; a hung request never holds a reservation open. */
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
          DestinationPath: `{folder.Orig.FullName}/${RESERVATIONS_DIR}/{file.Orig.FileName}`,
          DestinationFile: OUTPUT_NAME,
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

async function listByStatus(ctx: HookContext, base: string, status: number): Promise<LibraryFileRecord[]> {
  return ctx.partnerRequestJson<LibraryFileRecord[]>("fileflows", `${base}/api/library-file/list-all?status=${status}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/** FileFlows answers a refused request with the reason as text ("Unauthorized: Invalid signature"). */
async function reason(response: Response): Promise<string> {
  const text = (await response.text().catch(() => "")).trim();
  return text ? `: ${text.slice(0, 120)}` : "";
}

async function recordsFor(ctx: HookContext, base: string, paths: Set<string>): Promise<LibraryFileRecord[]> {
  const all: LibraryFileRecord[] = [];
  for (const status of [STATUS_UNPROCESSED, STATUS_PROCESSING, STATUS_PROCESSED, STATUS_FAILED]) {
    for (const record of await listByStatus(ctx, base, status)) {
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
  // reservation and takes its final name through a hard link the kernel refuses if the name is
  // taken, so the run then fails naming the file instead of replacing it.
  const taken = new Map<string, string>();
  const collisions: string[] = [];
  /** container path -> the copy's temp and final names on this script's view of the folder */
  const outputs = new Map<string, { temp: string; final: string; lock: string }>();
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
    const lock = reservationDirFor(localPathFor(ctx, file.path) as string);
    outputs.set(file.containerPath as string, { final: local, temp: `${lock}/${OUTPUT_NAME}`, lock });
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

  // FileFlows must not be busy with any of these files before anything else happens: a file it is
  // processing or has queued (for any flow, an earlier run of this one included) refuses the run
  // here, before a reservation is taken over, so a copy in progress is never disturbed.
  const containerPaths = files.map((f) => f.containerPath as string);
  const pathSet = new Set(containerPaths);
  const existingRecords = await recordsFor(ctx, base, pathSet);
  const busy = existingRecords.filter((r) => r.s === STATUS_PROCESSING || r.s === STATUS_UNPROCESSED);
  if (busy.length > 0) {
    ctx.fail("FileFlows is already working on some of these files", [
      { label: "Files", value: busy.map((r) => r.dn.split("/").pop() ?? r.dn).join(", ") },
      { label: "Fix", value: "Wait for FileFlows to finish them, or remove them from its queue in the FileFlows app" },
    ]);
  }

  // Reserve every file first, inside the same try/finally that releases them, so a reservation
  // that fails part-way (a folder that refuses the lock file) strands nothing. Released when this
  // run is over, however it ends, and only the locks this run still owns.
  const owner = randomUUID();
  const held: string[] = [];
  let queued = false;
  const release = () => {
    for (const lock of held) releaseOwn(lock, owner);
  };
  try {
    const reservedElsewhere: string[] = [];
    const unknownDirs: string[] = [];
    for (const file of files) {
      const lock = outputs.get(file.containerPath as string)?.lock ?? reservationDirFor(localPathFor(ctx, file.path) as string);
      const state = reserve(lock, owner);
      if (state === "ours") held.push(lock);
      else if (state === "unknown") unknownDirs.push(`${RESERVATIONS_DIR}/${file.name}`);
      else reservedElsewhere.push(file.name);
    }
    if (unknownDirs.length > 0) {
      ctx.fail("A folder HexOS would use for the conversion already exists and holds other files", [
        { label: "Folders", value: unknownDirs.join(", ") },
        { label: "Fix", value: "Move or remove that folder, then try again" },
      ]);
    }
    if (reservedElsewhere.length > 0) {
      ctx.fail("Another conversion is already working on some of these files", [
        { label: "Files", value: reservedElsewhere.join(", ") },
        { label: "Fix", value: "Wait for it to finish, then try again" },
      ]);
    }
    const stillOwner = () => held.every((lock) => holds(lock, owner));
    try {
      await convert(
        ctx,
        base,
        files,
        outputs,
        existingRecords,
        stillOwner,
        () => {
          queued = true;
        },
        () => {
          queued = false; // FileFlows is done with every file: nothing is left running to protect
        },
      );
    } catch (error) {
      if (queued) {
        // FileFlows may still be converting. The reservations stay, marked abandoned, so the copy
        // it produces lands in a directory the next run on these files may take over at once
        // (once FileFlows is no longer busy with them) instead of in the user's folder.
        for (const lock of held) {
          if (!holds(lock, owner)) continue; // taken over already: its new owner's, not this run's to mark
          try {
            writeFileSync(`${lock}/abandoned`, String(Date.now()));
          } catch {}
        }
        held.length = 0;
      }
      throw error;
    }
  } finally {
    release();
  }
}

/** The conversion itself, run with every file's reservation held. */
async function convert(
  ctx: HookContext,
  base: string,
  files: NonNullable<HookContext["target"]>["files"],
  outputs: Map<string, { temp: string; final: string; lock: string }>,
  existingRecords: LibraryFileRecord[],
  stillOwner: () => boolean,
  onQueued: () => void,
  onSettled: () => void,
): Promise<void> {
  const containerPaths = files.map((f) => f.containerPath as string);
  const pathSet = new Set(containerPaths);
  // The action's own deadline, applied from inside: the platform's timeout abandons an entrypoint
  // without stopping it, so a run past the deadline stops itself before it touches a file again.
  const deadline = Date.now() + RUN_DEADLINE_MS;
  /**
   * A run the platform abandoned at its deadline keeps executing; once a later run has taken its
   * reservation over, this one must not touch the files again. Checked before every step that does.
   */
  const assertOwner = (): void => {
    if (Date.now() > deadline) {
      ctx.fail("The conversion ran past its deadline", [
        { label: "Details", value: "FileFlows may still finish it; run the conversion again later to pick up the result" },
      ]);
    }
    if (stillOwner()) return;
    ctx.fail("Another conversion took these files over after this one ran past its deadline", [
      { label: "Fix", value: "Nothing to do here; the newer conversion is handling them" },
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
  // bet on which fields matter. Rewriting it is not.
  const blessed = flowDefinition();
  assertOwner();
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
  // flow (this one from an earlier run included) is refused: deleting that record would cut
  // across work in progress, and a queued one may start between this read and the delete.
  assertOwner();
  const stale = existingRecords.filter((r) => r.fu === flowUid && (r.s === STATUS_PROCESSED || r.s === STATUS_FAILED));
  if (stale.length > 0) {
    assertOwner();
    await ctx.partnerRequestJson("fileflows", `${base}/api/library-file`, {
      method: "DELETE",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: { Uids: stale.map((r) => r.u) },
    });
  }

  // 3. Enqueue
  assertOwner();
  onQueued(); // attempted: an answer lost on the way does not mean FileFlows did not take the files
  await ctx.partnerRequestJson("fileflows", `${base}/api/library-file/manually-add`, {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: { FlowUid: flowUid, Files: containerPaths },
  });
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

  const handedOver = new Set<string>();
  const blocked: string[] = [];
  const missing: string[] = [];
  /**
   * The finished copy takes its final name once, through a link the kernel refuses if the name is
   * taken. Counted as handed over only once the final file exists; a temp that is not there when
   * FileFlows says the file is done is a failure, never a silent success.
   */
  const handOver = (containerPath: string): void => {
    if (handedOver.has(containerPath)) return;
    assertOwner(); // right before the file is touched; the poll's awaits are behind us
    const out = outputs.get(containerPath);
    const name = out?.final.split("/").pop() ?? containerPath;
    if (!out || !existsSync(out.temp)) {
      if (!missing.includes(name)) missing.push(name);
      return;
    }
    try {
      linkSync(out.temp, out.final);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // The copy stays in the reservation directory and goes with it at release.
      if (!blocked.includes(name)) blocked.push(name);
      handedOver.add(containerPath);
      return;
    }
    handedOver.add(containerPath);
  };

  for (;;) {
    await sleep(POLL_INTERVAL_MS);
    assertOwner();
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
      onSettled();
      for (const record of done) handOver(record.dn);
      if (missing.length > 0) {
        ctx.fail("FileFlows reported a conversion done but its output is not there", [
          { label: "Files", value: missing.join(", ") },
          { label: "Details", value: "Open the FileFlows app and check the file's processing log, then run the conversion again" },
        ]);
      }
      // An output that could not be published is this run's own file and goes with the reservation
      // at release, not kept for good beside the user's media.
      if (blocked.length > 0) {
        ctx.fail("A file of the converted copy's name appeared while converting; the copy was discarded", [
          { label: "Files", value: blocked.join(", ") },
          { label: "Fix", value: "Rename or move that file and run the conversion again" },
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
