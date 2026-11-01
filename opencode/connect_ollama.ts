// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import type { HookContext } from "../_lib/hook_context";

/**
 * Gives OpenCode the owner's Ollama as its model. OpenCode reads opencode.json in its config folder
 * at its start, so the link merges the provider into that file and restarts it. It reaches Ollama
 * through the one hole in the agent network's block. Read at OpenCode 1.19.
 */

const APPS_UID = 568;

interface Settings {
  provider?: Record<string, unknown>;
  model?: string;
  [key: string]: unknown;
}

export async function run(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "locate", message: "Finding Ollama" },
    { id: "configure", message: "Connecting OpenCode to Ollama" },
  ]);
  const url = await ctx.getInstalledAppUrl("ollama");
  if (!url) ctx.fail("Ollama isn't installed, or HexOS can't find its port");
  const tags = (await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(15_000) }).then((response) => response.json())) as {
    models?: Array<{ name: string }>;
  };
  const model = tags.models?.[0]?.name;
  if (!model) ctx.fail("Ollama has no model yet. Run this again once its download has finished.");
  const data = ctx.mounts.find((mount) => mount.containerPath === "/data");
  if (!data) ctx.fail("HexOS couldn't find OpenCode's settings folder");
  await ctx.emitCheckpoint("locate");

  const folder = `${data.localPath}/.config/opencode`;
  const path = `${folder}/opencode.json`;
  if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
  let settings: Settings = {};
  try {
    settings = JSON.parse(readFileSync(path, "utf-8")) as Settings;
  } catch {}
  settings.provider = {
    ...settings.provider,
    ollama: {
      npm: "@ai-sdk/openai-compatible",
      name: "Ollama",
      options: { baseURL: `${url}/v1` },
      models: { [model]: { name: model } },
    },
  };
  settings.model = `ollama/${model}`;
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  for (const owned of [`${data.localPath}/.config`, folder, path]) chownSync(owned, APPS_UID, APPS_UID);
  if (typeof ctx.restartApp !== "function") ctx.fail("This server's HexOS needs an update first. Try again after it updates.");
  await ctx.restartApp();
  await ctx.emitCheckpoint("configure");
}
