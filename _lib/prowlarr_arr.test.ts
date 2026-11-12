import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookContext } from "./hook_context";
import { radarr } from "../prowlarr/connect_arr";

// Prowlarr's link to Radarr, against fakes of Prowlarr's application API and two copies of Radarr on
// the box. Prowlarr names each application once, whatever its case, shows the key it holds as
// ********, and tests an application sent by id with the key it holds (ProviderControllerBase,
// SchemaBuilder). Its test has Radarr check the key and reach Prowlarr back. Run again after the box's
// address or Radarr's port changed, the link moves Prowlarr's application to this Radarr with proof
// its saved key is this Radarr's, or with the owner's yes once nothing answers at its address; never
// one that may be another Radarr the owner chose, and never by adding a second under the same name.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const BOX = "10.0.0.5";
const OLD_BOX = "10.0.0.30";
const MASK = "********";
const PROWLARR = { url: `http://${BOX}:30050`, key: "prowlarr-key" };
/** The box's copies of Radarr. Each install makes its own key. */
const COPIES: Record<string, { url: string; key: string; displayName: string }> = {
  radarr: { url: `http://${BOX}:30025`, key: "radarr-key", displayName: "Radarr" },
  "radarr-2": { url: `http://${BOX}:30125`, key: "radarr-2-key", displayName: "Radarr 2" },
};
const FIELDS = ["prowlarrUrl", "baseUrl", "apiKey", "syncCategories"];

interface Field {
  name: string;
  value?: unknown;
}

interface Application {
  id: number;
  name: string;
  implementation: string;
  syncLevel: string;
  fields: Field[];
}

/** An application as Prowlarr holds it: plain values by field name. */
interface Stored {
  id: number;
  name: string;
  implementation: string;
  syncLevel: string;
  values: Record<string, unknown>;
}

interface Options {
  entries?: Stored[];
  /** The copy this run links; the first when unset. */
  copy?: string;
  /** Addresses ("host:port") where something answers besides this box's apps. */
  live?: string[];
  /** The owner's answer when asked, "skip" to skip the question, "none" for a box that can't ask. */
  owner?: boolean | "skip" | "none";
  /** Which app isn't up yet. */
  down?: "prowlarr" | "radarr";
  /** Applications Prowlarr has but leaves out of its list, as one added while the link runs would be. */
  unlisted?: Stored[];
}

class Skipped extends Error {}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "prowlarr-arr-"));
});

function configDir(name: string, key: string) {
  const path = join(root, name, "config");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "config.xml"), `<Config><ApiKey>${key}</ApiKey></Config>`);
  return path;
}

