import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anythingLlm, openWebui } from "../searxng/connect";
import type { HookContext } from "./hook_context";

// SearXNG gives a chat app private web search: it first lets SearXNG answer json, which it reads
// only at its start, then points the app's search at it. AnythingLLM takes its search address and
// engine without a sign-in on a fresh install, and refuses both once it has a password.

const SEARXNG = "http://10.0.0.5:30053";
const ANYTHING = "http://10.0.0.5:30239";
const OPEN_WEBUI = "http://10.0.0.5:30080";

let folder: string;
let restarts: number;
let calls: Array<{ url: string; body?: unknown }>;
let status: Record<string, number>;

function ctx(): HookContext {
  return {
    baseUrl: SEARXNG,
    mounts: [{ hostPath: "/mnt/pool/searxng/config", containerPath: "/etc/searxng", localPath: folder }],
    signIn: { username: "admin", password: "correct horse", email: "owner@example.com" },
    getInstalledAppUrl: async (app: string) => (app === "anything-llm" ? ANYTHING : app === "open-webui" ? OPEN_WEBUI : null),
    registerCheckpoints: async () => {},
    emitCheckpoint: async () => {},
    skipCheckpoint: async () => {},
    restartApp: async () => {
      restarts++;
    },
    waitForApp: async () => {},
    fail: (message: string) => {
      throw new Error(message);
    },
  } as unknown as HookContext;
}

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "searxng-"));
  writeFileSync(join(folder, "settings.yml"), "use_default_settings: true\nserver:\n  secret_key: abc\n");
  restarts = 0;
  calls = [];
  status = {};
  spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === "/api/v1/auths/signin") return Response.json({ token: "t" });
    if (path === "/api/v1/retrieval/config") return Response.json({ web: { RESULT_COUNT: 3 } });
    return new Response("{}", { status: status[path] ?? 200, statusText: status[path] ? "Unauthorized" : "OK" });
  }) as typeof fetch);
});
afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore: () => void }).mockRestore();
  rmSync(folder, { recursive: true, force: true });
});

const settings = () => readFileSync(join(folder, "settings.yml"), "utf-8");

describe("SearXNG's link to AnythingLLM", () => {
  test("lets SearXNG answer json, then gives AnythingLLM its search address before choosing it", async () => {
    await anythingLlm(ctx());
    expect(settings()).toContain("search:\n  formats:\n    - html\n    - json\n");
    expect(settings()).toStartWith("use_default_settings: true\n");
    expect(restarts).toBe(1);
    expect(calls.map((call) => [call.url, call.body])).toEqual([
      [`${ANYTHING}/api/system/update-env`, { AgentSearXNGApiUrl: `${SEARXNG}/search` }],
      [`${ANYTHING}/api/admin/system-preferences`, { agent_search_provider: "searxng-engine" }],
    ]);
  });

  test("leaves SearXNG alone when it already answers json, so a second run doesn't restart it", async () => {
    await anythingLlm(ctx());
    await anythingLlm(ctx());
    expect(restarts).toBe(1);
    expect(settings().match(/- json/g)).toHaveLength(1);
  });

  test("doesn't add a second search section to settings the owner wrote", async () => {
    writeFileSync(join(folder, "settings.yml"), "search:\n  safe_search: 1\n");
    await expect(anythingLlm(ctx())).rejects.toThrow("already have a search section");
    expect(settings()).toBe("search:\n  safe_search: 1\n");
    expect(calls).toHaveLength(0);
  });

  test("tells the owner where to choose SearXNG when AnythingLLM has a password, and chooses nothing", async () => {
    status["/api/system/update-env"] = 401;
    await expect(anythingLlm(ctx())).rejects.toThrow(`choose SearXNG and enter ${SEARXNG}/search`);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/api/system/update-env"]);
  });
});

describe("SearXNG's link to Open WebUI", () => {
  test("lets SearXNG answer json, then turns on Open WebUI's web search, keeping its other settings", async () => {
    await openWebui(ctx());
    expect(restarts).toBe(1);
    const update = calls.find((call) => call.url.endsWith("/api/v1/retrieval/config/update"));
    expect(update?.body).toEqual({
      web: { RESULT_COUNT: 3, ENABLE_WEB_SEARCH: true, WEB_SEARCH_ENGINE: "searxng", SEARXNG_QUERY_URL: `${SEARXNG}/search?q=<query>` },
    });
  });
});
