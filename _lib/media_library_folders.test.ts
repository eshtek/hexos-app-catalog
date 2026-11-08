import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as embyLibraries from "../emby/add_library";
import * as jellyfinLibraries from "../jellyfin/add_library";
import type { HookContext } from "./hook_context";

// The Sports, Books and Audiobooks links of Jellyfin and Emby, against fakes of their library and
// ValidatePath APIs (EnvironmentController at Jellyfin 10.11.0, EnvironmentService in Emby's API).
// Sportarr's and Chaptarr's folders of Media are datasets of their own, and one made after the
// media server started is mounted after the server's bind mount of Media was made. That mount
// passes no later mount on (rprivate), so the server sees an empty folder there, and nothing put in
// it, until it restarts. The folder itself is there either way, so the link puts an empty folder of
// its own in it for a moment and asks the server for that one, and for the library folder itself,
// which proves the server answers ValidatePath: only then is a 404 for its own folder a missing one.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "media-library-folders-"));
});

const TOKEN = "admin-token";
type Server = "jellyfin" | "emby";
const NAMES: Record<Server, string> = { jellyfin: "Jellyfin", emby: "Emby" };
const LINKS = { jellyfin: jellyfinLibraries, emby: embyLibraries };

interface Options {
  /** What the server sees inside its library folders: all of it, nothing until it restarts, or nothing ever. */
  media: "visible" | "after restart" | "hidden";
  /** A box from before ctx.restartApp. */
  noRestart?: boolean;
  /** ValidatePath refuses for a reason other than a missing folder. */
  unvalidatable?: boolean;
  /** Every ValidatePath is a 404, as a server without the route answers. */
  routeless?: boolean;
  /** Also link this companion's folders in the same fake, at the same time. */
  also?: "sportarr" | "chaptarr";
  /** The second list of libraries is held until the server starts restarting. */
  holdSecondList?: boolean;
}

