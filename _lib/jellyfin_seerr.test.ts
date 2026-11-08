import { afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookContext } from "./hook_context";
import { run as connectSeerr } from "../jellyfin/connect_seerr";

// Jellyfin to Seerr against fakes of the two APIs, read at Seerr 3.5.1: a fresh Seerr is set up and
// finished, and a Seerr already on this Jellyfin is left as it is. Run again, Seerr moves to this server
// when its own is gone (Jellyfin reinstalled at the same address, or this server at an address that no
// longer reaches it), asks the owner when its server doesn't answer, and never leaves another server
// that still answers; the step steps aside instead (ctx.skip), since trying again can't help.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Seerr's MediaServerType: PLEX, JELLYFIN, EMBY, NOT_CONFIGURED
const PLEX = 1;
const JELLYFIN = 2;
const EMBY = 3;
const NOT_CONFIGURED = 4;

let seerrConfig: string;
beforeAll(() => {
  seerrConfig = mkdtempSync(join(tmpdir(), "seerr-config-"));
  writeFileSync(join(seerrConfig, "settings.json"), JSON.stringify({ main: { apiKey: "seerr-key" } }));
});

/** This Jellyfin server, at jf.test:8096. A reinstall gives the same address a new id. */
const THIS_SERVER = "this-jf";

interface Options {
  initialized?: boolean;
  /** The server id Seerr holds; this server's unless said. */
  serverId?: string;
  /** What answers at each address, by "host:port" and any base path; this server answers at jf.test:8096. */
  answers?: Record<string, string>;
  /** Seerr's libraries before the sync. */
  enabled?: boolean;
  /** The owner's answer when asked, "skip" to skip the question; a box that can't ask when unset. */
  owner?: boolean | "skip";
  mediaServerType?: number;
  ip?: string;
  port?: number;
  useSsl?: boolean;
  urlBase?: string;
  initializeFails?: boolean;
  initializeNoop?: boolean;
  verifiedType?: number;
  signIn?: boolean;
}

interface Call {
  host: string;
  path: string;
  method: string;
  body: Record<string, unknown>;
}

class Skipped extends Error {}

