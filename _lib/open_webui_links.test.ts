import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookContext } from "./hook_context";
import { connect as connectOllama } from "../open-webui/connect_ollama";
import { run as connectSearxng } from "../searxng/connect_open_webui";

// Open WebUI's link to Ollama and SearXNG's link to Open WebUI against a fake Open WebUI, read at
// Open WebUI 0.13.0 (backend/open_webui/routers/ollama.py, auths.py, retrieval.py). Open WebUI keeps
// a list of Ollama connections with each one's settings keyed by its place in the list: the link
// replaces only this box's, keeps every other with its settings, and tells an Open WebUI that isn't
// answering from one that turned the sign-in away.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const WEBUI = "webui.test:31028";
const ADMIN = { email: "owner@home.test", password: "correct horse" };

interface OllamaConfig {
  ENABLE_OLLAMA_API?: boolean | null;
  OLLAMA_BASE_URLS: string[];
  OLLAMA_API_CONFIGS: Record<string, unknown>;
}

interface Options {
  /** Open WebUI's Ollama settings before the run. */
  ollama?: OllamaConfig;
  /** Where HexOS finds this box's Ollama. */
  ollamaUrl?: string;
  /** Addresses where an Ollama answers now, by "host:port". */
  answering?: string[];
  /** Open WebUI's web search settings before the run. */
  web?: Record<string, unknown>;
  /** What doesn't answer: everything, the sign-in, reading settings, or saving them. */
  outage?: "down" | "signin" | "read" | "save";
  /** The account's role; Open WebUI's admin API answers 401 to any other. */
  role?: "admin" | "user";
  /** The run's sign-in. */
  signIn?: { username: string; password: string; email?: string };
  /** The owner's answer when asked, "skip" to skip the question, or "none" for a box that can't ask. */
  owner?: { email: string; password: string } | "skip" | "none";
  /** The context Ollama runs at, as the box reads it. */
  contextLength?: number;
}

class Skipped extends Error {}

function openWebUi(options: Options = {}) {
  const questions: string[] = [];
  const checkpoints: string[] = [];
  const signIns: string[] = [];
  const updates: unknown[] = [];
  const state = {
    ollama: structuredClone(options.ollama ?? { ENABLE_OLLAMA_API: true, OLLAMA_BASE_URLS: ["http://box.test:30068"], OLLAMA_API_CONFIGS: {} }),
    web: { ...(options.web ?? { ENABLE_WEB_SEARCH: false, WEB_SEARCH_RESULT_COUNT: 3 }) },
  };
  const answering = new Set(options.answering ?? ["box.test:30068"]);
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    if (url.host !== WEBUI) {
      if (url.pathname === "/api/version" && answering.has(url.host)) return json({ version: "0.12.0" });
      throw new TypeError("fetch failed");
    }
    if (options.outage === "down") throw new TypeError("fetch failed");
    if (url.pathname === "/health") return json({ status: true });
    if (url.pathname === "/api/v1/auths/signin" && method === "POST") {
      if (options.outage === "signin") throw new TypeError("fetch failed");
      const body = JSON.parse(String(init?.body)) as { email: string; password: string };
      signIns.push(body.email);
      if (body.email !== ADMIN.email || body.password !== ADMIN.password) return json({ detail: "The email or password provided is incorrect." }, 400);
      return json({ token: "admin-token", token_type: "Bearer" });
    }
    if (options.outage === "read" && method === "GET") throw new TypeError("fetch failed");
    if (options.outage === "save" && method === "POST") throw new TypeError("fetch failed");
    const signedIn = (init?.headers as Record<string, string> | undefined)?.Authorization === "Bearer admin-token";
    if (!signedIn || (options.role ?? "admin") !== "admin") return json({ detail: "You do not have permission to access this resource." }, 401);
    if (url.pathname === "/ollama/config" && method === "GET") return json(state.ollama);
    if (url.pathname === "/ollama/config/update" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as OllamaConfig;
      updates.push(body);
      // Settings not keyed by a place in the list are dropped
      const keys = new Set(body.OLLAMA_BASE_URLS.map((_, index) => String(index)));
      const configs = Object.fromEntries(Object.entries(body.OLLAMA_API_CONFIGS).filter(([key]) => keys.has(key)));
      state.ollama = { ENABLE_OLLAMA_API: body.ENABLE_OLLAMA_API, OLLAMA_BASE_URLS: body.OLLAMA_BASE_URLS, OLLAMA_API_CONFIGS: configs };
      return json(state.ollama);
    }
    if (url.pathname === "/api/v1/retrieval/config" && method === "GET") return json({ web: state.web });
    if (url.pathname === "/api/v1/retrieval/config/update" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { web?: Record<string, unknown> };
      updates.push(body);
      // Only the web settings sent change
      Object.assign(state.web, body.web);
      return json({ web: state.web });
    }
    throw new Error(`Unexpected request: ${method} ${url.host}${url.pathname}`);
  }) as typeof fetch;

  const searxngConfig = mkdtempSync(join(tmpdir(), "searxng-config-"));
  writeFileSync(join(searxngConfig, "settings.yml"), "use_default_settings: true\nsearch:\n  formats:\n    - html\n    - json\n");
  const baseUrl = (ctxOf: "open-webui" | "searxng") => (ctxOf === "open-webui" ? `http://${WEBUI}` : "http://searxng.test:30053");
  const contextFor = (app: "open-webui" | "searxng") =>
    ({
      baseUrl: baseUrl(app),
      host: "box.test",
      signIn: options.signIn,
      mounts: app === "searxng" ? [{ containerPath: "/etc/searxng", hostPath: "/mnt/apps/searxng/config", localPath: searxngConfig }] : [],
      getInstalledAppUrl: async (id: string) => (id === "ollama" ? (options.ollamaUrl ?? "http://box.test:30068") : id === "open-webui" ? `http://${WEBUI}` : null),
      readLocalAiHardware: async () => ({ cards: [], ollama: { models: [], ...(options.contextLength ? { contextLength: options.contextLength } : {}) } }),
      waitForApp: async (path: string) => {
        const response = await fetch(`${baseUrl(app)}${path}`).catch(() => undefined);
        if (!response?.ok) throw new Error(`App did not respond at ${path}`);
        return response;
      },
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
              return { ...(options.owner as { email: string; password: string }) };
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
    }) as unknown as HookContext;
  return { contextFor, state, questions, checkpoints, signIns, updates };
}