function fakes(options: Options = {}) {
  const copy = options.copy ?? "radarr";
  const stored = new Map<number, Stored>();
  for (const entry of [...(options.entries ?? []), ...(options.unlisted ?? [])]) stored.set(entry.id, structuredClone(entry));
  const unlisted = new Set((options.unlisted ?? []).map((entry) => entry.id));
  let nextId = Math.max(0, ...stored.keys()) + 1;
  const questions: string[] = [];
  const checkpoints: Array<{ id: string; message?: string }> = [];
  const live = new Set(options.live ?? []);

  const masked = (entry: Stored): Application => ({
    id: entry.id,
    name: entry.name,
    implementation: entry.implementation,
    syncLevel: entry.syncLevel,
    fields: FIELDS.map((name) => ({ name, value: name === "apiKey" && entry.values.apiKey ? MASK : entry.values[name] })),
  });
  const resolve = (body: Application, known: Stored | undefined): Record<string, unknown> =>
    Object.fromEntries(body.fields.map((field) => [field.name, field.name === "apiKey" && field.value === MASK && known ? known.values.apiKey : field.value]));
  // Radarr checks the key, then reaches Prowlarr back at the address it's given
  const failure = (values: Record<string, unknown>): string | undefined => {
    const target = Object.values(COPIES).find((each) => each.url === values.baseUrl);
    if (!target || options.down === "radarr") return "Unable to complete application test, cannot connect to Radarr.";
    if (values.apiKey !== target.key) return "API Key is invalid";
    if (values.prowlarrUrl !== PROWLARR.url) return "Prowlarr URL is invalid, Radarr cannot connect to Prowlarr";
    return undefined;
  };
  const refuse = (errorMessage: string, propertyName = "") => Response.json([{ propertyName, errorMessage }], { status: 400 });
  const clash = (name: string, id?: number) => [...stored.values()].some((entry) => entry.name.toLowerCase() === name.toLowerCase() && entry.id !== id);

  const prowlarr = (url: URL, method: string, body: Application) => {
    const path = url.pathname.replace("/api/v1", "");
    if (path === "/applications" && method === "GET") return Response.json([...stored.values()].filter((e) => !unlisted.has(e.id)).map(masked));
    if (path === "/applications/schema") {
      return Response.json(
        ["Radarr", "Sonarr", "Lidarr", "Readarr"].map((implementation) => ({
          name: "",
          implementation,
          syncLevel: "addOnly",
          fields: FIELDS.map((name) => ({ name, value: name === "syncCategories" ? [2000] : "" })),
        })),
      );
    }
    if (path === "/applications/test") {
      const reason = failure(resolve(body, body.id ? stored.get(body.id) : undefined));
      return reason ? refuse(reason) : Response.json({});
    }
    const match = path.match(/^\/applications\/(\d+)$/);
    const known = match ? stored.get(Number(match[1])) : undefined;
    if ((path === "/applications" && method === "POST") || (known && method === "PUT")) {
      if (clash(body.name, known?.id)) return refuse("Should be unique", "Name");
      const values = resolve(body, known);
      if (body.syncLevel !== "disabled") {
        const reason = failure(values);
        if (reason) return refuse(reason);
      }
      const id = known?.id ?? nextId++;
      stored.set(id, { id, name: body.name, implementation: body.implementation, syncLevel: body.syncLevel, values });
      return Response.json({ ...body, id }, { status: known ? 202 : 201 });
    }
    throw new Error(`Unexpected Prowlarr request: ${method} ${url.pathname}`);
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    if (url.origin === PROWLARR.url) {
      if (options.down === "prowlarr") throw new TypeError("fetch failed");
      if (url.pathname === "/ping") return Response.json({ status: "OK" });
      if (new Headers(init?.headers).get("X-Api-Key") !== PROWLARR.key) return new Response(null, { status: 401 });
      return prowlarr(url, method, init?.body ? JSON.parse(String(init.body)) : undefined);
    }
    const copy = Object.values(COPIES).find((each) => each.url === url.origin);
    if (copy && options.down !== "radarr") return Response.json({ status: "OK" });
    if (!copy && live.has(url.host)) return new Response("a web page");
    throw new TypeError("fetch failed");
  }) as typeof fetch;

  const ctx = {
    resourceId: "prowlarr",
    baseUrl: PROWLARR.url,
    mounts: [{ containerPath: "/config", hostPath: "/mnt/pool/apps/prowlarr/config", localPath: configDir("prowlarr", PROWLARR.key) }],
    linkedApp: (app: string) => (app === "radarr" ? { name: copy, displayName: COPIES[copy].displayName } : null),
    getInstalledAppUrl: async (app: string) => (app === "radarr" ? COPIES[copy].url : null),
    getInstalledAppMounts: async () => [{ containerPath: "/config", hostPath: `/mnt/pool/apps/${copy}/config`, localPath: configDir(copy, COPIES[copy].key) }],
    registerCheckpoints: async () => {},
    emitCheckpoint: async (id: string, message?: string) => {
      checkpoints.push({ id, message });
    },
    ...(options.owner === "none"
      ? {}
      : {
          askForInputs: async (_inputs: unknown, prompt?: { description?: string }) => {
            questions.push(prompt?.description ?? "");
            if (options.owner === undefined || options.owner === "skip") {
              const error = new Error("unanswered");
              error.name = "HookInputsUnanswered";
              throw error;
            }
            return { switch: options.owner };
          },
        }),
    sleep: async () => {},
    log: () => {},
    fail: (message: string) => {
      throw new Error(message);
    },
    skip: (message: string) => {
      throw new Skipped(message);
    },
  } as unknown as HookContext;
  return { ctx, entries: () => [...stored.values()], questions, checkpoints };
}

/** An application HexOS made for a copy, at the address it had then. */
function made(copy: string, values: Record<string, unknown> = {}, rest: Partial<Stored> = {}): Stored {
  return {
    id: 3,
    name: COPIES[copy].displayName,
    implementation: "Radarr",
    syncLevel: "fullSync",
    values: { prowlarrUrl: `http://${OLD_BOX}:30050`, baseUrl: `http://${OLD_BOX}:${new URL(COPIES[copy].url).port}`, apiKey: COPIES[copy].key, syncCategories: [2000], ...values },
    ...rest,
  };
}

test("a Radarr Prowlarr doesn't have yet is added with full sync", async () => {
  const { ctx, entries } = fakes();
  await radarr(ctx);
  expect(entries()).toEqual([
    { id: 1, name: "Radarr", implementation: "Radarr", syncLevel: "fullSync", values: { prowlarrUrl: PROWLARR.url, baseUrl: COPIES.radarr.url, apiKey: "radarr-key", syncCategories: [2000] } },
  ]);
});

test("an application at this Radarr's address keeps the sync level and categories the owner chose", async () => {
  const before = made("radarr", { prowlarrUrl: PROWLARR.url, baseUrl: COPIES.radarr.url, syncCategories: [2000, 2040] }, { syncLevel: "addOnly" });
  const { ctx, entries, questions } = fakes({ entries: [before] });
  await radarr(ctx);
  expect(entries()).toEqual([{ ...before, values: { ...before.values } }]);
  expect(questions).toHaveLength(0);
});

