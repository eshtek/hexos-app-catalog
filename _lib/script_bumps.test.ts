import { describe, expect, test } from "bun:test";
import { bumpProblem, droppedFolders, unanswerableQuestions, updateProblems, versionRaised } from "./script_bumps";

const kodi = (tag: string, version: string, extra: Record<string, unknown> = {}) => ({
  version: 6,
  custom: true,
  metadata: { name: "Kodi", version: "21.2" },
  script: { version, changeLog: "Kodi on the TV." },
  app_values: { image: { repository: "eshtek/kodi", tag } },
  ...extra,
});

describe("bumpProblem", () => {
  test("a new image under the same script.version is refused", () => {
    expect(bumpProblem(kodi("21.2-1", "1.0.0"), kodi("21.2-2", "1.0.0"))).toContain("raise it (to 1.0.1 or later)");
  });

  test("a new image with a raised script.version ships", () => {
    expect(bumpProblem(kodi("21.2-1", "1.0.0"), kodi("21.2-2", "1.0.1"))).toBeNull();
    expect(bumpProblem(kodi("21.2-1", "1.0.9"), kodi("21.2-2", "1.1.0"))).toBeNull();
  });

  test("a lower script.version is refused too", () => {
    expect(bumpProblem(kodi("21.2-1", "1.0.2"), kodi("21.2-2", "1.0.1"))).not.toBeNull();
  });

  test("the catalog card, the change log and internal change nothing a server runs", () => {
    const after = kodi("21.2-1", "1.0.0", { internal: true });
    after.metadata.version = "21.3";
    after.script.changeLog = "Better words.";
    expect(bumpProblem(kodi("21.2-1", "1.0.0"), after)).toBeNull();
  });

  test("a change in layout alone is no change", () => {
    const { app_values: _values, ...rest } = kodi("21.2-1", "1.0.0");
    const reordered = { app_values: { image: { tag: "21.2-1", repository: "eshtek/kodi" } }, ...rest };
    expect(Object.keys(reordered)[0]).toBe("app_values");
    expect(bumpProblem(kodi("21.2-1", "1.0.0"), reordered)).toBeNull();
  });

  test("a TrueNAS catalog app is left alone: the deck offers its script updates to no one", () => {
    const plex = (port: number) => ({ script: { version: "1.0.0" }, app_values: { network: { web_port: port } } });
    expect(bumpProblem(plex(32400), plex(32401))).toBeNull();
  });
});

describe("versionRaised", () => {
  test("compares each number", () => {
    expect(versionRaised("1.0.10", "1.0.9")).toBe(true);
    expect(versionRaised("2.0.0", "1.9.9")).toBe(true);
    expect(versionRaised("1.0.0", "1.0.0")).toBe(false);
  });
});

describe("what an update can carry", () => {
  const question = (key: string, extra: Record<string, unknown> = {}) => ({ question: key, type: "text", key, required: true, ...extra });
  const valheim = (questions: unknown[], storage: unknown[], version = "1.0.0") => ({
    custom: true,
    script: { version },
    installation_questions: questions,
    app_values: { image: { repository: "example/valheim", tag: "1.4.1" }, storage },
  });
  const config = { type: "host_path", mount_path: "/config", host_path_config: { path: "$LOCATION(ApplicationsPerformance)/valheim/config" } };

  test("a new required question with no default is one no installed server can answer", () => {
    const base = valheim([question("server_name")], [config]);
    expect(unanswerableQuestions(base, valheim([question("server_name"), question("admin_ids")], [config]))).toEqual(["admin_ids"]);
    expect(unanswerableQuestions(base, valheim([question("server_name"), question("admin_ids", { default: "" })], [config]))).toEqual(["admin_ids"]);
  });

  test("a default, an optional question, or one the servers already answered is fine", () => {
    const base = valheim([question("server_name")], [config]);
    const head = valheim(
      [question("server_name"), question("world_seed", { default: "random" }), question("mods", { required: false })],
      [config],
    );
    expect(unanswerableQuestions(base, head)).toEqual([]);
  });

  test("a folder no longer mounted is named, and one moved to a new mount_path isn't", () => {
    const base = valheim([], [config, { type: "ix_volume", mount_path: "/cache", ix_volume_config: { dataset_name: "cache" } }]);
    expect(droppedFolders(base, valheim([], [{ ...config, mount_path: "/data" }]))).toEqual(["ix volume cache"]);
    const moved = { ...config, host_path_config: { path: "$LOCATION(ApplicationsPerformance)/valheim/data" } };
    expect(droppedFolders(base, valheim([], [moved]))).toEqual(["$LOCATION(ApplicationsPerformance)/valheim/config", "ix volume cache"]);
  });

  test("a folder behind an ACL counts as mounted", () => {
    const acl = { type: "host_path", mount_path: "/config", host_path_config: { acl_enable: true, acl: { path: "/mnt/a/config" } } };
    expect(droppedFolders(valheim([], [acl]), valheim([], [acl]))).toEqual([]);
    expect(droppedFolders(valheim([], [acl]), valheim([], []))).toEqual(["/mnt/a/config"]);
  });

  test("every reason is listed, and a TrueNAS catalog app has none", () => {
    const base = valheim([question("server_name")], [config]);
    const head = valheim([question("server_name"), question("admin_ids")], [], "1.0.1");
    expect(updateProblems(base, head)).toHaveLength(2);
    expect(updateProblems({ ...base, custom: undefined }, { ...head, custom: undefined })).toEqual([]);
  });
});
