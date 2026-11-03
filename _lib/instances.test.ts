import { describe, expect, test } from "bun:test";
import { asFirstCopy, instanceChangeProblems, instanceRules, linkCopyRules } from "./instances";

const script = (requirements: Record<string, unknown>, folders: string[], port: unknown = "$PORT(30100)") => ({
  requirements: { ports: [30100], ...requirements },
  ensure_directories_exists: [{ path: "$LOCATION(Media)" }, ...folders.map((path) => ({ path }))],
  app_values: { network: { web_port: { bind_mode: "published", port_number: port } } },
});
const messages = (id: string, s: ReturnType<typeof script>) => instanceRules(id, s).map((f) => f.message);

describe("instanceRules", () => {
  test("a script that doesn't allow copies is left alone", () => {
    expect(instanceRules("a", script({}, ["$LOCATION(Media)/a"], 30100))).toEqual([]);
  });

  test("every private folder has to follow the copy", () => {
    expect(messages("a", script({ instances: "many" }, ["$LOCATION(Media)/a/config"]))).toEqual([
      "$LOCATION(Media)/a/config doesn't follow the copy: write it with $INSTANCE, or list it in requirements.shared_folders",
    ]);
    expect(messages("a", script({ instances: "many" }, ["$LOCATION(Media)/$INSTANCE(a)/config"]))).toEqual([]);
  });

  test("a folder listed as shared, or inside one, may stay", () => {
    const shared = { instances: "many", shared_folders: ["$LOCATION(Media)/Movies"] };
    expect(messages("a", script(shared, ["$LOCATION(Media)/Movies/x"]))).toEqual([]);
  });

  test("a folder in app_values counts too", () => {
    const s = script({ instances: "many" }, []);
    (s.app_values as Record<string, unknown>).storage = { data: "$HOST_PATH($LOCATION(Media)/a/data)" };
    expect(messages("a", s)).toHaveLength(1);
  });

  test("a fixed port can't be run twice", () => {
    expect(messages("a", script({ instances: "many" }, [], 30100))[0]).toContain("is a fixed port");
  });

  test("the key takes one value, and a list of folders", () => {
    expect(messages("a", script({ instances: "two" }, []))).toEqual(['requirements.instances: "two" must be "many"']);
    expect(messages("a", script({ shared_folders: "x" }, []))).toHaveLength(1);
  });

  test("an id too long to number is refused", () => {
    expect(messages("a".repeat(37), script({ instances: "many" }, []))).toHaveLength(1);
  });
});

describe("instanceChangeProblems", () => {
  const plain = script({}, ["$LOCATION(Media)/a/config"]);
  const macro = script({ instances: "many" }, ["$LOCATION(Media)/$INSTANCE(a)/config"]);

  test("writing the macro over the folder it names changes nothing", () => {
    expect(instanceChangeProblems(plain, macro)).toEqual([]);
    expect(asFirstCopy("$LOCATION(Media)/$INSTANCE(a)/config")).toBe("$LOCATION(Media)/a/config");
  });

  test("the macro can't name another folder", () => {
    const other = script({ instances: "many" }, ["$LOCATION(Media)/$INSTANCE(b)/config"]);
    expect(instanceChangeProblems(plain, other)).toEqual([
      "$LOCATION(Media)/$INSTANCE(b)/config changes the folder $INSTANCE names; it has to be the one installed apps have",
    ]);
  });

  test("dropping the macro is refused, on any script", () => {
    expect(instanceChangeProblems(macro, plain)[0]).toContain("no longer follows the copy");
  });

  test("taking the key off alone is the rollback, and is fine", () => {
    const rolledBack = script({}, ["$LOCATION(Media)/$INSTANCE(a)/config"]);
    expect(instanceChangeProblems(macro, rolledBack)).toEqual([]);
  });

  test("a new script has nothing to keep", () => {
    expect(instanceChangeProblems({}, macro)).toEqual([]);
  });
});

describe("linkCopyRules", () => {
  const hook = (extra: Record<string, unknown> = {}) => ({
    id: "connect-sonarr",
    conditions: [
      { role: "visibility", type: "appInstalled", app: "sonarr" },
      { role: "availability", type: "appRunning", app: "prowlarr" },
    ],
    ...extra,
  });
  const copies = (app: string) => app === "sonarr";

  test("a link to an app with copies has to say how it treats them", () => {
    expect(linkCopyRules("prowlarr", { hooks: [hook()] }, copies).map((f) => f.message)).toEqual([
      'hook "connect-sonarr" names sonarr, which runs in copies: say how it treats them with "copies"',
    ]);
    expect(linkCopyRules("prowlarr", { hooks: [hook({ copies: "each" })] }, copies)).toEqual([]);
    expect(linkCopyRules("prowlarr", { hooks: [hook({ copies: "one" })] }, copies)).toEqual([]);
  });

  test("an app's own hooks and links to other apps are left alone", () => {
    expect(linkCopyRules("sonarr", { hooks: [hook()] }, copies)).toEqual([]);
    expect(linkCopyRules("prowlarr", { hooks: [hook()] }, () => false)).toEqual([]);
  });
});
