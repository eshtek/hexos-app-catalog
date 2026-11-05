import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookContext } from "./hook_context";
import { deluge, nzbget, qbittorrent, sabnzbd } from "../sportarr/connect_download_client";

// A download client's link from Sportarr, against fakes of Sportarr's download client API (read at
// 4.1.11: one flat record per client, its secrets listed as they are, no names it refuses) and the
// four clients. Sportarr gives a download to the first client it has that's on, so an entry the
// client had before the box's address or its port changed would keep getting them. Once nothing
// answers at that entry's address, the link moves it here when it holds this client's own key or
// sign-in, never one many clients have, or when the owner says so; with neither, it stops rather
// than add this one behind it. An entry that answers is another client, and this one joins beside it.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const BOX = "10.0.0.5";
const OLD_BOX = "10.0.0.30";
const SPORTARR = { port: 30160, key: "sportarr-key" };
const SIGN_IN = { username: "owner", password: "chosen-password" };
const SAB_KEY = "sab-key-of-this-box";

const PORTS = { qbittorrent: 30024, deluge: 30095, sabnzbd: 30055, nzbget: 30057 } as const;
type ClientId = keyof typeof PORTS;
const TYPES: Record<ClientId, number> = { qbittorrent: 0, deluge: 2, sabnzbd: 5, nzbget: 6 };
const NAMES: Record<ClientId, string> = { qbittorrent: "qBittorrent", deluge: "Deluge", sabnzbd: "SABnzbd", nzbget: "NZBGet" };

interface Entry {
  id: number;
  name: string;
  type: number;
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
  apiKey?: string | null;
  urlBase?: string;
  category?: string;
  useSsl?: boolean;
  enabled?: boolean;
  priority?: number;
}

interface Options {
  entries?: Entry[];
  /** Addresses ("host:port") where something answers besides this box's apps. */
  live?: string[];
  /** The owner's answer when asked, "skip" to skip the question, "none" for a box that can't ask. */
  owner?: boolean | "skip" | "none";
  /** What the client takes, when not the owner's chosen sign-in: then HexOS has none chosen. */
  takes?: { username?: string; password: string };
  /** HexOS kept no sign-in for the client, so it knows none that works. */
  unsaved?: boolean;
  sportarrDown?: boolean;
}

class Skipped extends Error {}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sportarr-clients-"));
});

