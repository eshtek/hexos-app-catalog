import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookContext } from "./hook_context";
import { radarr } from "../seerr/connect_arr";

// Seerr's link to Radarr, against fakes of Seerr's Radarr settings (read at Seerr 3.5.1) and two
// copies of Radarr on the box. Seerr's list gives each server's API key as it is, and saving a default
// takes it from any server of the same kind (4K or not). Run again after the box's address or Radarr's
// port changed, the link finds Seerr's entry by this Radarr's own key and moves it, so the entry stays
// Seerr's default. One it has to add beside another default says where Seerr sends requests.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const BOX = "10.0.0.5";
const OLD_BOX = "10.0.0.30";
const SEERR = { url: `http://${BOX}:30357`, key: "seerr-key" };
const COPIES: Record<string, { port: number; key: string; displayName: string }> = {
  radarr: { port: 30025, key: "radarr-key", displayName: "Radarr" },
  "radarr-2": { port: 30125, key: "radarr-2-key", displayName: "Radarr 2" },
};

interface Server {
  id: number;
  name: string;
  hostname: string;
  port: number;
  apiKey: string;
  is4k: boolean;
  isDefault: boolean;
  activeProfileId?: number;
  activeDirectory?: string;
  [field: string]: unknown;
}

interface Options {
  servers?: Server[];
  copy?: string;
  down?: "seerr" | "radarr";
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "seerr-arr-"));
});

function dir(name: string) {
  const path = join(root, name, "config");
  mkdirSync(path, { recursive: true });
  return path;
}

function fakes(options: Options = {}) {
  const copy = options.copy ?? "radarr";
  let servers = structuredClone(options.servers ?? []);
  const checkpoints: Array<{ id: string; message?: string }> = [];
  // Seerr's own handling of isDefault (server/routes/settings/radarr.ts)
  const clearDefaults = (body: Server) => {
    if (body.isDefault) for (const server of servers.filter((each) => each.is4k === body.is4k)) server.isDefault = false;
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.origin === SEERR.url) {
      if (options.down === "seerr") throw new TypeError("fetch failed");
      if (url.pathname === "/api/v1/status") return Response.json({ version: "3.5.1" });
      if (url.pathname === "/api/v1/settings/public") return Response.json({ initialized: true });
      if (new Headers(init?.headers).get("X-Api-Key") !== SEERR.key) return new Response(null, { status: 403 });
      if (url.pathname === "/api/v1/settings/radarr" && method === "GET") return Response.json(servers);
      if (url.pathname === "/api/v1/settings/radarr" && method === "POST") {
        clearDefaults(body);
        const created = { ...body, id: (servers.at(-1)?.id ?? -1) + 1 };
        servers = [...servers, created];
        return Response.json(created, { status: 201 });
      }
      const match = url.pathname.match(/^\/api\/v1\/settings\/radarr\/(\d+)$/);
      if (match && method === "PUT") {
        const index = servers.findIndex((each) => each.id === Number(match[1]));
        if (index === -1) return Response.json({ message: "Settings instance not found" }, { status: 404 });
        clearDefaults(body);
        servers[index] = { ...body, id: Number(match[1]) };
        return Response.json(servers[index]);
      }
    }
    const target = Object.values(COPIES).find((each) => url.origin === `http://${BOX}:${each.port}`);
    if (target && options.down !== "radarr") {
      if (url.pathname === "/ping") return Response.json({ status: "OK" });
      if (new Headers(init?.headers).get("X-Api-Key") !== target.key) return new Response(null, { status: 401 });
      if (url.pathname === "/api/v3/qualityprofile") return Response.json([{ id: 1, name: "Any" }, { id: 4, name: "1080p Balanced" }]);
      if (url.pathname === "/api/v3/rootfolder") return Response.json([{ path: "/movies" }, { path: "/movies-kids" }]);
    }
    if (target || url.hostname === OLD_BOX) throw new TypeError("fetch failed");
    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as typeof fetch;

  const seerrConfig = dir("seerr");
  writeFileSync(join(seerrConfig, "settings.json"), JSON.stringify({ main: { apiKey: SEERR.key } }));
  const radarrConfig = dir(copy);
  writeFileSync(join(radarrConfig, "config.xml"), `<Config><ApiKey>${COPIES[copy].key}</ApiKey></Config>`);
  const ctx = {
    resourceId: "seerr",
    baseUrl: SEERR.url,
    mounts: [{ containerPath: "/app/config", hostPath: "/mnt/pool/apps/seerr/config", localPath: seerrConfig }],
    linkedApp: (app: string) => (app === "radarr" ? { name: copy, displayName: COPIES[copy].displayName } : null),
    getInstalledAppUrl: async (app: string) => (app === "radarr" ? `http://${BOX}:${COPIES[copy].port}` : null),
    getInstalledAppMounts: async () => [{ containerPath: "/config", hostPath: `/mnt/pool/apps/${copy}/config`, localPath: radarrConfig }],
    registerCheckpoints: async () => {},
    emitCheckpoint: async (id: string, message?: string) => {
      checkpoints.push({ id, message });
    },
    sleep: async () => {},
    log: () => {},
    fail: (message: string) => {
      throw new Error(message);
    },
  } as unknown as HookContext;
  return { ctx, servers: () => servers, checkpoints };
}

