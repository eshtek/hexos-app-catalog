import { Database } from "bun:sqlite";
import type { ContextMount, HookContext } from "../_lib/hook_context";

// HexOS gives Jellyfin one of the server's GPUs at install, but Jellyfin stays on software until
// told otherwise. One setting the GPU can't honour makes every transcode fail, so nothing is saved
// until a short test encode passes, and an owner's own choice is left alone. The platform runs this
// again after a restart that changes what the GPU can do, and after the owner picks another card
// for Jellyfin in HexOS: its settings then follow that card. This also limits remote streams.

const DOCKER_SOCKET = "/var/run/docker.sock";
const FFMPEG = "/usr/lib/jellyfin-ffmpeg/ffmpeg";
const VAINFO = "/usr/lib/jellyfin-ffmpeg/vainfo";
const DB_RELATIVE = "/data/jellyfin.db";
const ENCODING_PATH = "/System/Configuration/encoding";
const NETWORK_PATH = "/System/Configuration/network";
const SERVER_PATH = "/System/Configuration";
const HOOK_ID = "hardware-transcoding";
/** The most a stream outside the owner's network gets, in bits per second. */
const REMOTE_BITRATE_LIMIT = 20_000_000;
/** A test encode of a second of video takes under one on a Celeron. */
const COMMAND_TIMEOUT_MS = 30_000;
/** Long enough for Jellyfin to have gone, so the wait after a restart doesn't see the old process. */
const RESTART_GRACE_MS = 5_000;
const TEST_SOURCE = ["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=24", "-t", "1"];
const TEST_OUTPUT = ["-b:v", "8M", "-maxrate", "8M", "-f", "null", "-"];

/** Each codec Jellyfin can hand to the GPU, by the profile that shows the GPU can decode it. */
const DECODERS: Array<[profile: string, codec: string]> = [
  ["VAProfileH264High", "h264"],
  ["VAProfileHEVCMain", "hevc"],
  ["VAProfileMPEG2Main", "mpeg2video"],
  ["VAProfileVC1Advanced", "vc1"],
  ["VAProfileVP8Version0_3", "vp8"],
  ["VAProfileVP9Profile0", "vp9"],
  ["VAProfileAV1Profile0", "av1"],
];

export type Gpu =
  | { kind: "nvidia" }
  | {
      kind: "intel" | "amd";
      node: string;
      /** What the driver reports, as "<profile> <entrypoint>". */
      abilities: Set<string>;
    };

interface EncodingOptions {
  HardwareAccelerationType?: string;
  VaapiDevice?: string;
  QsvDevice?: string;
  [key: string]: unknown;
}

/** The card HexOS gave Jellyfin (`ctx.videoCard`), or null when it names none. */
type VideoCard = Awaited<ReturnType<NonNullable<HookContext["videoCard"]>>>;

const decodes = (gpu: Exclude<Gpu, { kind: "nvidia" }>, profile: string) =>
  gpu.abilities.has(`${profile} VAEntrypointVLD`);

/** Jasper Lake and Elkhart Lake, and newer Arc parts, have no regular encoder, only the low-power one. */
const lowPowerOnly = (gpu: Exclude<Gpu, { kind: "nvidia" }>, profile: string) =>
  gpu.kind === "intel" &&
  gpu.abilities.has(`${profile} VAEntrypointEncSliceLP`) &&
  !gpu.abilities.has(`${profile} VAEntrypointEncSlice`);

/**
 * Quick Sync is leaving Linux on chips older than Tiger Lake, and Jellyfin's docs send those to
 * VA-API, which also ran Coco's tone-mapped 4K twice as fast on a Celeron N5105. Those chips are
 * the ones that can't decode AV1.
 */
const usesQuickSync = (gpu: Exclude<Gpu, { kind: "nvidia" }>) => gpu.kind === "intel" && decodes(gpu, "VAProfileAV1Profile0");

/** The GPU's vendor and abilities from `vainfo`, or null when it reports neither vendor. */
export function parseVainfo(output: string, node: string): Gpu | null {
  const driver = output.match(/Driver version: (.*)/)?.[1] ?? "";
  const kind = /intel/i.test(driver) ? "intel" : /radeonsi|\bamd\b/i.test(driver) ? "amd" : null;
  if (!kind) return null;
  const abilities = new Set(
    [...output.matchAll(/(VAProfile\w+)\s*:\s*(VAEntrypoint\w+)/g)].map(([, profile, entrypoint]) => `${profile} ${entrypoint}`),
  );
  return { kind, node, abilities };
}

