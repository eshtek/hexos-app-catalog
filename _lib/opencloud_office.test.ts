import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookContext } from "./hook_context";

// Giving a file to user 568 needs root, so the ownership is checked on a real install
mock.module("node:fs", () => ({ ...require("node:fs"), chownSync: () => {} }));
const { eurooffice, shareCertificate, untar } = await import("../opencloud/connect_office");

// OpenCloud's link to an office against fakes of Docker, the office and OpenCloud. OpenCloud makes
// its own certificate and the office serves the box's, and the editor opens in a frame where a
// browser offers no warning to accept, so the link gives OpenCloud the office's certificate.

const OFFICE = "https://10.0.0.5:30461";
const CERT = "-----BEGIN CERTIFICATE-----\nbox\n-----END CERTIFICATE-----\n";
const KEY = "-----BEGIN PRIVATE KEY-----\nbox\n-----END PRIVATE KEY-----\n";
const OWN_CERT = "-----BEGIN CERTIFICATE-----\nopencloud\n-----END CERTIFICATE-----\n";
const OWN_KEY = "-----BEGIN PRIVATE KEY-----\nopencloud\n-----END PRIVATE KEY-----\n";

/** One file as Docker's archive endpoint sends it. */
function tar(text: string): Uint8Array<ArrayBuffer> {
  const body = new TextEncoder().encode(text);
  const out = new Uint8Array(new ArrayBuffer(512 + Math.ceil(body.length / 512) * 512 + 1024));
  out.set(new TextEncoder().encode("tls"), 0);
  out.set(new TextEncoder().encode(body.length.toString(8).padStart(11, "0")), 124);
  out[156] = 48;
  out.set(body, 512);
  return out;
}

const dirs: string[] = [];
let spy: { mockRestore: () => void } | undefined;
afterEach(() => {
  spy?.mockRestore();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Box {
  /** OpenCloud's values before the run. */
  opencloud?: Record<string, unknown>;
  /** What the office's container answers for its certificate files. */
  cert?: string;
  key?: string;
  /** OpenCloud already has a certificate of its own on disk. */
  own?: boolean;
  restartApp?: boolean;
}

function box(options: Box = {}) {
  const data = mkdtempSync(join(tmpdir(), "opencloud-office-"));
  dirs.push(data);
  if (options.own !== false) {
    mkdirSync(join(data, "proxy"));
    writeFileSync(join(data, "proxy/server.crt"), OWN_CERT);
    writeFileSync(join(data, "proxy/server.key"), OWN_KEY);
  }
  let values: Record<string, unknown> = { opencloud: options.opencloud ?? { app_url: "https://10.0.0.5:30134", collaboration: { enabled: false } } };
  const events: string[] = [];
  let restarts = 0;
  spy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("http://docker/containers/json")) return Response.json([{ Id: "abc" }]);
    if (url === "http://docker/containers/abc/json")
      return Response.json({ Config: { Env: ["JWT_SECRET=office-secret", "SSL_CERTIFICATE_PATH=/certs/tls.crt", "SSL_KEY_PATH=/certs/tls.key"] } });
    if (url.startsWith("http://docker/containers/abc/archive")) {
      const text = decodeURIComponent(url).endsWith("tls.crt") ? (options.cert ?? CERT) : (options.key ?? KEY);
      return text ? new Response(new Blob([tar(text)])) : new Response("", { status: 404 });
    }
    return new Response("{}");
  }) as typeof fetch);
  const ctx = {
    host: "10.0.0.5",
    port: 30134,
    mounts: [{ hostPath: "/mnt/tank/Applications/opencloud/data", containerPath: null, localPath: data }],
    getInstalledAppUrl: async () => OFFICE.replace("https:", "http:"),
    registerCheckpoints: async () => {},
    emitCheckpoint: async (id: string) => void events.push(`done:${id}`),
    skipCheckpoint: async (id: string) => void events.push(`skip:${id}`),
    getAppValues: async () => structuredClone(values),
    updateAppValues: async (change: (next: Record<string, unknown>) => void) => {
      const next = structuredClone(values);
      change(next);
      const changed = JSON.stringify(next) !== JSON.stringify(values);
      values = next;
      return changed;
    },
    ...(options.restartApp === false ? {} : { restartApp: async () => void restarts++ }),
    sleep: async () => {},
    fail: (message: string) => {
      throw new Error(message);
    },
  } as unknown as HookContext;
  const file = (name: string) => readFileSync(join(data, "proxy", name), "utf-8");
  return { ctx, events, file, data, values: () => values.opencloud as { collaboration: Record<string, unknown> }, restarts: () => restarts };
}

