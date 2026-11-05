import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextMount, HookContext } from "./hook_context";

// The Ollama links of OpenClaw, OpenCode and AnythingLLM against a fake Ollama and AnythingLLM, read
// at OpenClaw 2026.10, OpenCode 1.19.5 and AnythingLLM 1.19. The settings files are the owner's: one
// HexOS can't read as plain JSON stays byte for byte, every key HexOS doesn't set survives, the old
// file is copied beside the new one first, and a run that changes nothing writes nothing and doesn't
// restart the app.

const real = { ...fs };
/** Owner changes need root, so the test only records them. */
const owned: string[] = [];
/** When set, a save writes half the file and then fails, as a full disk would. */
let failingWrites = false;
mock.module("node:fs", () => ({
  ...real,
  chownSync: (path: string) => {
    owned.push(path);
  },
  writeFileSync: (path: string, data: string, options?: fs.WriteFileOptions) => {
    if (!failingWrites) return real.writeFileSync(path, data, options);
    real.writeFileSync(path, String(data).slice(0, String(data).length / 2), options);
    throw new Error("ENOSPC: no space left on device");
  },
}));
const { run: connectOpenClaw, withOllama: openClawWithOllama } = await import("../openclaw/connect_ollama");
const { run: connectOpenCode } = await import("../opencode/connect_ollama");
const { run: connectAnythingLlm } = await import("../anything-llm/connect_ollama");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  failingWrites = false;
  owned.length = 0;
});
afterAll(() => {
  mock.module("node:fs", () => real);
});

const OLLAMA = "http://ollama.test:30068";
const MODEL = "llama3.2:3b";

class Skipped extends Error {}

interface Options {
  mounts?: ContextMount[];
  /** What Ollama lists, or "down" when it doesn't answer. */
  tags?: Array<{ name: string }> | "down";
  /** The model the owner chose on Ollama's Connections tab, which may still be downloading. */
  wanted?: string;
  baseUrl?: string;
  /** Another app's API, by host. */
  apps?: Record<string, (path: string, init?: RequestInit) => Response>;
}