function dir(...parts: string[]) {
  const path = join(root, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

function fakes(clientId: ClientId, options: Options = {}) {
  const takes = { username: SIGN_IN.username, ...(options.takes ?? SIGN_IN) };
  const secrets: Record<ClientId, Record<string, string>> = {
    qbittorrent: { username: takes.username, password: takes.password },
    deluge: { password: takes.password },
    sabnzbd: { apiKey: SAB_KEY },
    nzbget: { username: takes.username, password: takes.password },
  };
  let entries = structuredClone(options.entries ?? []);
  let nextId = Math.max(0, ...entries.map((entry) => entry.id)) + 1;
  const questions: string[] = [];
  const checkpoints: Array<{ id: string; message?: string }> = [];
  const live = new Set(options.live ?? []);

  // Sportarr's test reaches the client at the address it's given with the secrets it's given
  const passes = (entry: Entry) =>
    entry.type === TYPES[clientId] &&
    entry.host === BOX &&
    entry.port === PORTS[clientId] &&
    Object.entries(secrets[clientId]).every(([field, value]) => entry[field as keyof Entry] === value);

  const sportarr = (url: URL, method: string, body: Entry) => {
    if (url.pathname === "/api/downloadclient" && method === "GET") return Response.json(entries.toSorted((a, b) => (a.priority ?? 1) - (b.priority ?? 1)));
    if (url.pathname === "/api/downloadclient/test") {
      return passes(body) ? Response.json({ success: true }) : Response.json({ success: false, message: "Connection failed" }, { status: 400 });
    }
    if (url.pathname === "/api/downloadclient" && method === "POST") {
      const created = { ...body, id: nextId++ };
      entries = [...entries, created];
      return Response.json(created, { status: 201 });
    }
    const match = url.pathname.match(/^\/api\/downloadclient\/(\d+)$/);
    const known = match ? entries.find((entry) => entry.id === Number(match[1])) : undefined;
    if (known && method === "PUT") {
      // An empty password or key keeps the one Sportarr has (DownloadClientEndpoints)
      Object.assign(known, { ...body, id: known.id, password: body.password || known.password, apiKey: body.apiKey || known.apiKey });
      return Response.json(known);
    }
    throw new Error(`Unexpected Sportarr request: ${method} ${url.pathname}`);
  };

  const client = (url: URL, init: RequestInit | undefined, body: { method?: string; params?: unknown[] } | undefined) => {
    if (clientId === "qbittorrent") {
      if (url.pathname === "/api/v2/app/version") return new Response("Forbidden", { status: 403 });
      if (url.pathname === "/api/v2/auth/login") {
        const form = new URLSearchParams(String(init?.body));
        return new Response(form.get("username") === takes.username && form.get("password") === takes.password ? "Ok." : "Fails.");
      }
    }
    if (clientId === "deluge") {
      const result: Record<string, unknown> = {
        "auth.login": body?.params?.[0] === takes.password,
        "web.connected": true,
        "system.listMethods": ["label.get_labels"],
      };
      if (body?.method && body.method in result) return Response.json({ result: result[body.method], error: null, id: 1 });
    }
    if (clientId === "sabnzbd") {
      if (url.searchParams.get("apikey") !== SAB_KEY) return Response.json({ error: "API Key Incorrect" }, { status: 403 });
      const mode = url.searchParams.get("mode");
      if (mode === "get_config") return Response.json({ config: { misc: { download_dir: "/downloads/sabnzbd/incomplete", complete_dir: "/downloads/sabnzbd/complete" } } });
      if (mode === "get_cats") return Response.json({ categories: ["*", "sportarr"] });
    }
    if (clientId === "nzbget") {
      const auth = Buffer.from(`${takes.username}:${takes.password}`).toString("base64");
      if (new Headers(init?.headers).get("Authorization") !== `Basic ${auth}`) return new Response(null, { status: 401 });
      return Response.json({ result: [{ Name: "MainDir", Value: "/downloads/nzbget" }, { Name: "Category1.Name", Value: "sportarr" }], error: null });
    }
    throw new Error(`Unexpected ${clientId} request: ${url.pathname}`);
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : undefined;
    if (url.hostname === BOX && Number(url.port) === SPORTARR.port) {
      if (options.sportarrDown) throw new TypeError("fetch failed");
      if (url.pathname === "/ping") return Response.json({ status: "OK" });
      if (new Headers(init?.headers).get("X-Api-Key") !== SPORTARR.key) return new Response(null, { status: 401 });
      return sportarr(url, method, body);
    }
    if (url.hostname === BOX && Number(url.port) === PORTS[clientId]) return client(url, init, body);
    if (live.has(url.host)) return new Response("a web page");
    throw new TypeError("fetch failed");
  }) as typeof fetch;

  const clientConfig = dir(clientId, "config");
  writeFileSync(join(clientConfig, "sabnzbd.ini"), `api_key = ${SAB_KEY}\n`);
  writeFileSync(join(clientConfig, "nzbget.conf"), `ControlUsername=${takes.username}\nControlPassword=${takes.password}\n`);
  writeFileSync(join(clientConfig, "core.conf"), `{"file": 1, "format": 1}{"enabled_plugins": ["Label"]}`);
  if (options.takes && !options.unsaved && (clientId === "qbittorrent" || clientId === "deluge")) {
    // HexOS keeps the sign-in it gave the client when the owner chose none
    writeFileSync(join(dir(clientId, "config", "hexos"), "webui.json"), JSON.stringify(takes));
  }
  const sportarrConfig = dir("sportarr", "config");
  writeFileSync(join(sportarrConfig, "config.xml"), `<Config><ApiKey>${SPORTARR.key}</ApiKey></Config>`);

  const ctx = {
    resourceId: "sportarr",
    baseUrl: `http://${BOX}:${SPORTARR.port}`,
    mounts: [{ containerPath: "/config", hostPath: "/mnt/pool/apps/sportarr/config", localPath: sportarrConfig }],
    signIn: options.takes ? undefined : SIGN_IN,
    getInstalledAppUrl: async (app: string) => (app === clientId ? `http://${BOX}:${PORTS[clientId]}` : null),
    getInstalledAppMounts: async () => [{ containerPath: "/config", hostPath: `/mnt/pool/apps/${clientId}/config`, localPath: clientConfig }],
    registerCheckpoints: async () => {},
    emitCheckpoint: async (id: string, message?: string) => {
      checkpoints.push({ id, message });
    },
    skipCheckpoint: async () => {},
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
  return { ctx, entries: () => entries, questions, checkpoints };
}

const links = { qbittorrent, deluge, sabnzbd, nzbget };

/** Sportarr's entry for a client, at the address it had then. */
function made(clientId: ClientId, rest: Partial<Entry> = {}): Entry {
  const secret: Record<ClientId, Partial<Entry>> = {
    qbittorrent: { username: SIGN_IN.username, password: SIGN_IN.password },
    deluge: { password: SIGN_IN.password },
    sabnzbd: { apiKey: SAB_KEY },
    nzbget: { username: SIGN_IN.username, password: SIGN_IN.password },
  };
  return { id: 2, name: NAMES[clientId], type: TYPES[clientId], host: OLD_BOX, port: PORTS[clientId], urlBase: "", category: "sportarr", useSsl: false, enabled: true, priority: 1, ...secret[clientId], ...rest };
}

test("a client Sportarr doesn't have yet is added", async () => {
  const { ctx, entries, questions } = fakes("qbittorrent");
  await qbittorrent(ctx);
  expect(entries()).toHaveLength(1);
  expect(entries()[0]).toMatchObject({ name: "qBittorrent", host: BOX, port: PORTS.qbittorrent, ...SIGN_IN });
  expect(questions).toHaveLength(0);
});

test("an entry at the client's own address is updated in place", async () => {
  const { ctx, entries } = fakes("qbittorrent", { entries: [made("qbittorrent", { host: BOX, password: "old" })] });
  await qbittorrent(ctx);
  expect(entries()).toEqual([made("qbittorrent", { host: BOX })]);
});

for (const clientId of ["qbittorrent", "deluge", "sabnzbd", "nzbget"] as const) {
  test(`${NAMES[clientId]}: after the box's address changed, the entry holding this client's own ${clientId === "sabnzbd" ? "key" : "sign-in"} moves here without a question`, async () => {
    const { ctx, entries, questions, checkpoints } = fakes(clientId, { entries: [made(clientId)], owner: false });
    await links[clientId](ctx);
    expect(questions).toHaveLength(0);
    expect(entries()).toEqual([made(clientId, { host: BOX })]);
    expect(checkpoints.at(-1)).toEqual({ id: "configure", message: `Sportarr reaches ${NAMES[clientId]} at its new address` });
  });
}

for (const [clientId, takes] of [
  ["qbittorrent", { username: "admin", password: "adminadmin" }],
  ["qbittorrent", { username: "admin", password: "admin" }],
  ["deluge", { password: "deluge" }],
  ["deluge", { password: "admin" }],
  ["nzbget", { username: "nzbget", password: "tegbzn6789" }],
  ["nzbget", { username: "admin", password: "admin" }],
] as const) {
  test(`${NAMES[clientId]}: a sign-in many have (${takes.password}) proves nothing, so the owner is asked`, async () => {
    const { ctx, entries, questions } = fakes(clientId, { entries: [made(clientId, takes)], takes, owner: true });
    await links[clientId](ctx);
    expect(questions).toEqual([`Sportarr sends downloads to ${NAMES[clientId]} at ${OLD_BOX}:${PORTS[clientId]}, which isn't answering.`]);
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ id: 2, host: BOX });
  });
}

