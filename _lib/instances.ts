// One server may run several copies of an app whose script says `requirements.instances: "many"`.
// Each copy needs its own data and ports, so the rules here keep a script from saying that and then
// sharing a folder: two copies on one folder open each other's database with a new password.
//
// `$INSTANCE(folder)` is the folder for a first copy and the folder plus the copy's suffix for a
// later one, so writing it changes nothing on a server that already has the app. A folder that every
// copy shares on purpose is listed in `requirements.shared_folders`, as the script writes it.

import type { Finding, Script } from "./ports";
import { publishedPorts } from "./ports";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const LOCATION_PATH = /\$LOCATION\(([^)]+)\)\/((?:\$INSTANCE\([^)]+\)|[^"$)])+)/g;
const INSTANCE = /\$INSTANCE\(([^)]+)\)/g;

/** A copy's TrueNAS name is the id, a hyphen and a number, and TrueNAS allows 40 characters. */
const MAX_ID_LENGTH = 36;

const requirementsOf = (script: Script) => (isObject(script.requirements) ? script.requirements : {});

/** The folders a script keeps under a location, as it writes them. The location alone isn't one. */
export function locationFolders(script: Script): string[] {
  const { ensure_directories_exists, app_values } = script;
  const text = JSON.stringify({ ensure_directories_exists, app_values });
  return [...new Set([...text.matchAll(LOCATION_PATH)].map(([, location, path]) => `$LOCATION(${location})/${path}`))];
}

const followsCopy = (folder: string) => /^\$LOCATION\([^)]+\)\/\$INSTANCE\(/.test(folder);

const isUnder = (folder: string, root: string) => folder === root || folder.startsWith(`${root}/`);

/** The rules for a script that allows copies, and for the two keys anywhere else. */
export function instanceRules(id: string, script: Script): Finding[] {
  const error = (message: string): Finding => ({ level: "error", message });
  const requirements = requirementsOf(script);
  const findings: Finding[] = [];
  if (requirements.instances !== undefined && requirements.instances !== "many") {
    findings.push(error(`requirements.instances: "${String(requirements.instances)}" must be "many"`));
  }
  const listed = requirements.shared_folders;
  if (listed !== undefined && !(Array.isArray(listed) && listed.every((folder) => typeof folder === "string"))) {
    findings.push(error("requirements.shared_folders must be a list of folders as the script writes them"));
  }
  if (requirements.instances !== "many") return findings;

  if (id.length > MAX_ID_LENGTH) {
    findings.push(error(`"${id}" is too long for a copy's name: ${MAX_ID_LENGTH} characters at most`));
  }
  const shared = Array.isArray(listed) ? listed.filter((folder): folder is string => typeof folder === "string") : [];
  for (const folder of locationFolders(script)) {
    if (!followsCopy(folder) && !shared.some((root) => isUnder(folder, root))) {
      findings.push(
        error(`${folder} doesn't follow the copy: write it with $INSTANCE, or list it in requirements.shared_folders`),
      );
    }
  }
  for (const port of publishedPorts(script)) {
    if (!port.movable) {
      findings.push(error(`${port.path} is a fixed port, so a second copy could never start: write it as $PORT`));
    }
  }
  return findings;
}

/** `$INSTANCE(x)` read as `x`: what a first copy gets, and so what an installed app already has. */
export const asFirstCopy = (text: string): string => text.replace(INSTANCE, "$1");

/**
 * Why `head` can't replace `base`, for any script. `$INSTANCE` stays once a script has it, since
 * later copies already live under it; taking `requirements.instances` off is the rollback and is
 * fine. Its argument is the folder installed apps have, so it can't name another.
 */
export function instanceChangeProblems(base: Script, head: Script): string[] {
  const before = locationFolders(base);
  const after = new Set(locationFolders(head));
  const problems: string[] = [];
  for (const folder of before) {
    if (followsCopy(folder) && !after.has(folder)) {
      problems.push(`${folder} no longer follows the copy; later copies keep their data under it, so $INSTANCE stays`);
    }
  }
  const known = new Set(before.map(asFirstCopy));
  const sameFolder = (folder: string) => [...known].some((old) => old.split("/").slice(2).join("/") === folder);
  for (const folder of after) {
    if (!followsCopy(folder)) continue;
    const plain = asFirstCopy(folder);
    if (known.has(plain) || before.length === 0) continue;
    const rest = plain.split("/").slice(2).join("/");
    if (rest && sameFolder(rest)) {
      problems.push(`${folder} changes the folder $INSTANCE names; it has to be the one installed apps have`);
    }
  }
  return problems;
}