/** Seerr's entry for a copy, at the address it had then, with the owner's choices. */
function entry(copy: string, rest: Partial<Server> = {}): Server {
  return {
    id: 0,
    name: COPIES[copy].displayName,
    hostname: BOX,
    port: COPIES[copy].port,
    apiKey: COPIES[copy].key,
    useSsl: false,
    baseUrl: "",
    is4k: false,
    isDefault: true,
    activeProfileId: 1,
    activeProfileName: "Any",
    activeDirectory: "/movies-kids",
    ...rest,
  };
}

test("a Seerr with no Radarr gets this one as its default", async () => {
  const { ctx, servers, checkpoints } = fakes();
  await radarr(ctx);
  expect(servers()).toHaveLength(1);
  expect(servers()[0]).toMatchObject({ hostname: BOX, port: 30025, apiKey: "radarr-key", isDefault: true, activeProfileName: "1080p Balanced" });
  expect(checkpoints.at(-1)).toEqual({ id: "configure", message: undefined });
});

for (const [label, moved] of [
  ["the box's address changed", { hostname: OLD_BOX }],
  ["Radarr's port changed", { port: 30026 }],
] as const) {
  test(`Seerr's entry with this Radarr's own key moves here and stays the default, with the owner's choices (${label})`, async () => {
    const { ctx, servers, checkpoints } = fakes({ servers: [entry("radarr", moved)] });
    await radarr(ctx);
    expect(servers()).toEqual([{ ...entry("radarr"), id: 0 }]);
    expect(checkpoints.at(-1)).toEqual({ id: "configure", message: undefined });
  });
}

test("another copy's entry is never taken for this copy's, so the second copy joins beside it", async () => {
  const first = entry("radarr");
  const { ctx, servers, checkpoints } = fakes({ servers: [first], copy: "radarr-2" });
  await radarr(ctx);
  expect(servers()).toHaveLength(2);
  expect(servers()[0]).toEqual(first);
  expect(servers()[1]).toMatchObject({ id: 1, name: "Radarr 2", port: 30125, apiKey: "radarr-2-key", isDefault: false });
  expect(checkpoints.at(-1)?.message).toBe(`Seerr sends requests to Radarr at ${BOX}:30025 by default. Radarr 2 was added beside it.`);
});

test("a default Seerr can't tell is this Radarr (a reinstall, with a new key and address) is left as it is, and the step says where requests go", async () => {
  const gone = entry("radarr", { hostname: OLD_BOX, apiKey: "reinstalled" });
  const { ctx, servers, checkpoints } = fakes({ servers: [gone] });
  await radarr(ctx);
  expect(servers()[0]).toEqual(gone);
  expect(servers()[1]).toMatchObject({ hostname: BOX, port: 30025, apiKey: "radarr-key", isDefault: false });
  expect(checkpoints.at(-1)?.message).toBe(`Seerr sends requests to Radarr at ${OLD_BOX}:30025 by default. Radarr was added beside it.`);
});

test("with only a 4K default, this Radarr becomes the default for the rest, and the 4K one keeps its own", async () => {
  const fourK = entry("radarr-2", { name: "Radarr 4K", hostname: "10.0.0.80", port: 7878, apiKey: "radarr-4k", is4k: true });
  const { ctx, servers, checkpoints } = fakes({ servers: [fourK] });
  await radarr(ctx);
  expect(servers()[0]).toEqual(fourK);
  expect(servers()[1]).toMatchObject({ port: 30025, is4k: false, isDefault: true });
  expect(checkpoints.at(-1)).toEqual({ id: "configure", message: undefined });
});

for (const down of ["seerr", "radarr"] as const) {
  test(`${down === "seerr" ? "Seerr" : "a Radarr"} that isn't answering yet fails with a plain message before anything is changed`, async () => {
    const { ctx, servers } = fakes({ down, servers: [entry("radarr")] });
    await expect(radarr(ctx)).rejects.toThrow(`${down === "seerr" ? "Seerr" : "Radarr"} isn't answering yet. Try again once it has started.`);
    expect(servers()).toEqual([entry("radarr")]);
  });
}
