import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodingSettings, type Gpu, parseVainfo, run, testEncode } from "../jellyfin/hardware_transcoding";
import type { HookContext } from "./hook_context";

// HexOS gives Jellyfin the GPU, and this turns it on. A wrong setting makes every transcode fail with
// a fatal player error, so these hold what gets saved, and when nothing does.

const NODE = "/dev/dri/renderD128";
const GATEWAY = "172.16.5.1";
const SERVER_PATH = "/System/Configuration";
const NETWORK_PATH = "/System/Configuration/network";
const profiles = (...rows: string[]) => rows.map((row) => `      ${row.replace(" ", "   :\t")}`).join("\n");

/** What a Celeron N5105 reports: low-power encoders only, and no AV1. */
const JASPER_LAKE = `libva info: VA-API version 1.24.0
vainfo: Driver version: Intel iHD driver for Intel(R) Gen Graphics - 26.3.5 (1b5e662)
vainfo: Supported profile and entrypoints
${profiles(
  "VAProfileMPEG2Main VAEntrypointVLD",
  "VAProfileH264High VAEntrypointVLD",
  "VAProfileH264High VAEntrypointEncSliceLP",
  "VAProfileVC1Advanced VAEntrypointVLD",
  "VAProfileVP8Version0_3 VAEntrypointVLD",
  "VAProfileHEVCMain VAEntrypointVLD",
  "VAProfileHEVCMain VAEntrypointEncSliceLP",
  "VAProfileHEVCMain10 VAEntrypointVLD",
  "VAProfileVP9Profile0 VAEntrypointVLD",
  "VAProfileVP9Profile2 VAEntrypointVLD",
)}`;
const TIGER_LAKE = `vainfo: Driver version: Intel iHD driver for Intel(R) Gen Graphics - 26.3.5
${profiles(
  "VAProfileH264High VAEntrypointVLD",
  "VAProfileH264High VAEntrypointEncSlice",
  "VAProfileH264High VAEntrypointEncSliceLP",
  "VAProfileHEVCMain VAEntrypointVLD",
  "VAProfileHEVCMain VAEntrypointEncSlice",
  "VAProfileAV1Profile0 VAEntrypointVLD",
)}`;
const SKYLAKE = `vainfo: Driver version: Intel iHD driver for Intel(R) Gen Graphics - 26.3.5
${profiles("VAProfileH264High VAEntrypointVLD", "VAProfileH264High VAEntrypointEncSlice", "VAProfileHEVCMain VAEntrypointVLD")}`;
const RADEON = `vainfo: Driver version: Mesa Gallium driver 25.1 for AMD Radeon Graphics (radeonsi, renoir)
${profiles("VAProfileH264High VAEntrypointVLD", "VAProfileH264High VAEntrypointEncSlice", "VAProfileHEVCMain10 VAEntrypointVLD")}`;

const gpu = (output: string) => parseVainfo(output, NODE) as Gpu;

