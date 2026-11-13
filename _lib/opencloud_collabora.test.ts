import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookContext } from "./hook_context";

// Giving a file to user 568 needs root, so the ownership is checked on a real install
mock.module("node:fs", () => ({ ...require("node:fs"), chownSync: () => {} }));
const { collabora: linkOpenCloud } = await import("../opencloud/connect_office");
const { collaboraAddress } = await import("../nextcloud/startup");
const { run: useHttps, withHttps } = await import("../collabora/use_https");
const { run: linkLanguageTool } = await import("../collabora/connect_languagetool");

// Collabora beside OpenCloud. OpenCloud is https only and a browser blocks an http editor inside an
// https page, so Collabora serves https once OpenCloud is on the server. Collabora has no secret to
// share: it allows the addresses in its aliasgroup1, and the chart's nginx serves its certificate.

const root = join(import.meta.dir, "..");
const json = (name: string) => JSON.parse(readFileSync(join(root, name), "utf-8"));
const linked = (from: string, to: string) =>
  (json(`${from}.json`).hooks ?? []).some(
    (hook: { kind?: string; conditions?: Array<{ app?: string }> }) => hook.kind === "connect" && hook.conditions?.some((condition) => condition.app === to),
  );

const CERT = "-----BEGIN CERTIFICATE-----\nbox\n-----END CERTIFICATE-----\n";
const KEY = "-----BEGIN PRIVATE KEY-----\nbox\n-----END PRIVATE KEY-----\n";

const realFetch = globalThis.fetch;
const dirs: string[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One file as Docker's archive endpoint sends it. */
function tar(text: string): Uint8Array<ArrayBuffer> {
  const body = new TextEncoder().encode(text);
  const out = new Uint8Array(new ArrayBuffer(512 + Math.ceil(body.length / 512) * 512 + 1024));
  out.set(new TextEncoder().encode("server"), 0);
  out.set(new TextEncoder().encode(body.length.toString(8).padStart(11, "0")), 124);
  out[156] = 48;
  out.set(body, 512);
  return out;
}

/** Answers fetch by the first key the address contains, and records every address asked. */
function respond(answers: Record<string, () => Response>) {
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = decodeURIComponent(String(input instanceof Request ? input.url : input));
    asked.push(url);
    const match = Object.keys(answers).find((part) => url.includes(part));
    return match ? answers[match]() : new Response("", { status: 503 });
  }) as typeof fetch;
  return asked;
}

/** A hook's context, with only what these hooks use. */
function context(extra: Record<string, unknown> = {}) {
  const events: string[] = [];
  const messages: Array<string | undefined> = [];
  const ctx = {
    host: "10.0.0.5",
    port: 30134,
    mounts: [],
    registerCheckpoints: async () => {},
    emitCheckpoint: async (id: string, message?: string) => void (events.push(`done:${id}`), messages.push(message)),
    skipCheckpoint: async (id: string) => void events.push(`skip:${id}`),
    sleep: async () => {},
    fail: (message: string) => {
      throw new Error(message);
    },
    ...extra,
  } as unknown as HookContext;
  return { ctx, events, messages };
}

/** Values that `updateAppValues` changes in place, as HexOS does. */
function store(initial: Record<string, unknown>) {
  let values = structuredClone(initial);
  return {
    get: () => values,
    getAppValues: async () => structuredClone(values),
    updateAppValues: async (change: (next: Record<string, unknown>) => void) => {
      const next = structuredClone(values);
      change(next);
      const changed = JSON.stringify(next) !== JSON.stringify(values);
      values = next;
      return changed;
    },
  };
}

describe("the Office suite's editors", () => {
  const groups = json("_collections/office.json").groups as Array<{ id: string; options: Array<{ app: string; requires?: string[]; default?: boolean }> }>;
  const editors = groups.find((group) => group.id === "editor")!.options;
  /** What the walk offers beside a files app, in order. */
  const offered = (files: string) => editors.filter((editor) => !editor.requires || editor.requires.includes(files)).map((editor) => editor.app);

  test("OpenCloud is offered Collabora too, first", () => {
    expect(offered("opencloud")).toEqual(["collabora", "onlyoffice-document-server", "eurooffice-document-server"]);
  });

  test("Collabora is the one editor picked to start, beside either files app", () => {
    expect(editors.filter((editor) => editor.default).map((editor) => editor.app)).toEqual(["collabora"]);
    for (const files of ["nextcloud", "opencloud"]) expect(offered(files)).toContain("collabora");
  });

  test("every editor offered beside a files app has a link from it", () => {
    for (const files of ["nextcloud", "opencloud"]) for (const editor of offered(files)) expect(linked(files, editor)).toBe(true);
  });

  test("the files app installs before the editor, so Collabora finds OpenCloud", () => {
    expect(groups.findIndex((group) => group.id === "files")).toBeLessThan(groups.findIndex((group) => group.id === "editor"));
  });
});

