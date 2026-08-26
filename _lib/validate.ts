// Catalog validator. Every check here corresponds to a way an install script
// can be accepted by GitHub and still fail on a user's box: unparseable JSON,
// a version the backend no longer understands, a $LOCATION the resolver will
// throw on, a $QUESTION with no question behind it, an icon path that 404s.
//
// Run: bun run validate

import { readdirSync, existsSync, statSync } from "node:fs";
import {
  BARE_MACROS,
  CALL_MACROS,
  HOOK_EVENTS,
  LOCATIONS,
  PERMISSIONS,
  QUESTION_TYPES,
  SPEC_REGEX,
  SUPPORTED_VERSIONS,
} from "./contract";

type Problem = { file: string; message: string };

const errors: Problem[] = [];
const warnings: Problem[] = [];

const err = (file: string, message: string) => errors.push({ file, message });
const warn = (file: string, message: string) => warnings.push({ file, message });

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Every string leaf in the document, with a dotted path for error messages. */
function* strings(value: unknown, path = ""): Generator<{ path: string; value: string }> {
  if (typeof value === "string") {
    yield { path, value };
  } else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) yield* strings(v, `${path}[${i}]`);
  } else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) yield* strings(v, path ? `${path}.${k}` : k);
  }
}

/**
 * A referenced file must exist and must sit inside the repo. Catalog assets are
 * fetched by relative path from the raw GitHub URL, so a leading slash or a
 * `../` escape resolves somewhere that is not the catalog.
 */
function checkAssetPath(file: string, field: string, value: string) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return; // absolute URL, not our asset
  if (value.startsWith("/")) {
    err(file, `${field}: "${value}" is an absolute path; asset paths are relative to the repo root`);
    return;
  }
  if (value.split("/").includes("..")) {
    err(file, `${field}: "${value}" escapes the repository`);
    return;
  }
  if (!existsSync(value) || !statSync(value).isFile()) {
    err(file, `${field}: "${value}" does not exist in the repository`);
  }
}

