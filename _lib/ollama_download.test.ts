import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { download } from "../ollama/models";
import type { HookContext } from "./hook_context";

// Ollama streams a pull layer by layer, each layer's size only once it starts. The percent HexOS
// shows is over the whole model, so a small first layer doesn't read as 99% while the big one waits.

let pullLines: object[];
let percents: number[];
let wanted: string;

const ctx = {
  host: "10.0.0.5",
  port: 30068,
  registerCheckpoints: async () => {},
  getAppValues: async () => ({ ollama: { additional_envs: [{ name: "HEXOS_MODEL", value: wanted }] } }),
  setProgress: async (percent: number) => {
    percents.push(percent);
  },
  updateCheckpointMessage: async () => {},
  emitCheckpoint: async () => {},
  skipCheckpoint: async () => {},
  fail: (message: string) => {
    throw new Error(message);
  },
} as unknown as HookContext;

beforeEach(() => {
  percents = [];
  spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
    if (url.endsWith("/api/tags")) return Response.json({ models: [] });
    const body = pullLines.map((line) => `${JSON.stringify(line)}\n`).join("");
    return new Response(new Blob([body]).stream());
  }) as typeof fetch);
});
afterEach(() => (globalThis.fetch as unknown as { mockRestore: () => void }).mockRestore());

const GB = 1e9;

describe("Ollama's download percent", () => {
  test("is over the model's known size, so the first small layer is a small part of it", async () => {
    wanted = "qwen3.8:27b-q4_K_M"; // an 18 GB download
    pullLines = [
      { status: "pulling manifest" },
      { status: "pulling a", digest: "a", total: GB, completed: GB / 2 },
      { status: "pulling a", digest: "a", total: GB, completed: GB },
      { status: "pulling b", digest: "b", total: 17 * GB, completed: 0 },
      { status: "pulling b", digest: "b", total: 17 * GB, completed: 8 * GB },
      { status: "pulling b", digest: "b", total: 17 * GB, completed: 17 * GB },
      { status: "success" },
    ];
    await download(ctx);
    // Held under 99 until Ollama says it has finished
    expect(percents).toEqual([2, 5, 49, 98]);
  });

  test("never goes back, even when the layers come to more than the known size", async () => {
    wanted = "qwen3.5:4b-q4_K_M"; // a 3.3 GB download
    pullLines = [
      { status: "pulling a", digest: "a", total: 3 * GB, completed: 3 * GB },
      { status: "pulling b", digest: "b", total: GB, completed: 0 },
      { status: "pulling b", digest: "b", total: GB, completed: GB },
      { status: "success" },
    ];
    await download(ctx);
    expect(percents).toEqual([90, 98]);
  });

  test("measures a model it doesn't know over the layers seen so far", async () => {
    wanted = "llama9:1b";
    pullLines = [
      { status: "pulling a", digest: "a", total: 4_000, completed: 1_000 },
      { status: "pulling a", digest: "a", total: 4_000, completed: 3_000 },
      { status: "pulling a", digest: "a", total: 4_000, completed: 4_000 },
      { status: "success" },
    ];
    await download(ctx);
    expect(percents).toEqual([24, 74, 98]);
  });
});
