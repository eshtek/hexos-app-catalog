// A custom app reaches the servers that already have it only through a raised script.version: the
// platform offers the catalog's script as an update when its script.version is semver-greater than
// the one the app last ran (isScriptUpdateAvailable), and compares nothing else. A change to what a
// custom app runs under the same version reaches new installs and never those servers, so this
// compares each custom app's script with the base branch's and refuses that change. It refuses two
// changes such an update can't carry too (a script adapted to an image's new major version is where
// they turn up): a new required question with no default, and a host folder no longer mounted.
//
// Run: bun _lib/script_bumps.ts <base ref>     (CI passes origin/<the pull request's base>)

import { readdirSync, readFileSync } from "node:fs";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    isObject(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  );

/**
 * What a server runs from a script: everything but the catalog card (metadata), the version block
 * itself, and `internal`, which only says which catalog lists the app.
 */
export function runPart(script: Record<string, unknown>): string {
  const { metadata: _metadata, script: _block, internal: _internal, ...runs } = script;
  return canonical(runs);
}

const versionOf = (script: Record<string, unknown>): string | undefined =>
  isObject(script.script) && typeof script.script.version === "string" ? script.script.version : undefined;

/** a > b, both x.y.z, as semver.gt reads them. */
export function versionRaised(a: string, b: string): boolean {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** Why the head script can't ship as it is, or null when it can. */
export function bumpProblem(base: Record<string, unknown>, head: Record<string, unknown>): string | null {
  if (head.custom !== true || runPart(base) === runPart(head)) return null;
  const from = versionOf(base) ?? "";
  const to = versionOf(head) ?? "";
  if (![from, to].every((v) => /^\d+\.\d+\.\d+$/.test(v))) return null; // the validator names a version that isn't x.y.z
  if (versionRaised(to, from)) return null;
  return `what the app runs changed but script.version is still ${to}; raise it (to ${from.replace(/\d+$/, (n) => String(Number(n) + 1))} or later) or servers that already have the app never get the change`;
}

const questionsOf = (script: Record<string, unknown>): Record<string, unknown>[] =>
  Array.isArray(script.installation_questions) ? script.installation_questions.filter(isObject) : [];

/**
 * Required questions new in `head` with no default. An update takes each answer from the app's live
 * settings, where the old script put it, and the platform refuses an update with a required question
 * that has neither an answer nor a default, so every server that has the app would be refused.
 */
export function unanswerableQuestions(base: Record<string, unknown>, head: Record<string, unknown>): string[] {
  const known = new Set(questionsOf(base).map((q) => q.key));
  return questionsOf(head)
    .filter((q) => !known.has(q.key) && q.required !== false && (q.default === undefined || q.default === null || q.default === ""))
    .map((q) => String(q.key));
}

/** The host folders (and ix volumes) a script mounts into the container. */
function mountedFolders(script: Record<string, unknown>): string[] {
  const values = isObject(script.app_values) ? script.app_values : {};
  const folders: string[] = [];
  for (const entry of Array.isArray(values.storage) ? values.storage.filter(isObject) : []) {
    const host = isObject(entry.host_path_config) ? entry.host_path_config : {};
    const acl = isObject(host.acl) ? host.acl : {};
    const path = host.path ?? acl.path;
    if (typeof path === "string") folders.push(path);
    const volume = isObject(entry.ix_volume_config) ? entry.ix_volume_config.dataset_name : undefined;
    if (typeof volume === "string") folders.push(`ix volume ${volume}`);
  }
  return folders;
}

/**
 * Folders `base` mounts that `head` doesn't. A server that has the app keeps its data there, so the
 * update would start the app without it. Mounting the same folder at a new mount_path is fine.
 */
export function droppedFolders(base: Record<string, unknown>, head: Record<string, unknown>): string[] {
  const kept = new Set(mountedFolders(head));
  return mountedFolders(base).filter((folder) => !kept.has(folder));
}

/** Why a custom app's head script can't ship to the servers that have its base, one reason a line. */
export function updateProblems(base: Record<string, unknown>, head: Record<string, unknown>): string[] {
  if (head.custom !== true) return [];
  const problems: string[] = [];
  const bump = bumpProblem(base, head);
  if (bump) problems.push(bump);
  for (const key of unanswerableQuestions(base, head)) {
    problems.push(`question "${key}" is new, required and has no default; servers that already have the app have no answer for it, so their update would be refused. Give it a default`);
  }
  for (const folder of droppedFolders(base, head)) {
    problems.push(`${folder} is no longer mounted; servers that already have the app keep its data there, so it would start without it. Keep the folder mounted (a new mount_path is fine)`);
  }
  return problems;
}

if (import.meta.main) {
  const base = process.argv[2];
  if (!base) {
    console.error("Usage: bun _lib/script_bumps.ts <base ref>");
    process.exit(2);
  }
  const problems: string[] = [];
  for (const file of readdirSync(".").filter((f) => f.endsWith(".json")).sort()) {
    const shown = Bun.spawnSync(["git", "show", `${base}:${file}`]);
    if (shown.exitCode !== 0) continue; // new in this change: nothing installed yet
    let before: unknown;
    let after: unknown;
    try {
      before = JSON.parse(shown.stdout.toString());
      after = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      continue; // the validator reports a script that doesn't parse
    }
    if (!isObject(before) || !isObject(after)) continue;
    for (const problem of updateProblems(before, after)) problems.push(`✗ ${file}\n    ${problem}`);
  }
  for (const problem of problems) console.log(`\n${problem}`);
  console.log(`\nUpdates to installed apps checked against ${base}: ${problems.length} error(s)`);
  process.exit(problems.length > 0 ? 1 : 0);
}