/** A second of generated video through the encoder Jellyfin would use, with the rate control it would use. */
export function testEncode(gpu: Gpu): string[] {
  const start = [FFMPEG, "-hide_banner", "-y"];
  if (gpu.kind === "nvidia") return [...start, ...TEST_SOURCE, "-c:v", "h264_nvenc", ...TEST_OUTPUT];
  const lowPower = lowPowerOnly(gpu, "VAProfileH264High") ? ["-low_power", "1"] : [];
  if (usesQuickSync(gpu)) {
    return [
      ...start,
      "-init_hw_device", `vaapi=va:${gpu.node},driver=iHD`,
      "-init_hw_device", "qsv=qs@va",
      "-filter_hw_device", "qs",
      ...TEST_SOURCE,
      "-vf", "format=nv12,hwupload=extra_hw_frames=16,format=qsv",
      "-c:v", "h264_qsv",
      ...lowPower,
      ...TEST_OUTPUT,
    ];
  }
  return [
    ...start,
    "-init_hw_device", `vaapi=va:${gpu.node}`,
    "-filter_hw_device", "va",
    ...TEST_SOURCE,
    "-vf", "format=nv12,hwupload",
    "-c:v", "h264_vaapi",
    ...lowPower,
    "-rc_mode", "VBR",
    ...TEST_OUTPUT,
  ];
}

/** Jellyfin's settings for this GPU. */
export function encodingSettings(gpu: Gpu): EncodingOptions {
  if (gpu.kind === "nvidia") {
    return {
      HardwareAccelerationType: "nvenc",
      EnableHardwareEncoding: true,
      HardwareDecodingCodecs: ["h264", "hevc"],
      EnableDecodingColorDepth10Hevc: true,
      EnableTonemapping: true,
    };
  }
  return {
    HardwareAccelerationType: usesQuickSync(gpu) ? "qsv" : "vaapi",
    VaapiDevice: gpu.node,
    QsvDevice: gpu.node,
    EnableHardwareEncoding: true,
    EnableIntelLowPowerH264HwEncoder: lowPowerOnly(gpu, "VAProfileH264High"),
    EnableIntelLowPowerHevcHwEncoder: lowPowerOnly(gpu, "VAProfileHEVCMain"),
    HardwareDecodingCodecs: DECODERS.filter(([profile]) => decodes(gpu, profile)).map(([, codec]) => codec),
    EnableDecodingColorDepth10Hevc: decodes(gpu, "VAProfileHEVCMain10"),
    EnableDecodingColorDepth10Vp9: decodes(gpu, "VAProfileVP9Profile2"),
    EnableTonemapping: true,
  };
}

