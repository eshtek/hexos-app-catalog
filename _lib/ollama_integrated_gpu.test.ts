import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A Strix Halo runs Ollama on Vulkan in Ollama's own image, since ROCm gives wrong answers on gfx1151
// past one batch of prompt (ollama/ollama#17895, #17847), and Ollama (read at 0.40.15, the chart's)
// drops an integrated card on Vulkan unless OLLAMA_IGPU_ENABLE says otherwise. HexOS answers
// integrated_gpu with 1 for that card alone. Ollama reads an empty value as unset
// (envconfig.BoolWithDefault), and any other text it can't parse as on, so every other owner must
// get exactly the empty default.

type Json = Record<string, any>;
const read = (path: string): Json => JSON.parse(readFileSync(join(import.meta.dir, "..", path), "utf-8"));
const ollama = read("ollama.json");
const collection = read("_collections/local-ai.json");
const question = ollama.installation_questions.find((q: Json) => q.key === "integrated_gpu");
const envs: Json[] = ollama.app_values.ollama.additional_envs;

describe("Ollama's integrated graphics", () => {
  test("the question reaches OLLAMA_IGPU_ENABLE", () => {
    expect(envs.find((env) => env.name === "OLLAMA_IGPU_ENABLE")?.value).toBe("$QUESTION(integrated_gpu)");
  });

  test("an owner never has to answer it, and an unanswered one leaves Ollama as it was", () => {
    // A select can't offer the empty answer (the deck's select refuses an empty value), so it's text
    expect(question).toMatchObject({ type: "text", required: false, default: "" });
  });

  test("the Settings tab leaves it out, as it does the image it goes with", () => {
    expect(question.installonly).toBe(true);
  });

  test("its env comes last, so an Ollama from before it reads no other env's value as its answer", () => {
    // An update reads each answer from the app's env by name, and from the script's index when no
    // env has the name: earlier, that index holds OLLAMA_CONTEXT_LENGTH or OLLAMA_NOPRUNE, which
    // Ollama would read as on
    expect(envs.at(-1)?.name).toBe("OLLAMA_IGPU_ENABLE");
  });
});

describe("Local AI and a card that shares the server's memory", () => {
  test("the collection opens one only while its engine asks integrated_gpu", () => {
    expect(collection.localAi.sharedMemory).toBe(true);
    expect(question).toBeDefined();
  });

  test("the collection answers it itself, so its install never asks it", () => {
    const engine = collection.groups.flatMap((group: Json) => group.options).find((option: Json) => option.app === "ollama");
    expect(engine.answers.integrated_gpu).toBe("");
  });
});
