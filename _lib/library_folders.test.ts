import { afterEach, describe, expect, test } from "bun:test";
import { afterInstall as setUpEmby } from "../emby/emby_hook";
import { afterInstall as setUpJellyfin } from "../jellyfin/jellyfin_hook";
import { afterInstall as setUpPlex } from "../plex/plex_hook";
import type { ContextMount, HookContext } from "./hook_context";

// Pre-configure Plex, Jellyfin and Emby make five libraries, one per media folder HexOS mounts into
// the app (/movies, /shows, /music, /photos, /videos). HexOS leaves a folder's mount out of the app
// when the owner turned that location off, so a box with no Photos folder runs the app without
// /photos. Each server refuses a library at a path it can't see (Jellyfin 10.11.0's
// LibraryManager.AddVirtualFolder answers "The specified path does not exist"), which stopped a
// collection run at "Failed to create library: Photos" for the owner to press Retry or Skip.
// The setup reads the app's mounts and skips the library of a folder the app wasn't given, as the
// managers' setup already does for a root folder (servarr/configure.ts, ensureLibrary).

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const FOLDERS = ["/movies", "/shows", "/music", "/photos", "/videos"];
const CHECKPOINTS: Record<string, string> = {
  "/movies": "lib_movies",
  "/shows": "lib_tv",
  "/music": "lib_music",
  "/photos": "lib_photos",
  "/videos": "lib_videos",
};

const mount = (containerPath: string | null, hostPath: string): ContextMount => ({
  hostPath,
  containerPath,
  localPath: `/host${hostPath}`,
});
/** The app's mounts as HexOS reads them from TrueNAS: its own storage, then each media folder it was given. */
const mountsWith = (folders: string[]) => [
  mount(null, "/mnt/tank/Applications/app/config"),
  ...folders.map((folder) => mount(folder, `/mnt/tank${folder}`)),
];

interface Seen {
  /** The folder of each library the server was asked for. */
  asked: string[];
  made: string[];
  /** The checkpoints the owner was asked to Retry or Skip. */
  parked: string[];
  skipped: Array<{ id: string; message?: string }>;
  finished: string[];
}

interface Options {
  /** The folders the container has. */
  folders: string[];
  /** What HexOS read of the app's mounts. Left out: the mounts of `folders`. */
  mounts?: ContextMount[];
  /** Folders the server already has a library for. */
  existing?: string[];
  event?: string;
}

function context(appId: string, options: Options, seen: Seen): HookContext {
  return {
    resourceId: appId,
    catalogAppId: appId,
    baseUrl: `http://${appId}.test`,
    event: options.event ?? "onAfterInstall",
    signIn: { username: "owner", password: "secret" },
    mounts: options.mounts ?? mountsWith(options.folders),
    getInput: () => ({ authToken: "plex-token" }),
    waitForApp: async () => {},
    registerCheckpoints: async () => {},
    emitCheckpoint: async (id: string) => {
      seen.finished.push(id);
    },
    updateCheckpointMessage: async () => {},
    skipCheckpoint: async (id: string, message?: string) => {
      seen.skipped.push({ id, message });
    },
    awaitCheckpointRetry: async (id: string) => {
      seen.parked.push(id);
      return "skip";
    },
    log: () => {},
    sleep: async () => {},
    fail: (message: string) => {
      throw new Error(message);
    },
  } as unknown as HookContext;
}

/** A Plex server already claimed, which refuses a library at a folder the container doesn't have. */
function plex(options: Options, seen: Seen) {
  const libraries = [...(options.existing ?? [])];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    if (url.pathname === "/myplex/account") return Response.json({ MyPlex: { username: "owner" } });
    if (url.pathname === "/:/prefs") return new Response(null, { status: 200 });
    if (url.pathname === "/library/sections" && method === "GET") {
      return Response.json({ MediaContainer: { Directory: libraries.map((path) => ({ Location: [{ path }] })) } });
    }
    if (url.pathname === "/library/sections" && method === "POST") {
      const location = url.searchParams.get("location");
      // The setup's first POST carries no library: it only asks whether the server is still starting
      if (!location) return new Response("", { status: 400 });
      seen.asked.push(location);
      if (!options.folders.includes(location)) return new Response("", { status: 400 });
      libraries.push(location);
      seen.made.push(location);
      return new Response(null, { status: 201 });
    }
    throw new Error(`unexpected ${method} ${url.pathname}`);
  }) as typeof fetch;
}

