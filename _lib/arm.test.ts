import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AFTER_RIP_PY, applySettings, drivesWithoutSdf, OMDB_KEY_ENV, omdbKeyFromValues, wantedSettings, withSdfStop } from "../arm/configure";
import { downloadsAs, libraryAs, seenAt } from "../arm/connect_manager";
import { composeScriptProblems } from "./compose";

const read = (name: string) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf-8"));
const script = read("ripping-machine.json");

describe("Automatic Ripping Machine's settings", () => {
  const ARM_YAML = ["# Skip transcoding", "SKIP_TRANSCODE: false", 'RIPMETHOD: "backup"', "MAINFEATURE: false", 'OMDB_API_KEY: ""', ""].join("\n");

  test("a rip keeps the disc's quality, and ARM's comments and other settings stay", () => {
    const next = applySettings(ARM_YAML, wantedSettings("abc12345"));
    expect(next).toContain("SKIP_TRANSCODE: true\n");
    expect(next).toContain('RIPMETHOD: "mkv"\n');
    expect(next).toContain('OMDB_API_KEY: "abc12345"\n');
    expect(next).toContain("# Skip transcoding\n");
    expect(next).toContain("MAINFEATURE: false\n");
    expect(applySettings(next, wantedSettings("abc12345"))).toBe(next);
  });

  test("an empty answer leaves a key the owner typed in ARM itself", () => {
    const typed = ARM_YAML.replace('OMDB_API_KEY: ""', 'OMDB_API_KEY: "typedinarm"');
    expect(applySettings(typed, wantedSettings(""))).toContain('OMDB_API_KEY: "typedinarm"\n');
  });

  test("the hook reads the key from the env the script writes the answer to", () => {
    expect(script.app_values.services.ripper.environment[OMDB_KEY_ENV]).toBe("$QUESTION(omdb_api_key)");
    expect(omdbKeyFromValues({ services: { ripper: { environment: { [OMDB_KEY_ENV]: " abc12345 " } } } })).toBe("abc12345");
    expect(omdbKeyFromValues({})).toBe("");
  });
});

// MakeMKV 1.18.4's debug log on a server with two Pioneer BDR-S11 on firmware 1.53 and a VM's
// emulated drive (2026-11-18). With a disc in a Pioneer the scan hung after "SDF auto".
const DEBUG_LOG = [
  "Debug log started at Wed Nov 18 09:41:44 2026 , written by MakeMKV v1.18.4 linux(x64-release)",
  "001003:0020 DEBUG: Code 0 at KG]XmhY0,A.yRLL3a@B-s>:29393631",
  "No  SDF v0a6: PIONEER_BD-RW___BDR-S11_1.53_NEDL010153WL",
  "SDF auto v0a6: PIONEER_BD-RW___BDR-S11_1.53_NEDL010153WL",
  "No  SDF v0a6: PIONEER_BD-RW___BDR-S11_1.53_NCDL003599WL",
  "SDF id v0a6: PIONEER_BD-RW___BDR-S11_1.53_NCDL003599WL",
  "No  SDF v0a6: QEMU_QEMU_DVD-ROM_2.5+",
  "",
].join("\n");

describe("drives MakeMKV has no LibreDrive data for", () => {
  test("each is named once, from the debug log", () => {
    expect(drivesWithoutSdf(DEBUG_LOG)).toEqual(["PIONEER_BD-RW___BDR-S11_1.53_NEDL010153WL", "PIONEER_BD-RW___BDR-S11_1.53_NCDL003599WL", "QEMU_QEMU_DVD-ROM_2.5+"]);
    expect(drivesWithoutSdf("SDF v0a6: SOME_DRIVE\n")).toEqual([]);
  });

  test("they go in sdf_Stop beside MakeMKV's key, and a second run changes nothing", () => {
    const once = withSdfStop('app_Key = "T-key"\n', ["DRIVE_A", "DRIVE_B"]);
    expect(once).toBe('app_Key = "T-key"\nsdf_Stop = "DRIVE_A DRIVE_B"\n');
    expect(withSdfStop(once, ["DRIVE_B"])).toBe(once);
    expect(withSdfStop(once, ["DRIVE_C"])).toBe('app_Key = "T-key"\nsdf_Stop = "DRIVE_A DRIVE_B DRIVE_C"\n');
    expect(withSdfStop("", [])).toBe("");
    expect(withSdfStop("", ["DRIVE_A"])).toBe('sdf_Stop = "DRIVE_A"\n');
  });
});

