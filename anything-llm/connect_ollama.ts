// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import type { HookContext } from "../_lib/hook_context";

/**
 * Points AnythingLLM at Ollama and the model it has, through the settings API its own setup screen
 * uses. A fresh AnythingLLM has no sign-in on the home network. One that has been given a password
 * refuses this, and the owner sets Ollama in its settings. Read at AnythingLLM 1.19.
 */

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
    { id: "configure", message: "Connecting AnythingLLM to Ollama" },
  ]);
  const url = await ctx.getInstalledAppUrl("ollama");
  if (!url) ctx.fail("Ollama isn't installed, or HexOS can't find its port");
  await ctx.waitForApp("/api/ping", { maxAttempts: 60 });
  const model = await ollamaModel(ctx, url);
  await ctx.emitCheckpoint("locate");

  const response = await fetch(`${ctx.baseUrl}/api/system/update-env`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      LLMProvider: "ollama",
      OllamaLLMBasePath: url,
      ...(model ? { OllamaLLMModelPref: model } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) ctx.fail("AnythingLLM didn't take Ollama's address", [{ label: "Reason", value: `${response.status} ${response.statusText}` }]);
  await ctx.emitCheckpoint("configure");
}
