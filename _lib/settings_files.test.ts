import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A settings file a script declares in `ensure_files_exist` (AnythingLLM's /app/server/.env). HexOS
// makes the file, from the app's own copy on an update, and adds its mount, so a box from before
// the field leaves the app as it was. These are the rules a declaration has to meet for that.

interface Script {
  ensure_directories_exists?: Array<string | { path: string }>;
  ensure_files_exist?: unknown;
  app_values?: unknown;
}

const root = join(import.meta.dir, "..");
const scripts = readdirSync(root)
  .filter((name) => name.endsWith(".json"))
  .map((name) => ({ name, script: JSON.parse(readFileSync(join(root, name), "utf-8")) as Script }));

/** Every problem with one script's settings files. */
function problems(script: Script): string[] {
  const entries = script.ensure_files_exist;
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) return ["ensure_files_exist must be a list"];
  const folders = new Set((script.ensure_directories_exists ?? []).map((entry) => (typeof entry === "string" ? entry : entry.path)));
  const values = JSON.stringify(script.app_values ?? {});
  const found: string[] = [];
  for (const [i, entry] of entries.entries()) {
    const where = `ensure_files_exist[${i}]`;
    const { path, mount_path: mount, uid, gid } = (entry ?? {}) as Record<string, unknown>;
    if (typeof path !== "string" || !path.startsWith("$LOCATION(")) {
      found.push(`${where}.path must start at a location`);
      continue;
    }
    // The folder is made, and deleted with the app's data, by the folder rules
    if (!folders.has(path.slice(0, path.lastIndexOf("/")))) found.push(`${where}.path must be in a folder ensure_directories_exists makes`);
    if (path.split("/").includes("..")) found.push(`${where}.path must not climb`);
    if (typeof mount !== "string" || !/^\/[^\s]+[^/]$/.test(mount) || mount.length > 64 || mount.split("/").includes("..")) {
      found.push(`${where}.mount_path must be a file's absolute path inside the app, at most 64 characters`);
    } else if (values.includes(`"${mount}"`) || values.includes(`, ${mount})`)) {
      // TrueNAS refuses a mount whose file isn't there, so only a HexOS that makes the file mounts it
      found.push(`${where}.mount_path is mounted in app_values too: HexOS adds that mount itself`);
    }
    for (const [key, id] of [["uid", uid], ["gid", gid]] as const) {
      if (!Number.isInteger(id) || (id as number) < 0) found.push(`${where}.${key} must be the container user's number`);
    }
  }
  return found;
}

describe("every script's settings files", () => {
  for (const { name, script } of scripts.filter(({ script }) => script.ensure_files_exist !== undefined)) {
    test(`${name} declares them as HexOS can make them`, () => {
      expect(problems(script)).toEqual([]);
    });
  }
});

describe("AnythingLLM's settings file", () => {
  const anythingLlm = scripts.find(({ name }) => name === "anything-llm.json")!.script;

  // AnythingLLM writes every setting to /app/server/.env (server/utils/helpers/updateENV.js, dumpENV),
  // and TrueNAS runs it as 1000:1000 (run_as_context of its anything-llm app)
  test("is the .env it writes its settings to, owned by the user it runs as", () => {
    expect(anythingLlm.ensure_files_exist).toEqual([
      { path: "$LOCATION(ApplicationsPerformance)/anything-llm/config/.env", mount_path: "/app/server/.env", uid: 1000, gid: 1000 },
    ]);
  });

  test("lives in the app's own folder, so removing its data takes the file with it", () => {
    expect(anythingLlm.ensure_directories_exists).toContainEqual({ path: "$LOCATION(ApplicationsPerformance)/anything-llm/config" });
  });
});

describe("the rules", () => {
  const ok = {
    ensure_directories_exists: [{ path: "$LOCATION(ApplicationsPerformance)/app/config" }],
    ensure_files_exist: [{ path: "$LOCATION(ApplicationsPerformance)/app/config/.env", mount_path: "/app/.env", uid: 1000, gid: 1000 }],
    app_values: { storage: { data: "$HOST_PATH($LOCATION(ApplicationsPerformance)/app/data)" } },
  };
  const withEntry = (change: Record<string, unknown>) => ({ ...ok, ensure_files_exist: [{ ...ok.ensure_files_exist[0], ...change }] });

  test("take a declaration that meets them", () => {
    expect(problems(ok)).toEqual([]);
  });

  for (const [why, script] of [
    ["a path outside a location", { ...withEntry({ path: "/mnt/pool/app/config/.env" }), ensure_directories_exists: [{ path: "/mnt/pool/app/config" }] }],
    ["a file in a folder no entry makes", withEntry({ path: "$LOCATION(ApplicationsPerformance)/app/other/.env" })],
    ["a path that climbs", { ...withEntry({ path: "$LOCATION(ApplicationsPerformance)/app/config/../.env" }), ensure_directories_exists: [{ path: "$LOCATION(ApplicationsPerformance)/app/config/.." }] }],
    ["a relative mount", withEntry({ mount_path: "app/.env" })],
    ["a mount that names a folder", withEntry({ mount_path: "/app/" })],
    ["a mount longer than HexOS takes", withEntry({ mount_path: `/${"m".repeat(64)}` })],
    ["an owner by name", withEntry({ uid: "anythingllm" })],
    ["a negative group", withEntry({ gid: -1 })],
    ["the mount written in app_values too", { ...ok, app_values: { storage: { additional_storage: ["$MOUNTED_HOST_PATH($LOCATION(ApplicationsPerformance)/app/config/.env, /app/.env)"] } } }],
    ["the entries not in a list", { ...ok, ensure_files_exist: ok.ensure_files_exist[0] }],
  ] as const) {
    test(`refuse ${why}`, () => {
      expect(problems(script as Script)).not.toEqual([]);
    });
  }
});