describe("the settings for a GPU", () => {
  test("a Celeron N5105 gets VA-API, its low-power encoders, and only the decoders it reports", () => {
    expect(encodingSettings(gpu(JASPER_LAKE))).toEqual({
      HardwareAccelerationType: "vaapi",
      VaapiDevice: NODE,
      QsvDevice: NODE,
      EnableHardwareEncoding: true,
      EnableIntelLowPowerH264HwEncoder: true,
      EnableIntelLowPowerHevcHwEncoder: true,
      HardwareDecodingCodecs: ["h264", "hevc", "mpeg2video", "vc1", "vp8", "vp9"],
      EnableDecodingColorDepth10Hevc: true,
      EnableDecodingColorDepth10Vp9: true,
      EnableTonemapping: true,
    });
  });

  test("a GPU that decodes AV1 gets it, and stays on Quick Sync", () => {
    const settings = encodingSettings(gpu(TIGER_LAKE));
    expect(settings.HardwareDecodingCodecs).toEqual(["h264", "hevc", "av1"]);
    expect(settings.HardwareAccelerationType).toBe("qsv");
  });

  test("a chip with regular encoders doesn't get the low-power ones", () => {
    const settings = encodingSettings(gpu(TIGER_LAKE));
    expect(settings.EnableIntelLowPowerH264HwEncoder).toBe(false);
    expect(settings.EnableIntelLowPowerHevcHwEncoder).toBe(false);
  });

  test("an older Intel chip goes through VA-API, where Quick Sync is leaving Linux", () => {
    expect(encodingSettings(gpu(SKYLAKE)).HardwareAccelerationType).toBe("vaapi");
  });

  test("a 10-bit decoder the GPU doesn't report stays off", () => {
    const settings = encodingSettings(gpu(SKYLAKE));
    expect(settings.EnableDecodingColorDepth10Hevc).toBe(false);
    expect(settings.EnableDecodingColorDepth10Vp9).toBe(false);
  });

  test("an AMD GPU goes through VA-API, with no Intel low-power encoder", () => {
    const settings = encodingSettings(gpu(RADEON));
    expect(settings.HardwareAccelerationType).toBe("vaapi");
    expect(settings.EnableIntelLowPowerH264HwEncoder).toBe(false);
  });

  test("an AMD GPU that decodes AV1 gets the decoder, and still no Quick Sync, which is Intel's", () => {
    const settings = encodingSettings(gpu(`${RADEON}\n${profiles("VAProfileAV1Profile0 VAEntrypointVLD")}`));
    expect(settings.HardwareAccelerationType).toBe("vaapi");
    expect(settings.HardwareDecodingCodecs).toContain("av1");
  });

  test("an NVIDIA card gets NVENC, and the two decoders every card it can run on has", () => {
    const settings = encodingSettings({ kind: "nvidia" });
    expect(settings.HardwareAccelerationType).toBe("nvenc");
    expect(settings.HardwareDecodingCodecs).toEqual(["h264", "hevc"]);
  });

  test("an unknown driver is no GPU to set up", () => {
    expect(parseVainfo("vainfo: Driver version: Something Else 1.0", NODE)).toBeNull();
    expect(parseVainfo("", NODE)).toBeNull();
  });
});

describe("the test encode", () => {
  test("a low-power-only chip tests its low-power encoder at a set bitrate, what failed without HuC", () => {
    const args = testEncode(gpu(JASPER_LAKE)).join(" ");
    expect(args).toContain("-c:v h264_vaapi -low_power 1 -rc_mode VBR -b:v 8M");
    expect(args).toContain(`vaapi=va:${NODE}`);
  });

  test("a Quick Sync chip tests Quick Sync, with no low-power flag it doesn't need", () => {
    const args = testEncode(gpu(TIGER_LAKE)).join(" ");
    expect(args).toContain("-c:v h264_qsv");
    expect(args).not.toContain("-low_power");
  });

  test("an AMD GPU tests VA-API with no low-power flag, and an NVIDIA card tests NVENC", () => {
    expect(testEncode(gpu(RADEON)).join(" ")).toContain("-c:v h264_vaapi -rc_mode VBR");
    expect(testEncode(gpu(RADEON))).not.toContain("-low_power");
    expect(testEncode({ kind: "nvidia" }).join(" ")).toContain("-c:v h264_nvenc");
  });
});

