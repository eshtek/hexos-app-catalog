import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookSummaryProblems, needsSummary } from "./hook_summary";

// An app's own actions (Pre-configure, Jellyfin's transcoding) have rows on its Customize tab. A
// row shows the hook's summary while nothing runs, and without one it shows the description, which
// for these is the label of an install step ("Setting up Radarr"). These hold that every such hook
// says what it does, and what the validator refuses.

type Hook = Record<string, any>;

const root = join(import.meta.dir, "..");
const scripts = readdirSync(root)
  .filter((file) => file.endsWith(".json"))
  .map((file) => ({ app: file.replace(/\.json$/, ""), script: JSON.parse(readFileSync(join(root, file), "utf8")) as Record<string, any> }));
const hooks = scripts.flatMap(({ app, script }) =>
  script.version === 6 && Array.isArray(script.hooks) ? (script.hooks as Hook[]).map((hook) => ({ app, hook })) : [],
);
const named = (list: Array<{ app: string; hook: Hook }>) => list.map(({ app, hook }) => `${app} ${hook.id}`);

const setup = (over: object = {}) => ({
  id: "configure-app",
  title: "Pre-configure App",
  description: "Setting up App",
  events: ["onAfterInstall", "userAction"],
  rerun: "converge",
  surfaces: ["card"],
  ...over,
});

describe("the catalog's hooks", () => {
  test("every hook that runs at install and from its app's card has a summary", () => {
    const setups = hooks.filter(({ hook }) => needsSummary(hook));
    expect(setups.length).toBeGreaterThan(0);
    expect(named(setups.filter(({ hook }) => typeof hook.summary !== "string"))).toEqual([]);
  });

  test("none fails the validator's rules", () => {
    expect(named(hooks.filter(({ hook }) => hookSummaryProblems(hook).length > 0))).toEqual([]);
  });

  test("a summary is one or two whole sentences, and never the step's label again", () => {
    const summarised = hooks.filter(({ hook }) => hook.summary !== undefined);
    const wrong = summarised.filter(({ hook }) => {
      const summary = String(hook.summary);
      const sentences = summary.split(/(?<=\.)\s+/);
      return !summary.endsWith(".") || summary.includes("\u2014") || summary === hook.description || sentences.length > 2;
    });
    expect(named(wrong)).toEqual([]);
  });

  test("a summary names no tab, since the row moved from Connections to Customize and an older deck still draws it there", () => {
    const summarised = hooks.filter(({ hook }) => hook.summary !== undefined);
    expect(named(summarised.filter(({ hook }) => /\b(Connections|Customize)\b/.test(String(hook.summary))))).toEqual([]);
  });

  test("the hook Jellyfin names for its graphics card says it also limits streams from outside the network", () => {
    const jellyfin = scripts.find(({ app }) => app === "jellyfin")?.script;
    const hook = (jellyfin?.hooks as Hook[]).find((each) => each.id === jellyfin?.requirements.gpu_hook);
    expect(hook?.summary).toContain("graphics card");
    expect(hook?.summary).toContain("20 Mbps");
    // Its title is its install step's label, which a description would replace
    expect(hook?.description).toBeUndefined();
  });

  test.each(["emby", "plex"])("Pre-configure %s says it limits streams from outside the network too", (app) => {
    const script = scripts.find((each) => each.app === app)?.script;
    expect((script?.hooks as Hook[]).find((each) => each.id === `configure-${app}`)?.summary).toContain("20 Mbps");
  });
});

describe("which hooks need a summary", () => {
  test.each<[string, Hook, boolean]>([
    ["one that runs at install and from the app's card", setup(), true],
    ["one that runs after an upgrade and from the app's card", setup({ events: [{ event: "onAfterUpgrade" }, "userAction"] }), true],
    ["one with no surfaces of its own, which shows on the app's card", setup({ surfaces: undefined }), true],
    ["one that only its owner runs, whose description is already its row's line", setup({ events: ["userAction"] }), false],
    ["one with no events, which only its owner runs", setup({ events: undefined }), false],
    ["one that only runs at install, which has no row", setup({ events: ["onAfterInstall"] }), false],
    ["a link to another app", setup({ kind: "connect" }), false],
    ["one on the settings dialog only", setup({ surfaces: ["settings"] }), false],
    ["one that takes files, which belongs to the file browser", setup({ surfaces: undefined, target: { type: "files" } }), false],
  ])("%s", (_name, hook, expected) => expect(needsSummary(hook)).toBe(expected));
});

describe("what the validator refuses", () => {
  test("nothing, for a setup hook with a summary", () =>
    expect(hookSummaryProblems(setup({ summary: "Adds your Movies folder. Run it again if the folder is missing." }))).toEqual([]));
  test("nothing, for a hook that needs none and has none", () => expect(hookSummaryProblems(setup({ events: ["userAction"] }))).toEqual([]));
  test("nothing, for a summary on a hook that needs none", () =>
    expect(hookSummaryProblems(setup({ events: ["userAction"], summary: "Downloads the model you chose." }))).toEqual([]));

  test.each<[string, Hook, string]>([
    ["a setup hook with no summary", setup(), "needs a summary"],
    ["an empty summary", setup({ summary: "" }), "summary must be text"],
    ["a summary of spaces", setup({ summary: "   " }), "summary must be text"],
    ["a summary that isn't text", setup({ summary: ["Adds your Movies folder."] }), "summary must be text"],
    ["an empty summary on a hook that needs none", setup({ events: ["userAction"], summary: "" }), "summary must be text"],
  ])("%s", (_name, hook, message) => expect(hookSummaryProblems(hook).join("\n")).toContain(message));
});

describe("validate.ts", () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-summary-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (hook: Hook) => {
    const catalog = mkdtempSync(join(dir, "run-"));
    writeFileSync(join(catalog, "go.ts"), "export const run = () => {};\n");
    writeFileSync(
      join(catalog, "app.json"),
      JSON.stringify({
        version: 6,
        script: { version: "1.0.0" },
        requirements: { permissions: [], specifications: [], locations: [], ports: [30025] },
        app_values: { network: { web_port: { bind_mode: "published", port_number: "$PORT(30025)" } } },
        hooks: [{ ...hook, script: "go.ts", entrypoint: "run" }],
      }),
    );
    const result = Bun.spawnSync(["bun", join(import.meta.dir, "validate.ts")], { cwd: catalog });
    return { code: result.exitCode, output: result.stdout.toString() };
  };

  test("passes a setup hook with a summary", () => {
    const { code, output } = run(setup({ summary: "Adds your Movies folder. Run it again if the folder is missing." }));
    expect(output).toContain("0 error(s), 0 warning(s)");
    expect(code).toBe(0);
  });

  test("refuses a setup hook with none, and names the hook", () => {
    const { code, output } = run(setup());
    expect(output).toContain("hooks[0]: a hook that runs at an install or an upgrade and from its app's card needs a summary");
    expect(code).toBe(1);
  });

  test("refuses a summary that isn't text", () => {
    const { code, output } = run(setup({ summary: 3 }));
    expect(output).toContain("hooks[0]: summary must be text");
    expect(code).toBe(1);
  });
});
