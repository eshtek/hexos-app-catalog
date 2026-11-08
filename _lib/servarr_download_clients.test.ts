import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookContext } from "./hook_context";
import { deluge, nzbget, qbittorrent, sabnzbd } from "../servarr/connect_download_client";

// A download client's link from Radarr, against fakes of Radarr's provider API and the four clients.
// Radarr names each client once, whatever its case, and shows a password or key it holds as ********,
// testing an entry sent by id with the one it holds (ProviderControllerBase, SchemaBuilder). Run again
// after the box's address or a client's port changed, the link moves Radarr's entry to the client with
// proof it was this one, or with the owner's yes once nothing answers at its address; never one that
// may be another client the owner chose, and never by adding a second entry under the same name.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const BOX = "10.0.0.5";
const OLD_BOX = "10.0.0.30";
const RADARR = { port: 30025, key: "radarr-key" };
const MASK = "********";
const SIGN_IN = { username: "owner", password: "chosen-password" };
const SAB_KEY = "sab-key-of-this-box";

const PORTS = { qbittorrent: 30024, deluge: 30095, sabnzbd: 30055, nzbget: 30057 } as const;
type ClientId = keyof typeof PORTS;
const IMPLEMENTATIONS: Record<ClientId, string> = { qbittorrent: "QBittorrent", deluge: "Deluge", sabnzbd: "Sabnzbd", nzbget: "Nzbget" };
const NAMES: Record<ClientId, string> = { qbittorrent: "qBittorrent", deluge: "Deluge", sabnzbd: "SABnzbd", nzbget: "NZBGet" };
const SECRET_FIELDS = new Set(["password", "apiKey"]);
const FIELDS: Record<string, string[]> = {
  QBittorrent: ["host", "port", "useSsl", "urlBase", "username", "password", "movieCategory"],
  Deluge: ["host", "port", "useSsl", "urlBase", "password", "movieCategory", "downloadDirectory", "completedDirectory"],
  Sabnzbd: ["host", "port", "useSsl", "urlBase", "apiKey", "username", "password", "movieCategory"],
  Nzbget: ["host", "port", "useSsl", "urlBase", "username", "password", "movieCategory"],
  Transmission: ["host", "port", "useSsl", "urlBase", "username", "password", "movieCategory"],
};

interface Field {
  name: string;
  value?: unknown;
}

interface Entry {
  id: number;
  name: string;
  implementation: string;
  enable: boolean;
  priority: number;
  fields: Field[];
}

/** A client as Radarr holds it: plain values by field name. */
type Stored = { id: number; name: string; implementation: string; enable?: boolean; priority?: number; values: Record<string, unknown> };

interface Options {
  /** Radarr's entries before the run, with what Radarr holds in plain. */
  entries?: Stored[];
  /** Addresses ("host:port") where something answers besides this box's clients. */
  live?: string[];
  /** The owner's answer when asked, "skip" to skip the question, "none" for a box that can't ask. */
  owner?: boolean | "skip" | "none";
  /** NZBGet's sign-in in its settings file. */
  nzbgetSignIn?: { username: string; password: string };
  /** Radarr isn't up yet. */
  radarrDown?: boolean;
  /** Entries Radarr has but leaves out of its list, as one added while the link runs would be. */
  unlisted?: Stored[];
}

class Skipped extends Error {}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "servarr-clients-"));
});