describe("the hook", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  interface World {
    current?: Record<string, unknown>;
    nvidia?: boolean;
    nodes?: string;
    vainfo?: string;
    encodes?: boolean;
    saveStatus?: number;
    restartNeeded?: boolean;
    prepare?: "absent";
    token?: boolean;
    server?: Record<string, unknown>;
    network?: Record<string, unknown>;
    gateway?: string | null;
  }

  async function hook(world: World) {
    const dir = mkdtempSync(join(tmpdir(), "hexos-jellyfin-"));
    mkdirSync(join(dir, "data"));
    const db = new Database(join(dir, "data/jellyfin.db"));
    db.run("CREATE TABLE ApiKeys (AccessToken TEXT, DateCreated TEXT)");
    if (world.token !== false) db.run("INSERT INTO ApiKeys VALUES ('key', '2026-01-01')");
    db.close();

    const saved: Array<Record<string, unknown>> = [];
    const posted: Record<string, Record<string, unknown>> = {};
    const calls: string[] = [];
    const commands: string[][] = [];
    const logs: string[] = [];
    const prepared: unknown[] = [];
    let lastExec: { ok: boolean; output: string } = { ok: false, output: "" };

    const answerExec = (cmd: string[]) => {
      if (cmd[0] === "nvidia-smi") return { ok: world.nvidia === true, output: "" };
      if (cmd[0] === "sh") return { ok: world.nodes !== "", output: world.nodes ?? `${NODE}\r\n` };
      if (cmd[0]?.endsWith("vainfo")) return { ok: world.vainfo !== undefined, output: world.vainfo ?? "" };
      return { ok: world.encodes !== false, output: "" };
    };

    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://docker")) {
        const path = new URL(url).pathname;
        if (path.endsWith("/exec")) {
          const { Cmd } = JSON.parse(String(init?.body)) as { Cmd: string[] };
          commands.push(Cmd);
          lastExec = answerExec(Cmd);
          expect(path).toBe("/containers/ix-jellyfin-jellyfin-1/exec");
          return Response.json({ Id: "run" });
        }
        if (path.endsWith("/start")) return new Response(lastExec.output);
        if (path.endsWith("/containers/ix-jellyfin-jellyfin-1/json")) {
          const gateway = world.gateway === undefined ? GATEWAY : world.gateway;
          return Response.json({ NetworkSettings: { Networks: gateway ? { ix: { Gateway: gateway } } : {} } });
        }
        return Response.json({ ExitCode: lastExec.ok ? 0 : 1 });
      }
      expect(new Headers(init?.headers).get("Authorization")).toBe('MediaBrowser Token="key"');
      const path = new URL(url).pathname;
      if (init?.method === "POST") {
        calls.push(`POST ${path}`);
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posted[path] = body;
        if (path.endsWith("/encoding")) {
          saved.push(body);
          return new Response(null, { status: world.saveStatus ?? 204 });
        }
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/network")) return Response.json(world.network ?? { KnownProxies: [], EnableIPv6: false });
      if (path.endsWith("/encoding")) return Response.json(world.current ?? { HardwareAccelerationType: "none", TonemappingPeak: 100 });
      return Response.json(world.server ?? { RemoteClientBitrateLimit: 0, ServerName: "Mine" });
    }) as typeof fetch;

    const ctx = {
      resourceId: "jellyfin",
      baseUrl: "http://app",
      mounts: [{ hostPath: "/mnt/pool/jellyfin/config", containerPath: "/config", localPath: dir }],
      log: (message: string) => logs.push(message),
      waitForApp: async () => {
        calls.push("wait");
        return new Response();
      },
      sleep: async () => {},
      ...(world.prepare === "absent"
        ? {}
        : {
            prepareHardwareVideo: async (options: unknown) => {
              prepared.push(options);
              return { restartNeeded: world.restartNeeded === true };
            },
          }),
    } as unknown as HookContext;

    let failure: unknown;
    await run(ctx).catch((error: unknown) => {
      failure = error;
    });
    return { saved, posted, calls, commands, logs, prepared, failure };
  }

  test("a GPU that passes is saved over Jellyfin's other settings", async () => {
    const { saved, failure } = await hook({ vainfo: JASPER_LAKE });
    expect(failure).toBeUndefined();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ HardwareAccelerationType: "vaapi", TonemappingPeak: 100 });
  });

  test.each(["qsv", "vaapi", "nvenc", "amf"])("an owner's own %s is left alone, and the GPU isn't touched", async (type) => {
    const { saved, commands } = await hook({ current: { HardwareAccelerationType: type }, vainfo: JASPER_LAKE });
    expect(saved).toEqual([]);
    expect(commands).toEqual([]);
  });

  test("a failed test encode saves nothing, because a setting that fails stops every transcode", async () => {
    const { saved, logs } = await hook({ vainfo: JASPER_LAKE, encodes: false });
    expect(saved).toEqual([]);
    expect(logs.join(" ")).toContain("stays on software transcoding");
  });

  test("a failed test asks the platform to ready the firmware, and to run this again after", async () => {
    const { saved, prepared, logs } = await hook({ vainfo: JASPER_LAKE, encodes: false, restartNeeded: true });
    expect(saved).toEqual([]);
    expect(prepared).toEqual([{ rerunHook: "hardware-transcoding" }]);
    expect(logs.join(" ")).toContain("needs a server restart");
  });

  test("a passing test doesn't touch the firmware", async () => {
    expect((await hook({ vainfo: JASPER_LAKE })).prepared).toEqual([]);
  });

  test("a box whose image predates the firmware step stays on software, and doesn't fail", async () => {
    const { saved, failure } = await hook({ vainfo: JASPER_LAKE, encodes: false, prepare: "absent" });
    expect(saved).toEqual([]);
    expect(failure).toBeUndefined();
  });

  test("no GPU saves nothing and runs no encode", async () => {
    const { saved, commands } = await hook({ nodes: "" });
    expect(saved).toEqual([]);
    expect(commands.some((cmd) => cmd[0]?.endsWith("ffmpeg"))).toBe(false);
  });

  test("a GPU vainfo can't read saves nothing", async () => {
    expect((await hook({ vainfo: undefined })).saved).toEqual([]);
  });

  test("an NVIDIA card is found first, and tested", async () => {
    const { saved, commands } = await hook({ nvidia: true });
    expect(saved[0]).toMatchObject({ HardwareAccelerationType: "nvenc" });
    expect(commands.at(-1)?.join(" ")).toContain("h264_nvenc");
  });

  test("the next render node is tried when the first isn't a GPU it can read", async () => {
    const { commands, saved } = await hook({ nodes: `${NODE}\r\n/dev/dri/renderD129\r\n`, vainfo: JASPER_LAKE });
    expect(commands.filter((cmd) => cmd[0]?.endsWith("vainfo"))).toHaveLength(1);
    expect(saved).toHaveLength(1);
  });

  test("with no key to change settings with, it stays on software and doesn't fail", async () => {
    const { saved, commands, failure } = await hook({ token: false, vainfo: JASPER_LAKE });
    expect(saved).toEqual([]);
    expect(commands).toEqual([]);
    expect(failure).toBeUndefined();
  });

  describe("remote streams", () => {
    test("a stream from outside is limited to 20 Mbps, and Jellyfin's other settings stay", async () => {
      const { posted } = await hook({ vainfo: JASPER_LAKE });
      expect(posted[SERVER_PATH]).toEqual({ RemoteClientBitrateLimit: 20_000_000, ServerName: "Mine" });
    });

    test("an owner's own limit stays", async () => {
      const { posted } = await hook({ vainfo: JASPER_LAKE, server: { RemoteClientBitrateLimit: 8_000_000 } });
      expect(posted[SERVER_PATH]).toBeUndefined();
    });

    test("the limit is set with no GPU to use, and when the owner chose their own acceleration", async () => {
      expect((await hook({ nodes: "" })).posted[SERVER_PATH]).toBeDefined();
      expect((await hook({ current: { HardwareAccelerationType: "qsv" } })).posted[SERVER_PATH]).toBeDefined();
    });

    test("Docker's gateway is trusted to name the client, or remote access would count as local", async () => {
      const { posted } = await hook({ vainfo: JASPER_LAKE, network: { KnownProxies: ["10.1.1.1"], EnableIPv6: false } });
      expect(posted[NETWORK_PATH]).toEqual({ KnownProxies: ["10.1.1.1", GATEWAY], EnableIPv6: false });
    });

    test("Jellyfin restarts after that, last, and the hook waits for it to come back", async () => {
      const { calls } = await hook({ vainfo: JASPER_LAKE });
      expect(calls.slice(-3)).toEqual([`POST ${NETWORK_PATH}`, "POST /System/Restart", "wait"]);
    });

    test("run again, nothing restarts Jellyfin", async () => {
      const { calls, posted } = await hook({ vainfo: JASPER_LAKE, network: { KnownProxies: [GATEWAY] } });
      expect(calls).not.toContain("POST /System/Restart");
      expect(posted[NETWORK_PATH]).toBeUndefined();
    });

    test("with no gateway to trust, nothing restarts Jellyfin", async () => {
      const { calls } = await hook({ vainfo: JASPER_LAKE, gateway: null });
      expect(calls).not.toContain("POST /System/Restart");
    });
  });

  test("a save Jellyfin refuses fails the step, so the owner can see it", async () => {
    const { failure } = await hook({ vainfo: JASPER_LAKE, saveStatus: 500 });
    expect(String(failure)).toContain("refused the hardware settings");
  });
});
