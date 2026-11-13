import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookContext } from "./hook_context";
import { configure } from "../qbittorrent/configure";

// qBittorrent's new sign-in reaching the managers beside it, against fakes of its WebUI and their
// APIs. Each copy of a manager holds its own entry, and qBittorrent bans an address after five failed
// sign-ins, so a copy left on the old password locks out every manager on the box.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const QBITTORRENT = { host: "10.0.0.5", port: 30024 };
const WANTED = { username: "owner", password: "chosen" };

interface Copy {
  port: number;
  /** A later copy's folder ends in its own name, and only some apps mount it at /config. */
  containerPath: string;
  failsToList?: boolean;
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qbittorrent-signin-"));
});

function mountsOf(name: string, copy: Copy) {
  const localPath = join(root, name, "config");
  mkdirSync(localPath, { recursive: true });
  writeFileSync(join(localPath, "config.xml"), `<Config><ApiKey>key-${name}</ApiKey></Config>`);
  return [{ containerPath: copy.containerPath, hostPath: `/mnt/pool/Applications/${name}/config`, localPath }];
}

function client(host = QBITTORRENT.host, port = QBITTORRENT.port) {
  return {
    id: 7,
    implementation: "QBittorrent",
    fields: [
      { name: "host", value: host },
      { name: "port", value: port },
      { name: "username", value: "old" },
      { name: "password", value: "old" },
    ],
  };
}

/** The box's copies by name. Returns the sign-in each manager's API was sent, by port. */
function fakes(copies: Record<string, Copy>) {
  const saved = new Map<number, { username: unknown; password: unknown; key: string | null }>();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.port === String(QBITTORRENT.port)) {
      if (url.pathname === "/api/v2/app/preferences") {
        return Response.json({ web_ui_username: WANTED.username, temp_path_enabled: true });
      }
      return new Response("v5.3.0");
    }
    const copy = Object.values(copies).find((c) => String(c.port) === url.port);
    if (!copy) throw new Error(`nothing fakes ${url}`);
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as ReturnType<typeof client>;
      const value = (name: string) => body.fields.find((f) => f.name === name)?.value;
      saved.set(copy.port, {
        username: value("username"),
        password: value("password"),
        key: new Headers(init.headers).get("X-Api-Key"),
      });
      return new Response(null, { status: 202 });
    }
    if (copy.failsToList) return new Response("no", { status: 500, statusText: "Internal Server Error" });
    return Response.json([client()]);
  }) as typeof fetch;
  return saved;
}

function contextFor(copies: Record<string, Copy>, overrides: Partial<HookContext> = {}) {
  const logs: string[] = [];
  const mounts = [{ containerPath: "/config", hostPath: "/mnt/pool/Applications/qbittorrent/config", localPath: join(root, "qb") }];
  const ctx = {
    baseUrl: `http://${QBITTORRENT.host}:${QBITTORRENT.port}`,
    mounts,
    signIn: WANTED,
    log: (message: string) => logs.push(message),
    sleep: async () => {},
    registerCheckpoints: async () => {},
    emitCheckpoint: async () => {},
    skipCheckpoint: async () => {},
    fail: (message: string) => {
      throw new Error(message);
    },
    installedCopies: async (appId: string) => Object.keys(copies).filter((name) => name === appId || name.startsWith(`${appId}-`)),
    getInstalledAppUrl: async (name: string) => (copies[name] ? `http://10.0.0.5:${copies[name].port}` : undefined),
    getInstalledAppMounts: async (name: string) => mountsOf(name, copies[name]),
    ...overrides,
  };
  return { ctx: ctx as unknown as HookContext, logs };
}

test("every copy of a manager gets the new sign-in, under its own key", async () => {
  const copies = {
    sonarr: { port: 30027, containerPath: "/config" },
    "sonarr-2": { port: 30114, containerPath: "/data/settings" },
    radarr: { port: 30025, containerPath: "/config" },
  };
  const saved = fakes(copies);
  await configure(contextFor(copies).ctx);
  expect(saved.get(30027)).toEqual({ ...WANTED, key: "key-sonarr" });
  expect(saved.get(30114)).toEqual({ ...WANTED, key: "key-sonarr-2" });
  expect(saved.get(30025)).toEqual({ ...WANTED, key: "key-radarr" });
});

test("a box too old to list copies still reaches the first one", async () => {
  const copies = { sonarr: { port: 30027, containerPath: "/config" } };
  const saved = fakes(copies);
  await configure(contextFor(copies, { installedCopies: undefined }).ctx);
  expect(saved.get(30027)).toEqual({ ...WANTED, key: "key-sonarr" });
});

test("a copy that won't answer doesn't stop the next one getting it", async () => {
  const copies = {
    sonarr: { port: 30027, containerPath: "/config", failsToList: true },
    "sonarr-2": { port: 30114, containerPath: "/config" },
  };
  const saved = fakes(copies);
  const { ctx, logs } = contextFor(copies);
  await configure(ctx);
  expect(saved.has(30027)).toBe(false);
  expect(saved.get(30114)).toEqual({ ...WANTED, key: "key-sonarr-2" });
  expect(logs).toEqual(["sonarr keeps the qBittorrent sign-in it had: 500 Internal Server Error"]);
});