function dir(...parts: string[]) {
  const path = join(root, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

function fakes(clientId: ClientId, options: Options = {}) {
  const nzbgetSignIn = options.nzbgetSignIn ?? SIGN_IN;
  // What each of this box's clients takes, at its address
  const secrets: Record<ClientId, Record<string, string>> = {
    qbittorrent: SIGN_IN,
    deluge: { password: SIGN_IN.password },
    sabnzbd: { apiKey: SAB_KEY },
    nzbget: nzbgetSignIn,
  };
  const stored = new Map<number, Stored>();
  for (const entry of [...(options.entries ?? []), ...(options.unlisted ?? [])]) stored.set(entry.id, structuredClone(entry));
  const unlisted = new Set((options.unlisted ?? []).map((entry) => entry.id));
  let nextId = Math.max(0, ...stored.keys()) + 1;
  const tests: Array<Record<string, unknown>> = [];
  const questions: string[] = [];
  const probes: string[] = [];
  const checkpoints: Array<{ id: string; message?: string }> = [];
  const live = new Set(options.live ?? []);

  const masked = (entry: Stored): Entry => ({
    id: entry.id,
    name: entry.name,
    implementation: entry.implementation,
    enable: entry.enable ?? true,
    priority: entry.priority ?? 1,
    fields: FIELDS[entry.implementation].map((name) => {
      const value = entry.values[name];
      return { name, value: SECRET_FIELDS.has(name) && value !== undefined && value !== "" ? MASK : value };
    }),
  });
  // ReadFromSchema: a masked secret on an entry Radarr knows is the one it holds
  const resolve = (body: Entry, known: Stored | undefined): Record<string, unknown> =>
    Object.fromEntries(body.fields.map((field) => [field.name, field.value === MASK && known && SECRET_FIELDS.has(field.name) ? known.values[field.name] : field.value]));
  const failures = (values: Record<string, unknown>, implementation: string): string | undefined => {
    const id = (Object.keys(IMPLEMENTATIONS) as ClientId[]).find((each) => IMPLEMENTATIONS[each] === implementation);
    if (!id || values.host !== BOX || Number(values.port) !== PORTS[id]) return `Unable to connect to ${implementation}`;
    const wanted = secrets[id];
    if (Object.entries(wanted).some(([field, value]) => values[field] !== value)) return "Authentication failed";
    return undefined;
  };
  const refuse = (errorMessage: string, propertyName = "") => Response.json([{ propertyName, errorMessage }], { status: 400 });
  const clash = (name: string, id?: number) => [...stored.values()].some((entry) => entry.name.toLowerCase() === name.toLowerCase() && entry.id !== id);

  const radarr = (url: URL, method: string, body: unknown) => {
    const path = url.pathname.replace("/api/v3", "");
    const force = url.searchParams.get("forceSave") === "true";
    if (path === "/downloadclient" && method === "GET") return Response.json([...stored.values()].filter((e) => !unlisted.has(e.id)).map(masked));
    if (path === "/downloadclient/schema") {
      return Response.json(Object.keys(FIELDS).map((implementation) => ({ name: "", implementation, enable: true, priority: 1, fields: FIELDS[implementation].map((name) => ({ name, value: "" })) })));
    }
    if (path === "/downloadclient/test") {
      const entry = body as Entry;
      const values = resolve(entry, entry.id ? stored.get(entry.id) : undefined);
      tests.push(values);
      const failure = failures(values, entry.implementation);
      return failure ? refuse(failure) : new Response(null, { status: 204 });
    }
    if (path === "/downloadclient" && method === "POST") {
      const entry = body as Entry;
      if (clash(entry.name)) return refuse("Should be unique", "Name");
      const values = resolve(entry, undefined);
      if (entry.enable) {
        const failure = failures(values, entry.implementation);
        if (failure) return refuse(failure);
      }
      const id = nextId++;
      stored.set(id, { id, name: entry.name, implementation: entry.implementation, enable: entry.enable, priority: entry.priority, values });
      return Response.json({ ...entry, id }, { status: 201 });
    }
    const match = path.match(/^\/downloadclient\/(\d+)$/);
    if (match && method === "PUT") {
      const known = stored.get(Number(match[1]));
      if (!known) return new Response(null, { status: 404 });
      const entry = body as Entry;
      if (clash(entry.name, known.id)) return refuse("Should be unique", "Name");
      const values = resolve(entry, known);
      if (entry.enable && !force) {
        const failure = failures(values, entry.implementation);
        if (failure) return refuse(failure);
      }
      stored.set(known.id, { ...known, name: entry.name, enable: entry.enable, priority: entry.priority, values });
      return Response.json({ ...entry, id: known.id }, { status: 202 });
    }
    throw new Error(`Unexpected Radarr request: ${method} ${url.pathname}`);
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : init?.body;
    if (url.hostname === BOX && Number(url.port) === RADARR.port) {
      if (options.radarrDown) throw new TypeError("fetch failed");
      if (url.pathname === "/ping") return Response.json({ status: "OK" });
      if (new Headers(init?.headers).get("X-Api-Key") !== RADARR.key) return new Response(null, { status: 401 });
      return radarr(url, method, body);
    }
    if (url.hostname === BOX && Number(url.port) === PORTS[clientId]) return client(clientId, url, init, body);
    probes.push(url.host);
    if (live.has(url.host)) return new Response("a web page");
    throw new TypeError("fetch failed");
  }) as typeof fetch;

  const client = (id: ClientId, url: URL, init: RequestInit | undefined, body: unknown) => {
    if (id === "qbittorrent") {
      // Not the home network, so it asks for a sign-in
      if (url.pathname === "/api/v2/app/version") return new Response("Forbidden", { status: 403 });
      if (url.pathname === "/api/v2/auth/login") {
        const form = new URLSearchParams(String(init?.body));
        const ok = form.get("username") === SIGN_IN.username && form.get("password") === SIGN_IN.password;
        return new Response(ok ? "Ok." : "Fails.");
      }
    }
    if (id === "deluge") {
      const call = body as { method: string; params: unknown[] };
      const result: Record<string, unknown> = {
        "auth.login": call.params?.[0] === SIGN_IN.password,
        "web.connected": true,
        "system.listMethods": ["label.get_labels"],
      };
      if (call.method in result) return Response.json({ result: result[call.method], error: null, id: 1 });
    }
    if (id === "sabnzbd") {
      if (url.searchParams.get("apikey") !== SAB_KEY) return Response.json({ error: "API Key Incorrect" }, { status: 403 });
      const mode = url.searchParams.get("mode");
      if (mode === "get_config") return Response.json({ config: { misc: { download_dir: "/downloads/sabnzbd/incomplete", complete_dir: "/downloads/sabnzbd/complete" } } });
      if (mode === "get_cats") return Response.json({ categories: ["*", "movies", "tv"] });
    }
    if (id === "nzbget") {
      const auth = Buffer.from(`${nzbgetSignIn.username}:${nzbgetSignIn.password}`).toString("base64");
      if (new Headers(init?.headers).get("Authorization") !== `Basic ${auth}`) return new Response(null, { status: 401 });
      const options = [
        { Name: "MainDir", Value: "/downloads/nzbget" },
        { Name: "Category1.Name", Value: "Movies" },
      ];
      return Response.json({ result: options, error: null });
    }
    throw new Error(`Unexpected ${id} request: ${url.pathname}`);
  };

  // Each client's settings, where the link reads its key or sign-in
  const clientConfig = dir(clientId, "config");
  writeFileSync(join(clientConfig, "sabnzbd.ini"), `api_key = ${SAB_KEY}\n`);
  writeFileSync(join(clientConfig, "nzbget.conf"), `ControlUsername=${nzbgetSignIn.username}\nControlPassword=${nzbgetSignIn.password}\n`);
  writeFileSync(join(clientConfig, "core.conf"), `{"file": 1, "format": 1}{"enabled_plugins": ["Label"]}`);
  const radarrConfig = dir("radarr", "config");
  writeFileSync(join(radarrConfig, "config.xml"), `<Config><ApiKey>${RADARR.key}</ApiKey></Config>`);

  const ctx = {
    resourceId: "radarr",
    catalogAppId: "radarr",
    baseUrl: `http://${BOX}:${RADARR.port}`,
    mounts: [{ containerPath: "/config", hostPath: "/mnt/pool/apps/radarr/config", localPath: radarrConfig }],
    signIn: SIGN_IN,
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
  const entries = () => [...stored.values()];
  return { ctx, entries, tests, questions, probes, checkpoints };
}

const links = { qbittorrent, deluge, sabnzbd, nzbget };

/** An entry HexOS made for a client, at the address it had then. */
function made(clientId: ClientId, at: { host?: string; port?: number }, values: Record<string, unknown> = {}): Stored {
  return {
    id: 4,
    name: NAMES[clientId],
    implementation: IMPLEMENTATIONS[clientId],
    values: { host: at.host ?? BOX, port: at.port ?? PORTS[clientId], useSsl: false, urlBase: "", movieCategory: "radarr", ...values },
  };
}

const secretsOf: Record<ClientId, Record<string, unknown>> = {
  qbittorrent: SIGN_IN,
  deluge: { password: SIGN_IN.password },
  sabnzbd: { apiKey: SAB_KEY },
  nzbget: SIGN_IN,
};

test("a client Radarr doesn't have yet is added under its name", async () => {
  const { ctx, entries, questions } = fakes("qbittorrent");
  await qbittorrent(ctx);
  expect(entries()).toHaveLength(1);
  expect(entries()[0]).toMatchObject({ name: "qBittorrent", values: { host: BOX, port: PORTS.qbittorrent, ...SIGN_IN } });
  expect(questions).toHaveLength(0);
});

test("an entry at the client's own address is updated in place, without a question", async () => {
  const { ctx, entries, questions } = fakes("qbittorrent", { entries: [made("qbittorrent", {}, { username: "old", password: "old" })] });
  await qbittorrent(ctx);
  expect(entries()).toHaveLength(1);
  expect(entries()[0]).toMatchObject({ id: 4, values: SIGN_IN });
  expect(questions).toHaveLength(0);
});

for (const clientId of ["qbittorrent", "deluge"] as const) {
  test(`${NAMES[clientId]}: after the box's address changed, the owner is asked about the old one and it moves when they say so`, async () => {
    const before = made(clientId, { host: OLD_BOX }, secretsOf[clientId]);
    const { ctx, entries, questions, checkpoints } = fakes(clientId, { entries: [before], owner: true });
    await links[clientId](ctx);
    expect(questions).toEqual([`Radarr sends downloads to ${NAMES[clientId]} at ${OLD_BOX}:${PORTS[clientId]}, which isn't answering.`]);
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ id: 4, values: { host: BOX, port: PORTS[clientId], ...secretsOf[clientId] } });
    expect(checkpoints.at(-1)).toEqual({ id: "configure", message: `Radarr reaches ${NAMES[clientId]} at its new address` });
  });

  for (const owner of [false, "skip", "none"] as const) {
    test(`${NAMES[clientId]}: the old entry stays as it is when the owner doesn't move it (${owner}), and no second one is added`, async () => {
      const before = made(clientId, { host: OLD_BOX }, secretsOf[clientId]);
      const { ctx, entries } = fakes(clientId, { entries: [before], owner });
      const run = links[clientId](ctx);
      await expect(run).rejects.toThrow(Skipped);
      await expect(run).rejects.toThrow(`Radarr already has a download client named ${NAMES[clientId]}, at ${OLD_BOX}:${PORTS[clientId]}.`);
      expect(entries()).toEqual([before]);
    });
  }

  test(`${NAMES[clientId]}: an entry under its name that still answers elsewhere is left alone, without a question`, async () => {
    const before = made(clientId, { host: "10.0.0.80" }, secretsOf[clientId]);
    const { ctx, entries, questions } = fakes(clientId, { entries: [before], live: [`10.0.0.80:${PORTS[clientId]}`], owner: true });
    await expect(links[clientId](ctx)).rejects.toThrow(Skipped);
    expect(entries()).toEqual([before]);
    expect(questions).toHaveLength(0);
  });
}

