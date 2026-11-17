import { expect, test } from "bun:test";

import { FIREFLY, firefly, PAPERLESS, paperless, withProxySetting } from "../anywhere/proxy_setting";
import fireflyScript from "../firefly-iii.json";
import type { HookContext } from "./hook_context";
import paperlessScript from "../paperless-ngx.json";

// Paperless-ngx answered a sign-in at its https Anywhere address with 403, and Firefly III wrote
// http addresses into a page opened over https there.

type Env = { container?: string; name: string; value: string };
type Values = Record<string, { additional_envs?: Env[]; [key: string]: unknown }>;

const NAME = ["paperless.k7q2m9.example.com"];
const header: Env = { container: "paperless", name: "PAPERLESS_PROXY_SSL_HEADER", value: '["HTTP_X_FORWARDED_PROTO","https"]' };
const headerMark: Env = { container: "paperless", name: "HEXOS_ANYWHERE_ENVS", value: "PAPERLESS_PROXY_SSL_HEADER" };
const ocr: Env = { container: "paperless", name: "PAPERLESS_OCR_LANGUAGE", value: "deu" };
const livePaperless = (...envs: Env[]): Values => ({ paperless: { secret_key: "s", additional_envs: envs.map((env) => ({ ...env })) } });
const liveFirefly = (...envs: Env[]): Values => ({ firefly_iii: { app_url: "http://192.168.1.20:30105", additional_envs: envs.map((env) => ({ ...env })) } });

test("Paperless-ngx with an Anywhere name is told to read the scheme from X-Forwarded-Proto, on its own container", () => {
  const values = livePaperless(ocr);
  expect(withProxySetting(values, NAME, PAPERLESS)).toBe("added");
  expect(values.paperless.additional_envs).toEqual([ocr, header, headerMark]);
  // Paperless parses the value as JSON and hands Django the pair
  expect(JSON.parse(header.value)).toEqual(["HTTP_X_FORWARDED_PROTO", "https"]);
  expect(values.paperless.secret_key).toBe("s");
});

test("Firefly III with an Anywhere name trusts the proxy in front of it, and its LAN address stays", () => {
  const values = liveFirefly();
  expect(withProxySetting(values, ["firefly.k7q2m9.example.com"], FIREFLY)).toBe("added");
  expect(values.firefly_iii.additional_envs).toEqual([
    { name: "TRUSTED_PROXIES", value: "**" },
    { name: "HEXOS_ANYWHERE_ENVS", value: "TRUSTED_PROXIES" },
  ]);
  expect(values.firefly_iii.app_url).toBe("http://192.168.1.20:30105");
});

test("running it again changes nothing, wherever the owner's later envs sit", () => {
  const values = livePaperless(header, headerMark, ocr);
  const before = structuredClone(values);
  expect(withProxySetting(values, NAME, PAPERLESS)).toBe("unchanged");
  expect(withProxySetting(values, ["other.example.com", "second.example.com"], PAPERLESS)).toBe("unchanged");
  expect(values).toEqual(before);
});

test("an app with no Anywhere address is left exactly as it is", () => {
  for (const values of [livePaperless(ocr), { paperless: { secret_key: "s" } } as Values, {} as Values]) {
    const before = structuredClone(values);
    expect(withProxySetting(values, [], PAPERLESS)).toBe("unchanged");
    expect(values).toEqual(before);
  }
});

test("with the address turned off, what HexOS added comes back out and the owner's envs stay", () => {
  const values = livePaperless(ocr);
  withProxySetting(values, NAME, PAPERLESS);
  expect(withProxySetting(values, [], PAPERLESS)).toBe("removed");
  expect(values).toEqual(livePaperless(ocr));
  const money = liveFirefly();
  withProxySetting(money, NAME, FIREFLY);
  withProxySetting(money, [], FIREFLY);
  expect(money).toEqual(liveFirefly());
});

test("a setting the owner made themselves is never changed, marked or taken out", () => {
  for (const value of [header.value, '["HTTP_X_FORWARDED_SSL","on"]']) {
    const values = livePaperless({ ...header, value });
    const before = structuredClone(values);
    expect(withProxySetting(values, NAME, PAPERLESS)).toBe("owners");
    expect(withProxySetting(values, [], PAPERLESS)).toBe("owners");
    expect(values).toEqual(before);
  }
});

test("a value the owner changed after HexOS added it becomes the owner's, and survives the address being turned off", () => {
  const values = liveFirefly();
  withProxySetting(values, NAME, FIREFLY);
  values.firefly_iii.additional_envs![0].value = "10.0.0.5";
  expect(withProxySetting(values, [], FIREFLY)).toBe("owners");
  expect(values.firefly_iii.additional_envs).toEqual([{ name: "TRUSTED_PROXIES", value: "10.0.0.5" }]);
});