function fakes(server: Server, companion: "sportarr" | "chaptarr", options: Options) {
  const media = join(root, "Media");
  // The companion made its folders on the box
  for (const each of [companion, ...(options.also ? [options.also] : [])]) {
    for (const folder of each === "sportarr" ? ["sports"] : ["books", "audiobooks"]) mkdirSync(join(media, folder), { recursive: true });
  }
  const config = join(root, server, "config");
  mkdirSync(join(config, "data"), { recursive: true });
  const db = new Database(join(config, "data", server === "jellyfin" ? "jellyfin.db" : "authentication.db"));
  if (server === "jellyfin") {
    db.run("CREATE TABLE ApiKeys (AccessToken TEXT, DateCreated TEXT)");
    db.run("INSERT INTO ApiKeys VALUES (?, '2026-01-01')", [TOKEN]);
  } else {
    db.run("CREATE TABLE Tokens_2 (AccessToken TEXT, DeviceId INT, UserId TEXT, IsActive INT, DateLastActivityInt INT)");
    db.run("INSERT INTO Tokens_2 VALUES (?, 1, '', 1, 1)", [TOKEN]);
  }
  db.close();

  let stale = options.media !== "visible";
  const libraries: string[] = [];
  const restarts: number[] = [];
  const looks: string[] = [];
  let restartingNow = false;
  let lists = 0;
  // Whether the server sees a path under /media: a library folder is there either way, what's inside only when not stale
  const sees = (path: string) => {
    const inside = path.split("/").length > 3;
    if (stale && inside) return false;
    return existsSync(join(media, path.slice("/media".length)));
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    if (restartingNow) throw new TypeError("fetch failed");
    const path = url.pathname.replace(/^\/emby/, "");
    const headers = new Headers(init?.headers);
    const token = headers.get("X-Emby-Token") ?? headers.get("Authorization")?.match(/Token="([^"]+)"/)?.[1];
    if (path === "/System/Info/Public") return Response.json({ Version: "1" });
    if (token !== TOKEN) return new Response(null, { status: 401 });
    if (path === "/System/Configuration") return Response.json({});
    if (path === "/Library/VirtualFolders" && method === "GET") {
      lists++;
      if (options.holdSecondList && lists === 2) {
        while (restarts.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return Response.json(libraries.map((folder) => ({ Locations: [folder] })));
    }
    if (path === "/Library/VirtualFolders" && method === "POST") {
      libraries.push(url.searchParams.get("paths") ?? url.searchParams.get("Paths") ?? "");
      return new Response(null, { status: 204 });
    }
    if (path === "/Environment/ValidatePath" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { Path?: string };
      const asked = body.Path ?? url.searchParams.get("Path") ?? "";
      looks.push(asked);
      if (options.unvalidatable) return new Response("Forbidden", { status: 403 });
      if (options.routeless) return new Response(null, { status: 404 });
      return new Response(null, { status: sees(asked) ? 204 : 404 });
    }
    throw new Error(`Unexpected ${server} request: ${method} ${url.pathname}`);
  }) as typeof fetch;

  const ctx = {
    resourceId: server,
    baseUrl: `http://10.0.0.5:${server === "jellyfin" ? 30013 : 30096}`,
    mounts: [
      { containerPath: "/config", hostPath: `/mnt/pool/apps/${server}/config`, localPath: config },
      { containerPath: "/media", hostPath: "/mnt/pool/Media", localPath: media },
    ],
    ...(options.noRestart
      ? {}
      : {
          restartApp: async () => {
            restarts.push(looks.length);
            // A redeploy takes a while, long enough for another link to find a folder missing, and
            // the server answers nothing until it's back
            restartingNow = true;
            await new Promise((resolve) => setTimeout(resolve, 20));
            restartingNow = false;
            if (options.media === "after restart") stale = false;
          },
        }),
    registerCheckpoints: async () => {},
    emitCheckpoint: async () => {},
    updateCheckpointMessage: async () => {},
    skipCheckpoint: async () => {},
    sleep: async () => {},
    log: () => {},
    fail: (message: string) => {
      throw new Error(message);
    },
  } as unknown as HookContext;
  // What HexOS left in the library folders: nothing of its own once the link is done
  const leftovers = () => readdirSync(media, { recursive: true }).map(String).filter((entry) => entry.includes(".hexos"));
  return { ctx, libraries, restarts, looks, leftovers, media };
}

