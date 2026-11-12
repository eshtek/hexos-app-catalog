// `requirements.gpu: "one"` gives a new install one graphics card instead of every card the server
// has, and lets the owner change it in the app's Customize tab. `requirements.gpu_hook` names the
// hook HexOS runs after such a change, which sets the app's own video settings for the card. Both
// are read from the catalog's current script, and a box from before them ignores them.

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What is wrong with a script's one-card keys, one line each. */
export function videoCardProblems(script: Record<string, unknown>): string[] {
  const requirements = isObject(script.requirements) ? script.requirements : {};
  const { gpu, gpu_hook: hookId } = requirements;
  const problems: string[] = [];
  if (gpu !== undefined && gpu !== "one") problems.push(`requirements.gpu: "${String(gpu)}" is not "one"`);
  if (gpu === "one" && !JSON.stringify(script.app_values ?? {}).includes("$GPU_CONFIG()")) {
    problems.push("requirements.gpu needs $GPU_CONFIG() in app_values, which is what gives the app its card");
  }
  if (hookId === undefined) return problems;
  if (gpu !== "one") problems.push('requirements.gpu_hook needs requirements.gpu: "one"');
  const hooks = Array.isArray(script.hooks) ? script.hooks.filter(isObject) : [];
  const hook = typeof hookId === "string" ? hooks.find((candidate) => candidate.id === hookId) : undefined;
  if (!hook) {
    problems.push(`requirements.gpu_hook: "${String(hookId)}" is not one of the script's hooks`);
    return problems;
  }
  // HexOS runs it as the owner would from the app's card, and again after every pick
  const events = Array.isArray(hook.events) ? hook.events : ["userAction"];
  if (!events.includes("userAction")) problems.push(`requirements.gpu_hook: "${hookId}" needs the "userAction" event`);
  if (hook.rerun !== "converge" && hook.rerun !== "idempotent") {
    problems.push(`requirements.gpu_hook: "${hookId}" needs a hook that may run again`);
  }
  return problems;
}