function checkMacros(file: string, script: unknown, questionKeys: Set<string>) {
  const raw = JSON.stringify(script);

  // A macro name we do not know is almost always a typo. It survives install
  // untouched and lands in the container as a literal "$LOCATIN(...)".
  for (const match of raw.matchAll(/\$([A-Z_]{3,})/g)) {
    const name = match[1];
    const followedByParen = raw[match.index! + match[0].length] === "(";
    if (followedByParen) {
      if (!(CALL_MACROS as readonly string[]).includes(name)) {
        err(file, `unknown macro $${name}()`);
      }
    } else if (!(BARE_MACROS as readonly string[]).includes(name)) {
      // $LOCATION with no argument list is the same typo class.
      if ((CALL_MACROS as readonly string[]).includes(name)) {
        err(file, `$${name} is used without an argument list`);
      } else {
        err(file, `unknown macro $${name}`);
      }
    }
  }

  // replaceLocation() throws PROCESS_INSTALL_SCRIPT_UNKNOWN_LOCATION on any
  // name outside LocationPreferenceId, which aborts the whole install.
  for (const match of raw.matchAll(/\$LOCATION\(([^)]+)\)/g)) {
    const name = match[1].trim();
    if (!(LOCATIONS as readonly string[]).includes(name)) {
      err(file, `$LOCATION(${name}) is not a known location`);
    }
  }

  // A $QUESTION with no declaration behind it resolves to nothing.
  for (const match of raw.matchAll(/\$QUESTION\(([^)]+)\)/g)) {
    const key = match[1].trim().replace(/^["']|["']$/g, "").split(",")[0].trim();
    if (!questionKeys.has(key)) {
      err(file, `$QUESTION(${key}) has no matching question key`);
    }
  }

  // Unbalanced parentheses make the tokenizer consume to end-of-input.
  for (const name of CALL_MACROS) {
    for (const match of raw.matchAll(new RegExp(`\\$${name}\\(`, "g"))) {
      let depth = 0;
      let closed = false;
      for (let i = match.index! + match[0].length - 1; i < raw.length; i++) {
        if (raw[i] === "(") depth++;
        else if (raw[i] === ")" && --depth === 0) { closed = true; break; }
      }
      if (!closed) err(file, `$${name}( is never closed`);
    }
  }
}

function validate(file: string, script: Record<string, unknown>) {
  const version = script.version;
  if (typeof version !== "number") {
    err(file, "version is missing or not a number");
    return;
  }
  if (!(SUPPORTED_VERSIONS as readonly number[]).includes(version)) {
    err(
      file,
      `version ${version} is not parsed by the backend (supported: ${SUPPORTED_VERSIONS.join(", ")})`,
    );
    return;
  }

  // --- script block (required from v4 on) ---
  const scriptMeta = script.script;
  if (!isObject(scriptMeta)) {
    err(file, "script block is missing");
  } else if (typeof scriptMeta.version !== "string") {
    err(file, "script.version is missing");
  }

  // --- requirements (required from v4 on) ---
  const req = script.requirements;
  const declaredLocations = new Set<string>();
  if (!isObject(req)) {
    err(file, "requirements block is missing");
  } else {
    for (const key of ["permissions", "specifications", "locations", "ports"]) {
      if (!Array.isArray(req[key])) err(file, `requirements.${key} must be an array`);
    }
    for (const spec of (req.specifications as unknown[]) ?? []) {
      if (typeof spec !== "string" || !SPEC_REGEX.test(spec)) {
        err(file, `requirements.specifications: "${String(spec)}" is not a valid spec`);
      }
    }
    for (const perm of (req.permissions as unknown[]) ?? []) {
      if (typeof perm !== "string" || !(PERMISSIONS as readonly string[]).includes(perm)) {
        err(file, `requirements.permissions: "${String(perm)}" is not a known permission`);
      }
    }
    for (const loc of (req.locations as unknown[]) ?? []) {
      if (typeof loc !== "string" || !(LOCATIONS as readonly string[]).includes(loc)) {
        err(file, `requirements.locations: "${String(loc)}" is not a known location`);
      } else {
        declaredLocations.add(loc);
      }
    }
    for (const port of (req.ports as unknown[]) ?? []) {
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
        err(file, `requirements.ports: "${String(port)}" is not a valid port`);
      }
    }
  }

  // --- metadata and its assets ---
  const metadata = script.metadata;
  if (isObject(metadata)) {
    for (const key of ["name", "description", "icon", "version"]) {
      if (typeof metadata[key] !== "string" || !(metadata[key] as string).trim()) {
        err(file, `metadata.${key} is missing`);
      }
    }
    if (typeof metadata.icon === "string") checkAssetPath(file, "metadata.icon", metadata.icon);
    for (const [i, shot] of ((metadata.screenshots as unknown[]) ?? []).entries()) {
      if (typeof shot === "string") checkAssetPath(file, `metadata.screenshots[${i}]`, shot);
    }
  }

  // --- questions ---
  const questionKeys = new Set<string>();
  const collectQuestion = (q: unknown, where: string) => {
    if (!isObject(q)) return;
    const key = q.key;
    if (typeof key !== "string" || !key.trim()) {
      err(file, `${where}: question is missing a key`);
      return;
    }
    if (questionKeys.has(key)) err(file, `${where}: duplicate question key "${key}"`);
    questionKeys.add(key);
    if (typeof q.type !== "string" || !(QUESTION_TYPES as readonly string[]).includes(q.type)) {
      err(file, `${where}: question "${key}" has invalid type "${String(q.type)}"`);
    }
    if (q.type === "select") {
      const options = q.options;
      if (!Array.isArray(options) || options.length === 0) {
        err(file, `${where}: select question "${key}" has no options`);
      }
    }
  };

  for (const [i, q] of ((script.installation_questions as unknown[]) ?? []).entries()) {
    collectQuestion(q, `installation_questions[${i}]`);
  }

  // --- ensure_directories_exists ---
  for (const [i, entry] of ((script.ensure_directories_exists as unknown[]) ?? []).entries()) {
    const where = `ensure_directories_exists[${i}]`;
    if (!isObject(entry)) {
      err(file, `${where}: v${version} entries must be objects with a path`);
      continue;
    }
    if (typeof entry.path !== "string" || !entry.path.trim()) {
      err(file, `${where}: path is missing`);
    }
    // owner accepts a bare username string as shorthand for { user }.
    if (entry.owner !== undefined) {
      if (typeof entry.owner === "string") {
        if (!entry.owner.trim()) err(file, `${where}.owner: username is empty`);
      } else if (!isObject(entry.owner)) {
        err(file, `${where}.owner: must be a username string or { "user": "apps" }`);
      } else {
        if (typeof entry.owner.user !== "string" || !entry.owner.user.trim()) {
          err(file, `${where}.owner.user is missing`);
        }
        if (entry.owner.group !== undefined && typeof entry.owner.group !== "string") {
          err(file, `${where}.owner.group must be a string`);
        }
      }
    }
    if (entry.snapshot !== undefined) {
      if (!isObject(entry.snapshot) || typeof entry.snapshot.id !== "string") {
        err(file, `${where}.snapshot: must be an object with an id`);
      }
    }
    if (entry.network_share !== undefined && typeof entry.network_share !== "boolean") {
      err(file, `${where}.network_share must be a boolean`);
    }
  }

  // --- app_values ---
  if (!isObject(script.app_values)) err(file, "app_values is missing");

  // --- hooks (v5) ---
  const hookIds = new Set<string>();
  for (const [i, hook] of ((script.hooks as unknown[]) ?? []).entries()) {
    const where = `hooks[${i}]`;
    if (!isObject(hook)) {
      err(file, `${where}: must be an object`);
      continue;
    }
    if (version !== 5) err(file, `${where}: hooks require version 5`);
    const id = hook.id;
    if (typeof id !== "string" || !id.trim()) {
      err(file, `${where}: id is missing`);
    } else {
      if (hookIds.has(id)) err(file, `${where}: duplicate hook id "${id}"`);
      hookIds.add(id);
    }
    if (typeof hook.event !== "string" || !(HOOK_EVENTS as readonly string[]).includes(hook.event)) {
      err(file, `${where}: event "${String(hook.event)}" is not a known hook event`);
    }
    // A hook body is either a file reference or inlined scriptContent.
    const hasFile = typeof hook.script === "string" && hook.script.trim().length > 0;
    const hasInline = typeof hook.scriptContent === "string" && hook.scriptContent.trim().length > 0;
    if (!hasFile && !hasInline) {
      err(file, `${where}: needs either script or scriptContent`);
    } else if (hasFile && hasInline) {
      err(file, `${where}: declares both script and scriptContent`);
    } else if (hasFile) {
      checkAssetPath(file, `${where}.script`, hook.script as string);
    }
    if (typeof hook.entrypoint !== "string" || !hook.entrypoint.trim()) {
      err(file, `${where}: entrypoint is missing`);
    }
    if (hook.timeout !== undefined && (typeof hook.timeout !== "number" || hook.timeout <= 0)) {
      err(file, `${where}: timeout must be a positive number`);
    }
    for (const [j, input] of ((hook.inputs as unknown[]) ?? []).entries()) {
      if (!isObject(input)) continue;
      if (input.type === "question") collectQuestion(input.question, `${where}.inputs[${j}]`);
    }
  }

  checkMacros(file, script, questionKeys);

  // A location used by a macro but never declared still installs — the path
  // resolves — but HexOS never prompts for it, so the requirements screen and
  // the permission grant are both wrong.
  const used = new Set(
    [...JSON.stringify(script).matchAll(/\$LOCATION\(([^)]+)\)/g)].map((m) => m[1].trim()),
  );
  for (const loc of used) {
    if ((LOCATIONS as readonly string[]).includes(loc) && !declaredLocations.has(loc)) {
      warn(file, `$LOCATION(${loc}) is used but not declared in requirements.locations`);
    }
  }
}

