import { existsSync, readFileSync } from "node:fs";

import type { WidgetContext, WidgetFieldValue, WidgetMount, WidgetQueryResult } from "../_lib/widget_context";

// TShock makes its first admin from a one-time code: at every start until someone types
// /setup <code> in game and creates an account, it writes the code to setup-code.txt in its config
// folder. Once an account exists it deletes that file and leaves setup.lock in its place. Before
// either file exists the server is still on its first start, and the value shows as still to come.

const SETUP_FILE = "setup-code.txt";
const LOCK_FILE = "setup.lock";

/** The config folder, by its host path, since the chart mounts it at /tshock itself. A later copy's ends in -2. */
export const configMount = (mounts: WidgetMount[]): WidgetMount | undefined =>
  mounts.find((m) => m.containerPath === "/tshock") ?? mounts.find((m) => /\/terraria-tshock(-\d+)?\/config$/.test(m.hostPath));

/** The code in setup-code.txt, or null when there's no usable one. */
export function setupCode(text: string | null): string | null {
  const code = text?.trim() ?? "";
  return /^\d{4,10}$/.test(code) ? code : null;
}

/** What the card and the Settings tab show for a folder holding these files. */
export function setupField(code: string | null, locked: boolean): WidgetFieldValue {
  if (code) return { type: "stat", label: "Admin setup code", value: `/setup ${code}` };
  return { type: "stat", label: "Admin setup", value: locked ? "Done" : "" };
}

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

export async function run(ctx: WidgetContext): Promise<WidgetQueryResult> {
  const config = configMount(ctx.mounts);
  if (!config) return { fields: { setup: setupField(null, false) } };
  const code = setupCode(readText(`${config.localPath}/${SETUP_FILE}`));
  return { fields: { setup: setupField(code, existsSync(`${config.localPath}/${LOCK_FILE}`)) } };
}
