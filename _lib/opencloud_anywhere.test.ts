import { afterEach, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookContext } from "./hook_context";

// Giving a file to user 568 needs root, so the ownership is checked on a real install
mock.module("node:fs", () => ({ ...require("node:fs"), chownSync: () => {} }));
const { follow, parseState, planFollow, planUseAnywhere, planUseHome, useAnywhere, useHome } = await import("../opencloud/anywhere");
const opencloud = (await import("../opencloud.json")).default as {
  requirements: Record<string, unknown>;
  hooks: Array<Record<string, unknown>>;
  installation_questions: Array<{ key: string; type: string }>;
};

// OpenCloud answers at one address only (CS-202): its Anywhere address works only once its Web
// address is that address, and then its home address stops working. So HexOS moves it only on the
// owner's click, follows only what it moved, and never writes over an address the owner typed.

const HOME = "https://10.0.0.5:30134";
const NAME = "opencloud.k7q2m9.relay.hexos.com";
const AWAY = `https://${NAME}`;
const OFFICE_HOME = "https://10.0.0.5:30461";
const OFFICE_NAME = "onlyoffice.k7q2m9.relay.hexos.com";
const OFFICE_AWAY = `https://${OFFICE_NAME}`;
const OWN = "https://cloud.owner.example";

const isSkip = (plan: object): plan is { skip: string } => "skip" in plan;

// ---- the click ----

test("T-C1/T-C2: the click moves a home install to its Anywhere address and remembers the home one", () => {
  const plan = planUseAnywhere({ appUrl: HOME }, [NAME], [], null, HOME);
  expect(isSkip(plan)).toBe(false);
  expect(plan).toMatchObject({ appUrl: AWAY, state: { url: AWAY, previousUrl: HOME } });
  expect((plan as { message: string }).message).toContain("Require sign-in");
});

test("the click with no Anywhere address asks for one first and changes nothing", () => {
  expect(planUseAnywhere({ appUrl: HOME }, [], [], null, HOME)).toEqual({ skip: expect.stringContaining("Turn on HexOS Anywhere") });
});

test("T-C3: the click leaves an owner's own address", () => {
  const plan = planUseAnywhere({ appUrl: OWN }, [NAME], [], null, HOME);
  expect(isSkip(plan) && plan.skip).toContain("address of your own");
});

test("T-C5: with an office that has an Anywhere address, both move in one change", () => {
  const plan = planUseAnywhere({ appUrl: HOME, officeUrl: OFFICE_HOME }, [NAME], [OFFICE_NAME], null, HOME);
  expect(plan).toMatchObject({
    appUrl: AWAY,
    officeUrl: OFFICE_AWAY,
    state: { url: AWAY, previousUrl: HOME, officeUrl: OFFICE_AWAY, previousOfficeUrl: OFFICE_HOME },
  });
});

test("T-C5: an office with no Anywhere address stays home, and the owner is told what to do", () => {
  const plan = planUseAnywhere({ appUrl: HOME, officeUrl: OFFICE_HOME }, [NAME], [], null, HOME, "ONLYOFFICE");
  expect(plan).not.toHaveProperty("officeUrl");
  expect((plan as { message: string }).message).toContain("Turn on HexOS Anywhere for ONLYOFFICE");
});

test("T-C16: the click leaves an owner's own office address", () => {
  const plan = planUseAnywhere({ appUrl: HOME, officeUrl: "https://office.owner.example" }, [NAME], [OFFICE_NAME], null, HOME, "ONLYOFFICE");
  expect(plan).not.toHaveProperty("officeUrl");
  expect((plan as { state: { officeUrl?: string } }).state.officeUrl).toBeUndefined();
});

test("T-C12: a name that isn't a hostname is never written", () => {
  expect(isSkip(planUseAnywhere({ appUrl: HOME }, ["bad name/evil"], [], null, HOME))).toBe(true);
  expect(planUseAnywhere({ appUrl: HOME }, ["x.example.com,https://evil.example", NAME], [], null, HOME)).toMatchObject({ appUrl: AWAY });
});

// ---- the follower ----

test("T-C1/T-C2: with no record, the follower leaves a home install alone (no silent switch)", () => {
  expect(isSkip(planFollow({ appUrl: HOME }, [NAME], [], null, HOME, null))).toBe(true);
  expect(isSkip(planFollow({ appUrl: HOME }, [], [], null, HOME, null))).toBe(true);
});

test("T-C3: with no record, the follower leaves an owner's own address alone", () => {
  expect(isSkip(planFollow({ appUrl: OWN }, [NAME], [], null, HOME, null))).toBe(true);
});

test("T-C4: an install already at its Anywhere address by hand is adopted with no change", () => {
  const plan = planFollow({ appUrl: `${AWAY}/` }, [NAME], [], null, HOME, null);
  expect(plan).toEqual({ state: { url: AWAY, previousUrl: HOME }, message: expect.any(String) });
});