function apis(options: Options = {}) {
  const calls: Call[] = [];
  const checkpoints: string[] = [];
  const questions: string[] = [];
  const answers: Record<string, string> = { "jf.test:8096": THIS_SERVER, ...options.answers };
  const jellyfin = {
    ip: options.ip ?? "jf.test",
    port: options.port ?? 8096,
    useSsl: options.useSsl ?? false,
    urlBase: options.urlBase ?? "",
    serverId: options.serverId ?? THIS_SERVER,
    apiKey: "seerr-jf-key",
  };
  const keys: string[] = [];
  let enabled = options.enabled ?? false;
  let initialized = options.initialized ?? false;
  let mediaServerType = options.mediaServerType ?? NOT_CONFIGURED;
  let initializeCalls = 0;
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const call = { host: url.hostname, path: url.pathname, method: init?.method ?? "GET", body };
    calls.push(call);
    if (url.hostname !== "seer.test") {
      // A base path counts only for the server's info; the rest is at the root
      const base = url.pathname.endsWith("/System/Info/Public") ? url.pathname.replace(/\/System\/Info\/Public$/, "") : "";
      const id = answers[`${url.host}${base}`];
      if (!id || url.protocol === "https:") throw new TypeError("fetch failed");
      if (url.pathname.endsWith("/System/Info/Public")) return json({ Id: id, ServerName: "Jellyfin" });
      if (url.pathname === "/Users/AuthenticateByName") return json({ AccessToken: "jf-session", User: { Id: "0f0e-0d0c" } });
      if (url.pathname === "/Auth/Keys" && call.method === "GET") {
        return json({ Items: keys.map((key, index) => ({ AppName: "Seerr", AccessToken: key, DateCreated: `2026-11-0${index + 1}` })) });
      }
      if (url.pathname === "/Auth/Keys" && call.method === "POST") {
        keys.push(`jf-key-${keys.length + 1}`);
        return new Response(null, { status: 204 });
      }
    }
    if (url.hostname === "seer.test") {
      if (url.pathname === "/api/v1/settings/public") {
        const type = initializeCalls > 0 ? (options.verifiedType ?? mediaServerType) : mediaServerType;
        return json({ initialized, mediaServerType: type });
      }
      if (url.pathname === "/api/v1/auth/jellyfin") {
        if (mediaServerType !== NOT_CONFIGURED && body.hostname) return json({ message: "Jellyfin hostname already configured" }, 500);
        mediaServerType = JELLYFIN;
        return json({});
      }
      if (url.pathname === "/api/v1/settings/jellyfin" && call.method === "GET") return json(jellyfin);
      if (url.pathname === "/api/v1/settings/jellyfin" && call.method === "POST") {
        // Seerr asks the address for its system info with the key it would keep
        const next = { ...jellyfin, ...body };
        const id = next.useSsl ? undefined : answers[`${next.ip}:${next.port}${next.urlBase}`];
        const keyWorks = id === THIS_SERVER ? next.apiKey === "seerr-jf-key" ? jellyfin.serverId === THIS_SERVER : keys.includes(next.apiKey) : !!id;
        if (!id || !keyWorks) return json({ message: "INVALID_URL" }, 401);
        Object.assign(jellyfin, next, { serverId: id });
        return json(jellyfin);
      }
      if (url.pathname === "/api/v1/settings/jellyfin/library/sync") {
        return json([{ id: "1", name: "Movies", enabled, type: "movie" }]);
      }
      if (url.pathname.startsWith("/api/v1/settings/jellyfin/library/")) {
        enabled = body.enabled;
        return json({});
      }
      if (url.pathname === "/api/v1/settings/jellyfin/sync") return json({});
      if (url.pathname === "/api/v1/user") return json({ results: [{ id: 1, jellyfinUserId: "0f0e0d0c", permissions: 2 }] });
      if (url.pathname === "/api/v1/settings/initialize") {
        initializeCalls += 1;
        if (options.initializeFails) return json({ message: "Service Unavailable" }, 503);
        if (!options.initializeNoop) initialized = true;
        return json({ initialized });
      }
    }
    throw new Error(`Unexpected request: ${call.method} ${url.hostname}${url.pathname}`);
  }) as typeof fetch;
  const ctx = {
    baseUrl: "http://jf.test:8096",
    host: "jf.test",
    port: 8096,
    ...(options.signIn === false ? {} : { signIn: { username: "owner", password: "owner-password", email: "owner@example.test" } }),
    getInstalledAppUrl: async (id: string) => (id === "seerr" ? "http://seer.test" : null),
    getInstalledAppMounts: async () => [{ containerPath: "/app/config", hostPath: "/mnt/seerr/config", localPath: seerrConfig }],
    registerCheckpoints: async () => {},
    ...(options.owner === undefined
      ? {}
      : {
          askForInputs: async (_inputs: unknown, prompt?: { description?: string }) => {
            questions.push(prompt?.description ?? "");
            if (options.owner === "skip") {
              const error = new Error("unanswered");
              error.name = "HookInputsUnanswered";
              throw error;
            }
            return { switch: options.owner };
          },
        }),
    emitCheckpoint: async (id: string) => {
      checkpoints.push(id);
    },
    skipCheckpoint: async (id: string) => {
      checkpoints.push(`skipped:${id}`);
    },
    sleep: async () => {},
    log: () => {},
    fail: (message: string) => {
      throw new Error(message);
    },
    skip: (message: string) => {
      throw new Skipped(message);
    },
  } as unknown as HookContext;
  return { ctx, calls, checkpoints, questions, jellyfin, keys, enabled: () => enabled };
}

// Seerr's library sync is a POST that only rereads Jellyfin's libraries, so it isn't a change
const changes = (calls: Call[]) =>
  calls.filter((c) => c.host === "seer.test" && c.method !== "GET" && c.path !== "/api/v1/settings/jellyfin/library/sync");
const scanned = (calls: Call[]) => calls.some((c) => c.path === "/api/v1/settings/jellyfin/sync" && c.method === "POST");

test("Seerr sets up a fresh Jellyfin binding with the owner's account, its libraries and its setup finished", async () => {
  const { ctx, calls, checkpoints } = apis();
  await connectSeerr(ctx);
  const signIn = calls.find((c) => c.path === "/api/v1/auth/jellyfin")?.body;
  expect(signIn).toMatchObject({ username: "owner", email: "owner@example.test", hostname: "jf.test", port: 8096, useSsl: false, urlBase: "" });
  expect(calls.some((c) => c.path === "/api/v1/settings/jellyfin/library/1" && c.method === "PUT")).toBe(true);
  expect(calls.filter((c) => c.path === "/api/v1/settings/initialize")).toHaveLength(1);
  expect(checkpoints.at(-1)).toBe("finish");
});

