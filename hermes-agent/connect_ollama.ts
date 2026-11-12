// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { chownSync, existsSync, readFileSync, writeFileSync } from "node:fs";

import type { HookContext } from "../_lib/hook_context";

/**
 * Gives Hermes the owner's Ollama as its model. Hermes reads config.yaml in its data folder at its
 * start, so the link writes the model section there, keeps the rest of the file, and restarts it. It
 * reaches Ollama through the one hole in the agent network's block. Read at Hermes 0.22.
 *
 * Without `context_length`, Hermes takes the model's largest window from Ollama and compresses a chat
 * only near it, while Ollama runs every chat at its own context (agent/agent_init_ollama.py). The
 * link sets `context_length` to the context Ollama runs at.
 */

const APPS_UID = 568;

const section = (model: string, url: string, contextLength?: number) => `model:
  default: ${JSON.stringify(model)}
  provider: custom
  base_url: ${JSON.stringify(`${url}/v1`)}
  api_key: ollama
${contextLength ? `  context_length: ${contextLength}\n` : ""}`;

/** The file with its top-level `model:` block replaced, every other line as it was. */
export function withModel(config: string, block: string): string {
  const lines = config.split("\n");
  const start = lines.findIndex((line) => /^model:/.test(line));
  if (start === -1) return `${block}${config}`;
  let end = start + 1;
  while (end < lines.length && (/^\s/.test(lines[end]) || lines[end] === "")) end++;
  // Blank lines after the block stay, so the file keeps its spacing and its last newline
  while (end > start + 1 && lines[end - 1] === "") end--;
  return [...lines.slice(0, start), block.trimEnd(), ...lines.slice(end)].join("\n");
}

/**
 * The model Ollama is set to, which may still be downloading, else the first it has, and the
 * context Ollama runs at. A box from before the context was read doesn't say it.
 */
async function ollamaSettings(ctx: HookContext, url: string): Promise<{ model?: string; contextLength?: number }> {
  const hardware = await ctx.readLocalAiHardware?.().catch(() => undefined);
  const length = hardware?.ollama?.contextLength;
  const contextLength = typeof length === "number" && Number.isInteger(length) && length > 0 ? length : undefined;
  if (hardware?.ollama?.wanted) return { model: hardware.ollama.wanted, contextLength };
  const tags = (await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(15_000) }).then((response) => response.json())) as {
    models?: Array<{ name: string }>;
  };
  return { model: tags.models?.[0]?.name, contextLength };
}

export async function run(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "locate", message: "Finding Ollama" },
    { id: "configure", message: "Connecting Hermes to Ollama" },
  ]);
  const url = await ctx.getInstalledAppUrl("ollama");
  if (!url) ctx.fail("Ollama isn't installed, or HexOS can't find its port");
  const { model, contextLength } = await ollamaSettings(ctx, url);
  if (!model) ctx.fail("Ollama has no model yet. Choose one on its Connections tab, then run this again.");
  const data = ctx.mounts.find((mount) => mount.containerPath === "/opt/data") ?? ctx.mounts.find((mount) => mount.hostPath.endsWith("/hermes-agent/data"));
  if (!data) ctx.fail("HexOS couldn't find Hermes's data folder");
  await ctx.emitCheckpoint("locate");

  const path = `${data.localPath}/config.yaml`;
  const current = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const next = withModel(current, section(model, url, contextLength));
  if (next === current) {
    await ctx.skipCheckpoint("configure", `Hermes already uses ${model}`);
    return;
  }
  writeFileSync(path, next);
  chownSync(path, APPS_UID, APPS_UID);
  if (typeof ctx.restartApp !== "function") ctx.fail("This server's HexOS needs an update first. Try again after it updates.");
  await ctx.restartApp();
  await ctx.emitCheckpoint("configure");
}
