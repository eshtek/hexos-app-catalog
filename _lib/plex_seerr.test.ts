import { afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookContext } from "./hook_context";
import { run as connectSeerr } from "../plex/connect_seerr";

// Plex to Seerr against fakes of the two APIs, read at Seerr 3.5.1. A fresh Seerr is set up and
// finished. Run again, Seerr moves to this server when its own is gone (Plex reinstalled at the same
// address, or this server at an address that no longer reaches it), asks the owner when its server
// doesn't answer, and never leaves another server that still answers.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Seerr's MediaServerType: PLEX, JELLYFIN, NOT_CONFIGURED
const PLEX = 1;
const JELLYFIN = 2;
const NOT_CONFIGURED = 4;

/** This Plex server, at plex.test:32400. A reinstall gives the same address a new identifier. */
const THIS_SERVER = "new-machine";

let seerrConfig: string;
beforeAll(() => {
  seerrConfig = mkdtempSync(join(tmpdir(), "seerr-config-"));
  writeFileSync(join(seerrConfig, "settings.json"), JSON.stringify({ main: { apiKey: "seerr-key" } }));
});

interface Stored {
  name?: string;
  ip: string;
  port: number;
  useSsl?: boolean;
  machineId: string;
}

interface Options {
  mediaServerType?: number;
  initialized?: boolean;
  /** Seerr's Plex server as it stands. */
  stored?: Stored;
  /** What answers at each address, by "host:port"; this server always answers at plex.test:32400. */
  answers?: Record<string, string>;
  /** Seerr's libraries before the sync, each enabled or not. */
  libraries?: Array<{ id: string; enabled: boolean }>;
  /** The owner's answer when asked, "skip" to skip the question, or "none" for a box that can't ask. */
  owner?: boolean | "skip" | "none";
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
  const answers: Record<string, string> = { "plex.test:32400": THIS_SERVER, ...options.answers };
  let mediaServerType = options.mediaServerType ?? (options.stored ? PLEX : NOT_CONFIGURED);
  let initialized = options.initialized ?? !!options.stored;
  const plex: Partial<Stored> = { ...options.stored };
  let libraries = (options.libraries ?? [{ id: "1", enabled: false }]).map((library) => ({ ...library }));
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const call = { host: url.hostname, path: url.pathname, method: init?.method ?? "GET", body };
    calls.push(call);
    if (url.hostname !== "seer.test") {
      const id = answers[url.host];
      if (!id) throw new TypeError("fetch failed");
      if (url.pathname === "/" || url.pathname === "/identity") return json({ MediaContainer: { machineIdentifier: id } });
      if (url.pathname === "/library/sections") return json({ MediaContainer: { Directory: [{ key: "1" }, { key: "2" }] } });
    } else {
      if (url.pathname === "/api/v1/settings/public") return json({ initialized, mediaServerType });
      if (url.pathname === "/api/v1/auth/plex") {
        mediaServerType = PLEX;
        return json({});
      }
      if (url.pathname === "/api/v1/settings/plex" && call.method === "GET") return json(plex);
      if (url.pathname === "/api/v1/settings/plex" && call.method === "POST") {
        // Seerr asks the address for its server with the administrator's Plex sign-in
        const id = answers[`${body.ip}:${body.port}`];
        if (!id) return json({ message: "Unable to connect to Plex." }, 500);
        Object.assign(plex, body, { machineId: id });
        return json(plex);
      }
      if (url.pathname === "/api/v1/settings/plex/library/sync") {
        // Libraries are matched by id, so a new server's keep what the old server's had
        libraries = ["1", "2"].map((id) => ({ id, enabled: libraries.find((l) => l.id === id)?.enabled ?? false }));
        return json(libraries.map((library) => ({ ...library, name: `Library ${library.id}`, type: library.id === "1" ? "movie" : "show" })));
      }
      if (url.pathname.startsWith("/api/v1/settings/plex/library/")) {
        const library = libraries.find((l) => l.id === url.pathname.split("/").at(-1));
        if (library) library.enabled = body.enabled;
        return json(library ?? {});
      }
      if (url.pathname === "/api/v1/settings/plex/sync") return json({});
      if (url.pathname === "/api/v1/settings/initialize") {
        initialized = true;
        return json({ initialized });
      }
    }
    throw new Error(`Unexpected request: ${call.method} ${url.host}${url.pathname}`);
  }) as typeof fetch;
  const ctx = {
    baseUrl: "http://plex.test:32400",
    host: "plex.test",
    port: 32400,
    getInput: (id: string) => (id === "plex_login" ? { authToken: "plex-token" } : undefined),
    getInstalledAppUrl: async (id: string) => (id === "seerr" ? "http://seer.test" : null),
    getInstalledAppMounts: async () => [{ containerPath: "/app/config", hostPath: "/mnt/seerr/config", localPath: seerrConfig }],
    registerCheckpoints: async () => {},
    emitCheckpoint: async (id: string) => {
      checkpoints.push(id);
    },
    skipCheckpoint: async (id: string) => {
      checkpoints.push(`skipped:${id}`);
    },
    ...(options.owner === "none"
      ? {}
      : {
          askForInputs: async (_inputs: unknown, prompt?: { description?: string }) => {
            questions.push(prompt?.description ?? "");
            if (options.owner === "skip" || options.owner === undefined) {
              const error = new Error("unanswered");
              error.name = "HookInputsUnanswered";
              throw error;
            }
            return { switch: options.owner };
          },
        }),
    sleep: async () => {},
    log: () => {},
    fail: (message: string) => {
      throw new Error(message);
    },
    skip: (message: string) => {
      throw new Skipped(message);
    },
  } as unknown as HookContext;
  return { ctx, calls, checkpoints, questions, plex, libraries: () => libraries };
}

