import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookSummaryProblems, linkRowProblems, needsSummary } from "./hook_summary";

// An app's own actions (Pre-configure, Jellyfin's transcoding) have rows on its Customize tab. A
// row shows the hook's summary while nothing runs, and without one it shows the description, which
// for these is the label of an install step ("Setting up Radarr"). These hold that every such hook
// says what it does, and what the validator refuses. They also hold what a script tells its owner
// to the same rule as a summary: no tab is named for one of these actions.

type Hook = Record<string, any>;

const root = join(import.meta.dir, "..");
const scripts = readdirSync(root)
  .filter((file) => file.endsWith(".json"))
  .map((file) => ({ app: file.replace(/\.json$/, ""), script: JSON.parse(readFileSync(join(root, file), "utf8")) as Record<string, any> }));
const hooks = scripts.flatMap(({ app, script }) =>
  script.version === 6 && Array.isArray(script.hooks) ? (script.hooks as Hook[]).map((hook) => ({ app, hook })) : [],
);
const named = (list: Array<{ app: string; hook: Hook }>) => list.map(({ app, hook }) => `${app} ${hook.id}`);
const sentencesOf = (summary: unknown) => String(summary).split(/(?<=\.)\s+/);
/** The row's line sits in a narrow column beside its button, so a long one runs to five lines on a phone. */
const LONGEST_SUMMARY = 150;

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

  test("a summary is one to three whole sentences, and never the step's label again", () => {
    const summarised = hooks.filter(({ hook }) => hook.summary !== undefined);
    const wrong = summarised.filter(({ hook }) => {
      const summary = String(hook.summary);
      return !summary.endsWith(".") || summary.includes("\u2014") || summary === hook.description || sentencesOf(summary).length > 3;
    });
    expect(named(wrong)).toEqual([]);
  });

  test(`a summary is no longer than ${LONGEST_SUMMARY} characters`, () => {
    const summarised = hooks.filter(({ hook }) => hook.summary !== undefined);
    expect(named(summarised.filter(({ hook }) => String(hook.summary).length > LONGEST_SUMMARY))).toEqual([]);
  });

  test("a summary gives each thought a sentence of its own, with no semicolon to join two", () => {
    const summarised = hooks.filter(({ hook }) => hook.summary !== undefined);
    expect(named(summarised.filter(({ hook }) => String(hook.summary).includes(";")))).toEqual([]);
  });

  test("a summary names no tab, since the row moved from Connections to Customize and an older deck still draws it there", () => {
    const summarised = hooks.filter(({ hook }) => hook.summary !== undefined);
    expect(named(summarised.filter(({ hook }) => /\b(Connections|Customize)\b/.test(String(hook.summary))))).toEqual([]);
  });

  test("the hook Jellyfin names for its graphics card says it also limits streams from outside the network", () => {
    const jellyfin = scripts.find(({ app }) => app === "jellyfin")?.script;
    const hook = (jellyfin?.hooks as Hook[]).find((each) => each.id === jellyfin?.requirements.gpu_hook);
    expect(hook?.summary).toContain("graphics card");
    expect(sentencesOf(hook?.summary)).toContainEqual(expect.stringMatching(/^Also limits streams from outside your network to 20 Mbps\b/));
    // Its title is its install step's label, which a description would replace
    expect(hook?.description).toBeUndefined();
  });

  test("that hook's summary reads true on a server with no card Jellyfin could use, where it is its row's line", () => {
    const jellyfin = scripts.find(({ app }) => app === "jellyfin")?.script;
    const hook = (jellyfin?.hooks as Hook[]).find((each) => each.id === jellyfin?.requirements.gpu_hook);
    expect(sentencesOf(hook?.summary)[0]).toBe("Sets Jellyfin's video settings for its graphics card, or for none.");
    // A card it would match or test is one the server may not have
    expect(hook?.summary).not.toMatch(/\b(match|test)\b/);
  });

  test.each(["emby", "plex"])("Pre-configure %s says it limits streams from outside the network too, in a sentence of its own", (app) => {
    const script = scripts.find((each) => each.app === app)?.script;
    const summary = (script?.hooks as Hook[]).find((each) => each.id === `configure-${app}`)?.summary;
    expect(sentencesOf(summary)).toContain("Also limits streams from outside your network to 20 Mbps.");
  });
});

