import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AFTER_RIP_PY, AFTER_RIP_SCRIPT, applySettings, OMDB_KEY_ENV, omdbKeyFromValues, wantedSettings } from "../arm/configure";
import { radarrLink, seenAt } from "../arm/connect_radarr";

const script = JSON.parse(readFileSync(new URL("../arm.json", import.meta.url), "utf-8"));
const collection = JSON.parse(readFileSync(new URL("../_collections/media-management.json", import.meta.url), "utf-8"));

// The lines of ARM 2.24.4's setup/arm.yaml these settings sit on, with a comment between them
const ARM_YAML = [
  "# Skip transcoding",
  "SKIP_TRANSCODE: false",
  'METADATA_PROVIDER: "omdb"',
  'COMPLETED_PATH: "/somewhere/else/"',
  'RIPMETHOD: "backup"',
  "MAINFEATURE: false",
  "NOTIFY_TRANSCODE: false",
  'BASH_SCRIPT: ""',
  'OMDB_API_KEY: ""',
  "",
].join("\n");

describe("Automatic Ripping Machine's settings", () => {
  test("a rip keeps the disc's quality, and ARM runs the after-rip script when a job ends", () => {
    const next = applySettings(ARM_YAML, wantedSettings("abc12345", ARM_YAML));
    expect(next).toContain("SKIP_TRANSCODE: true\n");
    expect(next).toContain('RIPMETHOD: "mkv"\n');
    expect(next).toContain('COMPLETED_PATH: "/home/arm/media/completed/"\n');
    expect(next).toContain("NOTIFY_TRANSCODE: true\n");
    expect(next).toContain(`BASH_SCRIPT: "${AFTER_RIP_SCRIPT}"\n`);
    expect(next).toContain('OMDB_API_KEY: "abc12345"\n');
  });

  test("ARM's comments and the settings HexOS doesn't own stay as they were", () => {
    const next = applySettings(ARM_YAML, wantedSettings("abc12345", ARM_YAML));
    expect(next).toContain("# Skip transcoding\n");
    expect(next).toContain("MAINFEATURE: false\n");
    expect(next.split("\n").length).toBe(ARM_YAML.split("\n").length);
  });

  test("a script the owner set for themselves stays", () => {
    const theirs = ARM_YAML.replace('BASH_SCRIPT: ""', 'BASH_SCRIPT: "/etc/arm/config/mine.sh"');
    expect(applySettings(theirs, wantedSettings("", theirs))).toContain('BASH_SCRIPT: "/etc/arm/config/mine.sh"\n');
  });

  test("an empty answer leaves a key the owner typed in ARM itself", () => {
    const typed = ARM_YAML.replace('OMDB_API_KEY: ""', 'OMDB_API_KEY: "typedinarm"');
    expect(applySettings(typed, wantedSettings("", typed))).toContain('OMDB_API_KEY: "typedinarm"\n');
  });

  test("a second run changes nothing", () => {
    const once = applySettings(ARM_YAML, wantedSettings("abc12345", ARM_YAML));
    expect(applySettings(once, wantedSettings("abc12345", once))).toBe(once);
  });

  test("the hook reads the key from the env the script writes the answer to", () => {
    expect(script.app_values.envs).toContainEqual({ name: OMDB_KEY_ENV, value: "$QUESTION(omdb_api_key)" });
    expect(omdbKeyFromValues({ envs: [{ name: OMDB_KEY_ENV, value: " abc12345 " }] })).toBe("abc12345");
    expect(omdbKeyFromValues({})).toBe("");
  });
});

