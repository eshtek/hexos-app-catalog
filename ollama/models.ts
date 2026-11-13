// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import type { HookContext } from "../_lib/hook_context";

/**
 * Ollama's models, as actions its owner runs from Ollama in HexOS. The model Ollama should have is
 * an env on the app, HEXOS_MODEL, so it survives a deploy, a restart and the run that asked for it, and a box pass
 * starts Download a model when Ollama is up without it. Choose a model sets that env and the context
 * the model needs, which restarts Ollama. Remove a model asks first, and is the only thing here that
 * deletes: nothing automatic ever removes a model. Read at Ollama 0.40.
 */

const WANTED = "HEXOS_MODEL";
const CONTEXT = "OLLAMA_CONTEXT_LENGTH";

/** What this card can run. Kept with the walk's own list, and models only this tab offers. */
const CHOICES = [
  { model: "qwen3.5:4b-q4_K_M", sizeGB: 3.3, minVramGB: 4, contextK: 8 },
  { model: "qwen3.5:9b-q4_K_M", sizeGB: 6.6, minVramGB: 8, contextK: 16 },
  { model: "gemma4:12b-it-qat", sizeGB: 7.2, minVramGB: 10, contextK: 64 },
  { model: "gemma4:26b-a4b-it-qat", sizeGB: 16, minVramGB: 16, contextK: 64 },
  { model: "qwen3.8:27b-q4_K_M", sizeGB: 18, minVramGB: 24, contextK: 64 },
  { model: "glm-4.7-flash:q4_K_M", sizeGB: 19, minVramGB: 24, contextK: 64 },
  { model: "qwen3.6:35b", sizeGB: 24, minVramGB: 32, contextK: 64 },
  { model: "gemma4:31b", sizeGB: 20, minVramGB: 32, contextK: 64 },
];

interface Env {
  name: string;
  value: string;
}

type Values = { ollama: { additional_envs?: Env[] }; network?: { api_port?: { port_number?: number } } };

async function ollamaUrl(ctx: HookContext): Promise<string> {
  if (typeof ctx.getAppValues !== "function") ctx.fail("This server's HexOS needs an update first. Try again after it updates.");
  const values = (await ctx.getAppValues()) as unknown as Values;
  return `http://${ctx.host}:${values.network?.api_port?.port_number ?? ctx.port}`;
}

async function presentModels(url: string): Promise<string[]> {
  const response = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const body = (await response.json()) as { models?: Array<{ name: string }> };
  return (body.models ?? []).map((model) => model.name);
}

/** Pulls the model the app wants, with progress. A cancelled pull picks up where it stopped. */
export async function download(ctx: HookContext) {
  await ctx.registerCheckpoints([{ id: "download", message: "Downloading your model" }]);
  const url = await ollamaUrl(ctx);
  const values = (await ctx.getAppValues!()) as unknown as Values;
  const model = values.ollama.additional_envs?.find((env) => env.name === WANTED)?.value;
  if (!model) {
    await ctx.skipCheckpoint("download", "No model is chosen yet. Choose one from this tab.");
    return;
  }
  if ((await presentModels(url)).includes(model)) {
    await ctx.skipCheckpoint("download", `Ollama already has ${model}`);
    return;
  }

  const response = await fetch(`${url}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: true }),
  });
  if (!response.ok || !response.body) ctx.fail(`Ollama didn't start downloading ${model}`, [{ label: "Reason", value: `${response.status} ${response.statusText}` }]);

  // Ollama reports each layer only once it starts, so a small first layer would read as the whole
  // model. The percent is over the model's known download size, or the layers seen if they come to
  // more, and never goes back; held under 99 until Ollama says it has finished. A model this list
  // doesn't know is measured over the layers seen so far
  const expected = (CHOICES.find((choice) => choice.model === model)?.sizeGB ?? 0) * 1e9;
  const decoder = new TextDecoder();
  const layers = new Map<string, { total: number; completed: number }>();
  let pending = "";
  let shown = -1;
  let finished = false;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const update = JSON.parse(line) as {
        status?: string;
        digest?: string;
        total?: number;
        completed?: number;
        error?: string;
      };
      if (update.error) ctx.fail(`Ollama couldn't download ${model}`, [{ label: "Reason", value: update.error }]);
      if (update.status === "success") finished = true;
      if (update.total && update.completed !== undefined) {
        layers.set(update.digest ?? "", { total: update.total, completed: update.completed });
        const all = [...layers.values()];
        const total = Math.max(expected, all.reduce((sum, layer) => sum + layer.total, 0));
        const completed = all.reduce((sum, layer) => sum + layer.completed, 0);
        const measured = Math.min(98, Math.floor((completed / total) * 99));
        const percent = expected ? Math.max(shown, measured) : measured;
        if (percent !== shown) {
          shown = percent;
          await ctx.setProgress(percent);
          await ctx.updateCheckpointMessage("download", `Downloading ${model}: ${percent}%`);
        }
      }
    }
  }
  if (!finished) ctx.fail(`The download of ${model} stopped early. Run this again and it picks up where it stopped.`);
  await ctx.emitCheckpoint("download", `Ollama has ${model}`, 99);
}

