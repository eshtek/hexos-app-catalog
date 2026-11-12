import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookContext } from "./hook_context";

// seed-sign-in, before an app's first start. It writes the app's first settings only when there are
// none, and leaves a note that the app is new (hexos/fresh.json). The links that take out the
// profiles a manager starts with remove nothing from a manager without that note, so an app whose
// settings were there before must never get one.

const real = { ...fs };
/** Owner changes need root, so the test only records them. */
const owned: string[] = [];
mock.module("node:fs", () => ({
  ...real,
  chownSync: (path: string) => {
    owned.push(path);
  },
}));
const { seed } = await import("../servarr/configure");
afterAll(() => {
  mock.module("node:fs", () => real);
});

let root: string;
beforeEach(() => {
  root = real.mkdtempSync(join(tmpdir(), "servarr-seed-"));
  owned.length = 0;
});

function fakes(appId: string, options: { settings?: string; runsAs?: string } = {}) {
  const runsAs = options.runsAs ?? appId;
  const config = join(root, runsAs, "config");
  real.mkdirSync(config, { recursive: true });
  if (options.settings) real.writeFileSync(join(config, "config.xml"), options.settings);
  const steps: Array<{ id: string; message?: string; skipped?: boolean }> = [];
  const ctx = {
    resourceId: runsAs,
    catalogAppId: appId,
    baseUrl: "http://10.0.0.5:30025",
    mounts: [{ containerPath: "/config", hostPath: `/mnt/pool/apps/${runsAs}/config`, localPath: config }],
    signIn: { username: "owner", password: "a-long-password" },
    registerCheckpoints: async () => {},
    emitCheckpoint: async (id: string, message?: string) => {
      steps.push({ id, message });
    },
    skipCheckpoint: async (id: string, message?: string) => {
      steps.push({ id, message, skipped: true });
    },
    log: () => {},
    fail: (message: string) => {
      throw new Error(message);
    },
  } as unknown as HookContext;
  return {
    ctx,
    steps,
    settings: () => real.readFileSync(join(config, "config.xml"), "utf-8"),
    notedFresh: () => real.existsSync(join(config, "hexos", "fresh.json")),
  };
}

for (const appId of ["radarr", "sonarr"]) {
  test(`a ${appId} with no settings gets its first ones, and a note that it is new`, async () => {
    const run = fakes(appId);
    await seed(run.ctx);
    expect(run.settings()).toContain("<Username>owner</Username>");
    expect(run.notedFresh()).toBe(true);
    expect(owned).toEqual([join(root, appId, "config", "config.xml")]);
    expect(run.steps).toEqual([{ id: "signIn", message: undefined }]);
  });

  test(`a ${appId} whose settings were there before keeps them, and is never noted as new`, async () => {
    const before = "<Config><ApiKey>the-owners-key</ApiKey></Config>";
    const run = fakes(appId, { settings: before });
    await seed(run.ctx);
    expect(run.settings()).toBe(before);
    expect(run.notedFresh()).toBe(false);
    expect(run.steps).toEqual([{ id: "signIn", message: `${appId === "radarr" ? "Radarr" : "Sonarr"} keeps its settings from before`, skipped: true }]);
  });
}

test("a later copy's note is left in its own folder", async () => {
  const run = fakes("radarr", { runsAs: "radarr-2" });
  await seed(run.ctx);
  expect(run.notedFresh()).toBe(true);
  expect(real.existsSync(join(root, "radarr", "config", "hexos", "fresh.json"))).toBe(false);
});