describe("Automatic Ripping Machine's script", () => {
  const mount = (path: string) => script.app_values.storage.find((entry: { mount_path: string }) => entry.mount_path === path)?.host_path_config.path;

  test("rips land in Downloads, and Movies and Shows are where the after-rip script files them", () => {
    expect(mount("/home/arm/media")).toBe("$LOCATION(Downloads)/arm");
    expect(mount("/movies")).toBe("$LOCATION(Movies)");
    expect(mount("/shows")).toBe("$LOCATION(Shows)");
    expect(AFTER_RIP_PY).toContain('os.environ.get("HEXOS_ARM_MOVIES", "/movies")');
    expect(AFTER_RIP_PY).toContain('os.environ.get("HEXOS_ARM_SHOWS", "/shows")');
  });

  test("the container is privileged, which is what lets ARM mount a disc and see every drive", () => {
    expect(script.app_values.privileged).toBe(true);
    expect(script.app_values.devices).toBeUndefined();
  });

  test("Radarr makes ARM's folder in Downloads and carries the link to it", () => {
    const radarr = JSON.parse(readFileSync(new URL("../radarr.json", import.meta.url), "utf-8"));
    expect(radarr.requirements.shared_folders).toContain("$LOCATION(Downloads)/arm");
    expect(radarr.ensure_directories_exists).toContainEqual({ path: "$LOCATION(Downloads)/arm" });
    expect(radarr.hooks.find((hook: { id: string }) => hook.id === "connect-arm")).toMatchObject({ kind: "connect", script: "arm/connect_radarr.ts", entrypoint: "radarr" });
  });

  test("it is a download client of the Media library collection", () => {
    const download = collection.groups.find((group: { id: string }) => group.id === "download");
    expect(download.options.map((option: { app: string }) => option.app)).toContain("arm");
  });
});

describe("the Radarr link", () => {
  const ours = [
    { hostPath: "/mnt/tank/Downloads/arm", containerPath: "/home/arm/media" },
    { hostPath: "/mnt/tank/Movies", containerPath: "/movies" },
  ];
  const theirs = [
    { hostPath: "/mnt/tank/Applications/radarr/config", containerPath: null },
    { hostPath: "/mnt/tank/Downloads", containerPath: "/downloads" },
    { hostPath: "/mnt/tank/Downloads/qbittorrent", containerPath: "/config/Downloads" },
    { hostPath: "/mnt/tank/Movies", containerPath: "/movies" },
  ];

  test("a folder is seen through the mount that holds it most closely", () => {
    expect(seenAt("/mnt/tank/Downloads/arm", theirs)).toBe("/downloads/arm");
    expect(seenAt("/mnt/tank/Downloads/qbittorrent/done", theirs)).toBe("/config/Downloads/done");
    expect(seenAt("/mnt/tank/Downloads2", theirs)).toBeUndefined();
  });

  test("the link names each folder as ARM and as Radarr see it", () => {
    expect(radarrLink(ours, theirs, "http://10.0.0.5:30025", "key")).toEqual({
      url: "http://10.0.0.5:30025",
      apiKey: "key",
      downloads: { arm: "/home/arm/media", radarr: "/downloads/arm" },
      library: { arm: "/movies", radarr: "/movies" },
    });
  });

  test("a Radarr that can't see the rips or the library gets no link", () => {
    expect(radarrLink(ours, [theirs[3]], "u", "k")).toEqual({ missing: "downloads" });
    expect(radarrLink(ours, [theirs[1]], "u", "k")).toEqual({ missing: "library" });
  });
});

const python = Bun.which("python3");