test("a mark left behind after the owner deleted the setting is not taken for the setting", () => {
  const values = livePaperless(headerMark);
  expect(withProxySetting(values, NAME, PAPERLESS)).toBe("added");
  expect(values.paperless.additional_envs).toEqual([header, headerMark]);
  const off = livePaperless(headerMark);
  expect(withProxySetting(off, [], PAPERLESS)).toBe("unchanged");
  expect(off.paperless.additional_envs).toEqual([]);
});

test("the same name on another of Paperless-ngx's containers is another env, and stays", () => {
  const tika: Env = { ...header, container: "tika" };
  const values = livePaperless(tika);
  expect(withProxySetting(values, NAME, PAPERLESS)).toBe("added");
  expect(values.paperless.additional_envs).toEqual([tika, header, headerMark]);
  expect(withProxySetting(values, [], PAPERLESS)).toBe("removed");
  expect(values.paperless.additional_envs).toEqual([tika]);
});

test("no container ever gets a name twice, which TrueNAS refuses", () => {
  const values = livePaperless(ocr);
  for (const names of [NAME, NAME, [], NAME, ["renamed.example.com"], [], []]) {
    withProxySetting(values, names, PAPERLESS);
    const keys = values.paperless.additional_envs!.map((env) => `${env.container}/${env.name}`);
    expect(new Set(keys).size).toBe(keys.length);
  }
});

type Script = { version: number; app_values: Record<string, unknown>; hooks?: Array<Record<string, unknown>> };

test("each app's step is a hook of its own that follows the address, and its script never sets the env itself", () => {
  for (const [script, entrypoint, setting] of [
    [paperlessScript as Script, "paperless", PAPERLESS],
    [fireflyScript as Script, "firefly", FIREFLY],
  ] as const) {
    expect(script.version).toBe(6);
    expect(script.hooks).toHaveLength(1);
    expect(script.hooks![0]).toMatchObject({
      id: "anywhere-address",
      rerun: "converge",
      rerunsOn: ["remote-address"],
      events: ["userAction"],
      script: "anywhere/proxy_setting.ts",
      entrypoint,
    });
    // A static value would be put back by every app update, against the hook taking it out
    expect(JSON.stringify(script.app_values)).not.toContain(setting.name);
    expect(script.app_values[setting.group]).toBeDefined();
  }
});

/** A stand-in for the box: the app's values, and what the hook told its owner. */
function box(values: Values, names: string[] | undefined) {
  const said: string[] = [];
  let updates = 0;
  const ctx = {
    registerCheckpoints: async () => {},
    emitCheckpoint: async (id: string, message?: string) => void said.push(`done ${id}${message ? `: ${message}` : ""}`),
    skipCheckpoint: async (id: string, message?: string) => void said.push(`skipped ${id}: ${message}`),
    fail: (message: string) => {
      throw new Error(message);
    },
    ...(names ? { readRemoteAddresses: async () => ({ names }) } : {}),
    updateAppValues: async (change: (values: Record<string, unknown>) => void) => {
      const before = JSON.stringify(values);
      change(values);
      const changed = JSON.stringify(values) !== before;
      if (changed) updates += 1;
      return changed;
    },
  } as unknown as HookContext;
  return { ctx, said, updates: () => updates };
}

test("the hook updates the app once for a new address and not again", async () => {
  const values = livePaperless();
  const first = box(values, NAME);
  await paperless(first.ctx);
  expect(first.updates()).toBe(1);
  expect(first.said).toEqual(["done names", "done update"]);
  const second = box(values, NAME);
  await paperless(second.ctx);
  expect(second.updates()).toBe(0);
  expect(second.said).toEqual(["done names", "skipped update: Paperless-ngx is already set up for its Anywhere address"]);
});

test("the hook says when it took the setting out, and when it left the owner's alone", async () => {
  const values = liveFirefly();
  await firefly(box(values, NAME).ctx);
  const off = box(values, []);
  await firefly(off.ctx);
  expect(off.said).toEqual(["done names", "done update: Took Firefly III's Anywhere setting back out"]);
  expect(values).toEqual(liveFirefly());
  const owners = box(liveFirefly({ name: "TRUSTED_PROXIES", value: "10.0.0.5" }), NAME);
  await firefly(owners.ctx);
  expect(owners.updates()).toBe(0);
  expect(owners.said).toEqual(["done names", "skipped update: Left the TRUSTED_PROXIES setting you made yourself as it is"]);
});

test("a server from before the trigger is told to update, and its app is not touched", async () => {
  const values = livePaperless();
  const old = box(values, undefined);
  await expect(paperless(old.ctx)).rejects.toThrow("needs an update before Paperless-ngx can open at an Anywhere address");
  expect(old.updates()).toBe(0);
  expect(values).toEqual(livePaperless());
});