const RUN_SIGN_IN = { username: "owner", password: ADMIN.password, email: ADMIN.email };

describe("Open WebUI's link to Ollama", () => {
  test("an Open WebUI that already reaches this Ollama is left as it is", async () => {
    const { contextFor, updates, checkpoints } = openWebUi({ signIn: RUN_SIGN_IN });
    await connectOllama(contextFor("open-webui"));
    expect(updates).toHaveLength(0);
    expect(checkpoints).toEqual(["locate", "skipped:configure"]);
  });

  test("Ollama on a new port replaces only this box's old connection, and every connection keeps its settings", async () => {
    const ollama = {
      ENABLE_OLLAMA_API: true,
      OLLAMA_BASE_URLS: ["http://remote.test:11434", "http://box.test:30068"],
      OLLAMA_API_CONFIGS: { "0": { prefix_id: "gpu", key: "sk-remote" }, "1": { tags: ["home"], enable: false } },
    };
    const { contextFor, state, checkpoints } = openWebUi({ ollama, ollamaUrl: "http://box.test:30100", answering: ["box.test:30100", "remote.test:11434"], signIn: RUN_SIGN_IN });
    await connectOllama(contextFor("open-webui"));
    expect(state.ollama).toEqual({
      ENABLE_OLLAMA_API: true,
      OLLAMA_BASE_URLS: ["http://remote.test:11434", "http://box.test:30100"],
      OLLAMA_API_CONFIGS: { "0": { prefix_id: "gpu", key: "sk-remote" }, "1": { tags: ["home"], enable: true } },
    });
    expect(checkpoints).toEqual(["locate", "configure"]);
  });

  test("with no connection of this box's, Ollama is added after the owner's, which keep their settings", async () => {
    const ollama = { ENABLE_OLLAMA_API: false, OLLAMA_BASE_URLS: ["http://remote.test:11434"], OLLAMA_API_CONFIGS: { "0": { key: "sk-remote" } } };
    const { contextFor, state } = openWebUi({ ollama, answering: ["box.test:30068", "remote.test:11434"], signIn: RUN_SIGN_IN });
    await connectOllama(contextFor("open-webui"));
    expect(state.ollama).toEqual({
      ENABLE_OLLAMA_API: true,
      OLLAMA_BASE_URLS: ["http://remote.test:11434", "http://box.test:30068"],
      OLLAMA_API_CONFIGS: { "0": { key: "sk-remote" } },
    });
  });

  test("the connection carries nothing about Ollama's context, which Ollama applies itself", async () => {
    const ollama = { ENABLE_OLLAMA_API: true, OLLAMA_BASE_URLS: [], OLLAMA_API_CONFIGS: {} };
    const { contextFor, updates } = openWebUi({ ollama, signIn: RUN_SIGN_IN, contextLength: 65536 });
    await connectOllama(contextFor("open-webui"));
    expect(updates).toEqual([{ ENABLE_OLLAMA_API: true, OLLAMA_BASE_URLS: ["http://box.test:30068"], OLLAMA_API_CONFIGS: {} }]);
  });

  test("a connection to another computer that's switched off is kept, and this one is added", async () => {
    const ollama = { ENABLE_OLLAMA_API: true, OLLAMA_BASE_URLS: ["http://remote.test:11434"], OLLAMA_API_CONFIGS: { "0": { prefix_id: "gpu" } } };
    const { contextFor, state } = openWebUi({ ollama, answering: ["box.test:30068"], signIn: RUN_SIGN_IN });
    await connectOllama(contextFor("open-webui"));
    expect(state.ollama.OLLAMA_BASE_URLS).toEqual(["http://remote.test:11434", "http://box.test:30068"]);
    expect(state.ollama.OLLAMA_API_CONFIGS).toEqual({ "0": { prefix_id: "gpu" } });
  });

  test("another Ollama on this box that still answers is kept, and this one is added", async () => {
    const ollama = { ENABLE_OLLAMA_API: true, OLLAMA_BASE_URLS: ["http://box.test:11434"], OLLAMA_API_CONFIGS: { "0": { prefix_id: "mine" } } };
    const { contextFor, state } = openWebUi({ ollama, answering: ["box.test:30068", "box.test:11434"], signIn: RUN_SIGN_IN });
    await connectOllama(contextFor("open-webui"));
    expect(state.ollama.OLLAMA_BASE_URLS).toEqual(["http://box.test:11434", "http://box.test:30068"]);
    expect(state.ollama.OLLAMA_API_CONFIGS).toEqual({ "0": { prefix_id: "mine" } });
  });

  test("settings an older Open WebUI kept by address move to their connection's place, so its next save keeps them", async () => {
    const ollama = {
      ENABLE_OLLAMA_API: true,
      OLLAMA_BASE_URLS: ["http://remote.test:11434", "http://box.test:30068"],
      OLLAMA_API_CONFIGS: { "http://remote.test:11434": { prefix_id: "gpu" } },
    };
    const { contextFor, state } = openWebUi({ ollama, answering: ["box.test:30068", "remote.test:11434"], signIn: RUN_SIGN_IN });
    await connectOllama(contextFor("open-webui"));
    expect(state.ollama.OLLAMA_BASE_URLS).toEqual(ollama.OLLAMA_BASE_URLS);
    expect(state.ollama.OLLAMA_API_CONFIGS).toEqual({ "0": { prefix_id: "gpu" } });
  });

  test("an Open WebUI that isn't answering yet fails with what to do, not as a refused sign-in", async () => {
    const { contextFor, signIns } = openWebUi({ outage: "down", signIn: RUN_SIGN_IN });
    await expect(connectOllama(contextFor("open-webui"))).rejects.toThrow("Open WebUI isn't answering yet. Wait a minute for it to start, then run this again.");
    expect(signIns).toHaveLength(0);
  });

  test("a sign-in that never reaches Open WebUI says so, not that the sign-in was refused", async () => {
    const { contextFor, questions } = openWebUi({ outage: "signin", signIn: RUN_SIGN_IN });
    await expect(connectOllama(contextFor("open-webui"))).rejects.toThrow("Open WebUI stopped answering while HexOS signed in. Run this again.");
    expect(questions).toHaveLength(0);
  });

  test("when Open WebUI turns the run's sign-in away, the owner is asked and their sign-in is used", async () => {
    const ollama = { ENABLE_OLLAMA_API: true, OLLAMA_BASE_URLS: [], OLLAMA_API_CONFIGS: {} };
    const { contextFor, state, questions, signIns } = openWebUi({ ollama, signIn: { ...RUN_SIGN_IN, password: "another" }, owner: ADMIN });
    await connectOllama(contextFor("open-webui"));
    expect(questions).toHaveLength(1);
    expect(signIns).toEqual([ADMIN.email, ADMIN.email]);
    expect(state.ollama.OLLAMA_BASE_URLS).toEqual(["http://box.test:30068"]);
  });

  test("the owner skipping the sign-in skips the link, and Open WebUI keeps its connections", async () => {
    const ollama = { ENABLE_OLLAMA_API: true, OLLAMA_BASE_URLS: ["http://remote.test:11434"], OLLAMA_API_CONFIGS: {} };
    const { contextFor, state, updates } = openWebUi({ ollama, owner: "skip" });
    const run = connectOllama(contextFor("open-webui"));
    await expect(run).rejects.toBeInstanceOf(Skipped);
    await expect(run).rejects.toThrow("HexOS needs an Open WebUI administrator's sign-in to connect it to Ollama. Run this again to give it.");
    expect(updates).toHaveLength(0);
    expect(state.ollama).toEqual(ollama);
  });

  test("a box that can't ask skips the link the same way", async () => {
    const { contextFor } = openWebUi({ owner: "none" });
    await expect(connectOllama(contextFor("open-webui"))).rejects.toBeInstanceOf(Skipped);
  });

  test("a sign-in the owner gives that Open WebUI turns away fails with what to do", async () => {
    const { contextFor, updates } = openWebUi({ owner: { email: ADMIN.email, password: "wrong" } });
    await expect(connectOllama(contextFor("open-webui"))).rejects.toThrow("Open WebUI didn't accept that sign-in. Run this again.");
    expect(updates).toHaveLength(0);
  });

  test.each(["read", "save"] as const)("an Open WebUI that stops answering after the sign-in (%s) fails with what to do", async (outage) => {
    const ollama = { ENABLE_OLLAMA_API: true, OLLAMA_BASE_URLS: [], OLLAMA_API_CONFIGS: {} };
    const { contextFor } = openWebUi({ ollama, outage, signIn: RUN_SIGN_IN });
    await expect(connectOllama(contextFor("open-webui"))).rejects.toThrow("Open WebUI stopped answering. Run this again.");
  });

  test("an account that isn't an administrator fails with what to do", async () => {
    const { contextFor, updates } = openWebUi({ role: "user", signIn: RUN_SIGN_IN });
    await expect(connectOllama(contextFor("open-webui"))).rejects.toThrow("That Open WebUI account isn't an administrator. Run this again and sign in as one.");
    expect(updates).toHaveLength(0);
  });
});