// The after-rip script runs inside ARM's container, on its Python. A machine with no python3 can't run it.
describe.skipIf(!python)("the after-rip script", () => {
  let root: string;
  let env: Record<string, string>;

  const addJob = (job: Record<string, string | number | null>) => {
    const columns = Object.keys(job);
    const code = [
      "import sqlite3, sys, json",
      "db = sqlite3.connect(sys.argv[1])",
      'db.execute("CREATE TABLE IF NOT EXISTS job (job_id INTEGER PRIMARY KEY, title, title_manual, year, video_type, imdb_id, disctype, label, path)")',
      "job = json.loads(sys.argv[2])",
      'db.execute("INSERT INTO job (%s) VALUES (%s)" % (", ".join(job), ", ".join("?" for _ in job)), list(job.values()))',
      "db.commit()",
    ].join("\n");
    const made = Bun.spawnSync([python as string, "-c", code, env.HEXOS_ARM_DB, JSON.stringify(job)]);
    if (made.exitCode !== 0) throw new Error(`couldn't add job ${columns.join(",")}: ${made.stderr.toString()}`);
  };
  const run = (body: string) => Bun.spawnSync([python as string, join(root, "after_rip.py"), "ARM notification", body], { env: { ...process.env, ...env } });
  // The fake Radarr answers from this process, so a run that calls it can't block the event loop
  const runAsync = (body: string) => Bun.spawn([python as string, join(root, "after_rip.py"), "ARM notification", body], { env: { ...process.env, ...env } }).exited;
  const log = () => (existsSync(env.HEXOS_ARM_LOG) ? readFileSync(env.HEXOS_ARM_LOG, "utf-8") : "");
  const rip = (kind: "movies" | "tv", folder: string, files: Record<string, string>) => {
    const path = join(root, "completed", kind, folder);
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(path, name, ".."), { recursive: true });
      writeFileSync(join(path, name), text);
    }
    return path;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "arm-after-rip-"));
    for (const folder of ["completed/movies", "completed/tv", "movies", "shows"]) mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, "after_rip.py"), AFTER_RIP_PY);
    env = {
      HEXOS_ARM_DB: join(root, "arm.db"),
      HEXOS_ARM_COMPLETED: join(root, "completed"),
      HEXOS_ARM_MOVIES: join(root, "movies"),
      HEXOS_ARM_SHOWS: join(root, "shows"),
      HEXOS_ARM_RADARR: join(root, "radarr.json"),
      HEXOS_ARM_LOG: join(root, "after-rip.log"),
      HEXOS_ARM_POLL_SECONDS: "0.05",
      HEXOS_ARM_IMPORT_SECONDS: "5",
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const movie = (path: string) => ({ title: "Big-Buck-Bunny", title_manual: null, year: "2008", video_type: "movie", imdb_id: "tt1254207", disctype: "dvd", label: "BIG_BUCK_BUNNY", path });

  test("with no Radarr, a movie's folder moves to Movies under its title, year and IMDb id", () => {
    addJob(movie(rip("movies", "Big-Buck-Bunny (2008)", { "Big-Buck-Bunny (2008).mkv": "main feature", "extras/title_t01.mkv": "x" })));
    expect(run("Big-Buck-Bunny processing complete.").exitCode).toBe(0);
    const folder = join(root, "movies", "Big Buck Bunny (2008) [imdbid-tt1254207]");
    expect(readdirSync(folder).sort()).toEqual(["Big Buck Bunny (2008) [imdbid-tt1254207].mkv", "extras"]);
    expect(readdirSync(join(root, "completed", "movies"))).toEqual([]);
  });

  test("a notice that isn't the end of a job moves nothing", () => {
    const path = rip("movies", "Big-Buck-Bunny (2008)", { "Big-Buck-Bunny (2008).mkv": "main" });
    addJob(movie(path));
    run("Big-Buck-Bunny rip complete. Starting transcode. ");
    run(" Big-Buck-Bunny processing completed with errors. Title(s) 3 failed to complete. ");
    expect(readdirSync(path)).toEqual(["Big-Buck-Bunny (2008).mkv"]);
  });

  test("a movie Movies already has stays where ARM put it", () => {
    const path = rip("movies", "Big-Buck-Bunny (2008)", { "Big-Buck-Bunny (2008).mkv": "second copy" });
    addJob(movie(path));
    mkdirSync(join(root, "movies", "Big Buck Bunny (2008) [imdbid-tt1254207]"));
    run("Big-Buck-Bunny processing complete.");
    expect(readdirSync(path)).toEqual(["Big-Buck-Bunny (2008).mkv"]);
    expect(readdirSync(join(root, "movies", "Big Buck Bunny (2008) [imdbid-tt1254207]"))).toEqual([]);
    expect(log()).toContain("stays in");
  });

  test("a show's files move to its folder in Shows, named by the disc they came from", () => {
    const show = { title: "Planet-Earth", title_manual: null, year: "2006", video_type: "series", imdb_id: "tt0795176", disctype: "bluray" };
    addJob({ ...show, label: "PLANET_EARTH_D1", path: rip("tv", "Planet-Earth (2006)", { "title_t00.mkv": "a", "title_t01.mkv": "b" }) });
    run("Planet-Earth processing complete.");
    addJob({ ...show, label: "PLANET_EARTH_D2", path: rip("tv", "Planet-Earth (2006)", { "title_t00.mkv": "c" }) });
    run("Planet-Earth processing complete.");
    expect(readdirSync(join(root, "shows", "Planet Earth (2006) [imdbid-tt0795176]")).sort()).toEqual([
      "Planet Earth - PLANET_EARTH_D1 - title_t00.mkv",
      "Planet Earth - PLANET_EARTH_D1 - title_t01.mkv",
      "Planet Earth - PLANET_EARTH_D2 - title_t00.mkv",
    ]);
  });

  test("a rip ARM couldn't name stays in Downloads", () => {
    const path = join(root, "completed", "unidentified", "BIG_BUCK_BUNNY");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "title_t00.mkv"), "x");
    addJob({ ...movie(path), video_type: "unknown", imdb_id: null });
    run("Big-Buck-Bunny processing complete.");
    expect(readdirSync(path)).toEqual(["title_t00.mkv"]);
  });

  describe("with Radarr linked", () => {
    let server: ReturnType<typeof Bun.serve>;
    let calls: { method: string; path: string; body?: unknown }[];
    let radarr: { library: unknown[]; imports: boolean };

    beforeEach(() => {
      calls = [];
      radarr = { library: [], imports: true };
      const filed = { id: 7, title: "Big Buck Bunny", tmdbId: 10378, path: "/movies/Big Buck Bunny (2008) [tmdbid-10378]" };
      server = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          const path = url.pathname.replace("/api/v3", "");
          const body = request.method === "POST" ? await request.json() : undefined;
          calls.push({ method: request.method, path: path + url.search, body });
          if (request.headers.get("x-api-key") !== "secret") return new Response("no", { status: 401 });
          if (path === "/movie/lookup/imdb") return Response.json({ title: "Big Buck Bunny", tmdbId: 10378, imdbId: "tt1254207", year: 2008 });
          if (path === "/movie" && request.method === "GET") return Response.json(radarr.library);
          if (path === "/qualityprofile") return Response.json([{ id: 4, name: "Any" }]);
          if (path === "/movie" && request.method === "POST") return Response.json({ ...filed, hasFile: false });
          if (path === "/manualimport") {
            const folder = url.searchParams.get("folder") as string;
            return Response.json([{ path: `${folder}/Big-Buck-Bunny (2008).mkv`, quality: { quality: { id: 0, name: "Unknown" } }, languages: [{ id: 1, name: "English" }] }]);
          }
          if (path === "/qualitydefinition") return Response.json([{ quality: { id: 2, name: "DVD" } }, { quality: { id: 30, name: "Remux-1080p" } }]);
          if (path === "/command" && request.method === "POST") {
            // Radarr moves the file into the folder it names
            if (radarr.imports) {
              const target = join(root, "movies", "Big Buck Bunny (2008) [tmdbid-10378]");
              mkdirSync(target);
              rmSync(join(root, "completed", "movies", "Big-Buck-Bunny (2008)", "Big-Buck-Bunny (2008).mkv"));
              writeFileSync(join(target, "Big Buck Bunny (2008) [tmdbid-10378] - [DVD][AC3 2.0][MPEG2].mkv"), "main");
            }
            return Response.json({ id: 99, status: "queued" });
          }
          if (path === "/command/99") return Response.json({ id: 99, status: radarr.imports ? "completed" : "failed" });
          if (path === "/movie/7") return Response.json({ ...filed, hasFile: radarr.imports });
          return new Response("not found", { status: 404 });
        },
      });
      writeFileSync(
        env.HEXOS_ARM_RADARR,
        JSON.stringify({
          url: `http://127.0.0.1:${server.port}`,
          apiKey: "secret",
          downloads: { arm: join(root, "completed", ".."), radarr: "/downloads/arm" },
          library: { arm: join(root, "movies"), radarr: "/movies" },
        }),
      );
    });
    afterEach(() => server.stop(true));

    test("Radarr is given the movie, told its quality, and the extras follow it", async () => {
      addJob(movie(rip("movies", "Big-Buck-Bunny (2008)", { "Big-Buck-Bunny (2008).mkv": "main", "extras/title_t01.mkv": "x" })));
      expect(await runAsync("Big-Buck-Bunny processing complete.")).toBe(0);

      const added = calls.find((call) => call.method === "POST" && call.path === "/movie")?.body as Record<string, unknown>;
      expect(added).toMatchObject({ tmdbId: 10378, rootFolderPath: "/movies", qualityProfileId: 4, monitored: false, addOptions: { searchForMovie: false } });
      const command = calls.find((call) => call.method === "POST" && call.path === "/command")?.body as { name: string; importMode: string; files: Record<string, unknown>[] };
      expect(command).toMatchObject({ name: "ManualImport", importMode: "move" });
      expect(command.files).toEqual([
        {
          path: "/downloads/arm/completed/movies/Big-Buck-Bunny (2008)/Big-Buck-Bunny (2008).mkv",
          movieId: 7,
          quality: { quality: { id: 2, name: "DVD" }, revision: { version: 1, real: 0, isRepack: false } },
          languages: [{ id: 1, name: "English" }],
          releaseGroup: "",
        },
      ]);
      expect(readdirSync(join(root, "movies", "Big Buck Bunny (2008) [tmdbid-10378]")).sort()).toEqual([
        "Big Buck Bunny (2008) [tmdbid-10378] - [DVD][AC3 2.0][MPEG2].mkv",
        "extras",
      ]);
      expect(readdirSync(join(root, "completed", "movies"))).toEqual([]);
    });

    test("a movie Radarr already has a file for stays in Downloads", async () => {
      radarr.library = [{ id: 7, title: "Big Buck Bunny", hasFile: true }];
      const path = rip("movies", "Big-Buck-Bunny (2008)", { "Big-Buck-Bunny (2008).mkv": "main" });
      addJob(movie(path));
      await runAsync("Big-Buck-Bunny processing complete.");
      expect(calls.some((call) => call.path === "/command")).toBe(false);
      expect(readdirSync(path)).toEqual(["Big-Buck-Bunny (2008).mkv"]);
      expect(readdirSync(join(root, "movies"))).toEqual([]);
    });

    test("an import Radarr started and didn't finish leaves the rip in Downloads", async () => {
      radarr.imports = false;
      const path = rip("movies", "Big-Buck-Bunny (2008)", { "Big-Buck-Bunny (2008).mkv": "main" });
      addJob(movie(path));
      await runAsync("Big-Buck-Bunny processing complete.");
      expect(readdirSync(path)).toEqual(["Big-Buck-Bunny (2008).mkv"]);
      expect(readdirSync(join(root, "movies"))).toEqual([]);
    });

    test("a Radarr that doesn't answer sends the movie to Movies instead", async () => {
      server.stop(true);
      addJob(movie(rip("movies", "Big-Buck-Bunny (2008)", { "Big-Buck-Bunny (2008).mkv": "main" })));
      await runAsync("Big-Buck-Bunny processing complete.");
      expect(readdirSync(join(root, "movies"))).toEqual(["Big Buck Bunny (2008) [imdbid-tt1254207]"]);
    });
  });
});