test("qBittorrent: when HexOS knows no sign-in that works, nothing proves whose an entry is, so the owner is asked", async () => {
  const takes = { username: "owner", password: "only-the-owner-knows" };
  const before = made("qbittorrent", takes);
  const { ctx, entries, questions } = fakes("qbittorrent", { entries: [before], takes, unsaved: true, owner: true });
  await qbittorrent(ctx);
  expect(questions).toEqual([`Sportarr sends downloads to qBittorrent at ${OLD_BOX}:${PORTS.qbittorrent}, which isn't answering.`]);
  // Moved with the sign-in Sportarr already had, which its test showed qBittorrent takes
  expect(entries()).toEqual([{ ...before, host: BOX }]);
});

test("an entry with another sign-in where nothing answers moves when the owner says so", async () => {
  const { ctx, entries, questions } = fakes("qbittorrent", { entries: [made("qbittorrent", { password: "old" })], owner: true });
  await qbittorrent(ctx);
  expect(questions).toHaveLength(1);
  expect(entries()).toEqual([made("qbittorrent", { host: BOX })]);
});

for (const owner of [false, "skip", "none"] as const) {
  test(`an entry with another sign-in where nothing answers stays as it is when the owner doesn't move it (${owner}), and none is added behind it`, async () => {
    const before = made("qbittorrent", { password: "old" });
    const { ctx, entries } = fakes("qbittorrent", { entries: [before], owner });
    const run = qbittorrent(ctx);
    await expect(run).rejects.toThrow(Skipped);
    await expect(run).rejects.toThrow(`Sportarr sends downloads to qBittorrent at ${OLD_BOX}:${PORTS.qbittorrent}, which isn't answering.`);
    expect(entries()).toEqual([before]);
  });
}