/** Runs a command in Jellyfin's container, as Jellyfin's own user. */
export async function inContainer(ctx: HookContext, cmd: string[]): Promise<{ ok: boolean; output: string }> {
  const docker = (path: string, body?: unknown) =>
    fetch(`http://docker${path}`, {
      unix: DOCKER_SOCKET,
      signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
      ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
  try {
    const container = `ix-${ctx.resourceId}-${ctx.resourceId}-1`;
    const created = await docker(`/containers/${container}/exec`, { Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: true });
    if (!created.ok) return { ok: false, output: "" };
    const { Id } = (await created.json()) as { Id: string };
    const output = await (await docker(`/exec/${Id}/start`, { Detach: false, Tty: true })).text();
    const { ExitCode } = (await (await docker(`/exec/${Id}/json`)).json()) as { ExitCode: number };
    return { ok: ExitCode === 0, output };
  } catch {
    return { ok: false, output: "" };
  }
}

/** Each render node with the PCI device behind it: "/dev/dri/renderD128 /sys/devices/pci0000:00/0000:00:02.0". */
const RENDER_NODE_DEVICES = 'for n in /dev/dri/renderD*; do echo "$n $(readlink -f "/sys/class/drm/${n##*/}/device")"; done';

/**
 * The render node of the card at `pciSlot`. The container gets every Intel and AMD card's node at
 * once, numbered in the order the kernel found them, so the slot is what says which is which.
 */
async function renderNodeOf(ctx: HookContext, pciSlot: string): Promise<string | undefined> {
  const listed = await inContainer(ctx, ["sh", "-c", RENDER_NODE_DEVICES]);
  if (!listed.ok) return undefined;
  for (const line of listed.output.split(/\r?\n/)) {
    const [node, device] = line.trim().split(/\s+/);
    if (node && device?.toLowerCase().endsWith(`/${pciSlot.toLowerCase()}`)) return node;
  }
  return undefined;
}

async function readGpu(ctx: HookContext, node: string): Promise<Gpu | null> {
  const info = await inContainer(ctx, [VAINFO, "--display", "drm", "--device", node]);
  return info.ok ? parseVainfo(info.output, node) : null;
}

/**
 * The GPU Jellyfin uses. With a card from HexOS it is that card: an NVIDIA card through its driver,
 * an Intel or AMD card through its own render node, or the first node that answers when its own
 * can't be told. A box that names no card gets what the container can reach: an NVIDIA card first,
 * then the first render node that answers.
 */
export async function detectGpu(ctx: HookContext, card?: VideoCard): Promise<Gpu | null> {
  if (card?.pciSlot && card.vendor === "NVIDIA") {
    return (await inContainer(ctx, ["nvidia-smi", "-L"])).ok ? { kind: "nvidia" } : null;
  }
  if (card?.pciSlot) {
    const node = await renderNodeOf(ctx, card.pciSlot);
    if (node) return readGpu(ctx, node);
  } else if ((await inContainer(ctx, ["nvidia-smi", "-L"])).ok) {
    return { kind: "nvidia" };
  }
  const nodes = await inContainer(ctx, ["sh", "-c", "ls /dev/dri/renderD*"]);
  for (const node of nodes.ok ? nodes.output.split(/\s+/).filter(Boolean) : []) {
    const gpu = await readGpu(ctx, node);
    if (gpu) return gpu;
  }
  return null;
}

/** Whether Jellyfin's settings already send its video through this GPU. */
function alreadyUses(current: EncodingOptions, gpu: Gpu): boolean {
  const type = current.HardwareAccelerationType;
  if (gpu.kind === "nvidia") return type === "nvenc";
  if (type === "qsv") return current.QsvDevice === gpu.node;
  return type === "vaapi" && current.VaapiDevice === gpu.node;
}

function storedToken(ctx: HookContext): string | null {
  const config: ContextMount | undefined =
    ctx.mounts.find((m) => m.containerPath === "/config") ?? ctx.mounts.find((m) => m.hostPath.endsWith("/jellyfin/config"));
  if (!config) return null;
  let db: Database | undefined;
  try {
    db = new Database(config.localPath + DB_RELATIVE, { readonly: true });
    return db.query<{ AccessToken: string }, []>("SELECT AccessToken FROM ApiKeys ORDER BY DateCreated DESC LIMIT 1").get()?.AccessToken ?? null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** The address Docker's host side has on Jellyfin's network, which is where HexOS's gateway reaches it from. */
async function dockerGateway(ctx: HookContext): Promise<string | undefined> {
  try {
    const container = `ix-${ctx.resourceId}-${ctx.resourceId}-1`;
    const answer = await fetch(`http://docker/containers/${container}/json`, { unix: DOCKER_SOCKET, signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS) });
    if (!answer.ok) return undefined;
    const { NetworkSettings } = (await answer.json()) as { NetworkSettings?: { Networks?: Record<string, { Gateway?: string }> } };
    return Object.values(NetworkSettings?.Networks ?? {}).find((network) => network.Gateway)?.Gateway;
  } catch {
    return undefined;
  }
}

/**
 * Limits streams from outside the owner's network, unless the owner has set a limit. Remote access
 * reaches Jellyfin from Docker's gateway, a private address it would count as local, so the gateway
 * is trusted to name the real client. Jellyfin reads that only as it starts, so it restarts once.
 */
async function limitRemoteStreams(ctx: HookContext, headers: Record<string, string>): Promise<void> {
  const load = async <T>(path: string): Promise<T> => {
    const answer = await fetch(`${ctx.baseUrl}${path}`, { headers });
    if (!answer.ok) throw new Error(`Jellyfin's settings didn't load (${answer.status})`);
    return (await answer.json()) as T;
  };
  const save = async (path: string, body: unknown): Promise<void> => {
    const answer = await fetch(`${ctx.baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!answer.ok) throw new Error(`Jellyfin refused its settings (${answer.status})`);
  };

  const server = await load<{ RemoteClientBitrateLimit?: number }>(SERVER_PATH);
  if (!server.RemoteClientBitrateLimit) await save(SERVER_PATH, { ...server, RemoteClientBitrateLimit: REMOTE_BITRATE_LIMIT });

  const gateway = await dockerGateway(ctx);
  const network = await load<{ KnownProxies?: string[] }>(NETWORK_PATH);
  if (!gateway || network.KnownProxies?.includes(gateway)) return;
  await save(NETWORK_PATH, { ...network, KnownProxies: [...(network.KnownProxies ?? []), gateway] });
  await save("/System/Restart", {});
  await ctx.sleep(RESTART_GRACE_MS);
  await ctx.waitForApp("/health");
}

export async function run(ctx: HookContext): Promise<void> {
  await ctx.waitForApp("/health");
  const token = storedToken(ctx);
  if (!token) {
    ctx.log("No Jellyfin key to change its settings with, so it stays on software transcoding.");
    return;
  }
  const headers = { Authorization: `MediaBrowser Token="${token}"`, "Content-Type": "application/json" };
  await enableHardware(ctx, headers);
  await limitRemoteStreams(ctx, headers);
}

async function enableHardware(ctx: HookContext, headers: Record<string, string>): Promise<void> {
  const answer = await fetch(`${ctx.baseUrl}${ENCODING_PATH}`, { headers });
  if (!answer.ok) throw new Error(`Jellyfin's encoding settings didn't load (${answer.status})`);
  const current = (await answer.json()) as EncodingOptions;
  const save = async (settings: EncodingOptions): Promise<void> => {
    const saved = await fetch(`${ctx.baseUrl}${ENCODING_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...current, ...settings }),
    });
    if (!saved.ok) throw new Error(`Jellyfin refused the hardware settings (${saved.status})`);
  };
  const isSet = !!current.HardwareAccelerationType && current.HardwareAccelerationType !== "none";
  // Absent on a box from before it, and null when HexOS names no single card: both look as before.
  const card = (await ctx.videoCard?.().catch(() => null)) ?? null;
  const pickedByOwner = card?.picked === true;

  if (pickedByOwner && card.pciSlot === null) {
    // The acceleration Jellyfin had would now fail every transcode, since its card is gone.
    if (isSet) {
      await save({ HardwareAccelerationType: "none" });
      ctx.log("Jellyfin has no graphics card in HexOS now, so it is back on software transcoding.");
    }
    return;
  }
  // Only a card the owner picked in HexOS moves an acceleration that is already set.
  if (isSet && !pickedByOwner) {
    ctx.log(`Jellyfin already uses ${current.HardwareAccelerationType}, so it is left as it is.`);
    return;
  }

  // What Jellyfin is left on when the card can't be set up: an acceleration it already had stays.
  const leftOn = isSet ? "its settings are left as they were" : "it stays on software transcoding";
  const gpu = await detectGpu(ctx, card);
  if (!gpu) {
    ctx.log(`No GPU Jellyfin can use, so ${leftOn}.`);
    return;
  }
  if (isSet && alreadyUses(current, gpu)) {
    ctx.log(`Jellyfin already uses the ${gpu.kind} GPU picked in HexOS, so it is left as it is.`);
    return;
  }
  if (!(await inContainer(ctx, testEncode(gpu))).ok) {
    // A low-power Intel chip can need firmware that only loads at boot. The platform sets that up
    // and runs this hook again after the restart.
    const restart = await ctx.prepareHardwareVideo?.({ rerunHook: HOOK_ID });
    ctx.log(
      restart?.restartNeeded
        ? `This GPU needs a server restart first. Until then ${leftOn}.`
        : `The ${gpu.kind} GPU failed a test encode, so ${leftOn}.`,
    );
    return;
  }

  // Every setting is the card's own, decoders included: one the new card can't decode would fail.
  await save(encodingSettings(gpu));
  ctx.log(`Hardware transcoding is on, through the ${gpu.kind} GPU.`);
}
