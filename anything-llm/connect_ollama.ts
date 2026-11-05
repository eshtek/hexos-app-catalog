// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import type { HookContext } from "../_lib/hook_context";

/**
 * Points AnythingLLM at Ollama and the model it has, through the settings API its own setup screen
 * uses. A fresh AnythingLLM has no sign-in on the home network. One that has been given a password
 * refuses this, and the owner sets Ollama in its settings. Read at AnythingLLM 1.19.
 */

/** Ends the link for something only the owner can change, so a collection doesn't offer Try again. */
function refuse(ctx: HookContext, message: string, context?: Array<{ label: string; value: string }>): never {
  if (ctx.skip) ctx.skip(message, context);
  return ctx.fail(message, context);
}

/** The model Ollama is set to, which may still be downloading, else the first it has. */
async function ollamaModel(ctx: HookContext, url: string): Promise<string | undefined> {
  const hardware = await ctx.readLocalAiHardware?.().catch(() => undefined);
  if (hardware?.ollama?.wanted) return hardware.ollama.wanted;
  const tags = (await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(15_000) })
    .then((response) => (response.ok ? response.json() : undefined))
    .catch(() => undefined)) as { models?: Array<{ name: string }> } | undefined;
  if (!tags) ctx.fail("Ollama didn't answer. Wait a minute for it to start, then run this again.");
  return tags.models?.[0]?.name;
}

export async function run(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "locate", message: "Finding Ollama" },
    { id: "configure", message: "Connecting AnythingLLM to Ollama" },
  ]);
  const url = await ctx.getInstalledAppUrl("ollama");
  if (!url) ctx.fail("Ollama isn't installed, or HexOS can't find its port");
  await ctx.waitForApp("/api/ping", { maxAttempts: 60 });
  const model = await ollamaModel(ctx, url);
  if (!model) ctx.fail("Ollama has no model yet. Choose one on its Connections tab, then run this again.");
  await ctx.emitCheckpoint("locate");

  // AnythingLLM takes the settings in the order sent and stops at the first it refuses, so the
  // provider comes last and is never switched to an Ollama it didn't take
  const response = await fetch(`${ctx.baseUrl}/api/system/update-env`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ OllamaLLMBasePath: url, OllamaLLMModelPref: model, LLMProvider: "ollama" }),
    signal: AbortSignal.timeout(30_000),
  }).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  if (response instanceof Error) {
    ctx.fail("AnythingLLM didn't answer. Wait a minute for it to start, then run this again.", [{ label: "Reason", value: response.message }]);
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    refuse(ctx, "AnythingLLM asks for a password, so HexOS can't change its settings. Set Ollama as the LLM provider in AnythingLLM's own settings.");
  }
  if (!response.ok) ctx.fail("AnythingLLM didn't take Ollama's address", [{ label: "Reason", value: `${response.status} ${response.statusText}` }]);
  // A setting AnythingLLM refuses still answers 200, with the reason
  const result = (await response.json().catch(() => ({}))) as { error?: string | false };
  if (result.error) ctx.fail("AnythingLLM didn't take Ollama's address", [{ label: "Reason", value: String(result.error) }]);
  await ctx.emitCheckpoint("configure");
}