function harness(options: Options = {}) {
  const checkpoints: string[] = [];
  let restarts = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host === "ollama.test:30068") {
      if (options.tags === "down") throw new TypeError("fetch failed");
      if (url.pathname === "/api/tags") return Response.json({ models: options.tags ?? [{ name: MODEL }] });
    }
    const app = options.apps?.[url.host];
    if (app) return app(url.pathname, init);
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url.host}${url.pathname}`);
  }) as typeof fetch;
  const ctx = {
    baseUrl: options.baseUrl ?? "",
    host: "box.test",
    mounts: options.mounts ?? [],
    getInstalledAppUrl: async (id: string) => (id === "ollama" ? OLLAMA : null),
    readLocalAiHardware: async () => ({ cards: [], ollama: { models: [], ...(options.wanted ? { wanted: options.wanted } : {}) } }),
    waitForApp: async () => new Response("ok"),
    registerCheckpoints: async () => {},
    emitCheckpoint: async (id: string) => {
      checkpoints.push(id);
    },
    skipCheckpoint: async (id: string) => {
      checkpoints.push(`skipped:${id}`);
    },
    restartApp: async () => {
      restarts++;
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
  return { ctx, checkpoints, restarts: () => restarts };
}

const folderFiles = (folder: string) => (real.existsSync(folder) ? real.readdirSync(folder).sort() : []);
const modeOf = (path: string) => real.statSync(path).mode & 0o777;

describe("OpenClaw's link to Ollama", () => {
  /** OpenClaw's home folder, with its settings file when given. */
  function openClaw(text?: string, mode = 0o600) {
    const home = real.mkdtempSync(join(tmpdir(), "openclaw-home-"));
    const folder = join(home, ".openclaw");
    const path = join(folder, "openclaw.json");
    if (text !== undefined) {
      real.mkdirSync(folder);
      real.writeFileSync(path, text);
      real.chmodSync(path, mode);
    }
    const mounts = [{ containerPath: "/home/node", hostPath: "/mnt/apps/openclaw/config", localPath: home }];
    return { folder, path, mounts };
  }

  test("a missing settings file is made with Ollama as the provider and default model, and OpenClaw restarts", async () => {
    const { folder, path, mounts } = openClaw();
    const { ctx, checkpoints, restarts } = harness({ mounts });
    await connectOpenClaw(ctx);
    expect(JSON.parse(real.readFileSync(path, "utf-8"))).toEqual({
      models: { providers: { ollama: { baseUrl: OLLAMA, apiKey: "ollama-local", api: "ollama", models: [{ id: MODEL, name: MODEL }] } } },
      agents: { defaults: { model: { primary: `ollama/${MODEL}` } } },
    });
    expect(modeOf(path)).toBe(0o600);
    expect(folderFiles(folder)).toEqual(["openclaw.json"]);
    expect(owned).toContain(folder);
    expect(restarts()).toBe(1);
    expect(checkpoints).toEqual(["locate", "configure"]);
  });

  test("a file with comments, as JSON5 allows, is left byte for byte and nothing restarts", async () => {
    const text = '{\n  // my gateway\n  gateway: { mode: "local" },\n  agents: { defaults: { model: "anthropic/claude" } },\n}\n';
    const { folder, path, mounts } = openClaw(text);
    const { ctx, restarts } = harness({ mounts });
    const run = connectOpenClaw(ctx);
    await expect(run).rejects.toBeInstanceOf(Skipped);
    await expect(run).rejects.toThrow("OpenClaw's settings file has comments or isn't plain JSON, so HexOS won't rewrite it");
    expect(real.readFileSync(path, "utf-8")).toBe(text);
    expect(folderFiles(folder)).toEqual(["openclaw.json"]);
    expect(restarts()).toBe(0);
  });

  test.skipIf(process.getuid?.() === 0)("a file HexOS can't read is left as it is and nothing restarts", async () => {
    const { path, mounts } = openClaw('{ "gateway": { "mode": "local" } }\n', 0o000);
    const { ctx, restarts } = harness({ mounts });
    try {
      const run = connectOpenClaw(ctx);
      await expect(run).rejects.toBeInstanceOf(Skipped);
      await expect(run).rejects.toThrow("HexOS couldn't read OpenClaw's settings file");
      expect(restarts()).toBe(0);
    } finally {
      real.chmodSync(path, 0o600);
    }
    expect(real.readFileSync(path, "utf-8")).toBe('{ "gateway": { "mode": "local" } }\n');
  });

  test("the owner's settings survive, the old file is kept beside the new one, and its permissions stay", async () => {
    const owner = {
      meta: { lastTouchedVersion: "2026.10.10" },
      gateway: { mode: "local", auth: { mode: "token" } },
      models: {
        mode: "merge",
        providers: {
          anthropic: { baseUrl: "https://api.anthropic.com", apiKey: "sk-owner", models: [{ id: "claude", name: "Claude" }] },
          ollama: { baseUrl: "http://old.test:11434", apiKey: "owner-key", api: "ollama", models: [{ id: "qwen3:8b", name: "Qwen", contextWindow: 32768 }] },
        },
      },
      agents: { defaults: { workspace: "~/work", model: { primary: "anthropic/claude", fallbacks: ["ollama/qwen3:8b"] } }, list: [{ id: "main" }] },
    };
    const text = `${JSON.stringify(owner, null, 2)}\n`;
    const { folder, path, mounts } = openClaw(text, 0o640);
    const { ctx, restarts } = harness({ mounts });
    await connectOpenClaw(ctx);
    const saved = JSON.parse(real.readFileSync(path, "utf-8"));
    expect(saved.meta).toEqual(owner.meta);
    expect(saved.gateway).toEqual(owner.gateway);
    expect(saved.models.mode).toBe("merge");
    expect(saved.models.providers.anthropic).toEqual(owner.models.providers.anthropic);
    expect(saved.models.providers.ollama).toEqual({
      baseUrl: OLLAMA,
      api: "ollama",
      apiKey: "owner-key",
      models: [
        { id: "qwen3:8b", name: "Qwen", contextWindow: 32768 },
        { id: MODEL, name: MODEL },
      ],
    });
    expect(saved.agents).toEqual({ defaults: { workspace: "~/work", model: { primary: `ollama/${MODEL}`, fallbacks: ["ollama/qwen3:8b"] } }, list: [{ id: "main" }] });
    expect(real.readFileSync(`${path}.hexos-bak`, "utf-8")).toBe(text);
    expect(modeOf(path)).toBe(0o640);
    expect(folderFiles(folder)).toEqual(["openclaw.json", "openclaw.json.hexos-bak"]);
    expect(restarts()).toBe(1);
  });

  test("a default model written as one provider/model string becomes this one", () => {
    const next = openClawWithOllama({ agents: { defaults: { model: "anthropic/claude" } } }, OLLAMA, MODEL) as {
      agents: { defaults: { model: unknown } };
    };
    expect(next.agents.defaults.model).toEqual({ primary: `ollama/${MODEL}` });
  });

  test("a run that changes nothing writes nothing and doesn't restart OpenClaw", async () => {
    const { folder, path, mounts } = openClaw();
    const first = harness({ mounts });
    await connectOpenClaw(first.ctx);
    const text = real.readFileSync(path, "utf-8");
    const written = real.statSync(path).mtimeMs;
    const second = harness({ mounts });
    await connectOpenClaw(second.ctx);
    expect(real.readFileSync(path, "utf-8")).toBe(text);
    expect(real.statSync(path).mtimeMs).toBe(written);
    expect(folderFiles(folder)).toEqual(["openclaw.json"]);
    expect(second.restarts()).toBe(0);
    expect(second.checkpoints).toEqual(["locate", "skipped:configure"]);
  });

  test("a save that fails partway leaves the settings as they were and nothing restarts", async () => {
    const text = `${JSON.stringify({ gateway: { mode: "local" } }, null, 2)}\n`;
    const { folder, path, mounts } = openClaw(text);
    const { ctx, restarts } = harness({ mounts });
    failingWrites = true;
    await expect(connectOpenClaw(ctx)).rejects.toThrow("HexOS couldn't save OpenClaw's settings, so they're as they were");
    expect(real.readFileSync(path, "utf-8")).toBe(text);
    expect(folderFiles(folder)).not.toContain("openclaw.json.hexos-tmp");
    expect(restarts()).toBe(0);
  });

  test("an Ollama that doesn't answer fails with what to do, and nothing is written", async () => {
    const { folder, mounts } = openClaw();
    const { ctx, restarts } = harness({ mounts, tags: "down" });
    await expect(connectOpenClaw(ctx)).rejects.toThrow("Ollama didn't answer. Wait a minute for it to start, then run this again.");
    expect(folderFiles(folder)).toEqual([]);
    expect(restarts()).toBe(0);
  });

  test("a box that can't restart OpenClaw fails before anything is written", async () => {
    const { folder, mounts } = openClaw();
    const { ctx } = harness({ mounts });
    (ctx as { restartApp?: unknown }).restartApp = undefined;
    await expect(connectOpenClaw(ctx)).rejects.toThrow("This server's HexOS needs an update first");
    expect(folderFiles(folder)).toEqual([]);
  });
});

describe("OpenCode's link to Ollama", () => {
  /** OpenCode's data folder, with these settings files in its config folder. */
  function openCode(files: Record<string, string> = {}) {
    const data = real.mkdtempSync(join(tmpdir(), "opencode-data-"));
    const folder = join(data, ".config", "opencode");
    if (Object.keys(files).length > 0) real.mkdirSync(folder, { recursive: true });
    for (const [name, text] of Object.entries(files)) real.writeFileSync(join(folder, name), text);
    const mounts = [{ containerPath: "/data", hostPath: "/mnt/apps/opencode/data", localPath: data }];
    return { folder, mounts };
  }
  const ours = {
    npm: "@ai-sdk/openai-compatible",
    name: "Ollama",
    options: { baseURL: `${OLLAMA}/v1` },
    models: { [MODEL]: { name: MODEL } },
  };
  /** What OpenCode 1.19.5 writes on its first start when its config folder has no settings file. */
  const SEEDED = JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2);

  test("the opencode.jsonc OpenCode makes on its first start gets Ollama, and no second file is made", async () => {
    const { folder, mounts } = openCode({ "opencode.jsonc": SEEDED });
    const { ctx, restarts } = harness({ mounts });
    await connectOpenCode(ctx);
    expect(JSON.parse(real.readFileSync(join(folder, "opencode.jsonc"), "utf-8"))).toEqual({
      $schema: "https://opencode.ai/config.json",
      provider: { ollama: ours },
      model: `ollama/${MODEL}`,
    });
    expect(folderFiles(folder)).toEqual(["opencode.jsonc", "opencode.jsonc.hexos-bak"]);
    expect(restarts()).toBe(1);
  });

  test("an opencode.jsonc with comments is left byte for byte, with no opencode.json made beside it", async () => {
    const text = '{\n  // the owner\'s theme\n  "theme": "tokyonight",\n}\n';
    const { folder, mounts } = openCode({ "opencode.jsonc": text });
    const { ctx, restarts } = harness({ mounts });
    const run = connectOpenCode(ctx);
    await expect(run).rejects.toBeInstanceOf(Skipped);
    await expect(run).rejects.toThrow("OpenCode's settings file has comments or isn't plain JSON, so HexOS won't rewrite it");
    expect(real.readFileSync(join(folder, "opencode.jsonc"), "utf-8")).toBe(text);
    expect(folderFiles(folder)).toEqual(["opencode.jsonc"]);
    expect(restarts()).toBe(0);
  });

  test("with opencode.json and opencode.jsonc both there, the one that wins gets Ollama and the other stays as it is", async () => {
    const old = JSON.stringify({ provider: { ollama: { options: { baseURL: "http://old.test:11434/v1" } } }, model: "ollama/old" }, null, 2);
    const { folder, mounts } = openCode({ "opencode.json": old, "opencode.jsonc": SEEDED });
    await connectOpenCode(harness({ mounts }).ctx);
    expect(real.readFileSync(join(folder, "opencode.json"), "utf-8")).toBe(old);
    expect(JSON.parse(real.readFileSync(join(folder, "opencode.jsonc"), "utf-8")).model).toBe(`ollama/${MODEL}`);
  });

  test.skipIf(process.getuid?.() === 0)("a file HexOS can't read is left as it is and nothing restarts", async () => {
    const { folder, mounts } = openCode({ "opencode.json": "{}\n" });
    const path = join(folder, "opencode.json");
    real.chmodSync(path, 0o000);
    const { ctx, restarts } = harness({ mounts });
    try {
      const run = connectOpenCode(ctx);
      await expect(run).rejects.toBeInstanceOf(Skipped);
      await expect(run).rejects.toThrow("HexOS couldn't read OpenCode's settings file");
      expect(restarts()).toBe(0);
    } finally {
      real.chmodSync(path, 0o644);
    }
    expect(folderFiles(folder)).toEqual(["opencode.json"]);
  });

  test("a box that can't restart OpenCode fails before anything is written", async () => {
    const { folder, mounts } = openCode({ "opencode.jsonc": SEEDED });
    const { ctx } = harness({ mounts });
    (ctx as { restartApp?: unknown }).restartApp = undefined;
    await expect(connectOpenCode(ctx)).rejects.toThrow("This server's HexOS needs an update first");
    expect(real.readFileSync(join(folder, "opencode.jsonc"), "utf-8")).toBe(SEEDED);
    expect(folderFiles(folder)).toEqual(["opencode.jsonc"]);
  });

  test("an opencode.json with a comment is left byte for byte and nothing restarts", async () => {
    const text = '{\n  "theme": "tokyonight" // the owner\'s\n}\n';
    const { folder, mounts } = openCode({ "opencode.json": text });
    const { ctx, restarts } = harness({ mounts });
    await expect(connectOpenCode(ctx)).rejects.toBeInstanceOf(Skipped);
    expect(real.readFileSync(join(folder, "opencode.json"), "utf-8")).toBe(text);
    expect(folderFiles(folder)).toEqual(["opencode.json"]);
    expect(restarts()).toBe(0);
  });

  test("with no settings file yet, opencode.json is made and OpenCode restarts", async () => {
    const { folder, mounts } = openCode();
    const { ctx, checkpoints, restarts } = harness({ mounts });
    await connectOpenCode(ctx);
    expect(JSON.parse(real.readFileSync(join(folder, "opencode.json"), "utf-8"))).toEqual({ provider: { ollama: ours }, model: `ollama/${MODEL}` });
    expect(modeOf(join(folder, "opencode.json"))).toBe(0o644);
    expect(folderFiles(folder)).toEqual(["opencode.json"]);
    expect(owned).toEqual(expect.arrayContaining([folder, join(folder, "..")]));
    expect(restarts()).toBe(1);
    expect(checkpoints).toEqual(["locate", "configure"]);
  });

  test("the owner's settings survive, the old file is kept beside the new one, and its permissions stay", async () => {
    const owner = {
      $schema: "https://opencode.ai/config.json",
      theme: "tokyonight",
      provider: {
        anthropic: { options: { apiKey: "{env:ANTHROPIC_API_KEY}" } },
        ollama: { npm: "@ai-sdk/openai-compatible", name: "My Ollama", options: { baseURL: "http://old.test:11434/v1", timeout: 600000 }, models: { "qwen3:8b": { name: "Qwen", limit: { context: 32768 } } } },
      },
      model: "anthropic/claude-sonnet",
      small_model: "ollama/qwen3:8b",
    };
    const text = JSON.stringify(owner, null, 2);
    const { folder, mounts } = openCode({ "opencode.json": text });
    real.chmodSync(join(folder, "opencode.json"), 0o640);
    const { ctx } = harness({ mounts });
    await connectOpenCode(ctx);
    const saved = JSON.parse(real.readFileSync(join(folder, "opencode.json"), "utf-8"));
    expect(saved).toEqual({
      ...owner,
      provider: {
        anthropic: owner.provider.anthropic,
        ollama: {
          npm: "@ai-sdk/openai-compatible",
          name: "My Ollama",
          options: { baseURL: `${OLLAMA}/v1`, timeout: 600000 },
          models: { "qwen3:8b": { name: "Qwen", limit: { context: 32768 } }, [MODEL]: { name: MODEL } },
        },
      },
      model: `ollama/${MODEL}`,
    });
    expect(real.readFileSync(join(folder, "opencode.json.hexos-bak"), "utf-8")).toBe(text);
    expect(modeOf(join(folder, "opencode.json"))).toBe(0o640);
  });

  test("a run that changes nothing writes nothing and doesn't restart OpenCode", async () => {
    const { folder, mounts } = openCode();
    await connectOpenCode(harness({ mounts }).ctx);
    const path = join(folder, "opencode.json");
    const text = real.readFileSync(path, "utf-8");
    const written = real.statSync(path).mtimeMs;
    const second = harness({ mounts });
    await connectOpenCode(second.ctx);
    expect(real.readFileSync(path, "utf-8")).toBe(text);
    expect(real.statSync(path).mtimeMs).toBe(written);
    expect(folderFiles(folder)).toEqual(["opencode.json"]);
    expect(second.restarts()).toBe(0);
    expect(second.checkpoints).toEqual(["locate", "skipped:configure"]);
  });

  test("a save that fails partway leaves the settings as they were and nothing restarts", async () => {
    const { folder, mounts } = openCode({ "opencode.jsonc": SEEDED });
    const { ctx, restarts } = harness({ mounts });
    failingWrites = true;
    await expect(connectOpenCode(ctx)).rejects.toThrow("HexOS couldn't save OpenCode's settings, so they're as they were");
    expect(real.readFileSync(join(folder, "opencode.jsonc"), "utf-8")).toBe(SEEDED);
    expect(folderFiles(folder)).not.toContain("opencode.jsonc.hexos-tmp");
    expect(restarts()).toBe(0);
  });

  test("an Ollama that doesn't answer fails with what to do, and nothing is written", async () => {
    const { folder, mounts } = openCode();
    const { ctx } = harness({ mounts, tags: "down" });
    await expect(connectOpenCode(ctx)).rejects.toThrow("Ollama didn't answer. Wait a minute for it to start, then run this again.");
    expect(folderFiles(folder)).toEqual([]);
  });
});

describe("AnythingLLM's link to Ollama", () => {
  interface Llm {
    /** AnythingLLM's settings, as update-env keeps them. */
    env: Record<string, string>;
    calls: number;
  }
  /**
   * AnythingLLM's update-env: 401 behind a password, else each setting in the order sent until one
   * fails its check, answering 200 either way with the reason (server/utils/helpers/updateENV.js).
   */
  function anythingLlm(options: { password?: 401 | 403; down?: boolean; refuseAddress?: string } = {}) {
    const llm: Llm = { env: { LLMProvider: "openai", OllamaLLMModelPref: "old-model" }, calls: 0 };
    const api = (path: string, init?: RequestInit) => {
      if (path !== "/api/system/update-env" || init?.method !== "POST") throw new Error(`Unexpected request: ${path}`);
      llm.calls++;
      if (options.down) throw new TypeError("fetch failed");
      if (options.password) return Response.json({ error: "No auth token found." }, { status: options.password });
      const body = JSON.parse(String(init.body)) as Record<string, string>;
      const newValues: Record<string, string> = {};
      for (const [key, value] of Object.entries(body)) {
        if (key === "OllamaLLMBasePath" && options.refuseAddress) return Response.json({ newValues, error: options.refuseAddress });
        llm.env[key] = value;
        newValues[key] = value;
      }
      return Response.json({ newValues, error: false });
    };
    return { llm, apps: { "llm.test:30239": api }, baseUrl: "http://llm.test:30239" };
  }

  test("AnythingLLM gets Ollama's address, its model and Ollama as the provider", async () => {
    const { llm, apps, baseUrl } = anythingLlm();
    const { ctx, checkpoints } = harness({ apps, baseUrl });
    await connectAnythingLlm(ctx);
    expect(llm.env).toEqual({ LLMProvider: "ollama", OllamaLLMBasePath: OLLAMA, OllamaLLMModelPref: MODEL });
    expect(checkpoints).toEqual(["locate", "configure"]);
  });

  test("the model the owner chose on Ollama, still downloading, is the one AnythingLLM gets", async () => {
    const { llm, apps, baseUrl } = anythingLlm();
    await connectAnythingLlm(harness({ apps, baseUrl, tags: [], wanted: "qwen3:8b" }).ctx);
    expect(llm.env.OllamaLLMModelPref).toBe("qwen3:8b");
  });

  test("an Ollama with no model fails with what to do, and AnythingLLM keeps its settings", async () => {
    const { llm, apps, baseUrl } = anythingLlm();
    const { ctx } = harness({ apps, baseUrl, tags: [] });
    await expect(connectAnythingLlm(ctx)).rejects.toThrow("Ollama has no model yet. Choose one on its Connections tab, then run this again.");
    expect(llm.calls).toBe(0);
    expect(llm.env).toEqual({ LLMProvider: "openai", OllamaLLMModelPref: "old-model" });
  });

  test("an Ollama that doesn't answer fails with what to do, and AnythingLLM keeps its settings", async () => {
    const { llm, apps, baseUrl } = anythingLlm();
    const { ctx } = harness({ apps, baseUrl, tags: "down" });
    await expect(connectAnythingLlm(ctx)).rejects.toThrow("Ollama didn't answer. Wait a minute for it to start, then run this again.");
    expect(llm.calls).toBe(0);
  });

  test.each([401, 403] as const)("an AnythingLLM with a password (%d) is skipped with what to do", async (status) => {
    const { apps, baseUrl } = anythingLlm({ password: status });
    const run = connectAnythingLlm(harness({ apps, baseUrl }).ctx);
    await expect(run).rejects.toBeInstanceOf(Skipped);
    await expect(run).rejects.toThrow("AnythingLLM asks for a password, so HexOS can't change its settings. Set Ollama as the LLM provider in AnythingLLM's own settings.");
  });

  test("an AnythingLLM that doesn't answer fails with what to do", async () => {
    const { apps, baseUrl } = anythingLlm({ down: true });
    await expect(connectAnythingLlm(harness({ apps, baseUrl }).ctx)).rejects.toThrow("AnythingLLM didn't answer. Wait a minute for it to start, then run this again.");
  });

  test("an address AnythingLLM refuses fails with its reason and leaves its provider as it was", async () => {
    const reason = "Port is not running a reachable service on loopback address from inside the AnythingLLM container.";
    const { llm, apps, baseUrl } = anythingLlm({ refuseAddress: reason });
    await expect(connectAnythingLlm(harness({ apps, baseUrl }).ctx)).rejects.toThrow("AnythingLLM didn't take Ollama's address");
    expect(llm.env.LLMProvider).toBe("openai");
  });
});
