import { afterEach, expect, test } from "bun:test";
import type { HookContext } from "./hook_context";
import { afterInstall } from "../jellyfin/jellyfin_hook";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Options {
  /** Paths the server already has libraries for. */
  existing?: string[];
  /** Answers a list of libraries with 503 this many times after each request to make one. */
  busyListsAfterRequest?: number;
  /** Every list of libraries is a 503. */
  listBroken?: boolean;
  /** The request lands but the answer never comes. */
  noAnswer?: boolean;
  /** With noAnswer: lists to answer before the library shows. */
  landsAfterLists?: number;
  /** Status of a refused request. */
  refuse?: number;
  event?: string;
}

/** A Jellyfin that behaves as 12.4 does: no guard against a repeat, each request gets a numbered library. */
function jellyfin(options: Options = {}) {
  const libraries = (options.existing ?? []).map((path, i) => ({ Name: `Old${i}`, Locations: [path] }));
  const pending: Array<{ library: { Name: string; Locations: string[] }; lists: number }> = [];
  const requests: string[] = [];
  const parked: string[] = [];
  let busy = 0;

  const numbered = (name: string) => {
    const names = new Set([...libraries, ...pending.map((p) => p.library)].map((l) => l.Name));
    if (!names.has(name)) return name;
    let n = 2;
    while (names.has(`${name}${n}`)) n++;
    return `${name}${n}`;
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    if (url.pathname === "/Startup/User") return new Response(null, { status: 401 });
    if (url.pathname === "/System/Info/Public") return Response.json({ StartupWizardCompleted: true });
    if (url.pathname === "/Users/AuthenticateByName")
      return Response.json({ AccessToken: "session", User: { Policy: { IsAdministrator: true } } });
    if (url.pathname === "/Auth/Keys") return Response.json({ Items: [{ AppName: "HexOS" }] });
    if (url.pathname === "/Library/VirtualFolders" && method === "GET") {
      if (options.listBroken) return new Response("busy", { status: 503 });
      if (busy > 0) {
        busy--;
        return new Response("busy", { status: 503 });
      }
      for (const entry of [...pending]) {
        if (entry.lists-- > 0) continue;
        pending.splice(pending.indexOf(entry), 1);
        libraries.push(entry.library);
      }
      return Response.json(libraries);
    }
    if (url.pathname === "/Library/VirtualFolders" && method === "POST") {
      const name = url.searchParams.get("name")!;
      requests.push(name);
      if (options.refuse) return new Response("refused", { status: options.refuse });
      const library = { Name: numbered(name), Locations: [url.searchParams.get("paths")!] };
      busy = options.busyListsAfterRequest ?? 0;
      if (options.noAnswer) {
        pending.push({ library, lists: options.landsAfterLists ?? 0 });
        throw new DOMException("The operation timed out.", "TimeoutError");
      }
      libraries.push(library);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${method} ${url.pathname}`);
  }) as typeof fetch;

  const ctx = {
    baseUrl: "http://jf.test",
    event: options.event ?? "onAfterInstall",
    signIn: { username: "owner", password: "secret" },
    mounts: [],
    registerCheckpoints: async () => {},
    emitCheckpoint: async () => {},
    updateCheckpointMessage: async () => {},
    skipCheckpoint: async () => {},
    awaitCheckpointRetry: async (id: string) => {
      parked.push(id);
      return "skip";
    },
    log: () => {},
    sleep: async () => {},
    fail: (message: string) => {
      throw new Error(message);
    },
  } as unknown as HookContext;

  return { ctx, libraries, requests, parked };
}

const names = ["Movies", "Shows", "Music", "Photos", "Videos"];

test("each library is made once on a healthy server", async () => {
  const { ctx, libraries, requests, parked } = jellyfin();
  await afterInstall(ctx);
  expect(requests).toEqual(names);
  expect(libraries.map((l) => l.Name)).toEqual(names);
  expect(parked).toEqual([]);
});

test("a library the server is slow to list is not asked for again", async () => {
  const { ctx, libraries, requests, parked } = jellyfin({ busyListsAfterRequest: 6 });
  await afterInstall(ctx);
  expect(requests).toEqual(names);
  expect(libraries.map((l) => l.Name)).toEqual(names);
  expect(parked).toEqual([]);
});

test("a request with no answer that landed is not repeated", async () => {
  const { ctx, libraries, requests, parked } = jellyfin({ noAnswer: true });
  await afterInstall(ctx);
  expect(requests).toEqual(names);
  expect(libraries.map((l) => l.Name)).toEqual(names);
  expect(parked).toEqual([]);
});

test("a request with no answer that lands late is not repeated", async () => {
  const { ctx, libraries, requests } = jellyfin({ noAnswer: true, landsAfterLists: 8 });
  await afterInstall(ctx);
  expect(requests).toEqual(names);
  expect(libraries.map((l) => l.Name)).toEqual(names);
});

test("a request that lands after the wait is found before asking again", async () => {
  const { ctx, libraries, requests } = jellyfin({ noAnswer: true, landsAfterLists: 12 });
  await afterInstall(ctx);
  expect(requests).toEqual(names);
  expect(libraries.map((l) => l.Name)).toEqual(names);
});

test("a server that can't list its libraries gets no request, and the owner is asked", async () => {
  const { ctx, requests, parked } = jellyfin({ listBroken: true });
  await afterInstall(ctx);
  expect(requests).toEqual([]);
  expect(parked).toEqual(["lib_movies", "lib_tv", "lib_music", "lib_photos", "lib_videos"]);
});

test("a run from the card that can't list its libraries stops", async () => {
  const { ctx, requests } = jellyfin({ listBroken: true, event: "action" });
  await expect(afterInstall(ctx)).rejects.toThrow(/Could not read/);
  expect(requests).toEqual([]);
});

test("a refused request is tried five times, then the owner is asked", async () => {
  const { ctx, requests, parked } = jellyfin({ refuse: 500 });
  await afterInstall(ctx);
  expect(requests.filter((name) => name === "Movies")).toHaveLength(5);
  expect(parked).toContain("lib_movies");
});

test("a library the server already has is left alone", async () => {
  const { ctx, requests } = jellyfin({ existing: ["/movies", "/shows"] });
  await afterInstall(ctx);
  expect(requests).toEqual(["Music", "Photos", "Videos"]);
});
