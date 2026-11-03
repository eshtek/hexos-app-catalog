// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import type { HookContext } from "../_lib/hook_context";

/**
 * Gives OpenClaw the owner's Ollama as its model. OpenClaw keeps its settings in openclaw.json in its
 * config folder and reads them at its start, so the link merges the Ollama provider into that file
 * and restarts it. It reaches Ollama through the one hole in the agent network's block. Read at
 * OpenClaw 2026.10.
 */

const APPS_UID = 568;

interface Settings {
  models?: { providers?: Record<string, unknown> };
  agents?: { defaults?: { model?: { primary?: string } } };
  [key: string]: unknown;
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
    { id: "configure", message: "Connecting OpenClaw to Ollama" },
  ]);
  const url = await ctx.getInstalledAppUrl("ollama");
  if (!url) ctx.fail("Ollama isn't installed, or HexOS can't find its port");
  const model = await ollamaModel(ctx, url);
  if (!model) ctx.fail("Ollama has no model yet. Choose one on its Connections tab, then run this again.");
  const home = ctx.mounts.find((mount) => mount.containerPath === "/home/node") ?? ctx.mounts.find((mount) => mount.hostPath.endsWith("/openclaw/config"));
  if (!home) ctx.fail("HexOS couldn't find OpenClaw's settings folder");
  await ctx.emitCheckpoint("locate");

  const folder = `${home.localPath}/.openclaw`;
  const path = `${folder}/openclaw.json`;
  if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
  let settings: Settings = {};
  try {
    settings = JSON.parse(readFileSync(path, "utf-8")) as Settings;
  } catch {}
  settings.models = {
    ...settings.models,
    providers: {
      ...settings.models?.providers,
      ollama: { baseUrl: url, apiKey: "ollama-local", api: "ollama", models: [{ id: model, name: model }] },
    },
  };
  settings.agents = { ...settings.agents, defaults: { ...settings.agents?.defaults, model: { primary: `ollama/${model}` } } };
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  chownSync(folder, APPS_UID, APPS_UID);
  chownSync(path, APPS_UID, APPS_UID);
  if (typeof ctx.restartApp !== "function") ctx.fail("This server's HexOS needs an update first. Try again after it updates.");
  await ctx.restartApp();
  await ctx.emitCheckpoint("configure");
}