// Seerr's library sync is a POST that only rereads Plex's libraries, so it isn't a change
const changes = (calls: Call[]) =>
  calls.filter((c) => c.host === "seer.test" && c.method !== "GET" && c.path !== "/api/v1/settings/plex/library/sync");
const scanned = (calls: Call[]) => calls.some((c) => c.path === "/api/v1/settings/plex/sync" && c.method === "POST");

test("a fresh Seerr is set up with this server, its libraries turned on and its setup finished", async () => {
  const { ctx, calls, checkpoints, plex, libraries } = apis();
  await connectSeerr(ctx);
  expect(calls.some((c) => c.path === "/api/v1/auth/plex")).toBe(true);
  expect(plex).toMatchObject({ ip: "plex.test", port: 32400, machineId: THIS_SERVER });
  expect(libraries().every((library) => library.enabled)).toBe(true);
  expect(checkpoints).toEqual(["locate", "signin", "server", "libraries", "finish"]);
});

test("a Seerr already on this server, at an address that reaches it, is left as it is", async () => {
  const stored = { ip: "plex.test", port: 32400, machineId: THIS_SERVER };
  const { ctx, calls, checkpoints } = apis({ stored, libraries: [{ id: "1", enabled: true }] });
  await connectSeerr(ctx);
  expect(changes(calls)).toHaveLength(0);
  expect(checkpoints).toContain("skipped:server");
});

test("after Plex is reinstalled, Seerr moves to the new server at the address it had, with every library and a scan", async () => {
  // The owner had turned TV off on the old server; the new server's libraries are all new to Seerr
  const stored = { name: "HexOS Plex", ip: "plex.test", port: 32400, machineId: "old-machine" };
  const { ctx, calls, checkpoints, questions, plex, libraries } = apis({ stored, libraries: [{ id: "1", enabled: true }, { id: "2", enabled: false }] });
  await connectSeerr(ctx);
  expect(calls.find((c) => c.path === "/api/v1/settings/plex" && c.method === "POST")?.body).toEqual({ ip: "plex.test", port: 32400 });
  expect(plex.machineId).toBe(THIS_SERVER);
  expect(libraries().every((library) => library.enabled)).toBe(true);
  expect(scanned(calls)).toBe(true);
  expect(checkpoints).toContain("server");
  expect(questions).toHaveLength(0);
});

test("an address the owner wrote that now answers as this server is kept as written", async () => {
  const stored = { ip: "plex.home.test", port: 32400, machineId: "old-machine" };
  const { ctx, plex } = apis({ stored, answers: { "plex.home.test:32400": THIS_SERVER } });
  await connectSeerr(ctx);
  expect(plex).toMatchObject({ ip: "plex.home.test", port: 32400, machineId: THIS_SERVER });
});

for (const [label, stored] of [
  ["the box's address changed", { ip: "10.0.0.30", port: 32400, machineId: THIS_SERVER }],
  ["Plex's port changed", { ip: "plex.test", port: 32401, machineId: THIS_SERVER }],
] as const) {
  test(`a Seerr on this server at an address that no longer reaches it (${label}) moves to this one without asking`, async () => {
    const { ctx, calls, questions, plex } = apis({ stored, libraries: [{ id: "1", enabled: true }] });
    await connectSeerr(ctx);
    expect(plex).toMatchObject({ ip: "plex.test", port: 32400, machineId: THIS_SERVER });
    expect(questions).toHaveLength(0);
    // Still this server, so the owner's library choices hold
    expect(calls.some((c) => c.path.startsWith("/api/v1/settings/plex/library/") && c.method === "PUT")).toBe(false);
  });
}

test("a Seerr on another Plex server that still answers is never moved, nor is the owner asked", async () => {
  const stored = { ip: "10.0.0.80", port: 32400, machineId: "friends-machine" };
  const { ctx, calls, questions } = apis({ stored, answers: { "10.0.0.80:32400": "friends-machine" }, owner: true });
  await expect(connectSeerr(ctx)).rejects.toThrow(Skipped);
  expect(changes(calls)).toHaveLength(0);
  expect(questions).toHaveLength(0);
});

test("a Seerr whose other server doesn't answer asks the owner, and moves when they say so", async () => {
  const stored = { name: "Old Plex", ip: "10.0.0.30", port: 32400, machineId: "old-machine" };
  const { ctx, questions, plex, libraries, calls } = apis({ stored, libraries: [{ id: "1", enabled: true }, { id: "2", enabled: false }], owner: true });
  await connectSeerr(ctx);
  expect(questions).toEqual(["Seerr uses Old Plex at 10.0.0.30:32400, which isn't answering."]);
  expect(plex).toMatchObject({ ip: "plex.test", port: 32400, machineId: THIS_SERVER });
  expect(libraries().every((library) => library.enabled)).toBe(true);
  expect(scanned(calls)).toBe(true);
});

for (const owner of [false, "skip", "none"] as const) {
  test(`a Seerr whose other server doesn't answer stays as it is when the owner doesn't move it (${owner})`, async () => {
    const stored = { ip: "10.0.0.30", port: 32400, machineId: "old-machine" };
    const { ctx, calls } = apis({ stored, owner });
    await expect(connectSeerr(ctx)).rejects.toThrow(/another Plex server/);
    expect(changes(calls)).toHaveLength(0);
  });
}

test("a Seerr on another media server is left as it is", async () => {
  const { ctx, calls } = apis({ mediaServerType: JELLYFIN, initialized: true, owner: true });
  await expect(connectSeerr(ctx)).rejects.toThrow(/another media server/);
  expect(changes(calls)).toHaveLength(0);
});
