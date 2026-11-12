// A hook's `summary` is the line its row shows in HexOS while nothing runs: what the action does,
// and when its owner would run it again. A hook that runs at install keeps its step's label in
// `description` ("Setting up Radarr"), which its row would otherwise show at rest. HexOS reads the
// summary from the catalog's current script, and a box from before it shows `description`.

/** Whether the hook is one the owner runs from its app's card that also runs by itself, at an install or an upgrade. */
export function needsSummary(hook: Record<string, unknown>): boolean {
  // An event written as an object is always a lifecycle one
  const events: unknown[] = Array.isArray(hook.events) ? hook.events : ["userAction"];
  if (!events.includes("userAction") || events.every((event) => event === "userAction")) return false;
  // A link has a row of its own kind, and its description already says what it links
  if (hook.kind === "connect") return false;
  return Array.isArray(hook.surfaces) ? hook.surfaces.includes("card") : hook.target === undefined;
}

/**
 * A hook that links another app but would be drawn with its own app's setup actions. HexOS puts a
 * hook on the Connections tab when it says `"kind": "connect"`, or when it is one of the links the
 * install offers, which it builds only from hooks on the install picker (the default for a hook
 * that names another app). A link narrowed to the card alone is neither.
 */
export function linkRowProblems(hook: Record<string, unknown>, appId: string): string[] {
  const conditions: unknown[] = Array.isArray(hook.conditions) ? hook.conditions : [];
  const namesAnother = conditions.some((condition) => {
    const app = (condition as { app?: unknown } | null)?.app;
    return typeof app === "string" && app !== appId;
  });
  if (!namesAnother || hook.kind === "connect" || !Array.isArray(hook.surfaces)) return [];
  if (!hook.surfaces.includes("card") || hook.surfaces.includes("installPicker")) return [];
  return [
    'a hook that names another app in conditions and leaves "installPicker" out of surfaces needs "kind": "connect": without it its row is drawn with the app\'s own setup actions, not its connections',
  ];
}

/** What is wrong with a hook's summary, one line each. */
export function hookSummaryProblems(hook: Record<string, unknown>): string[] {
  const { summary } = hook;
  if (summary !== undefined) {
    // A box drops a hook whose summary isn't text
    return typeof summary === "string" && summary.trim() ? [] : ["summary must be text that says what the hook does"];
  }
  return needsSummary(hook)
    ? ["a hook that runs at an install or an upgrade and from its app's card needs a summary: without one its row shows the description, which is its step's label"]
    : [];
}