describe("Collabora's https", () => {
  const values = () => ({
    network: {},
    collabora: { aliasgroup1: ["http://10.0.0.5:[0-9]+"], extra_params: ["--o:ssl.termination=false", "--o:ssl.enable=false", "--o:languagetool.enabled=true"] },
  });

  test("turns https on and keeps LanguageTool's settings", () => {
    const changed = values() as Record<string, any>;
    withHttps(changed);
    expect(changed.network.certificate_id).toBe(1);
    expect(changed.collabora.extra_params).toEqual(["--o:ssl.enable=false", "--o:languagetool.enabled=true", "--o:ssl.termination=true", "--o:ssl.ssl_verification=false"]);
  });

  test("leaves the allowed addresses alone: Collabora ignores the script's pattern and lets Nextcloud and OpenCloud both in", () => {
    const changed = values() as Record<string, any>;
    withHttps(changed);
    expect(changed.collabora.aliasgroup1).toEqual(["http://10.0.0.5:[0-9]+"]);
  });

  test("a second run changes nothing more", () => {
    const once = values() as Record<string, any>;
    withHttps(once);
    const twice = structuredClone(once);
    withHttps(twice);
    expect(twice).toEqual(once);
  });

  test("with no OpenCloud on the server, Collabora stays on http", async () => {
    respond({ "containers/json": () => Response.json([]) });
    const values = store({ network: {}, collabora: {} });
    const { ctx, events } = context({ port: 9980, ...values });
    await useHttps(ctx);
    expect(values.get()).toEqual({ network: {}, collabora: {} });
    expect(events).toEqual(["skip:locate", "skip:update", "skip:confirm"]);
  });

  test("on another port than 9980 it can't serve https, and says so", async () => {
    respond({ "containers/json": () => Response.json([{ Ports: [{ PublicPort: 30134 }] }]) });
    const values = store({ network: {}, collabora: {} });
    await expect(useHttps(context({ port: 9981, ...values }).ctx)).rejects.toThrow("can only serve https on port 9980");
    expect(values.get()).toEqual({ network: {}, collabora: {} });
  });

  test("turning https on tells the owner to connect a Nextcloud that's there too again", async () => {
    respond({
      "ix-opencloud": () => Response.json([{ Ports: [{ PublicPort: 30134 }] }]),
      "ix-nextcloud": () => Response.json([{ Ports: [{ PublicPort: 30027 }] }]),
      "https://10.0.0.5:9980/hosting/discovery": () => new Response(""),
    });
    const values = store({ network: {}, collabora: {} });
    const { ctx, messages } = context({ port: 9980, ...values });
    await useHttps(ctx);
    expect((values.get().network as Record<string, unknown>).certificate_id).toBe(1);
    expect(messages.at(-1)).toContain("Run Connect to Collabora from Nextcloud's Connections tab");
  });
});

describe("OpenCloud's link to Collabora", () => {
  function box() {
    const data = mkdtempSync(join(tmpdir(), "opencloud-collabora-"));
    dirs.push(data);
    mkdirSync(join(data, "proxy"));
    writeFileSync(join(data, "proxy/server.crt"), "own cert");
    writeFileSync(join(data, "proxy/server.key"), "own key");
    return data;
  }

  test("tells the owner what to press while Collabora is still on http", async () => {
    respond({});
    const { ctx } = context({ getInstalledAppUrl: async () => "http://10.0.0.5:9980", ...store({ opencloud: {} }) });
    await expect(linkOpenCloud(ctx)).rejects.toThrow("Run Serve over https from Collabora's card");
  });

  test("sets Collabora's address with no secret, and gives OpenCloud the certificate nginx serves", async () => {
    const asked = respond({
      "/hosting/discovery": () => new Response(""),
      "openid-configuration": () => new Response(""),
      "containers/json": () => Response.json([{ Id: "web" }]),
      "containers/web/json": () => Response.json({ Config: { Env: ["NGINX_VERSION=1.31.8"] } }),
      "/etc/certs/server.crt": () => new Response(new Blob([tar(CERT)])),
      "/etc/certs/server.key": () => new Response(new Blob([tar(KEY)])),
    });
    const data = box();
    const values = store({ opencloud: { app_url: "https://10.0.0.5:30134", collaboration: { enabled: false, jwt_secret: "" } } });
    const { ctx, events } = context({
      getInstalledAppUrl: async () => "http://10.0.0.5:9980",
      mounts: [{ hostPath: "/mnt/tank/Applications/opencloud/data", containerPath: null, localPath: data }],
      ...values,
    });
    await linkOpenCloud(ctx);
    const opencloud = values.get().opencloud as { collaboration: Record<string, unknown> };
    expect(opencloud.collaboration).toEqual({ enabled: true, jwt_secret: "", proof_disable: true, type: "collabora", url: "https://10.0.0.5:9980", insecure: true });
    expect(asked.some((url) => url.includes("com.docker.compose.service=nginx") && url.includes("ix-collabora"))).toBe(true);
    expect(readFileSync(join(data, "proxy/server.crt"), "utf-8")).toBe(CERT);
    expect(readFileSync(join(data, "proxy/server.key"), "utf-8")).toBe(KEY);
    expect(readFileSync(join(data, "proxy/server.crt.hexos-bak"), "utf-8")).toBe("own cert");
    expect(events).toEqual(["done:locate", "done:certificate", "done:update", "done:confirm"]);
  });

  test("without nginx's certificate the link is still made", async () => {
    respond({
      "/hosting/discovery": () => new Response(""),
      "openid-configuration": () => new Response(""),
      "containers/json": () => Response.json([]),
    });
    const data = box();
    const values = store({ opencloud: { app_url: "https://10.0.0.5:30134", collaboration: {} } });
    const { ctx, events } = context({
      getInstalledAppUrl: async () => "http://10.0.0.5:9980",
      mounts: [{ hostPath: "/mnt/tank/Applications/opencloud/data", containerPath: null, localPath: data }],
      ...values,
    });
    await linkOpenCloud(ctx);
    expect((values.get().opencloud as { collaboration: Record<string, unknown> }).collaboration.type).toBe("collabora");
    expect(readFileSync(join(data, "proxy/server.crt"), "utf-8")).toBe("own cert");
    expect(events).toEqual(["done:locate", "skip:certificate", "done:update", "done:confirm"]);
  });
});