for (const [label, values] of [
  ["the box's address changed", {}],
  ["Radarr's port changed", { prowlarrUrl: PROWLARR.url, baseUrl: `http://${BOX}:30026` }],
] as const) {
  test(`an application with this Radarr's own key moves here without a question (${label})`, async () => {
    const before = made("radarr", values, { syncLevel: "addOnly" });
    const { ctx, entries, questions, checkpoints } = fakes({ entries: [before], owner: false });
    await radarr(ctx);
    expect(questions).toHaveLength(0);
    expect(entries()).toEqual([{ ...before, values: { ...before.values, prowlarrUrl: PROWLARR.url, baseUrl: COPIES.radarr.url } }]);
    expect(checkpoints.at(-1)).toEqual({ id: "configure", message: "Prowlarr reaches Radarr at its new address" });
  });
}

test("a name matches whatever its case, as Prowlarr's own check does", async () => {
  const before = made("radarr", {}, { name: "RADARR" });
  const { ctx, entries } = fakes({ entries: [before] });
  await radarr(ctx);
  expect(entries()).toHaveLength(1);
  expect(entries()[0]).toMatchObject({ id: 3, name: "RADARR", values: { baseUrl: COPIES.radarr.url } });
});

test("a later copy's application moves to that copy by its own key, and the first copy's is untouched", async () => {
  const first = { ...made("radarr", { prowlarrUrl: PROWLARR.url, baseUrl: COPIES.radarr.url }), id: 2 };
  const second = made("radarr-2", { baseUrl: `http://${BOX}:30126` });
  const { ctx, entries } = fakes({ entries: [first, second], copy: "radarr-2" });
  await radarr(ctx);
  expect(entries()).toEqual([first, { ...second, values: { ...second.values, prowlarrUrl: PROWLARR.url, baseUrl: COPIES["radarr-2"].url } }]);
});

test("an application under the name with another Radarr's key that still answers is left alone, without a question", async () => {
  const before = made("radarr", { baseUrl: "http://10.0.0.80:7878", apiKey: "friends-radarr" });
  const { ctx, entries, questions } = fakes({ entries: [before], live: ["10.0.0.80:7878"], owner: true });
  const run = radarr(ctx);
  await expect(run).rejects.toThrow(Skipped);
  await expect(run).rejects.toThrow("Prowlarr already has an app named Radarr, at http://10.0.0.80:7878. Rename that one in Prowlarr's Settings, under Apps");
  expect(entries()).toEqual([before]);
  expect(questions).toHaveLength(0);
});

test("an application under the name with another key where nothing answers moves when the owner says so, with this Radarr's key", async () => {
  const before = made("radarr", { apiKey: "reinstalled-radarr" });
  const { ctx, entries, questions } = fakes({ entries: [before], owner: true });
  await radarr(ctx);
  expect(questions).toEqual([`Prowlarr syncs indexers to Radarr at http://${OLD_BOX}:30025, which isn't answering.`]);
  expect(entries()).toEqual([{ ...before, values: { ...before.values, prowlarrUrl: PROWLARR.url, baseUrl: COPIES.radarr.url, apiKey: "radarr-key" } }]);
});

for (const owner of [false, "skip", "none"] as const) {
  test(`an application where nothing answers stays as it is when the owner doesn't move it (${owner}), and no second one is added`, async () => {
    const before = made("radarr", { apiKey: "reinstalled-radarr" });
    const { ctx, entries } = fakes({ entries: [before], owner });
    await expect(radarr(ctx)).rejects.toThrow(Skipped);
    expect(entries()).toEqual([before]);
  });
}

test("an application under the name for another kind of manager is left alone, without a question", async () => {
  const before = { ...made("radarr"), implementation: "Sonarr" };
  const { ctx, entries, questions } = fakes({ entries: [before], owner: true });
  await expect(radarr(ctx)).rejects.toThrow(Skipped);
  expect(entries()).toEqual([before]);
  expect(questions).toHaveLength(0);
});

test("a second application under the name that Prowlarr doesn't list yet is reported as a name taken, not as Radarr out of reach", async () => {
  const { ctx } = fakes({ unlisted: [made("radarr")] });
  const run = radarr(ctx);
  await expect(run).rejects.toThrow("Prowlarr already has an app named Radarr. Run Connect to Radarr again to check it.");
  await expect(run).rejects.not.toThrow(Skipped);
});

for (const down of ["prowlarr", "radarr"] as const) {
  test(`${down === "prowlarr" ? "Prowlarr" : "a Radarr"} that isn't answering yet fails with a plain message before anything is changed`, async () => {
    const { ctx, entries } = fakes({ down, entries: [made("radarr")] });
    await expect(radarr(ctx)).rejects.toThrow(`${down === "prowlarr" ? "Prowlarr" : "Radarr"} isn't answering yet. Try again once it has started.`);
    expect(entries()).toEqual([made("radarr")]);
  });
}
