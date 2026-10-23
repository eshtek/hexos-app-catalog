import { afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookContext } from "./hook_context";
import { run as connectSeerr } from "../jellyfin/connect_seerr";

// Jellyfin to Seerr against fakes of the two APIs, read at Seerr 3.5.1: a fresh Seerr is set up and
// finished, a Seerr already on this Jellyfin is left as it is, and one on another server or address is
// never changed; the step steps aside instead (ctx.skip), since trying again can't help.

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

interface Options {
  initialized?: boolean;
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
  let initialized = options.initialized ?? false;
  let mediaServerType = options.mediaServerType ?? NOT_CONFIGURED;
  let initializeCalls = 0;
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const call = { host: url.hostname, path: url.pathname, method: init?.method ?? "GET", body };
    calls.push(call);
    if (url.hostname === "jf.test" && url.pathname === "/Users/AuthenticateByName") {
      return json({ AccessToken: "jf-session", User: { Id: "0f0e-0d0c" } });
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
      if (url.pathname === "/api/v1/settings/jellyfin") {
        return json({ ip: options.ip ?? "jf.test", port: options.port ?? 8096, useSsl: options.useSsl ?? false, urlBase: options.urlBase ?? "" });
      }
      if (url.pathname === "/api/v1/settings/jellyfin/library/sync") {
        return json([{ id: "1", name: "Movies", enabled: false, type: "movie" }]);
      }
      if (url.pathname.startsWith("/api/v1/settings/jellyfin/library/") || url.pathname === "/api/v1/settings/jellyfin/sync") {
        return json({});
      }
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
  return { ctx, calls, checkpoints };
}

const changes = (calls: Call[]) => calls.filter((c) => c.host === "seer.test" && c.method !== "GET");

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

test("Seerr on another Jellyfin server is left as it is", async () => {
  const { ctx, calls } = apis({ initialized: true, mediaServerType: JELLYFIN, ip: "another.test" });
  await expect(connectSeerr(ctx)).rejects.toThrow(Skipped);
  expect(changes(calls)).toHaveLength(0);
});

for (const options of [{ port: 8097 }, { useSsl: true }, { urlBase: "/other" }]) {
  test(`Seerr at another address of this Jellyfin (${Object.keys(options)[0]}) is left as it is`, async () => {
    const { ctx, calls } = apis({ initialized: true, mediaServerType: JELLYFIN, ...options });
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
