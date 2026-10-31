import { afterEach, expect, test } from "bun:test";
import { limitRemoteStreams } from "../emby/emby_hook";
import { setPreferences } from "../plex/plex_hook";
import type { HookContext } from "./hook_context";

// Remote streams are limited to 20 Mbps out of the box. An owner's own limit stays.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const logs: string[] = [];
const ctx = { baseUrl: "http://app", log: (message: string) => logs.push(message), sleep: async () => {} } as unknown as HookContext;

function emby(config: Record<string, unknown> | Error) {
  const posted: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
    if (config instanceof Error) throw config;
    if (init?.method === "POST") posted.push(JSON.parse(String(init.body)));
    return Response.json(config);
  }) as typeof fetch;
  return posted;
}

test("Emby gets the limit, with its other settings kept", async () => {
  const posted = emby({ RemoteClientBitrateLimit: 0, ServerName: "Mine" });
  await limitRemoteStreams(ctx, "token");
  expect(posted).toEqual([{ RemoteClientBitrateLimit: 20_000_000, ServerName: "Mine" }]);
});

test("an Emby owner's own limit stays", async () => {
  const posted = emby({ RemoteClientBitrateLimit: 8_000_000 });
  await limitRemoteStreams(ctx, "token");
  expect(posted).toEqual([]);
});

test("a failure costs only the limit, and never the setup", async () => {
  emby(new Error("connection refused"));
  await limitRemoteStreams(ctx, "token");
  expect(logs.at(-1)).toContain("Remote stream limit not set");
});

function plex() {
  const set = new Map<string, string>();
  globalThis.fetch = (async (input: string | URL) => {
    for (const [key, value] of new URL(String(input)).searchParams) set.set(key, value);
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return set;
}

test("a Plex server just claimed gets the limit, in the kilobits Plex counts in", async () => {
  const set = plex();
  await setPreferences("token", ctx, "HexOS Plex");
  expect(set.get("WanPerStreamMaxUploadRate")).toBe("20000");
});

test("a rerun on a server already claimed leaves an owner's limit", async () => {
  const set = plex();
  await setPreferences("token", ctx, undefined);
  expect(set.has("WanPerStreamMaxUploadRate")).toBe(false);
});