test("T-C10: a rename moves the address once, and the same names change nothing", () => {
  const state = { url: AWAY, previousUrl: HOME };
  const renamed = planFollow({ appUrl: AWAY }, ["files.k7q2m9.relay.hexos.com"], [], state, HOME, null);
  expect(renamed).toMatchObject({ appUrl: "https://files.k7q2m9.relay.hexos.com", state: { url: "https://files.k7q2m9.relay.hexos.com", previousUrl: HOME } });
  expect(isSkip(planFollow({ appUrl: AWAY }, [NAME], [], state, HOME, null))).toBe(true);
});

test("T-C8: names gone, the home address and the office's come back and the record goes", () => {
  const state = { url: AWAY, previousUrl: HOME, officeUrl: OFFICE_AWAY, previousOfficeUrl: OFFICE_HOME };
  const plan = planFollow({ appUrl: AWAY, officeUrl: OFFICE_AWAY }, [], [OFFICE_NAME], state, HOME, OFFICE_HOME);
  expect(plan).toMatchObject({ appUrl: HOME, officeUrl: OFFICE_HOME, state: null });
});

test("T-C9: a Web address typed by hand since makes HexOS forget its record and change nothing", () => {
  const plan = planFollow({ appUrl: OWN }, [NAME], [], { url: AWAY, previousUrl: HOME }, HOME, null);
  expect(plan).toEqual({ state: null, message: expect.any(String) });
});

test("the follower moves the office HexOS set when the office's address goes", () => {
  const state = { url: AWAY, previousUrl: HOME, officeUrl: OFFICE_AWAY, previousOfficeUrl: OFFICE_HOME };
  const plan = planFollow({ appUrl: AWAY, officeUrl: OFFICE_AWAY }, [NAME], [], state, HOME, OFFICE_HOME);
  expect(plan).toMatchObject({ officeUrl: OFFICE_HOME, state: { url: AWAY, previousUrl: HOME } });
  expect((plan as { state: { officeUrl?: string } }).state.officeUrl).toBeUndefined();
});

// ---- the way home ----

test("T-C13: going home puts back what HexOS replaced, office too, even with the names still there (paused)", () => {
  const state = { url: AWAY, previousUrl: HOME, officeUrl: OFFICE_AWAY, previousOfficeUrl: OFFICE_HOME };
  expect(planUseHome({ appUrl: AWAY, officeUrl: OFFICE_AWAY }, [NAME], [OFFICE_NAME], state, HOME, OFFICE_HOME)).toMatchObject({
    appUrl: HOME,
    officeUrl: OFFICE_HOME,
    state: null,
  });
});

test("going home with no record moves an install set to its own Anywhere name by hand", () => {
  expect(planUseHome({ appUrl: AWAY }, [NAME], [], null, HOME, null)).toMatchObject({ appUrl: HOME, state: null });
});

test("T-C14: going home on a home install changes nothing", () => {
  expect(planUseHome({ appUrl: HOME }, [NAME], [], null, HOME, null)).toEqual({ skip: expect.stringContaining("already") });
});

test("T-C15: going home never replaces an owner's own address, with or without a record", () => {
  expect(isSkip(planUseHome({ appUrl: OWN }, [NAME], [], null, HOME, null))).toBe(true);
  expect(isSkip(planUseHome({ appUrl: OWN }, [NAME], [], { url: AWAY, previousUrl: HOME }, HOME, null))).toBe(true);
});

test("T-C16: going home leaves an owner's own office address", () => {
  const plan = planUseHome({ appUrl: AWAY, officeUrl: "https://office.owner.example" }, [NAME], [OFFICE_NAME], { url: AWAY, previousUrl: HOME }, HOME, OFFICE_HOME);
  expect(plan).not.toHaveProperty("officeUrl");
});

test("a broken record is no record", () => {
  expect(parseState("{")).toBeNull();
  expect(parseState(JSON.stringify({ url: 1 }))).toBeNull();
  expect(parseState(JSON.stringify({ url: AWAY, previousUrl: HOME, extra: "x" }))).toEqual({ url: AWAY, previousUrl: HOME });
});

// ---- on a fake box ----

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function box(values: Record<string, unknown>, names: Record<string, string[]>, options: { noUpdate?: boolean; state?: object } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "oc-anywhere-"));
  dirs.push(dir);
  if (options.state) {
    mkdirSync(join(dir, "hexos"));
    writeFileSync(join(dir, "hexos/anywhere.json"), JSON.stringify(options.state));
  }
  const live = structuredClone(values);
  const updates: unknown[] = [];
  const skipped: string[] = [];
  const ctx = {
    host: "10.0.0.5",
    port: 30134,
    mounts: [{ hostPath: "/mnt/apps/opencloud/data", containerPath: "/var/lib/opencloud", localPath: dir }],
    registerCheckpoints: async () => {},
    emitCheckpoint: async () => {},
    skipCheckpoint: async (_id: string, message?: string) => {
      if (message) skipped.push(message);
    },
    sleep: async () => {},
    fail: (message: string) => {
      throw new Error(message);
    },
    getAppValues: async () => structuredClone(live),
    readRemoteAddresses: async (appId?: string) => ({ names: names[appId ?? "opencloud"] ?? [] }),
    getInstalledAppUrl: async () => "http://10.0.0.5:30461",
    ...(options.noUpdate
      ? {}
      : {
          updateAppValues: async (change: (v: Record<string, unknown>) => void) => {
            const before = JSON.stringify(live);
            change(live);
            updates.push(structuredClone(live));
            return JSON.stringify(live) !== before;
          },
        }),
  } as unknown as HookContext;
  const statePath = join(dir, "hexos/anywhere.json");
  return { ctx, live, updates, skipped, state: () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf-8")) : null) };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const upAlways = () => {
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
};