test("Seerr reruns against its own Jellyfin binding without signing in or finishing setup again", async () => {
  const { ctx, calls } = apis({ initialized: true, mediaServerType: JELLYFIN });
  await connectSeerr(ctx);
  expect(calls.some((c) => c.path === "/api/v1/auth/jellyfin")).toBe(false);
  expect(calls.some((c) => c.path === "/api/v1/settings/initialize")).toBe(false);
});

for (const mediaServerType of [PLEX, EMBY]) {
  for (const initialized of [true, false]) {
    test(`Seerr on another media server (${mediaServerType}, ${initialized ? "finished" : "part set up"}) is left as it is`, async () => {
      const { ctx, calls } = apis({ initialized, mediaServerType });
      await expect(connectSeerr(ctx)).rejects.toThrow(Skipped);
      expect(changes(calls)).toHaveLength(0);
    });
  }
}

test("Seerr on another Jellyfin server that still answers is never moved, nor is the owner asked", async () => {
  const { ctx, calls, questions } = apis({
    initialized: true,
    mediaServerType: JELLYFIN,
    ip: "another.test",
    serverId: "friends-jf",
    answers: { "another.test:8096": "friends-jf" },
    owner: true,
  });
  await expect(connectSeerr(ctx)).rejects.toThrow(Skipped);
  expect(changes(calls)).toHaveLength(0);
  expect(questions).toHaveLength(0);
});

test("an address of this Jellyfin the owner wrote, which still reaches it, is kept as written", async () => {
  const { ctx, calls } = apis({ initialized: true, mediaServerType: JELLYFIN, enabled: true, ip: "jellyfin.home.test", answers: { "jellyfin.home.test:8096": THIS_SERVER } });
  await connectSeerr(ctx);
  expect(changes(calls)).toHaveLength(0);
});

for (const options of [{ ip: "10.0.0.30" }, { port: 8097 }, { useSsl: true }, { urlBase: "/other" }]) {
  test(`Seerr on this Jellyfin at an address that no longer reaches it (${Object.keys(options)[0]}) moves to this one without asking`, async () => {
    const { ctx, calls, questions, jellyfin, keys } = apis({ initialized: true, mediaServerType: JELLYFIN, enabled: true, owner: false, ...options });
    await connectSeerr(ctx);
    expect(jellyfin).toMatchObject({ ip: "jf.test", port: 8096, useSsl: false, urlBase: "", apiKey: "seerr-jf-key" });
    expect(questions).toHaveLength(0);
    expect(keys).toHaveLength(0);
    // Still this server, so the owner's library choices hold
    expect(calls.some((c) => c.path.startsWith("/api/v1/settings/jellyfin/library/") && c.method === "PUT")).toBe(false);
  });
}

test("after Jellyfin is reinstalled, Seerr moves to the new server with a key of its own, the owner as an administrator, its libraries and a scan", async () => {
  const { ctx, calls, jellyfin, keys, enabled } = apis({ initialized: true, mediaServerType: JELLYFIN, serverId: "old-jf", enabled: true });
  await connectSeerr(ctx);
  expect(keys).toEqual(["jf-key-1"]);
  expect(jellyfin).toMatchObject({ ip: "jf.test", port: 8096, serverId: THIS_SERVER, apiKey: "jf-key-1" });
  // The owner's account in the new Jellyfin is looked up in Seerr (imported and made an administrator when missing)
  expect(calls.some((c) => c.path === "/api/v1/user")).toBe(true);
  expect(enabled()).toBe(true);
  expect(scanned(calls)).toBe(true);
});

test("after Jellyfin is reinstalled, an address the owner wrote that answers as the new server is kept as written", async () => {
  const { ctx, jellyfin } = apis({
    initialized: true,
    mediaServerType: JELLYFIN,
    serverId: "old-jf",
    ip: "jellyfin.home.test",
    answers: { "jellyfin.home.test:8096": THIS_SERVER },
  });
  await connectSeerr(ctx);
  expect(jellyfin).toMatchObject({ ip: "jellyfin.home.test", port: 8096, serverId: THIS_SERVER, apiKey: "jf-key-1" });
});