// A failed run's message is read in a deck that draws an app's own actions on Customize, and in an
// older one that draws them on Connections. So a message names a tab only for a link, which both
// draw on Connections: "connect Tautulli from Plex's Connections tab".
describe("what a script tells its owner", () => {
  const scriptLines = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_") && !entry.name.startsWith(".") && entry.name !== "node_modules")
    .flatMap((dir) =>
      readdirSync(join(root, dir.name))
        .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
        .flatMap((file) =>
          readFileSync(join(root, dir.name, file), "utf8")
            .split("\n")
            .map((text, index) => ({ at: `${dir.name}/${file}:${index + 1}`, text: text.trim() })),
        ),
    )
    // What a script says to its owner, not what a comment says to its reader
    .filter(({ text }) => !text.startsWith("*") && !text.startsWith("/*") && !text.startsWith("//"));
  const name = "(\\$\\{[^}]+\\}|[A-Z][\\w-]*)";
  const aLink = new RegExp(
    `(connect ${name}|Run Connect to ${name}|can't add ${name} to it\\. Run this again) from ${name}'s Connections tab`,
  );

  test("reads every app's scripts", () => {
    expect(scriptLines.length).toBeGreaterThan(1000);
    expect(scriptLines.some(({ text }) => text.includes("Connections tab"))).toBe(true);
  });

  test("names the Connections tab only for a link to another app", () => {
    const tabbed = scriptLines.filter(({ text }) => text.includes("Connections tab"));
    expect(tabbed.filter(({ text }) => !aLink.test(text)).map(({ at }) => at)).toEqual([]);
  });

  test("never sends its owner to the Customize tab, which an older deck doesn't use for these", () => {
    expect(scriptLines.filter(({ text }) => text.includes("Customize tab")).map(({ at }) => at)).toEqual([]);
  });

  test.each([
    ["a setup action sent to a tab", "ctx.fail(\"Run Pre-configure Jellyfin from its Connections tab to choose one.\");", false],
    ["a model chosen on a tab", "ctx.fail(\"Ollama has no model yet. Choose one on its Connections tab, then run this again.\");", false],
    ["a setup action run again from a tab", "ctx.fail(\"Run this again from Profilarr's Connections tab.\");", false],
    ["a link named after a setup action", "const message = \"Run Pre-configure Plex, then connect Tautulli from Plex's Connections tab.\";", true],
    ["a link named by its title", "ctx.fail(`Run Connect to ${name} from Profilarr's Connections tab to send them again.`);", true],
  ])("the rule reads %s rightly", (_name, line, allowed) => expect(aLink.test(line)).toBe(allowed));
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

describe("a link that would be drawn as one of its app's own setup actions", () => {
  const link = (over: object = {}) => ({
    id: "check-other",
    title: "Check Other and App",
    kind: "maintain",
    conditions: [
      { role: "visibility", type: "appInstalled", app: "other" },
      { role: "availability", type: "appRunning", app: "app" },
    ],
    ...over,
  });

  test.each<[string, Hook, boolean]>([
    ["one off the install picker with no kind connect", link({ surfaces: ["card"] }), true],
    ["one on the card and a widget only", link({ surfaces: ["card", "widget"] }), true],
    ["one with the default surfaces, which the install offers as a link", link(), false],
    ["one that keeps the install picker", link({ surfaces: ["installPicker", "card"] }), false],
    ["one that says kind connect", link({ kind: "connect", surfaces: ["card"] }), false],
    ["one with no row on the card", link({ surfaces: ["settings"] }), false],
    ["a hook whose conditions name only its own app", link({ surfaces: ["card"], conditions: [{ role: "availability", type: "appRunning", app: "app" }] }), false],
    ["a hook with no conditions", link({ surfaces: ["card"], conditions: undefined }), false],
  ])("%s", (_name, hook, refused) => expect(linkRowProblems(hook, "app").length > 0).toBe(refused));

  test("is none of the catalog's hooks", () => {
    expect(named(hooks.filter(({ app, hook }) => linkRowProblems(hook, app).length > 0))).toEqual([]);
  });
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

  test("refuses a link narrowed to the card that doesn't say it is a connection", () => {
    const { code, output } = run({
      id: "check-other",
      title: "Check Other and App",
      events: ["userAction"],
      surfaces: ["card"],
      conditions: [{ role: "visibility", type: "appInstalled", app: "other" }],
    });
    expect(output).toContain('hooks[0]: a hook that names another app in conditions and leaves "installPicker" out of surfaces needs "kind": "connect"');
    expect(code).toBe(1);
  });
});