for (const [label, rest] of [
  ["another sign-in", { host: "10.0.0.80", password: "theirs" }],
  ["this sign-in, which the owner may use twice", { host: "10.0.0.80" }],
] as const) {
  test(`an entry that still answers elsewhere (${label}) is left as it is, and this client joins beside it without a question`, async () => {
    const before = made("qbittorrent", rest);
    const { ctx, entries, questions } = fakes("qbittorrent", { entries: [before], live: [`10.0.0.80:${PORTS.qbittorrent}`], owner: true });
    await qbittorrent(ctx);
    expect(questions).toHaveLength(0);
    expect(entries()[0]).toEqual(before);
    expect(entries()[1]).toMatchObject({ id: 3, host: BOX, port: PORTS.qbittorrent });
  });
}

test("an entry that's off takes no downloads, so it's left as it is and this client is added", async () => {
  const before = made("qbittorrent", { password: "old", enabled: false });
  const { ctx, entries, questions } = fakes("qbittorrent", { entries: [before], owner: true });
  await qbittorrent(ctx);
  expect(questions).toHaveLength(0);
  expect(entries()[0]).toEqual(before);
  expect(entries()[1]).toMatchObject({ id: 3, host: BOX });
});

test("of two entries where nothing answers, the one holding this client's sign-in moves, without a question", async () => {
  const other = made("qbittorrent", { password: "old" });
  const ours = made("qbittorrent", { id: 3, port: 30023 });
  const { ctx, entries, questions } = fakes("qbittorrent", { entries: [other, ours], owner: true });
  await qbittorrent(ctx);
  expect(questions).toHaveLength(0);
  expect(entries()).toEqual([other, { ...ours, host: BOX, port: PORTS.qbittorrent }]);
});

test("a Sportarr that isn't answering yet fails with a plain message before anything is changed", async () => {
  const { ctx } = fakes("qbittorrent", { sportarrDown: true });
  await expect(qbittorrent(ctx)).rejects.toThrow("Sportarr isn't answering yet. Try again once it has started.");
});