describe("Nextcloud's link to Collabora", () => {
  test("asks over https when Collabora serves it", async () => {
    respond({ "https://10.0.0.5:9980/hosting/discovery": () => new Response("") });
    expect(await collaboraAddress("http://10.0.0.5:9980")).toBe("https://10.0.0.5:9980");
  });

  test("stays on http when Collabora does", async () => {
    respond({});
    expect(await collaboraAddress("http://10.0.0.5:9980")).toBe("http://10.0.0.5:9980");
  });

});

describe("running OpenCloud's link again", () => {
  test("the chart's trailing slash on the stored address isn't a change, so OpenCloud doesn't restart", async () => {
    respond({
      "/hosting/discovery": () => new Response(""),
      "openid-configuration": () => new Response(""),
      "containers/json": () => Response.json([]),
    });
    const values = store({ opencloud: { app_url: "https://10.0.0.5:30134", collaboration: { enabled: true, proof_disable: true, type: "collabora", url: "https://10.0.0.5:9980/", insecure: true }, additional_envs: [{ name: "HEXOS_TEXT_EDITOR_NEW_FILES", value: "md" }] } });
    const { ctx, events } = context({ getInstalledAppUrl: async () => "http://10.0.0.5:9980", ...values });
    await linkOpenCloud(ctx);
    expect(events).toEqual(["done:locate", "skip:certificate", "skip:update", "skip:confirm"]);
  });
});

describe("Collabora's link to LanguageTool", () => {
  test("waits for Collabora over https once it serves https, since ctx.waitForApp only asks over http", async () => {
    const asked = respond({ "https://10.0.0.5:9980/hosting/discovery": () => new Response("") });
    const values = store({ collabora: { extra_params: ["--o:ssl.termination=true", "--o:ssl.ssl_verification=false"] } });
    const { ctx, events } = context({ port: 9980, getInstalledAppUrl: async () => "http://10.0.0.5:30022", ...values });
    await linkLanguageTool(ctx);
    expect(events).toEqual(["done:locate", "done:update", "done:confirm"]);
    expect(asked.some((url) => url.startsWith("http://"))).toBe(false);
    expect((values.get().collabora as { extra_params: string[] }).extra_params).toEqual([
      "--o:ssl.termination=true",
      "--o:ssl.ssl_verification=false",
      "--o:languagetool.enabled=true",
      "--o:languagetool.base_url=http://10.0.0.5:30022/v2",
      "--o:languagetool.ssl_verification=false",
    ]);
  });

  test("still waits over http beside Nextcloud alone", async () => {
    respond({ "http://10.0.0.5:9980/hosting/discovery": () => new Response("") });
    const values = store({ collabora: { extra_params: [] } });
    const { ctx, events } = context({ port: 9980, getInstalledAppUrl: async () => "http://10.0.0.5:30022", ...values });
    await linkLanguageTool(ctx);
    expect(events).toEqual(["done:locate", "done:update", "done:confirm"]);
  });

  test("Serve over https and the link to LanguageTool, run after each other, leave each other's settings alone", async () => {
    respond({ "https://10.0.0.5:9980/hosting/discovery": () => new Response(""), "containers/json": () => Response.json([{ Ports: [{ PublicPort: 30134 }] }]) });
    const values = store({ collabora: { extra_params: ["--o:ssl.enable=false"] }, network: {} });
    const link = context({ port: 9980, getInstalledAppUrl: async () => "http://10.0.0.5:30022", ...values });
    await useHttps(context({ port: 9980, ...values }).ctx);
    await linkLanguageTool(link.ctx);
    const settled = JSON.stringify(values.get());
    const again = context({ port: 9980, ...values });
    await useHttps(again.ctx);
    expect(again.events).toEqual(["done:locate", "skip:update", "skip:confirm"]);
    const relink = context({ port: 9980, getInstalledAppUrl: async () => "http://10.0.0.5:30022", ...values });
    await linkLanguageTool(relink.ctx);
    expect(relink.events).toEqual(["done:locate", "skip:update", "skip:confirm"]);
    expect(JSON.stringify(values.get())).toBe(settled);
  });
});
