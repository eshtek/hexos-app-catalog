// Sibling files are type imports only: each script is compiled standalone, so runtime imports of them wouldn't resolve.
import { readFileSync } from "node:fs";

import type { WidgetContext, WidgetMount, WidgetQueryResult } from "../_lib/widget_context";

// The join code friends type in Valheim. A crossplay server logs its code when it registers, again
// when it replaces it (it did so two seconds after registering on demeter), and when its session
// becomes active:
//   Session "HexOS Valheim" registered with join code 144343
//   Created new join code 282677 for session "HexOS Valheim"
//   Session "HexOS Valheim" with join code 282677 and IP 203.0.113.7:2456 is active with 0 player(s)
// The image's log filter writes the latest such line to /config/hexos-session.txt (the script's
// VALHEIM_LOG_FILTER_CONTAINS_HexosSession and _HexosNewCode), and PRE_SERVER_RUN_HOOK removes the
// file before each start, since every start brings a new code. No file means the server isn't
// ready for players yet. The player count is left out: the server logged it once, at the start, in
// sixteen minutes of running.

const SESSION_FILE = "/hexos-session.txt";
// Anchored at the end, or at the code itself, so a server name with "join code 12" in it is never read as one
const JOIN_CODE_LINES = [
  /Session ".*" registered with join code (\d+)$/,
  /: Created new join code (\d+) for session ".*"$/,
  /Session ".*" with join code (\d+) and IP \S+ is active with \d+ player\(s\)$/,
];
const STARTING = "Valheim is starting. The join code shows here once friends can join.";

const configMount = (mounts: WidgetMount[]): WidgetMount | undefined =>
  mounts.find((m) => m.containerPath === "/config") ?? mounts.find((m) => m.hostPath.endsWith("/valheim/config"));

/** The newest join code in the file's text, or null when it names none yet. */
export function joinCode(text: string): string | null {
  for (const line of text.trimEnd().split("\n").reverse()) {
    for (const pattern of JOIN_CODE_LINES) {
      const code = pattern.exec(line.trimEnd())?.[1];
      if (code) return code;
    }
  }
  return null;
}

export async function run(ctx: WidgetContext): Promise<WidgetQueryResult> {
  const config = configMount(ctx.mounts);
  let code: string | null = null;
  try {
    if (config) code = joinCode(readFileSync(config.localPath + SESSION_FILE, "utf-8"));
  } catch {
    // No file yet: the server hasn't registered
  }
  if (!code) return { needsSetup: true, reason: STARTING };
  return { fields: { code: { type: "stat", label: "Join code", value: code } } };
}