for (const server of ["jellyfin", "emby"] as const) {
  const name = NAMES[server];

  test(`${name}: a Sports folder it can't see inside gets one restart and a second look, then the library is added`, async () => {
    const { ctx, libraries, restarts, looks, leftovers } = fakes(server, "sportarr", { media: "after restart" });
    await LINKS[server].sportarr(ctx);
    // The library folder, then HexOS's own in it, before the restart; HexOS's own again after
    expect(restarts).toEqual([2]);
    expect(looks).toHaveLength(3);
    expect(looks[0]).toBe("/media/sports");
    expect(looks[1]).toStartWith(`/media/sports/.hexos-check-${server}-`);
    expect(libraries).toEqual(["/media/sports"]);
    expect(leftovers()).toEqual([]);
  });

  test(`${name}: folders it sees get no restart`, async () => {
    const { ctx, libraries, restarts, looks, leftovers } = fakes(server, "chaptarr", { media: "visible" });
    await LINKS[server].chaptarr(ctx);
    expect(restarts).toEqual([]);
    expect(looks).toHaveLength(4);
    expect(libraries).toEqual(["/media/books", "/media/audiobooks"]);
    expect(leftovers()).toEqual([]);
  });

  test(`${name}: both of Chaptarr's folders missing take one restart between them`, async () => {
    const { ctx, libraries, restarts, looks } = fakes(server, "chaptarr", { media: "after restart" });
    await LINKS[server].chaptarr(ctx);
    expect(restarts).toEqual([4]);
    expect(looks).toHaveLength(6);
    expect(libraries).toEqual(["/media/books", "/media/audiobooks"]);
  });

  test(`${name}: a folder still missing after the restart fails the link with what to do, and no library is added`, async () => {
    const { ctx, libraries, restarts, leftovers } = fakes(server, "sportarr", { media: "hidden" });
    await expect(LINKS[server].sportarr(ctx)).rejects.toThrow(
      `${name} still can't see your Sports folder after HexOS restarted it. Stop ${name} and start it again, then run Connect to Sportarr again.`,
    );
    expect(restarts).toEqual([2]);
    expect(libraries).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  test(`${name}: a box that can't restart it fails the link with what to do`, async () => {
    const { ctx, libraries, leftovers } = fakes(server, "sportarr", { media: "after restart", noRestart: true });
    await expect(LINKS[server].sportarr(ctx)).rejects.toThrow(
      `${name} can't see your Sports folder yet. Stop ${name} and start it again, then run Connect to Sportarr again.`,
    );
    expect(libraries).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  test(`${name}: a refusal that doesn't say the folder is missing isn't a reason to restart`, async () => {
    const { ctx, libraries, restarts } = fakes(server, "sportarr", { media: "hidden", unvalidatable: true });
    await LINKS[server].sportarr(ctx);
    expect(restarts).toEqual([]);
    expect(libraries).toEqual(["/media/sports"]);
  });
}

for (const server of ["jellyfin", "emby"] as const) {
  const name = NAMES[server];

  test(`${name}: a server that answers 404 for every path says nothing, so it isn't restarted`, async () => {
    const { ctx, libraries, restarts } = fakes(server, "sportarr", { media: "hidden", routeless: true });
    await LINKS[server].sportarr(ctx);
    expect(restarts).toEqual([]);
    expect(libraries).toEqual(["/media/sports"]);
  });

  test(`${name}: its own empty check folders an earlier run left are taken out, and nothing else is`, async () => {
    const { ctx, media, leftovers } = fakes(server, "sportarr", { media: "visible" });
    const other = server === "jellyfin" ? "emby" : "jellyfin";
    const left = join(media, "sports", `.hexos-check-${server}-0e3a7c1e-5f2b-4d1a-9c3e-7a1b2c3d4e5f`);
    const holding = join(media, "sports", `.hexos-check-${server}-1f4b8d2f-6a3c-4e2b-8d4f-8b2c3d4e5f60`);
    const others = join(media, "sports", `.hexos-check-${other}-2a5c9e3a-7b4d-4f3c-9e5a-9c3d4e5f6071`);
    for (const folder of [left, holding, others]) mkdirSync(folder);
    writeFileSync(join(holding, "keep.txt"), "an owner's file");
    await LINKS[server].sportarr(ctx);
    expect(existsSync(left)).toBe(false);
    expect(existsSync(join(holding, "keep.txt"))).toBe(true);
    expect(existsSync(others)).toBe(true);
    expect(leftovers().sort()).toEqual([holding, join(holding, "keep.txt"), others].map((path) => path.slice(media.length + 1)).sort());
  });

  test(`${name}: Connect to Sportarr and Connect to Chaptarr at once share one restart`, async () => {
    const { ctx, libraries, restarts } = fakes(server, "sportarr", { media: "after restart", also: "chaptarr" });
    await Promise.all([LINKS[server].sportarr(ctx), LINKS[server].chaptarr(ctx)]);
    expect(restarts).toHaveLength(1);
    expect(libraries.sort()).toEqual(["/media/audiobooks", "/media/books", "/media/sports"]);
  });
}

for (const server of ["jellyfin", "emby"] as const) {
  test(`${NAMES[server]}: a link that reaches its look while the other link restarts it waits for that restart, and doesn't restart it again`, async () => {
    const { ctx, libraries, restarts } = fakes(server, "sportarr", { media: "after restart", also: "chaptarr", holdSecondList: true });
    await Promise.all([LINKS[server].sportarr(ctx), LINKS[server].chaptarr(ctx)]);
    expect(restarts).toHaveLength(1);
    expect(libraries.sort()).toEqual(["/media/audiobooks", "/media/books", "/media/sports"]);
  });
}