test("qBittorrent: the old entry's saved password is never tried, so it can't count toward a lockout", async () => {
  const before = made("qbittorrent", { host: OLD_BOX }, SIGN_IN);
  const { ctx, tests } = fakes("qbittorrent", { entries: [before], owner: false });
  await expect(qbittorrent(ctx)).rejects.toThrow(Skipped);
  expect(tests).toHaveLength(0);
});

test("a name matches whatever its case, as Radarr's own check does", async () => {
  const before = { ...made("qbittorrent", { host: OLD_BOX }, SIGN_IN), name: "QBITTORRENT" };
  const { ctx, entries, questions } = fakes("qbittorrent", { entries: [before], owner: true });
  await qbittorrent(ctx);
  expect(questions).toHaveLength(1);
  expect(entries()).toHaveLength(1);
  expect(entries()[0]).toMatchObject({ id: 4, name: "QBITTORRENT", values: { host: BOX } });
});

test("an entry under the name that's another kind of client is left alone, without a question", async () => {
  const before: Stored = { id: 4, name: "qBittorrent", implementation: "Transmission", values: { host: OLD_BOX, port: 9091 } };
  const { ctx, entries, questions } = fakes("qbittorrent", { entries: [before], owner: true });
  await expect(qbittorrent(ctx)).rejects.toThrow(Skipped);
  expect(entries()).toEqual([before]);
  expect(questions).toHaveLength(0);
});

