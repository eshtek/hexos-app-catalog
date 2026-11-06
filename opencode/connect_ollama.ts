// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { chmodSync, chownSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

import type { HookContext } from "../_lib/hook_context";

/**
 * Gives OpenCode the owner's Ollama as its model. OpenCode reads its settings folder at its start, so
 * the link merges the provider into its settings file there and restarts it. It reaches Ollama
 * through the one hole in the agent network's block. Read at OpenCode 1.19.
 *
 * OpenCode reads config.json, then opencode.json, then opencode.jsonc, a later one winning, and writes
 * its own changes to the one that wins of those it has. On its first start with none it makes an
 * opencode.jsonc that names only its schema. The link writes to that same file, so its settings never
 * lose to another file. Each is read as JSONC, so HexOS changes it only when it reads as plain JSON,
 * keeps every setting it doesn't set, and copies the old file to <file>.hexos-bak first. A file it
 * can't read is left as it is, and so is one that already has this model.
 *
 * OpenCode knows a model's window only from its `limit`, and with none it never compacts a chat
 * (packages/opencode/src/session/overflow.ts). The link sets it to the context Ollama runs at.
 */

const APPS_UID = 568;
/** The longest reply OpenCode asks for (packages/opencode/src/provider/transform.ts, OUTPUT_TOKEN_MAX). */
const OUTPUT_TOKEN_MAX = 32_000;
/** The mode OpenCode gives a file it makes. */
const NEW_FILE_MODE = 0o644;
/** OpenCode's settings files, the one it writes to first. */
const FILES = ["opencode.jsonc", "opencode.json", "config.json"];

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

/**
 * The window as OpenCode's `limit` holds it, which must name the reply's share too. OpenCode
 * compacts once a chat fills the window less that share, so it gets a quarter, at most OpenCode's own.
 */
const limitFor = (contextLength: number) => ({ context: contextLength, output: Math.min(OUTPUT_TOKEN_MAX, Math.floor(contextLength / 4)) });

/** The settings as they are, an empty set when there's no file yet, or why HexOS won't change them. */
function readSettings(path: string): { settings: Json } | { refused: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { settings: {} };
    return { refused: "HexOS couldn't read OpenCode's settings file, so it won't rewrite it. Set Ollama as OpenCode's model in its own settings." };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) return { settings: parsed };
  } catch {}
  return { refused: "OpenCode's settings file has comments or isn't plain JSON, so HexOS won't rewrite it. Set Ollama as OpenCode's model in its own settings." };
}

/**
 * The settings with Ollama as a provider and the model, everything else as it was. With
 * `contextLength`, this model's `limit` gets it; without, its entry is left alone.
 */
export function withOllama(settings: Json, url: string, model: string, contextLength?: number): Json {
  const providers = isRecord(settings.provider) ? settings.provider : {};
  const ollama = isRecord(providers.ollama) ? providers.ollama : {};
  const options = isRecord(ollama.options) ? ollama.options : {};
  // Models the owner added to this provider, and their settings, stay
  const models = isRecord(ollama.models) ? ollama.models : {};
  const entry = models[model] ?? { name: model };
  const sized =
    contextLength && isRecord(entry) ? { ...entry, limit: { ...(isRecord(entry.limit) ? entry.limit : {}), ...limitFor(contextLength) } } : entry;
  return {
    ...settings,
    provider: {
      ...providers,
      ollama: {
        ...ollama,
        npm: "@ai-sdk/openai-compatible",
        name: ollama.name ?? "Ollama",
        options: { ...options, baseURL: `${url}/v1` },
        models: { ...models, [model]: sized },
      },
    },
    model: `ollama/${model}`,
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
    { id: "configure", message: "Connecting OpenCode to Ollama" },
  ]);
  const url = await ctx.getInstalledAppUrl("ollama");
  if (!url) ctx.fail("Ollama isn't installed, or HexOS can't find its port");
  const { model, contextLength } = await ollamaSettings(ctx, url);
  if (!model) ctx.fail("Ollama has no model yet. Choose one on its Connections tab, then run this again.");
  const data = ctx.mounts.find((mount) => mount.containerPath === "/data");
  if (!data) ctx.fail("HexOS couldn't find OpenCode's settings folder");
  await ctx.emitCheckpoint("locate");

  const folder = `${data.localPath}/.config/opencode`;
  const file = FILES.find((name) => existsSync(`${folder}/${name}`)) ?? "opencode.json";
  const path = `${folder}/${file}`;
  const read = readSettings(path);
  if ("refused" in read) refuse(ctx, read.refused, [{ label: "File", value: `${data.hostPath}/.config/opencode/${file}` }]);
  const next = withOllama(read.settings, url, model, contextLength);
  if (JSON.stringify(next) === JSON.stringify(read.settings)) {
    await ctx.skipCheckpoint("configure", `OpenCode already uses ${model}`);
    return;
  }
  if (typeof ctx.restartApp !== "function") ctx.fail("This server's HexOS needs an update first. Try again after it updates.");
  try {
    mkdirSync(folder, { recursive: true });
    for (const owned of [`${data.localPath}/.config`, folder]) chownSync(owned, APPS_UID, APPS_UID);
    save(path, `${JSON.stringify(next, null, 2)}\n`);
  } catch (error) {
    ctx.fail("HexOS couldn't save OpenCode's settings, so they're as they were. Run this again.", [
      { label: "Reason", value: error instanceof Error ? error.message : String(error) },
    ]);
  }
  await ctx.restartApp();
  await ctx.emitCheckpoint("configure");
}