describe("Automatic Ripping Machine's script", () => {
  test("the ripper alone is privileged, and the script says it wants the optical drives", () => {
    expect(script.requirements.optical_drives).toBe(true);
    expect(script.app_values.services.ripper.privileged).toBe(true);
    expect(script.app_values.services.dashboard.privileged).toBeUndefined();
    expect(composeScriptProblems(script, { processed: false })).toEqual([]);
  });

  test("without that requirement, the same script is refused", () => {
    const { optical_drives: _asked, ...requirements } = script.requirements;
    expect(composeScriptProblems({ ...script, requirements }, { processed: false }).join(" ")).toContain("privileged is refused");
  });

  test("rips land in ARM's own folder in Downloads, which Radarr and Sonarr each make and link to", () => {
    expect(script.app_values.services.ripper.volumes).toContain("$LOCATION(Downloads)/arm:/home/arm/media");
    for (const name of ["radarr", "sonarr"]) {
      const manager = read(`${name}.json`);
      expect(manager.requirements.shared_folders).toContain("$LOCATION(Downloads)/arm");
      expect(manager.ensure_directories_exists).toContainEqual({ path: "$LOCATION(Downloads)/arm" });
      expect(manager.hooks.find((hook: { id: string }) => hook.id === "connect-arm")).toMatchObject({ kind: "connect", script: "arm/connect_manager.ts", entrypoint: name });
    }
  });

  test("it is a download client of the Media library collection", () => {
    const download = read("_collections/media-management.json").groups.find((group: { id: string }) => group.id === "download");
    expect(download.options.map((option: { app: string }) => option.app)).toContain("ripping-machine");
  });

  test("the hook's copy of the after-rip script is the file beside it", () => {
    expect(AFTER_RIP_PY).toBe(readFileSync(new URL("../arm/after_rip.py", import.meta.url), "utf-8"));
  });
});

describe("the link to Radarr and Sonarr", () => {
  const arm = [{ hostPath: "/mnt/tank/Downloads/arm", containerPath: "/home/arm/media" }];
  const manager = [
    { hostPath: "/mnt/tank/Applications/radarr/config", containerPath: null },
    { hostPath: "/mnt/tank/Downloads", containerPath: "/downloads" },
    { hostPath: "/mnt/tank/Downloads/qbittorrent", containerPath: "/config/Downloads" },
  ];

  test("a folder is seen through the mount that holds it most closely", () => {
    expect(seenAt("/mnt/tank/Downloads/arm", manager)).toBe("/downloads/arm");
    expect(seenAt("/mnt/tank/Downloads/qbittorrent/done", manager)).toBe("/config/Downloads/done");
    expect(seenAt("/mnt/tank/Downloads2", manager)).toBeUndefined();
  });

  test("the library is named as each sees it only when ARM mounts a folder that holds it", () => {
    const radarr = [...manager, { hostPath: "/mnt/tank/Movies", containerPath: "/movies" }];
    expect(libraryAs("/movies", radarr, [...arm, { hostPath: "/mnt/tank/Movies", containerPath: "/library/movies" }])).toEqual({ arm: "/library/movies", manager: "/movies" });
    expect(libraryAs("/movies/4K", radarr, [...arm, { hostPath: "/mnt/tank/Movies", containerPath: "/library/movies" }])).toEqual({ arm: "/library/movies/4K", manager: "/movies/4K" });
    expect(libraryAs("/movies", radarr, arm)).toBeUndefined();
  });

  test("the link names ARM's folder as ARM and as the manager see it, or nothing when the manager can't", () => {
    expect(downloadsAs(arm, manager)).toEqual({ arm: "/home/arm/media", manager: "/downloads/arm" });
    expect(downloadsAs(arm, [manager[0]])).toBeUndefined();
  });
});