for (const [label, at, live] of [
  ["SABnzbd's port changed", { port: 30054 }, []],
  ["the box's address changed, and it still reaches this box", { host: OLD_BOX }, [`${OLD_BOX}:${PORTS.sabnzbd}`]],
] as const) {
  test(`SABnzbd: an entry holding this SABnzbd's own key moves here without a question (${label})`, async () => {
    const before = made("sabnzbd", at, { apiKey: SAB_KEY });
    const { ctx, entries, questions, tests } = fakes("sabnzbd", { entries: [before], live: [...live], owner: false });
    await sabnzbd(ctx);
    // The proof went out with the key Radarr holds, not this one
    expect(tests[0]).toMatchObject({ host: BOX, port: PORTS.sabnzbd, apiKey: SAB_KEY });
    expect(questions).toHaveLength(0);
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ id: 4, values: { host: BOX, port: PORTS.sabnzbd, apiKey: SAB_KEY } });
  });
}

test("SABnzbd: an entry with another SABnzbd's key that still answers is left alone, without a question", async () => {
  const before = made("sabnzbd", { host: "10.0.0.80" }, { apiKey: "another-sab" });
  const { ctx, entries, questions } = fakes("sabnzbd", { entries: [before], live: [`10.0.0.80:${PORTS.sabnzbd}`], owner: true });
  await expect(sabnzbd(ctx)).rejects.toThrow("Radarr already has a download client named SABnzbd, at 10.0.0.80:30055.");
  expect(entries()).toEqual([before]);
  expect(questions).toHaveLength(0);
});