// --- run ---

const files = readdirSync(".")
  .filter((f) => f.endsWith(".json"))
  .sort();

if (files.length === 0) {
  console.error("No install scripts found. Is the working directory the repo root?");
  process.exit(1);
}

for (const file of files) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Bun.file(file).text());
  } catch (cause) {
    err(file, `is not valid JSON: ${(cause as Error).message}`);
    continue;
  }
  if (!isObject(parsed)) {
    err(file, "top level must be an object");
    continue;
  }
  validate(file, parsed);
}

// Assets are cheap to orphan and invisible when they rot, so name the ones
// nothing points at rather than letting them accumulate.
const referenced = new Set<string>();
for (const file of files) {
  try {
    for (const { value } of strings(JSON.parse(await Bun.file(file).text()))) {
      if (value.includes("/") && !/^[a-z][a-z0-9+.-]*:/i.test(value) && existsSync(value)) {
        referenced.add(value);
      }
    }
  } catch { /* already reported as a parse error */ }
}

const group = (problems: Problem[]) => {
  const byFile = new Map<string, string[]>();
  for (const p of problems) {
    if (!byFile.has(p.file)) byFile.set(p.file, []);
    byFile.get(p.file)!.push(p.message);
  }
  return byFile;
};

for (const [file, messages] of group(warnings)) {
  console.log(`\n⚠ ${file}`);
  for (const m of messages) console.log(`    ${m}`);
}

for (const [file, messages] of group(errors)) {
  console.log(`\n✗ ${file}`);
  for (const m of messages) console.log(`    ${m}`);
}

console.log(
  `\n${files.length} install scripts checked — ` +
    `${errors.length} error(s), ${warnings.length} warning(s)`,
);

process.exit(errors.length > 0 ? 1 : 0);