test("on a box: click, rename, then turn off, with ONLYOFFICE linked, each in one update", async () => {
  upAlways();
  const values = { opencloud: { app_url: HOME, collaboration: { enabled: true, type: "onlyoffice", url: `${OFFICE_HOME}/`, jwt_secret: "s" } } };
  const b = box(values, { opencloud: [NAME], "onlyoffice-document-server": [OFFICE_NAME] });
  await useAnywhere(b.ctx);
  expect(b.updates).toHaveLength(1);
  expect(b.live.opencloud).toMatchObject({ app_url: AWAY, collaboration: { enabled: true, type: "onlyoffice", url: OFFICE_AWAY, jwt_secret: "s" } });
  expect(b.state()).toEqual({ url: AWAY, previousUrl: HOME, officeUrl: OFFICE_AWAY, previousOfficeUrl: `${OFFICE_HOME}/` });

  // Same names again: nothing changes, no restart
  await follow(b.ctx);
  expect(b.updates).toHaveLength(1);
});

test("on a box: the follower never touches a home install with Anywhere on (boxes today)", async () => {
  upAlways();
  const b = box({ opencloud: { app_url: HOME, collaboration: { enabled: false } } }, { opencloud: [NAME] });
  await follow(b.ctx);
  expect(b.updates).toHaveLength(0);
  expect(b.state()).toBeNull();
});

test("on a box: going home after a pause restores both addresses and removes the note", async () => {
  upAlways();
  const values = { opencloud: { app_url: AWAY, collaboration: { enabled: true, type: "onlyoffice", url: OFFICE_AWAY } } };
  const b = box(values, { opencloud: [NAME], "onlyoffice-document-server": [OFFICE_NAME] }, {
    state: { url: AWAY, previousUrl: HOME, officeUrl: OFFICE_AWAY, previousOfficeUrl: OFFICE_HOME },
  });
  await useHome(b.ctx);
  expect(b.live.opencloud).toMatchObject({ app_url: HOME, collaboration: { url: OFFICE_HOME } });
  expect(b.state()).toBeNull();
});

test("a note that can't be saved stops the run before OpenCloud changes", async () => {
  upAlways();
  const b = box({ opencloud: { app_url: HOME } }, { opencloud: [NAME] });
  // A file where the note's folder should be makes the save fail
  writeFileSync(join((b.ctx.mounts[0] as { localPath: string }).localPath, "hexos"), "not a folder");
  await expect(useAnywhere(b.ctx)).rejects.toThrow("left as it was");
  expect(b.updates).toHaveLength(0);
  expect((b.live.opencloud as { app_url: string }).app_url).toBe(HOME);
});

test("an update that fails puts the note back as it was", async () => {
  upAlways();
  const b = box({ opencloud: { app_url: HOME } }, { opencloud: [NAME] });
  (b.ctx as unknown as { updateAppValues: () => Promise<boolean> }).updateAppValues = async () => {
    throw new Error("app.update failed");
  };
  await expect(useAnywhere(b.ctx)).rejects.toThrow("app.update failed");
  expect(b.state()).toBeNull();
});

test("T-C7: a box without the newer hook methods fails cleanly and writes nothing", async () => {
  const b = box({ opencloud: { app_url: HOME } }, { opencloud: [NAME] }, { noUpdate: true });
  await expect(useAnywhere(b.ctx)).rejects.toThrow("needs an update");
  expect(b.state()).toBeNull();
});

// ---- the script ----

test("T-C11: three hooks of their own; only the follower reruns on the address, and none rides on it", () => {
  const byId = new Map(opencloud.hooks.map((hook) => [hook.id, hook]));
  for (const id of ["use-anywhere-address", "anywhere-address", "use-home-address"]) {
    expect(byId.get(id)).toMatchObject({ events: ["userAction"], rerun: "converge", script: "opencloud/anywhere.ts" });
  }
  expect(byId.get("anywhere-address")?.rerunsOn).toEqual(["remote-address"]);
  expect(byId.get("use-anywhere-address")?.rerunsOn).toBeUndefined();
  expect(byId.get("use-home-address")?.rerunsOn).toBeUndefined();
  for (const hook of opencloud.hooks) expect((hook.requiresHooks as string[] | undefined) ?? []).not.toContain("anywhere-address");
});

test("one_address names the Web address question", () => {
  expect(opencloud.requirements.one_address).toBe("address");
  expect(opencloud.installation_questions.find((q) => q.key === "address")?.type).toBe("text");
});