/** A Jellyfin or Emby that was set up before, which refuses a library at a folder the container doesn't have. */
function mediaBrowser(prefix: string) {
  return (options: Options, seen: Seen) => {
    const libraries = [...(options.existing ?? [])];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? "GET";
      const at = url.pathname.slice(prefix.length);
      if (at === "/Startup/User") return new Response(null, { status: 401 });
      if (at === "/System/Info/Public") return Response.json({ StartupWizardCompleted: true });
      if (at === "/Users/AuthenticateByName") {
        return Response.json({ AccessToken: "session", User: { Id: "u1", Policy: { IsAdministrator: true } } });
      }
      if (at === "/Auth/Keys") return Response.json({ Items: [{ AppName: "HexOS" }] });
      if (at === "/System/Configuration") return Response.json({ RemoteClientBitrateLimit: 1 });
      if (at === "/Library/VirtualFolders" && method === "GET") {
        return Response.json(libraries.map((path, i) => ({ Name: `Library${i}`, Locations: [path] })));
      }
      if (at === "/Library/VirtualFolders" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { LibraryOptions?: { PathInfos?: Array<{ Path: string }> } };
        const path = url.searchParams.get("paths") ?? body.LibraryOptions?.PathInfos?.[0]?.Path ?? "";
        seen.asked.push(path);
        if (!options.folders.includes(path)) {
          return new Response(`The specified path does not exist: ${path}.`, { status: 400 });
        }
        libraries.push(path);
        seen.made.push(path);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected ${method} ${url.pathname}`);
    }) as typeof fetch;
  };
}

const SERVERS = [
  { name: "Plex", appId: "plex", setUp: setUpPlex, serve: plex, fromCard: false },
  { name: "Jellyfin", appId: "jellyfin", setUp: setUpJellyfin, serve: mediaBrowser(""), fromCard: true },
  { name: "Emby", appId: "emby", setUp: setUpEmby, serve: mediaBrowser("/emby"), fromCard: true },
];

describe.each(SERVERS)("$name's libraries", ({ name, appId, setUp, serve, fromCard }) => {
  async function run(options: Options) {
    const seen: Seen = { asked: [], made: [], parked: [], skipped: [], finished: [] };
    serve(options, seen);
    await setUp(context(appId, options, seen));
    return seen;
  }
  const without = (folder: string) => FOLDERS.filter((each) => each !== folder);

  test("a box with no Photos folder gets the other four libraries, and the owner is asked nothing", async () => {
    const seen = await run({ folders: without("/photos") });
    expect(seen.asked).toEqual(without("/photos"));
    expect(seen.made).toEqual(without("/photos"));
    expect(seen.parked).toEqual([]);
    // The Photos step says it was skipped, and why
    expect(seen.skipped).toEqual([
      { id: "lib_photos", message: `HexOS didn't give ${name} a Photos folder, so it has no library to make` },
    ]);
    expect(seen.finished).not.toContain("lib_photos");
  });

  test("skips each folder the app wasn't given, whichever it is", async () => {
    const seen = await run({ folders: ["/movies"] });
    expect(seen.asked).toEqual(["/movies"]);
    expect(seen.skipped.map((each) => each.id)).toEqual(without("/movies").map((folder) => CHECKPOINTS[folder]!));
    expect(seen.parked).toEqual([]);
  });

  test("an app given every folder gets all five libraries, with nothing skipped", async () => {
    const seen = await run({ folders: FOLDERS });
    expect(seen.made).toEqual(FOLDERS);
    expect(seen.skipped).toEqual([]);
    expect(seen.parked).toEqual([]);
  });

  test("mounts that couldn't be read are no proof a folder is missing: every library is asked for", async () => {
    const seen = await run({ folders: FOLDERS, mounts: [] });
    expect(seen.asked).toEqual(FOLDERS);
    expect(seen.skipped).toEqual([]);
  });

  test("a library the server already has stays as it is, though its folder is gone", async () => {
    const seen = await run({ folders: without("/photos"), existing: ["/photos"] });
    expect(seen.asked).toEqual(without("/photos"));
    expect(seen.skipped).toEqual([]);
    expect(seen.finished).toContain("lib_photos");
  });

  // Plex's setup parks for Retry or Skip from the card too, so only these two used to stop there
  if (fromCard) {
    test("a run from the app's card skips it too, rather than stopping at the missing folder", async () => {
      const seen = await run({ folders: without("/photos"), event: "action" });
      expect(seen.made).toEqual(without("/photos"));
      expect(seen.skipped.map((each) => each.id)).toEqual(["lib_photos"]);
    });
  }
});
