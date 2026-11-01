// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { chownSync, existsSync, readFileSync, writeFileSync } from "node:fs";

import type { HookContext } from "../_lib/hook_context";

/**
 * Gives Hermes the owner's Ollama as its model. Hermes reads config.yaml in its data folder at its
 * start, so the link writes the model section there, keeps the rest of the file, and restarts it. It
 * reaches Ollama through the one hole in the agent network's block. Read at Hermes 0.22.
 */

const APPS_UID = 568;

const section = (model: string, url: string) => `model:
  default: ${JSON.stringify(model)}
  provider: custom
  base_url: ${JSON.stringify(`${url}/v1`)}
  api_key: ollama
`;

/** The file with its top-level `model:` block replaced, every other line as it was. */
export function withModel(config: string, block: string): string {
  const lines = config.split("\n");
  const start = lines.findIndex((line) => /^model:/.test(line));
  if (start === -1) return `${block}${config}`;
  let end = start + 1;
  while (end < lines.length && (/^\s/.test(lines[end]) || lines[end] === "")) end++;
  return [...lines.slice(0, start), block.trimEnd(), ...lines.slice(end)].join("\n");
}

/** The model Ollama is set to, which may still be downloading, else the first it has. */
async function ollamaModel(ctx: HookContext, url: string): Promise<string | undefined> {
  const hardware = await ctx.readLocalAiHardware?.().catch(() => undefined);
  if (hardware?.ollama?.wanted) return hardware.ollama.wanted;
  const tags = (await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(15_000) }).then((response) => response.json())) as {
    models?: Array<{ name: string }>;
  };
  return tags.models?.[0]?.name;
}

export async function run(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "locate", message: "Finding Ollama" },
    { id: "configure", message: "Connecting Hermes to Ollama" },
  ]);
  const url = await ctx.getInstalledAppUrl("ollama");
  if (!url) ctx.fail("Ollama isn't installed, or HexOS can't find its port");
  const model = await ollamaModel(ctx, url);
  if (!model) ctx.fail("Ollama has no model yet. Choose one on its Connections tab, then run this again.");
  const data = ctx.mounts.find((mount) => mount.containerPath === "/opt/data") ?? ctx.mounts.find((mount) => mount.hostPath.endsWith("/hermes-agent/data"));
  if (!data) ctx.fail("HexOS couldn't find Hermes's data folder");
  await ctx.emitCheckpoint("locate");

  const path = `${data.localPath}/config.yaml`;
  const current = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const next = withModel(current, section(model, url));
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