describe("the office's certificate", () => {
  test("a file comes out of Docker's archive, past a pax header", () => {
    expect(untar(tar(CERT))).toBe(CERT);
    const pax = tar("comment");
    pax[156] = 120;
    const both = new Uint8Array(pax.length - 1024 + tar(KEY).length);
    both.set(pax.subarray(0, pax.length - 1024));
    both.set(tar(KEY), pax.length - 1024);
    expect(untar(both)).toBe(KEY);
    expect(untar(new Uint8Array(1024))).toBe("");
  });

  test("the link gives OpenCloud the office's certificate and keeps OpenCloud's own beside it", async () => {
    const { ctx, events, file, data, values } = box();
    await eurooffice(ctx);
    expect(file("server.crt")).toBe(CERT);
    expect(file("server.key")).toBe(KEY);
    expect(statSync(join(data, "proxy/server.key")).mode & 0o777).toBe(0o600);
    expect(file("server.crt.hexos-bak")).toBe(OWN_CERT);
    expect(file("server.key.hexos-bak")).toBe(OWN_KEY);
    expect(values().collaboration).toMatchObject({ enabled: true, type: "eurooffice", url: OFFICE, jwt_secret: "office-secret" });
    expect(events).toEqual(["done:locate", "done:certificate", "done:update", "done:confirm"]);
  });

  test("run again, nothing is written and nothing restarts", async () => {
    const { ctx, events, restarts } = box();
    await eurooffice(ctx);
    events.length = 0;
    await eurooffice(ctx);
    expect(events).toEqual(["done:locate", "skip:certificate", "skip:update", "skip:confirm"]);
    expect(restarts()).toBe(0);
  });

  test("a second office's certificate replaces the first, and OpenCloud's own stays the backup", async () => {
    const { ctx, file, data } = box();
    await eurooffice(ctx);
    shareCertificate({ hostPath: "", containerPath: null, localPath: data }, { cert: `${CERT}2`, key: `${KEY}2` });
    expect(file("server.crt")).toBe(`${CERT}2`);
    expect(file("server.crt.hexos-bak")).toBe(OWN_CERT);
  });

  test("an OpenCloud already linked restarts to read a certificate it didn't have", async () => {
    const linked = { app_url: "https://10.0.0.5:30134", collaboration: {}, additional_envs: [] };
    const first = box({ opencloud: linked });
    await eurooffice(first.ctx);
    // The same settings as that run left, with OpenCloud's own certificate back on disk
    const again = box({ opencloud: first.values() });
    await eurooffice(again.ctx);
    expect(again.file("server.crt")).toBe(CERT);
    expect(again.restarts()).toBe(1);
    expect(again.events).toEqual(["done:locate", "done:certificate", "skip:update", "done:confirm"]);
  });

  test("that restart needs a HexOS that can restart an app", async () => {
    const first = box();
    await eurooffice(first.ctx);
    const again = box({ opencloud: first.values(), restartApp: false });
    await expect(eurooffice(again.ctx)).rejects.toThrow("needs an update");
  });

  test("an OpenCloud at an outside address keeps its own certificate", async () => {
    const { ctx, events, file } = box({ opencloud: { app_url: "https://cloud.example.com", collaboration: {} } });
    await eurooffice(ctx);
    expect(file("server.crt")).toBe(OWN_CERT);
    expect(events).toEqual(["done:locate", "skip:certificate", "done:update", "done:confirm"]);
  });

  test("a certificate that can't be read leaves OpenCloud's own, and the link is still made", async () => {
    for (const broken of [{ cert: "" }, { key: "" }, { key: "not a key" }]) {
      const { ctx, events, file, values } = box(broken);
      await eurooffice(ctx);
      expect(file("server.crt")).toBe(OWN_CERT);
      expect(file("server.key")).toBe(OWN_KEY);
      expect(values().collaboration.enabled).toBe(true);
      expect(events).toEqual(["done:locate", "skip:certificate", "done:update", "done:confirm"]);
      spy?.mockRestore();
    }
  });

  test("an OpenCloud with no certificate yet gets the office's", async () => {
    const { ctx, file } = box({ own: false });
    await eurooffice(ctx);
    expect(file("server.crt")).toBe(CERT);
    expect(file("server.key")).toBe(KEY);
  });
});
