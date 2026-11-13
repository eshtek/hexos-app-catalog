// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { chmodSync, chownSync, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

import type { HookContext } from "../_lib/hook_context";

/**
 * Gives OpenClaw the owner's Ollama as its model. OpenClaw keeps its settings in openclaw.json in its
 * config folder and reads them at its start, so the link merges the Ollama provider into that file
 * and restarts it. It reaches Ollama through the one hole in the agent network's block. Read at
 * OpenClaw 2026.10.
 *
 * The file is the owner's. OpenClaw reads it as JSON5 and writes it as plain JSON, so HexOS changes
 * it only when it reads as plain JSON, keeps every setting it doesn't set, and copies the old file to
 * openclaw.json.hexos-bak first (OpenClaw's own backups are openclaw.json.bak and up). A file it
 * can't read is left as it is, and so is one that already has this model.
 *
 * OpenClaw sends Ollama a context size with every chat, its model's `contextTokens`, and gives a
 * local Ollama model 32,768 when the entry has none (extensions/ollama/src/stream.runtime.ts,
 * provider-models.ts capLocalOllamaModelContext). The link sets it to the context Ollama runs at.
 */

const APPS_UID = 568;
/** The mode OpenClaw gives the file, which holds its secrets. */
const NEW_FILE_MODE = 0o600;

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** Ends the link for something only the owner can change, so a collection doesn't offer Try again. */
function refuse(ctx: HookContext, message: string, context?: Array<{ label: string; value: string }>): never {
  if (ctx.skip) ctx.skip(message, context);
  return ctx.fail(message, context);
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
  const tags = (await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(15_000) })
    .then((response) => (response.ok ? response.json() : undefined))
    .catch(() => undefined)) as { models?: Array<{ name: string }> } | undefined;
  if (!tags) ctx.fail("Ollama didn't answer. Wait a minute for it to start, then run this again.");
  return { model: tags.models?.[0]?.name, contextLength };
}

/** The settings as they are, an empty set when there's no file yet, or why HexOS won't change them. */
function readSettings(path: string): { settings: Json } | { refused: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { settings: {} };
    return { refused: "HexOS couldn't read OpenClaw's settings file, so it won't rewrite it. Set Ollama as OpenClaw's model in its own settings." };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) return { settings: parsed };
  } catch {}
  return { refused: "OpenClaw's settings file has comments or isn't plain JSON, so HexOS won't rewrite it. Set Ollama as OpenClaw's model in its own settings." };
}

/**
 * The settings with Ollama as a provider and the default model, everything else as it was. With
 * `contextLength`, this model's entry gets it as its `contextTokens`; without, its entry is left alone.
 */
export function withOllama(settings: Json, url: string, model: string, contextLength?: number): Json {
  const models = isRecord(settings.models) ? settings.models : {};
  const providers = isRecord(models.providers) ? models.providers : {};
  const ollama = isRecord(providers.ollama) ? providers.ollama : {};
  // Models the owner added to this provider stay listed
  const existing = Array.isArray(ollama.models) ? ollama.models : [];
  const known = existing.some((entry) => isRecord(entry) && entry.id === model);
  const listed = contextLength
    ? existing.map((entry) => (isRecord(entry) && entry.id === model ? { ...entry, contextTokens: contextLength } : entry))
    : existing;
  const added = contextLength ? { id: model, name: model, contextTokens: contextLength } : { id: model, name: model };
  const agents = isRecord(settings.agents) ? settings.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  // The default model is "provider/model" or { primary, fallbacks }, and the owner's fallbacks stay
  const primary = { ...(isRecord(defaults.model) ? defaults.model : {}), primary: `ollama/${model}` };
  return {
    ...settings,
    models: {
      ...models,
      providers: {
        ...providers,
        ollama: {
          ...ollama,
          baseUrl: url,
          apiKey: ollama.apiKey ?? "ollama-local",
          api: "ollama",
          models: known ? listed : [...listed, added],
        },
      },
    },
    agents: { ...agents, defaults: { ...defaults, model: primary } },
  };
}

/** Replaces the file in one step, after copying the old one beside it, keeping its permissions. */
function save(path: string, text: string) {
  const temporary = `${path}.hexos-tmp`;
  let mode = NEW_FILE_MODE;
  try {
    mode = statSync(path).mode & 0o777;
    copyFileSync(path, `${path}.hexos-bak`);
    chownSync(`${path}.hexos-bak`, APPS_UID, APPS_UID);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    writeFileSync(temporary, text, { mode });
    chmodSync(temporary, mode);
    chownSync(temporary, APPS_UID, APPS_UID);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export async function run(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "locate", message: "Finding Ollama" },
    { id: "configure", message: "Connecting OpenClaw to Ollama" },
  ]);
  const url = await ctx.getInstalledAppUrl("ollama");
  if (!url) ctx.fail("Ollama isn't installed, or HexOS can't find its port");
  const { model, contextLength } = await ollamaSettings(ctx, url);
  if (!model) ctx.fail("Ollama has no model yet. Open Ollama in HexOS and run Choose a model, then run this again.");
  const home = ctx.mounts.find((mount) => mount.containerPath === "/home/node") ?? ctx.mounts.find((mount) => mount.hostPath.endsWith("/openclaw/config"));
  if (!home) ctx.fail("HexOS couldn't find OpenClaw's settings folder");
  await ctx.emitCheckpoint("locate");

  const folder = `${home.localPath}/.openclaw`;
  const path = `${folder}/openclaw.json`;
  const read = readSettings(path);
  if ("refused" in read) refuse(ctx, read.refused, [{ label: "File", value: `${home.hostPath}/.openclaw/openclaw.json` }]);
  const next = withOllama(read.settings, url, model, contextLength);
  if (JSON.stringify(next) === JSON.stringify(read.settings)) {
    await ctx.skipCheckpoint("configure", `OpenClaw already uses ${model}`);
    return;
  }
  if (typeof ctx.restartApp !== "function") ctx.fail("This server's HexOS needs an update first. Try again after it updates.");
  try {
    mkdirSync(folder, { recursive: true });
    chownSync(folder, APPS_UID, APPS_UID);
    save(path, `${JSON.stringify(next, null, 2)}\n`);
  } catch (error) {
    ctx.fail("HexOS couldn't save OpenClaw's settings, so they're as they were. Run this again.", [
      { label: "Reason", value: error instanceof Error ? error.message : String(error) },
    ]);
  }
  await ctx.restartApp();
  await ctx.emitCheckpoint("configure");
}