test("SABnzbd: an entry with another key where nothing answers moves only when the owner says so", async () => {
  const before = made("sabnzbd", { host: OLD_BOX }, { apiKey: "reinstalled-sab" });
  const asked = fakes("sabnzbd", { entries: [before], owner: true });
  await sabnzbd(asked.ctx);
  expect(asked.questions).toHaveLength(1);
  expect(asked.entries()[0]).toMatchObject({ id: 4, values: { host: BOX, apiKey: SAB_KEY } });

  const declined = fakes("sabnzbd", { entries: [before], owner: false });
  await expect(sabnzbd(declined.ctx)).rejects.toThrow(Skipped);
  expect(declined.entries()).toEqual([before]);
});

test("NZBGet: an entry with this NZBGet's own sign-in moves here without a question once nothing answers at its address", async () => {
  const before = made("nzbget", { host: OLD_BOX }, SIGN_IN);
  const { ctx, entries, questions } = fakes("nzbget", { entries: [before], owner: false });
  await nzbget(ctx);
  expect(questions).toHaveLength(0);
  expect(entries()[0]).toMatchObject({ id: 4, values: { host: BOX, port: PORTS.nzbget, ...SIGN_IN } });
});

test("NZBGet: an entry with the same sign-in that still answers elsewhere is left alone, since the owner may use it twice", async () => {
  const before = made("nzbget", { host: "10.0.0.80" }, SIGN_IN);
  const { ctx, entries, questions } = fakes("nzbget", { entries: [before], live: [`10.0.0.80:${PORTS.nzbget}`], owner: true });
  await expect(nzbget(ctx)).rejects.toThrow(Skipped);
  expect(entries()).toEqual([before]);
  expect(questions).toHaveLength(0);
});

for (const shared of [
  { username: "nzbget", password: "tegbzn6789" },
  { username: "admin", password: "admin" },
]) {
  test(`NZBGet: a sign-in many NZBGets have (${shared.username}) proves nothing, so the owner is asked`, async () => {
    const before = made("nzbget", { host: OLD_BOX }, shared);
    const { ctx, entries, questions, tests } = fakes("nzbget", { entries: [before], nzbgetSignIn: shared, owner: true });
    await nzbget(ctx);
    expect(questions).toHaveLength(1);
    // No proof was tried, and the save went out with the sign-in NZBGet takes
    expect(tests).toHaveLength(0);
    expect(entries()[0]).toMatchObject({ id: 4, values: { host: BOX, ...shared } });
  });
}

test("a second entry under the name that Radarr doesn't list yet is reported as a name taken, not as a client it can't reach", async () => {
  const { ctx } = fakes("qbittorrent", { unlisted: [made("qbittorrent", { host: OLD_BOX }, SIGN_IN)] });
  // A run again lists it and checks it, so this one isn't skipped
  const run = qbittorrent(ctx);
  await expect(run).rejects.toThrow("Radarr already has a download client named qBittorrent. Run Connect to qBittorrent again to check it.");
  await expect(run).rejects.not.toThrow(Skipped);
});

test("a Radarr that isn't answering yet fails with a plain message before anything is changed", async () => {
  const { ctx } = fakes("qbittorrent", { radarrDown: true });
  await expect(qbittorrent(ctx)).rejects.toThrow("Radarr isn't answering yet. Try again once it has started.");
});

// A Deluge the owner already had keeps its password, which they gave in the collection's walk
// (Aaron, 2026-11-08): the manager gets that one, without asking for it again
test("Deluge: a kept Deluge's own password is the one the manager gets, ahead of the run's sign-in", async () => {
  const { ctx, entries, questions } = fakes("deluge");
  Object.assign(ctx, {
    signIn: { username: "admin", password: "the-runs-new-password" },
    existingSignIns: { deluge: { username: "", password: SIGN_IN.password } },
  });
  await deluge(ctx);
  expect(entries()[0]).toMatchObject({ name: "Deluge", values: { password: SIGN_IN.password } });
  expect(questions).toHaveLength(0);
});
