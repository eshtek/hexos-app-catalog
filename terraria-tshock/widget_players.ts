import { existsSync, readdirSync, readFileSync } from "node:fs";

import type { WidgetContext, WidgetFieldValue, WidgetMount, WidgetQueryResult } from "../_lib/widget_context";

// Who's playing on a TShock server, and, on the Settings tab only, the code that makes its first admin.
//
// TShock starts a new log file in its config folder's logs at every start, and writes a line when a
// player joins, with the count and the server's limit, and another when one disconnects. The card
// folds back to the plain one while nobody is on.
//
// TShock makes its first admin from a one-time code: at every start until someone types
// /setup <code> in game and creates an account, it writes the code to setup-code.txt in its config
// folder. Once an account exists it deletes that file and leaves setup.lock in its place. Before
// either file exists the server is still on its first start, and the value shows as still to come.

const SETUP_FILE = "setup-code.txt";
const LOCK_FILE = "setup.lock";
/** TShock's own default, until a join line says otherwise. */
const DEFAULT_MAX_PLAYERS = 8;
const JOINED = /: INFO: (.+?) \([^)]*\) from '[^']*' group(?: from '[^']*')? joined\. \((\d+)\/(\d+)\)$/;
const DISCONNECTED = /: INFO: (.+?) disconnected\.$/;

/** The config folder, by its host path, since the chart mounts it at /tshock itself. A later copy's ends in -2. */
export const configMount = (mounts: WidgetMount[]): WidgetMount | undefined =>
  mounts.find((m) => m.containerPath === "/tshock") ?? mounts.find((m) => /\/terraria-tshock(-\d+)?\/config$/.test(m.hostPath));

/** The code in setup-code.txt, or null when there's no usable one. */
export function setupCode(text: string | null): string | null {
  const code = text?.trim() ?? "";
  return /^\d{4,10}$/.test(code) ? code : null;
}

/** What the Settings tab shows for a folder holding these files. */
export function setupField(code: string | null, locked: boolean): WidgetFieldValue {
  if (code) return { type: "stat", label: "Admin setup", value: `/setup ${code}` };
  return { type: "stat", label: "Admin setup", value: locked ? "Done" : "" };
}

/** Who's on, in the order they joined, and the server's limit, from one start's log. */
export function players(log: string): { names: string[]; max: number } {
  const online = new Set<string>();
  let max = DEFAULT_MAX_PLAYERS;
  for (const line of log.split("\n").map((l) => l.trimEnd())) {
    const joined = JOINED.exec(line);
    if (joined) {
      online.add(joined[1]);
      max = Number(joined[3]) || max;
      continue;
    }
    const left = DISCONNECTED.exec(line);
    if (left) online.delete(left[1]);
  }
  return { names: [...online], max };
}

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** This start's log: TShock names each by when it began, so the last one sorts last. */
function currentLog(config: WidgetMount): string {
  try {
    const logs = readdirSync(`${config.localPath}/logs`).filter((name) => name.endsWith(".log")).sort();
    const latest = logs.at(-1);
    return latest ? (readText(`${config.localPath}/logs/${latest}`) ?? "") : "";
  } catch {
    return "";
  }
}

export async function run(ctx: WidgetContext): Promise<WidgetQueryResult> {
  const config = configMount(ctx.mounts);
  const { names, max } = config ? players(currentLog(config)) : { names: [], max: DEFAULT_MAX_PLAYERS };
  const code = config ? setupCode(readText(`${config.localPath}/${SETUP_FILE}`)) : null;
  const locked = config ? existsSync(`${config.localPath}/${LOCK_FILE}`) : false;
  return {
    fields: {
      // One entry while anyone's on: who, in the small line under it
      online: { type: "list", entries: names.length ? [{ title: "Terraria", subtitle: names.join(", ") }] : [] },
      count: { type: "stat", label: "Players", value: `${names.length}/${max}` },
      setup: setupField(code, locked),
    },
  };
}