/** Lets the owner pick any model their card can run, which then downloads in the background. */
export async function choose(ctx: HookContext) {
  await ctx.registerCheckpoints([{ id: "choose", message: "Choosing a model" }]);
  if (typeof ctx.readLocalAiHardware !== "function" || typeof ctx.updateAppValues !== "function") {
    ctx.fail("This server's HexOS needs an update first. Try again after it updates.");
  }
  const hardware = await ctx.readLocalAiHardware();
  const memoryGB = Math.max(0, ...hardware.cards.filter((card) => card.pciSlot === hardware.ollama?.pciSlot).map((card) => card.memoryGB ?? 0));
  const fits = CHOICES.filter((choice) => choice.minVramGB <= memoryGB);
  if (fits.length === 0) ctx.fail("HexOS can't confirm this Ollama's graphics card has room for a model.");

  const answers = await ctx.askForInputs(
    [
      {
        type: "question",
        id: "model",
        question: {
          question: "Model",
          type: "select",
          key: "model",
          required: true,
          options: fits.map((choice) => ({ text: `${choice.model}, a ${choice.sizeGB} GB download`, value: choice.model })),
        },
      },
    ],
    { title: "Choose a model", description: "It downloads in the background, and Ollama restarts if it needs more room." },
  );
  const picked = fits.find((choice) => choice.model === answers.model);
  if (!picked) ctx.fail("That model isn't one this card can run.");
  const current = (await ctx.getAppValues?.()) as unknown as Values | undefined;
  if (current?.ollama.additional_envs?.some((env) => env.name === WANTED && env.value === picked.model)) {
    await ctx.skipCheckpoint("choose", `${picked.model} is already this Ollama's model. Download your model fetches it if it's missing.`);
    return;
  }

  await ctx.updateAppValues((raw) => {
    const values = raw as unknown as Values;
    const others = (values.ollama.additional_envs ?? []).filter((env) => env.name !== WANTED && env.name !== CONTEXT);
    values.ollama.additional_envs = [
      ...others,
      { name: CONTEXT, value: String(picked.contextK * 1024) },
      { name: WANTED, value: picked.model },
    ];
  });
  await ctx.emitCheckpoint("choose", `${picked.model} starts downloading within a minute`);
}

/** Removes a model the owner names and confirms. The app stops wanting it first, or it'd come back. */
export async function remove(ctx: HookContext) {
  await ctx.registerCheckpoints([{ id: "remove", message: "Removing a model" }]);
  const url = await ollamaUrl(ctx);
  const models = await presentModels(url);
  if (models.length === 0) {
    await ctx.skipCheckpoint("remove", "Ollama has no models to remove");
    return;
  }
  const answers = await ctx.askForInputs(
    [
      {
        type: "question",
        id: "model",
        question: { question: "Model to remove", type: "select", key: "model", required: true, options: models.map((model) => ({ text: model, value: model })) },
      },
      {
        type: "question",
        id: "confirm",
        question: { question: "Delete this model from your server", description: "You'd have to download it again to use it.", type: "boolean", key: "confirm", required: true },
      },
    ],
    { title: "Remove a model" },
  );
  if (answers.confirm !== true || typeof answers.model !== "string" || !models.includes(answers.model)) {
    await ctx.skipCheckpoint("remove", "Nothing was removed");
    return;
  }
  const model = answers.model;
  await ctx.updateAppValues!((raw) => {
    const values = raw as unknown as Values;
    values.ollama.additional_envs = (values.ollama.additional_envs ?? []).map((env) => (env.name === WANTED && env.value === model ? { ...env, value: "" } : env));
  });
  // The update restarts Ollama when it wanted this model
  await ctx.waitForApp("/api/tags", { maxAttempts: 30 }).catch(() => undefined);
  const response = await fetch(`${await ollamaUrl(ctx)}/api/delete`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) ctx.fail(`Ollama didn't remove ${model}`, [{ label: "Reason", value: `${response.status} ${response.statusText}` }]);
  await ctx.emitCheckpoint("remove", `${model} was removed`);
}