describe("SearXNG's link to Open WebUI", () => {
  const SEARCH = { ENABLE_WEB_SEARCH: true, WEB_SEARCH_ENGINE: "searxng", SEARXNG_QUERY_URL: "http://searxng.test:30053/search?q=<query>" };

  test("web search is turned on with the run's sign-in, and Open WebUI's other web settings stay", async () => {
    const { contextFor, state, checkpoints } = openWebUi({ signIn: RUN_SIGN_IN });
    await connectSearxng(contextFor("searxng"));
    expect(state.web).toEqual({ ...SEARCH, WEB_SEARCH_RESULT_COUNT: 3 });
    expect(checkpoints).toEqual(["skipped:formats", "configure"]);
  });

  test("when Open WebUI turns the run's sign-in away, the owner is asked and their sign-in is used", async () => {
    const { contextFor, state, questions } = openWebUi({ signIn: { ...RUN_SIGN_IN, password: "another" }, owner: ADMIN });
    await connectSearxng(contextFor("searxng"));
    expect(questions).toHaveLength(1);
    expect(state.web).toMatchObject(SEARCH);
  });

  test("the owner skipping the sign-in skips the link, and Open WebUI's settings stay", async () => {
    const { contextFor, state, updates } = openWebUi({ owner: "skip" });
    const run = connectSearxng(contextFor("searxng"));
    await expect(run).rejects.toBeInstanceOf(Skipped);
    await expect(run).rejects.toThrow("HexOS needs an Open WebUI administrator's sign-in to turn on web search. Run this again to give it.");
    expect(updates).toHaveLength(0);
    expect(state.web.ENABLE_WEB_SEARCH).toBe(false);
  });

  test("a box that can't ask skips the link the same way", async () => {
    const { contextFor, updates } = openWebUi({ owner: "none" });
    await expect(connectSearxng(contextFor("searxng"))).rejects.toBeInstanceOf(Skipped);
    expect(updates).toHaveLength(0);
  });

  test("an Open WebUI that isn't answering yet fails with what to do, not as a refused sign-in", async () => {
    const { contextFor, signIns } = openWebUi({ outage: "down", signIn: RUN_SIGN_IN });
    await expect(connectSearxng(contextFor("searxng"))).rejects.toThrow("Open WebUI isn't answering yet. Wait a minute for it to start, then run this again.");
    expect(signIns).toHaveLength(0);
  });

  test("a sign-in that never reaches Open WebUI says so, not that the sign-in was refused", async () => {
    const { contextFor, questions } = openWebUi({ outage: "signin", signIn: RUN_SIGN_IN });
    await expect(connectSearxng(contextFor("searxng"))).rejects.toThrow("Open WebUI stopped answering while HexOS signed in. Run this again.");
    expect(questions).toHaveLength(0);
  });

  test("a sign-in the owner gives that Open WebUI turns away fails with what to do", async () => {
    const { contextFor, updates } = openWebUi({ owner: { email: ADMIN.email, password: "wrong" } });
    await expect(connectSearxng(contextFor("searxng"))).rejects.toThrow("Open WebUI didn't accept that sign-in. Run this again.");
    expect(updates).toHaveLength(0);
  });

  test.each(["read", "save"] as const)("an Open WebUI that stops answering after the sign-in (%s) fails with what to do", async (outage) => {
    const { contextFor } = openWebUi({ outage, signIn: RUN_SIGN_IN });
    await expect(connectSearxng(contextFor("searxng"))).rejects.toThrow("Open WebUI stopped answering. Run this again.");
  });
});