test("a reinstalled Jellyfin that already holds a Seerr key gets no second one", async () => {
  const { ctx, keys } = apis({ initialized: true, mediaServerType: JELLYFIN, serverId: "old-jf" });
  keys.push("jf-key-1");
  await connectSeerr(ctx);
  expect(keys).toEqual(["jf-key-1"]);
});

test("a Seerr whose other Jellyfin doesn't answer asks the owner, and moves when they say so", async () => {
  const { ctx, questions, jellyfin } = apis({ initialized: true, mediaServerType: JELLYFIN, ip: "10.0.0.30", serverId: "old-jf", owner: true });
  await connectSeerr(ctx);
  expect(questions).toEqual(["Seerr uses 10.0.0.30:8096, which isn't answering."]);
  expect(jellyfin).toMatchObject({ ip: "jf.test", port: 8096, serverId: THIS_SERVER, apiKey: "jf-key-1" });
});

for (const owner of [false, "skip", undefined] as const) {
  test(`a Seerr whose other Jellyfin doesn't answer stays as it is when the owner doesn't move it (${owner})`, async () => {
    const { ctx, calls } = apis({ initialized: true, mediaServerType: JELLYFIN, ip: "10.0.0.30", serverId: "old-jf", owner });
    await expect(connectSeerr(ctx)).rejects.toThrow(/another Jellyfin server/);
    expect(changes(calls)).toHaveLength(0);
  });
}

test("Seerr whose media server can't be read is left as it is", async () => {
  const { ctx, calls } = apis({ mediaServerType: Number.NaN });
  await expect(connectSeerr(ctx)).rejects.toThrow(Skipped);
  expect(changes(calls)).toHaveLength(0);
});

test("Seerr set up with this Jellyfin but stopped before its setup finished gets it finished", async () => {
  const { ctx, calls } = apis({ initialized: false, mediaServerType: JELLYFIN });
  await connectSeerr(ctx);
  expect(calls.some((c) => c.path === "/api/v1/auth/jellyfin")).toBe(false);
  expect(calls.filter((c) => c.path === "/api/v1/settings/initialize")).toHaveLength(1);
});

test("Seerr refusing to finish its setup fails the step rather than claiming it", async () => {
  const { ctx } = apis({ initializeFails: true });
  await expect(connectSeerr(ctx)).rejects.toThrow(/Service Unavailable/);
});

for (const options of [{ initializeNoop: true }, { verifiedType: PLEX }]) {
  test(`Seerr's finished setup is checked afterwards (${Object.keys(options)[0]})`, async () => {
    const { ctx } = apis(options);
    await expect(connectSeerr(ctx)).rejects.toThrow(/didn't finish its setup/);
  });
}

// A Jellyfin the owner already had keeps its own administrator (Aaron, 2026-11-08): Seerr is signed
// in as the one they gave in the collection's walk, not the run's new sign-in, which Jellyfin never took
test("Seerr signs in as a kept Jellyfin's own administrator, ahead of the run's sign-in", async () => {
  const { ctx, calls } = apis();
  Object.assign(ctx, { resourceId: "jellyfin", existingSignIns: { jellyfin: { username: "jellyadmin", password: "their-own" } } });
  await connectSeerr(ctx);
  expect(calls.find((c) => c.path === "/api/v1/auth/jellyfin")?.body).toMatchObject({ username: "jellyadmin", password: "their-own" });
});

test("a Seerr already on a kept Jellyfin gains no administrator from the run's sign-in", async () => {
  const { ctx, calls } = apis({ initialized: true, mediaServerType: JELLYFIN });
  Object.assign(ctx, { resourceId: "jellyfin", existingSignIns: { jellyfin: { username: "jellyadmin", password: "their-own" } } });
  await connectSeerr(ctx);
  // Not even looked up: the run's sign-in is no Jellyfin user of this server
  expect(calls.some((c) => c.path === "/Users/AuthenticateByName")).toBe(false);
  expect(changes(calls).filter((c) => c.path.startsWith("/api/v1/user"))).toHaveLength(0);
});