const python = Bun.which("python3");

// What ffprobe 4.4.2, the one in ARM's image, reported for two real UHD rips (2026-11-18). It names
// neither Dolby Vision nor Atmos, which the script reads from the file's bytes instead.
const INTERSTELLAR = [
  { codec_type: "video", codec_name: "hevc", profile: "Main 10", width: 3840, height: 2160, color_transfer: "smpte2084", color_primaries: "bt2020" },
  { codec_type: "audio", codec_name: "dts", profile: "DTS-HD MA", channels: 6, channel_layout: "5.1(side)" },
];
const FALLOUT = [
  { codec_type: "video", codec_name: "hevc", profile: "Main 10", width: 3840, height: 2160, color_transfer: "smpte2084", color_primaries: "bt2020" },
  { codec_type: "audio", codec_name: "truehd", channels: 8, channel_layout: "7.1" },
];
// Fallout season one's episode lengths in minutes, as an episode list gives them
const SEASON = [74, 65, 56, 50, 46, 49, 59, 58].map((runtime, at) => ({ episodeNumber: at + 1, seasonNumber: 1, runtime }));

// The after-rip script runs inside ARM's container, on its Python. A machine with no python3 can't run it.
describe.skipIf(!python)("the after-rip script", () => {
  const file = join(import.meta.dir, "..", "arm", "after_rip.py");
  const ask = (flag: string, asked: unknown) => Bun.spawnSync([python as string, file, flag, JSON.stringify(asked)]).stdout.toString().trim();
  const name = (asked: Record<string, unknown>) => ask("--release-name", asked);
  const decide = (asked: Record<string, unknown>) => JSON.parse(ask("--decide", asked));

  test("release names for a UHD movie, a UHD episode, a Blu-ray and a DVD", () => {
    expect(name({ title: "Interstellar", year: "2014", disctype: "bluray", streams: INTERSTELLAR })).toBe("Interstellar.2014.2160p.UHD.BluRay.REMUX.HDR.HEVC.DTS-HD.MA.5.1-MyOwnMedia");
    expect(name({ title: "Fallout", episode: "S01E01", disctype: "bluray", streams: FALLOUT, dv: true, atmos: true })).toBe(
      "Fallout.S01E01.2160p.UHD.BluRay.REMUX.DV.HDR.HEVC.TrueHD.7.1.Atmos-MyOwnMedia",
    );
    const bluray = [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080 }, { codec_type: "audio", codec_name: "dts", profile: "DTS-HD MA", channels: 6 }];
    const dvd = [{ codec_type: "video", codec_name: "mpeg2video", width: 720, height: 480 }, { codec_type: "audio", codec_name: "ac3", channels: 6 }];
    expect(name({ title: "Big Buck Bunny", year: "2008", disctype: "bluray", streams: bluray })).toBe("Big.Buck.Bunny.2008.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-MyOwnMedia");
    expect(name({ title: "Big Buck Bunny", year: "2008", disctype: "dvd", streams: dvd })).toBe("Big.Buck.Bunny.2008.DVD.REMUX.MPEG-2.DD.5.1-MyOwnMedia");
    expect(name({ title: "Spider-Man: Into the Spider-Verse & Friends", year: "2018", disctype: "bluray", streams: INTERSTELLAR })).toStartWith("Spider.Man.Into.the.Spider.Verse.and.Friends.2018.");
  });

  test("Dolby Vision is read from the Matroska record, and Atmos from TrueHD's sync frames", () => {
    const detect = (bytes: Uint8Array) => {
      const sample = join(mkdtempSync(join(tmpdir(), "arm-bytes-")), "rip.mkv");
      writeFileSync(sample, bytes);
      return JSON.parse(Bun.spawnSync([python as string, file, "--detect", sample]).stdout.toString());
    };
    const sync = (substreams: number, info: number) => {
      const frame = new Uint8Array(32);
      frame.set([0xf8, 0x72, 0x6f, 0xba], 0);
      frame[16] = substreams << 4;
      frame[17] = info;
      return frame;
    };
    const all = (...parts: Uint8Array[]) => new Uint8Array(parts.flatMap((part) => [...part]));
    expect(detect(all(new Uint8Array([0x41, 0xe7, 0x84, ...new TextEncoder().encode("dvcC")]), sync(4, 0x80), sync(4, 0x80)))).toEqual({ dv: true, atmos: true });
    expect(detect(all(new Uint8Array(64), sync(3, 0x00), sync(3, 0x00)))).toEqual({ dv: false, atmos: false });
  });

  test("a disc's titles are matched to episodes by length, whatever order the disc lists them in", () => {
    // Fallout season one disc one: its titles ran 53:52, 62:36 and 71:33, the reverse of the episodes
    const found = decide({ lengths: [53.87, 62.6, 71.55], episodes: SEASON, discs: ["Fallout Season One Disc 1", "FALLOUT_S1_D1"] });
    expect(found).toMatchObject({ episodes: [3, 2, 1], season: 1, show: "Fallout" });
    expect(decide({ lengths: [71.55, 53.87, 62.6], episodes: SEASON }).episodes).toEqual([1, 3, 2]);
    expect(decide({ discs: ["FALLOUT_S2_D3"] }).season).toBe(2);
  });

  test("titles too alike in length, or unlike any run of episodes, are matched to nothing", () => {
    const alike = [45, 45, 44].map((runtime, at) => ({ episodeNumber: at + 1, runtime }));
    expect(decide({ lengths: [44.1, 44.6, 43.0], episodes: alike }).episodes).toBeNull();
    expect(decide({ lengths: [120, 121], episodes: SEASON }).episodes).toBeNull();
    expect(decide({ lengths: [53.87, 62.6, 71.55], episodes: SEASON.slice(0, 2) }).episodes).toBeNull();
  });

  test("a movie is the lookup result with the disc's own title and the rip's length, or none", () => {
    const candidates = [
      { tmdbId: 1, title: "Interstellar Civil War: Shadows of the Empire", runtime: 97 },
      { tmdbId: 157336, title: "Interstellar", runtime: 169 },
      { tmdbId: 3, title: "Interstellar", runtime: 12 },
    ];
    // ARM's own guess was the first of these; the file's title and length say the second
    expect(decide({ candidates, titles: ["Interstellar", "Interstellar-Civil-War--Shadows-of-the-Empire"], minutes: 168.9 }).movie).toBe(157336);
    expect(decide({ candidates: candidates.slice(0, 1), titles: ["Interstellar"], minutes: 168.9 }).movie).toBeNull();
    expect(decide({ candidates: [{ tmdbId: 9, title: "Twins", runtime: 100 }, { tmdbId: 10, title: "Twins", runtime: 102 }], titles: ["Twins"], minutes: 101 }).movie).toBeNull();
    // One result of that title is taken whatever its length: an extended cut runs long
    expect(decide({ candidates: [{ tmdbId: 120, title: "The Fellowship of the Ring", runtime: 179 }], titles: ["The Fellowship of the Ring"], minutes: 228 }).movie).toBe(120);
  });

  describe("with ARM, Radarr and Sonarr answering", () => {
    let root: string;
    let env: Record<string, string>;
    let server: ReturnType<typeof Bun.serve>;
    let calls: { method: string; path: string; body?: unknown }[];
    let job: Record<string, unknown>;
    let imports: boolean;
    let library: { id: number; tmdbId: number; title: string; path: string }[];

    const run = () => Bun.spawn([python as string, file], { env: { ...process.env, ...env } }).exited;
    const log = () => (existsSync(env.HEXOS_ARM_LOG) ? readFileSync(env.HEXOS_ARM_LOG, "utf-8") : "");
    const rip = (folder: string, files: Record<string, number>) => {
      mkdirSync(join(root, folder), { recursive: true });
      for (const [title, megabytes] of Object.entries(files)) writeFileSync(join(root, folder, title), "x".repeat(megabytes));
      return join(root, folder);
    };

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "arm-after-rip-"));
      calls = [];
      imports = true;
      library = [];
      mkdirSync(join(root, "links"));
      mkdirSync(join(root, "bin"));
      // ffprobe answers from a file beside each video: its length, and the title the disc gave it
      writeFileSync(
        join(root, "bin", "ffprobe"),
        `#!${python}\nimport json, sys\npath = sys.argv[-1]\ntry:\n    meta = json.load(open(path + ".json"))\nexcept OSError:\n    meta = {}\nprint(json.dumps({"streams": meta.get("streams", []), "format": {"duration": str(meta.get("seconds", 0)), "tags": {"title": meta.get("title", "")}}}))\n`,
      );
      chmodSync(join(root, "bin", "ffprobe"), 0o755);
      server = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          const path = url.pathname.replace("/api/v3", "").replace("/api/v1", "");
          const body = request.method === "POST" ? await request.json() : undefined;
          calls.push({ method: request.method, path: path + url.search, body });
          if (path === "/jobs/7/detail") return Response.json({ job });
          if (request.headers.get("x-api-key") !== "secret") return new Response("no", { status: 401 });
          if (path === "/movie/lookup") return Response.json([{ title: "Interstellar Civil War: Shadows of the Empire", tmdbId: 1, runtime: 97, year: 2017 }, { title: "Interstellar", tmdbId: 157336, runtime: 169, year: 2014 }]);
          if (path === "/movie/lookup/imdb") return Response.json({ title: "Interstellar Civil War: Shadows of the Empire", tmdbId: 1, runtime: 97, year: 2017 });
          if (path === "/movie" && request.method === "GET") return Response.json(url.searchParams.has("tmdbId") ? library.filter((movie) => String(movie.tmdbId) === url.searchParams.get("tmdbId")) : library);
          if (/^\/movie\/\d+$/.test(path)) return Response.json(library.find((movie) => `/movie/${movie.id}` === path) ?? {});
          if (path === "/qualityprofile") return Response.json([{ id: 4, name: "Any" }]);
          if (path === "/movie" || path === "/series") return Response.json({ id: 9, title: path === "/series" ? "Fallout" : "Interstellar" });
          if (path === "/series/lookup") return Response.json([{ title: "Fallout", tvdbId: 416744, year: 2024 }]);
          if (path === "/episode") return Response.json(SEASON);
          if (path === "/command" && request.method === "POST") {
            // The manager moves what it imports out of the folder it was pointed at
            const folder = join(root, (body as { path: string }).path.replace("/downloads/arm/", ""));
            if (imports) for (const entry of readdirSync(folder)) rmSync(join(folder, entry));
            return Response.json({ id: 99, status: "queued" });
          }
          if (path === "/command/99") return Response.json({ id: 99, status: "completed" });
          return new Response("not found", { status: 404 });
        },
      });
      env = {
        ARM_JOB_ID: "7",
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        HEXOS_ARM_API: `http://127.0.0.1:${server.port}/api/v1`,
        HEXOS_ARM_LINKS: join(root, "links"),
        HEXOS_ARM_COMPLETED: join(root, "completed"),
        HEXOS_ARM_LOG: join(root, "after-rip.log"),
        HEXOS_ARM_POLL_SECONDS: "0.05",
        HEXOS_ARM_IMPORT_SECONDS: "5",
        HEXOS_ARM_JOB_SECONDS: "5",
      };
    });
    afterEach(() => {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    });

    const link = (name: string, more: Record<string, unknown> = {}) =>
      writeFileSync(join(root, "links", `${name}.json`), JSON.stringify({ url: `http://127.0.0.1:${server.port}`, apiKey: "secret", downloads: { arm: root, manager: "/downloads/arm" }, rootFolder: "/library", ...more }));
    const describeFile = (path: string, meta: Record<string, unknown>) => writeFileSync(`${path}.json`, JSON.stringify(meta));

    test("a movie ARM named wrongly is named by the disc's own title, and Radarr is told to import its folder", async () => {
      const path = rip("completed/movies/Interstellar Civil War (2017)", { "A1_t00.mkv": 50 });
      describeFile(join(path, "A1_t00.mkv"), { title: "Interstellar", seconds: 10134, streams: INTERSTELLAR });
      job = { status: "success", path, title: "Interstellar-Civil-War--Shadows-of-the-Empire", year: "2017", video_type: "movie", imdb_id: "tt5056352", disctype: "bluray" };
      link("radarr");
      imports = false;
      expect(await run()).toBe(0);

      const named = "Interstellar.2014.2160p.UHD.BluRay.REMUX.HDR.HEVC.DTS-HD.MA.5.1-MyOwnMedia";
      expect(readdirSync(join(root, "completed", "movies", named))).toEqual([`${named}.mkv`]);
      expect(calls.find((call) => call.method === "POST" && call.path === "/movie")?.body).toMatchObject({ tmdbId: 157336, rootFolderPath: "/library", monitored: false });
      expect(calls.find((call) => call.path === "/command")?.body).toEqual({ name: "DownloadedMoviesScan", path: `/downloads/arm/completed/movies/${named}`, importMode: "Move" });
      // Radarr kept the copy it had, so the rip is still there under its name
      expect(log()).toContain("Radarr left it in Downloads");
    });

    test("a movie Radarr can't confirm stays where ARM put it", async () => {
      const path = rip("completed/movies/Mystery Disc", { "A1_t00.mkv": 50 });
      describeFile(join(path, "A1_t00.mkv"), { title: "DISC_VOLUME_1", seconds: 6000, streams: INTERSTELLAR });
      job = { status: "success", path, title: "Mystery-Disc", video_type: "movie", disctype: "bluray" };
      link("radarr");
      await run();
      expect(readdirSync(path)).toContain("A1_t00.mkv");
      expect(calls.some((call) => call.path === "/command")).toBe(false);
      expect(log()).toContain("couldn't confirm");
    });

    test("with no Radarr, a movie is still named as a release and left in Downloads", async () => {
      const path = rip("completed/movies/Interstellar (2014)", { "A1_t00.mkv": 50 });
      describeFile(join(path, "A1_t00.mkv"), { title: "Interstellar", seconds: 10134, streams: INTERSTELLAR });
      job = { status: "success", path, title: "Interstellar", year: "2014", video_type: "movie", disctype: "bluray" };
      await run();
      expect(readdirSync(join(root, "completed", "movies"))).toContain("Interstellar.2014.2160p.UHD.BluRay.REMUX.HDR.HEVC.DTS-HD.MA.5.1-MyOwnMedia");
    });

    test("a show's titles lose their duplicates, are named by episode and go to Sonarr", async () => {
      // Fallout season one disc one as it ripped: three episodes in reverse, and four repeats of them
      const lengths: Record<string, [number, number]> = { t00: [3232, 25], t01: [3756, 29], t02: [4293, 33], t03: [4293, 31], t04: [4293, 34], t05: [3232, 25], t06: [3756, 29] };
      const path = rip("completed/tv/Fallout", Object.fromEntries(Object.entries(lengths).map(([title, [, size]]) => [`${title}.mkv`, size])));
      for (const [title, [seconds]] of Object.entries(lengths)) describeFile(join(path, `${title}.mkv`), { title: "Fallout Season One Disc 1", seconds, streams: FALLOUT });
      job = { status: "success", path, title: "Fallout--The-Ghoul-Log", video_type: "series", disctype: "bluray", label: "FALLOUT_S1_D1" };
      link("sonarr");
      imports = false;
      expect(await run()).toBe(0);

      const folder = join(root, "completed", "tv", "Fallout.S01.MyOwnMedia");
      expect(readdirSync(folder).sort()).toEqual(["E01", "E02", "E03"].map((episode) => `Fallout.S01${episode}.2160p.UHD.BluRay.REMUX.HDR.HEVC.TrueHD.7.1-MyOwnMedia.mkv`));
      expect(calls.find((call) => call.path === "/command")?.body).toEqual({ name: "DownloadedEpisodesScan", path: "/downloads/arm/completed/tv/Fallout.S01.MyOwnMedia", importMode: "Move" });
      // The four repeats stay where ARM put them: nothing is deleted
      expect(readdirSync(path).filter((entry) => entry.endsWith(".mkv")).length).toBe(4);
    });

    test("a disc ARM couldn't identify is still a show when it names its season", async () => {
      const lengths: Record<string, number> = { t00: 3232, t01: 3756, t02: 4293 };
      const path = rip("completed/unidentified/Fallout Season One Disc 1 (2025)", Object.fromEntries(Object.keys(lengths).map((title, at) => [`${title}.mkv`, 25 + at])));
      for (const [title, seconds] of Object.entries(lengths)) describeFile(join(path, `${title}.mkv`), { title: "Fallout Season One Disc 1", seconds, streams: FALLOUT });
      job = { status: "success", path, title: "Fallout Season One Disc 1", video_type: "unknown", disctype: "bluray", label: "FALLOUT_S1_D1" };
      link("sonarr");
      expect(await run()).toBe(0);
      expect(calls.find((call) => call.path === "/command")?.body).toMatchObject({ name: "DownloadedEpisodesScan" });
    });

    test("a disc ARM couldn't identify that names no season stays where ARM put it", async () => {
      const path = rip("completed/unidentified/Mystery", { "t00.mkv": 25 });
      job = { status: "success", path, title: "Mystery", video_type: "unknown", disctype: "bluray", label: "DISC_1" };
      link("sonarr");
      await run();
      expect(readdirSync(path)).toContain("t00.mkv");
      expect(log()).toContain("couldn't tell whether it is a movie or a show");
    });

    test("a movie's other titles are filed under the movie as extras, once ARM has a way to the library", async () => {
      const path = rip("completed/movies/Interstellar (2014)", { "A1_t00.mkv": 50, "A1_t01.mkv": 5, "A1_t02.mkv": 4 });
      describeFile(join(path, "A1_t00.mkv"), { title: "Interstellar", seconds: 10134, streams: INTERSTELLAR });
      describeFile(join(path, "A1_t01.mkv"), { title: "Interstellar", seconds: 583, streams: INTERSTELLAR });
      describeFile(join(path, "A1_t02.mkv"), { title: "Interstellar", seconds: 469, streams: INTERSTELLAR });
      job = { status: "success", path, title: "Interstellar", year: "2014", video_type: "movie", disctype: "bluray" };
      mkdirSync(join(root, "library", "Interstellar (2014)"), { recursive: true });
      link("radarr", { library: { arm: join(root, "library"), manager: "/movies" } });
      library = [{ id: 9, tmdbId: 157336, title: "Interstellar", path: "/movies/Interstellar (2014)" }];
      expect(await run()).toBe(0);
      expect(readdirSync(join(root, "library", "Interstellar (2014)", "Featurettes")).sort()).toEqual(["A1_t01.mkv", "A1_t02.mkv"]);
      expect(log()).toContain("Filed 2 extra(s) under /movies/Interstellar (2014)/Featurettes");
    });

    test("with no way to the library, a movie's extras stay in Downloads", async () => {
      const path = rip("completed/movies/Interstellar (2014)", { "A1_t00.mkv": 50, "A1_t01.mkv": 5 });
      describeFile(join(path, "A1_t00.mkv"), { title: "Interstellar", seconds: 10134, streams: INTERSTELLAR });
      describeFile(join(path, "A1_t01.mkv"), { title: "Interstellar", seconds: 583, streams: INTERSTELLAR });
      job = { status: "success", path, title: "Interstellar", year: "2014", video_type: "movie", disctype: "bluray" };
      link("radarr");
      library = [{ id: 9, tmdbId: 157336, title: "Interstellar", path: "/movies/Interstellar (2014)" }];
      await run();
      expect(readdirSync(path).filter((entry) => entry.endsWith(".mkv"))).toEqual(["A1_t01.mkv"]);
    });

    test("a bonus disc's titles go under the movie it names, and never to Radarr as a movie", async () => {
      const path = rip("completed/movies/Inside Interstellar (2015)", { "B1_t00.mkv": 5, "B1_t01.mkv": 4 });
      job = { status: "success", path, title: "Inside 'Interstellar'", year: "2015", video_type: "movie", disctype: "bluray", label: "INTERSTELLAR_BONUS_DISC" };
      mkdirSync(join(root, "library", "Interstellar (2014)"), { recursive: true });
      link("radarr", { library: { arm: join(root, "library"), manager: "/movies" } });
      library = [{ id: 9, tmdbId: 157336, title: "Interstellar", path: "/movies/Interstellar (2014)" }, { id: 10, tmdbId: 2, title: "Inception", path: "/movies/Inception (2010)" }];
      expect(await run()).toBe(0);
      expect(readdirSync(join(root, "library", "Interstellar (2014)", "Featurettes")).sort()).toEqual(["B1_t00.mkv", "B1_t01.mkv"]);
      expect(calls.some((call) => call.path === "/command" || (call.method === "POST" && call.path === "/movie"))).toBe(false);
    });

    test("a bonus disc whose movie isn't in the library yet stays where ARM put it", async () => {
      const path = rip("completed/movies/Inside Interstellar (2015)", { "B1_t00.mkv": 5 });
      job = { status: "success", path, title: "Inside 'Interstellar'", video_type: "movie", disctype: "bluray", label: "INTERSTELLAR_BONUS_DISC" };
      link("radarr", { library: { arm: join(root, "library"), manager: "/movies" } });
      await run();
      expect(readdirSync(path)).toEqual(["B1_t00.mkv"]);
      expect(log()).toContain("Rip or add the movie first");
    });

    test("a show disc's short extras are left out, so its episodes still match", async () => {
      const lengths: Record<string, number> = { t00: 3232, t01: 3756, t02: 4293, t03: 240, t04: 95 };
      const path = rip("completed/tv/Fallout", Object.fromEntries(Object.keys(lengths).map((title, at) => [`${title}.mkv`, 25 + at])));
      for (const [title, seconds] of Object.entries(lengths)) describeFile(join(path, `${title}.mkv`), { title: "Fallout Season One Disc 1", seconds, streams: FALLOUT });
      job = { status: "success", path, title: "Fallout", video_type: "series", disctype: "bluray", label: "FALLOUT_S1_D1" };
      link("sonarr");
      imports = false;
      expect(await run()).toBe(0);
      expect(readdirSync(join(root, "completed", "tv", "Fallout.S01.MyOwnMedia")).length).toBe(3);
      expect(readdirSync(path).filter((entry) => entry.endsWith(".mkv")).sort()).toEqual(["t03.mkv", "t04.mkv"]);
    });

    test("a show with no Sonarr connected stays where ARM put it", async () => {
      const path = rip("completed/tv/Fallout", { "t00.mkv": 25 });
      describeFile(join(path, "t00.mkv"), { title: "Fallout Season One Disc 1", seconds: 3232, streams: FALLOUT });
      job = { status: "success", path, title: "Fallout", video_type: "series", disctype: "bluray" };
      await run();
      expect(readdirSync(path)).toContain("t00.mkv");
      expect(log()).toContain("Sonarr isn't connected");
    });

    test("a job that failed is left alone", async () => {
      const path = rip("completed/movies/Broken", { "A1_t00.mkv": 5 });
      job = { status: "fail", path, title: "Broken", video_type: "movie" };
      await run();
      expect(readdirSync(path)).toContain("A1_t00.mkv");
      expect(calls.length).toBe(1);
    });
  });
});
