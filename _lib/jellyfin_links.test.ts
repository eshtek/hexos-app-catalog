import { afterEach, describe, expect, test } from "bun:test";
import type { HookContext } from "./hook_context";
import { run as connectJellystat } from "../jellyfin/connect_jellystat";
import { run as checkFladder } from "../jellyfin/check_fladder";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** This Jellyfin server's id, at jf.test:8096. A reinstall gives the same address a new one. */
const THIS_SERVER = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

class Skipped extends Error {}

interface Options {
  state?: number | null;
  existingHost?: string;
  /** The Jellyfin server id Jellystat saved (`settings.ServerID`), null as a first setup leaves it. */
  serverId?: string | null;
  /** Jellystat's libraries, each with the id of the server it was synced from. */
  libraries?: Array<{ ServerId: string; archived?: boolean }>;
  librariesStatus?: number;
  /** Other Jellyfin servers, by "host:port"; this one always answers at jf.test:8096. */
  servers?: Record<string, { Id: string; ServerName?: string }>;
  /** The answers before any the run is given; a card run has none. */
  inputs?: Record<string, unknown>;
  /** What the owner answers when asked, by input id, "skip" to skip, or "none" for a box that can't ask. */
  owner?: Record<string, unknown> | "skip" | "none";
  statSetupStatus?: number;
  statConfigStatus?: number;
  password?: string;
  admin?: boolean;
  keyExists?: boolean;
  statLoginFails?: boolean;
  initialized?: boolean;
  mediaServerType?: number;
  seerHost?: string;
  seerPort?: number;
  seerSsl?: boolean;
  seerBase?: string;
  missingInitialized?: boolean;
  missingMediaType?: boolean;
  missingCookie?: boolean;
  initializeFails?: boolean;
  initializeNoop?: boolean;
  verifiedType?: number;
  wizard?: boolean | null;
}
interface Call {
  host: string;
  path: string;
  method: string;
  body: Record<string, unknown>;
  headers: Headers;
}

function apis(options: Options = {}) {
  const calls: Call[] = [];
  const checkpoints: string[] = [];
  const questions: Array<{ title?: string; description?: string }> = [];
  let statHost = options.existingHost ?? "";
  let statServerId = options.serverId ?? null;
  const servers: Record<string, { Id: string; ServerName?: string }> = {
    "jf.test:8096": { Id: THIS_SERVER, ServerName: "Test library" },
    ...options.servers,
  };
  /** The server that answers at a Jellyfin address, as Jellystat and HexOS reach it. */
  const serverAt = (address: string) => {
    try {
      return servers[new URL(address).host];
    } catch {
      return undefined;
    }
  };
  let keyExists = options.keyExists ?? false;
  let initialized = options.initialized ?? false;
  let publicReads = 0;
  let mediaServerType = options.mediaServerType ?? (initialized ? 2 : 0);
  const json = (value: unknown, status = 200, headers?: HeadersInit) => Response.json(value, { status, headers });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const call = {
      host: url.hostname,
      path: url.pathname,
      method: init?.method ?? "GET",
      body,
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    if (url.host === "jf.test:8096") {
      if (url.pathname === "/Users/AuthenticateByName")
        return json({ AccessToken: "jf-session", User: { Policy: { IsAdministrator: options.admin ?? true } } });
      // As Jellyfin 12 does with EnableLegacyAuthorization off: a token counts only in Authorization
      if (url.pathname === "/Auth/Keys" && call.headers.get("Authorization") !== 'MediaBrowser Token="jf-session"')
        return json({}, 401);
      if (url.pathname === "/Auth/Keys" && call.method === "GET")
        return json({ Items: keyExists ? [{ AppName: "Jellystat", AccessToken: "jf-api-key" }] : [] });
      if (url.pathname === "/Auth/Keys" && call.method === "POST") {
        keyExists = true;
        return json({});
      }
      if (url.pathname === "/System/Info/Public")
        return json(
          options.wizard === null
            ? {}
            : { Id: THIS_SERVER, StartupWizardCompleted: options.wizard ?? true, ServerName: "Test library" },
        );
    }
    if (url.hostname === "stats.test") {
      if (url.pathname === "/auth/isConfigured")
        return json({ state: options.state === undefined ? 0 : options.state }, options.statSetupStatus ?? 200);
      if (url.pathname === "/auth/createuser")
        return options.state === 2 ? json({}, 403) : json({ token: "stat-session" });
      if (url.pathname === "/auth/login")
        return options.statLoginFails ? json({}, 401) : json({ token: "stat-session" });
      // Jellystat leaves its API key out of what it shows
      if (url.pathname === "/api/getconfig")
        return json(
          { JF_HOST: statHost, APP_USER: "owner", settings: { ServerID: statServerId }, REQUIRE_LOGIN: true, IS_JELLYFIN: true },
          options.statConfigStatus ?? 200,
        );
      if (url.pathname === "/api/getLibraries")
        return json(
          (options.libraries ?? []).map((library, index) => ({ Id: `library-${index}`, Name: `Library ${index}`, archived: false, ...library })),
          options.librariesStatus ?? 200,
        );
      if (url.pathname === "/api/setconfig") {
        // Jellystat checks the key at the address before it keeps either (validateSettings), and only
        // this server made the key
        if (serverAt(String(body.JF_HOST))?.Id !== THIS_SERVER || body.JF_API_KEY !== "jf-api-key")
          return json({ isValid: false, errorMessage: "401 Unauthorized" }, 401);
        // It saves the id of the server its old settings reach (systemInfo runs before it rereads
        // them), and none on its first setup
        statServerId = statHost ? (serverAt(statHost)?.Id ?? null) : null;
        statHost = String(body.JF_HOST);
        return json({});
      }
    }
    if (servers[url.host] && url.pathname === "/System/Info/Public") return json(servers[url.host]);
    if (url.hostname === "seer.test") {
      if (url.pathname === "/api/v1/settings/public") {
        publicReads += 1;
        return json(
          options.missingInitialized
            ? { mediaServerType }
            : {
                initialized,
                ...(options.missingMediaType
                  ? {}
                  : { mediaServerType: publicReads > 1 ? (options.verifiedType ?? mediaServerType) : mediaServerType }),
              },
        );
      }
      if (url.pathname === "/api/v1/auth/jellyfin") {
        if (mediaServerType === 2 && body.hostname) return json({ error: "Jellyfin hostname already configured" }, 500);
        mediaServerType = 2;
        return json(
          {},
          200,
          options.missingCookie ? {} : { "set-cookie": "connect.sid=seer-session; Path=/; HttpOnly" },
        );
      }
      if (url.pathname === "/api/v1/settings/jellyfin")
        return json({
          ip: options.seerHost ?? "jf.test",
          port: options.seerPort ?? 8096,
          useSsl: options.seerSsl ?? false,
          urlBase: options.seerBase ?? "",
        });
      if (url.pathname === "/api/v1/settings/initialize") {
        if (options.initializeFails) return json({}, 503);
        if (!options.initializeNoop) initialized = true;
        return json({ initialized });
      }
    }
    if (url.hostname === "fladder.test" && url.pathname === "/") return new Response("Fladder");
    // Another Jellyfin address that nothing answers at
    if (!["jf.test", "stats.test", "seer.test", "fladder.test"].includes(url.hostname)) throw new TypeError("fetch failed");
    throw new Error(`Unexpected request: ${call.method} ${url.hostname}${url.pathname}`);
  }) as typeof fetch;
  const inputs: Record<string, unknown> = options.inputs ?? { admin_username: "owner", admin_password: options.password ?? "password" };
  const unanswered = () => Object.assign(new Error("unanswered"), { name: "HookInputsUnanswered" });
  const owner = options.owner;
  const ctx = {
    baseUrl: "http://jf.test:8096",
    host: "jf.test",
    port: 8096,
    inputs,
    getInstalledAppUrl: async (id: string) =>
      ({ jellystat: "http://stats.test", seerr: "http://seer.test", fladder: "http://fladder.test" })[id] ?? null,
    // As the platform's does: an answer the run wasn't given throws
    getInput: (id: string) => {
      if (inputs[id] === undefined) throw new Error(`Missing required input: ${id}`);
      return inputs[id];
    },
    ...(owner === "none"
      ? {}
      : {
          askForInputs: async (declared: Array<{ id: string }>, prompt?: { title?: string; description?: string }) => {
            questions.push(prompt ?? {});
            if (owner === undefined || owner === "skip") throw unanswered();
            const answers: Record<string, unknown> = {};
            for (const { id } of declared) {
              if (owner[id] === undefined) throw unanswered();
              answers[id] = owner[id];
            }
            return answers;
          },
        }),
    registerCheckpoints: async () => {},
    emitCheckpoint: async (id: string) => {
      checkpoints.push(id);
    },
    log: () => {},
    fail: (message: string) => {
      throw new Error(message);
    },
    skip: (message: string) => {
      throw new Skipped(message);
    },
  } as unknown as HookContext;
  return { ctx, calls, checkpoints, questions, jellystat: () => ({ host: statHost, serverId: statServerId }) };
}

// Independent Keccak-512 vectors, including UTF-8 and the 72-byte sponge boundary.
const vectors = [
  [
    "",
    "0eab42de4c3ceb9235fc91acffe746b29c29a8c366b7c60e4e67c466f36a4304c00fa9caf9d87976ba469bcbe06713b435f091ef2769fb160cdab33d3670680e",
  ],
  [
    "password",
    "a6818b8188b36c44d17784c5551f63accc5deaf8786f9d0ad1ae3cd8d887cbab4f777286dbb315fb14854c8774dc0d10b5567e4a705536cc2a1d61ec0a16a7a6",
  ],
  [
    "x".repeat(71),
    "1d5b30925090b531368f10a15c7802f81d40dcf54b20e6eff0286fe072f5b31db35a0744e835b6ff018f571d2607a2633c55a7b6057933d4e285c923b4ed09dc",
  ],
  [
    "x".repeat(72),
    "d30e32f14fc2bd1063cc8f348d8b7106f8660fe3f013e29cc44283bb8f03f31464ab9a8e62052bf83ffe2778be334349d65f2bc93c53bbd69b91c288fa4944b8",
  ],
  [
    "π|€",
    "83dd1158294e7d0ddef5aa4c6ac366d455636b32b75e63b1ef1eff98241c2116de13f24be5a4827d0592ca633f81d25c0aab860af0e12edbada30324d694ac1a",
  ],
] as const;

for (const [password, digest] of vectors) {
  test(`Jellystat creates a fresh account with its UI-compatible digest (${password.length} characters)`, async () => {
    const { ctx, calls, checkpoints } = apis({ password });
    await connectJellystat(ctx);
    expect(calls.find((c) => c.path === "/auth/createuser")?.body).toEqual({ username: "owner", password: digest });
    expect(calls.find((c) => c.path === "/api/setconfig")?.body).toEqual({
      JF_HOST: ctx.baseUrl,
      JF_API_KEY: "jf-api-key",
    });
    expect(checkpoints.at(-1)).toBe("verify");
  });
}

for (const state of [1, 2]) {
  test(`Jellystat signs in without resetting an existing state-${state} account`, async () => {
    const { ctx, calls } = apis({ state, existingHost: state === 2 ? "http://jf.test:8096" : "" });
    await connectJellystat(ctx);
    expect(calls.some((c) => c.path === "/auth/createuser")).toBe(false);
    expect(calls.some((c) => c.path === "/auth/login")).toBe(true);
  });
}

test("Jellystat refuses an unknown account state before creating an account", async () => {
  const { ctx, calls } = apis({ state: null });
  await expect(connectJellystat(ctx)).rejects.toThrow();
  expect(calls.some((c) => c.path === "/auth/createuser" || c.path === "/api/setconfig")).toBe(false);
});

test("Jellystat preserves an existing binding to another Jellyfin server that still answers, without asking", async () => {
  const servers = { "another.test:8096": { Id: "friends-server", ServerName: "Friend's Jellyfin" } };
  const { ctx, calls, questions } = apis({ state: 2, existingHost: "http://another.test:8096", servers, owner: { switch: true } });
  const refused = await connectJellystat(ctx).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(Skipped);
  expect((refused as Error).message).toMatch(/another Jellyfin server/);
  expect(calls.some((c) => c.path === "/api/setconfig")).toBe(false);
  expect(questions).toHaveLength(0);
});

test("Jellystat moved to another server in its own settings is left alone while that server answers, though its saved id names this one", async () => {
  // Jellystat saves the id its old settings reach, so after a move in its own settings it still names this server
  const servers = { "another.test:8096": { Id: "friends-server" } };
  const libraries = [{ ServerId: THIS_SERVER }];
  const { ctx, calls } = apis({ state: 2, existingHost: "http://another.test:8096", serverId: THIS_SERVER, libraries, servers });
  await expect(connectJellystat(ctx)).rejects.toThrow(/another Jellyfin server/);
  expect(calls.some((c) => c.path === "/api/setconfig")).toBe(false);
});

const setconfig = (calls: Call[]) => calls.find((c) => c.path === "/api/setconfig")?.body;

for (const [label, existingHost] of [
  ["the box's address changed", "http://10.0.0.30:8096"],
  ["Jellyfin's port changed", "http://jf.test:8097"],
] as const) {
  const named: Array<[string, Options]> = [
    ["its saved id", { serverId: THIS_SERVER }],
    ["its libraries, before it has saved an id", { serverId: null, libraries: [{ ServerId: THIS_SERVER }] }],
    [
      "its saved id and libraries, beside an archived one from an older server",
      { serverId: THIS_SERVER, libraries: [{ ServerId: THIS_SERVER }, { ServerId: "old-server", archived: true }] },
    ],
  ];
  for (const [records, saved] of named) {
    test(`Jellystat at an address that answers nothing moves to this server without asking when ${records} names it (${label})`, async () => {
      const { ctx, calls, questions, checkpoints, jellystat } = apis({ state: 2, existingHost, keyExists: true, ...saved });
      await connectJellystat(ctx);
      expect(setconfig(calls)).toEqual({ JF_HOST: ctx.baseUrl, JF_API_KEY: "jf-api-key" });
      expect(jellystat().host).toBe(ctx.baseUrl);
      expect(questions).toHaveLength(0);
      expect(checkpoints.at(-1)).toBe("verify");
    });
  }
}

test("Jellystat on a reinstalled Jellyfin at the same address gets a key from the new server", async () => {
  const { ctx, calls } = apis({ state: 2, existingHost: "http://jf.test:8096", serverId: "old-server", keyExists: false });
  await connectJellystat(ctx);
  expect(calls.some((c) => c.path === "/Auth/Keys" && c.method === "POST")).toBe(true);
  expect(setconfig(calls)).toEqual({ JF_HOST: ctx.baseUrl, JF_API_KEY: "jf-api-key" });
});

test("Jellystat at an address the owner wrote that now answers as this server, reinstalled, keeps that address", async () => {
  const servers = { "jellyfin.home.test:8096": { Id: THIS_SERVER } };
  const libraries = [{ ServerId: "old-server" }];
  const existingHost = "http://jellyfin.home.test:8096";
  const { ctx, calls, questions } = apis({ state: 2, existingHost, serverId: "old-server", libraries, servers });
  await connectJellystat(ctx);
  expect(setconfig(calls)).toEqual({ JF_HOST: existingHost, JF_API_KEY: "jf-api-key" });
  expect(questions).toHaveLength(0);
});

const unproven: Array<[string, Options]> = [
  ["its records name another server", { serverId: "old-server" }],
  ["it has no records", {}],
  ["its saved id names this server and a library another", { serverId: THIS_SERVER, libraries: [{ ServerId: THIS_SERVER }, { ServerId: "old-server" }] }],
  ["its libraries can't be read", { serverId: THIS_SERVER, librariesStatus: 503 }],
];
for (const [label, saved] of unproven) {
  test(`Jellystat whose server doesn't answer and ${label} asks the owner, and moves when they say so`, async () => {
    const { ctx, calls, questions } = apis({ state: 2, existingHost: "http://10.0.0.30:8096", owner: { switch: true }, ...saved });
    await connectJellystat(ctx);
    expect(questions.map((q) => q.description)).toEqual(["Jellystat uses http://10.0.0.30:8096, which isn't answering."]);
    expect(setconfig(calls)).toEqual({ JF_HOST: ctx.baseUrl, JF_API_KEY: "jf-api-key" });
  });
}

for (const owner of [{ switch: false }, "skip", "none"] as const) {
  test(`Jellystat whose other server doesn't answer stays as it is when the owner doesn't move it (${JSON.stringify(owner)})`, async () => {
    const { ctx, calls, jellystat } = apis({ state: 2, existingHost: "http://10.0.0.30:8096", serverId: "old-server", owner });
    await expect(connectJellystat(ctx)).rejects.toThrow(/another Jellyfin server/);
    expect(setconfig(calls)).toBeUndefined();
    expect(calls.some((c) => c.path === "/Auth/Keys" && c.method === "POST")).toBe(false);
    expect(jellystat()).toEqual({ host: "http://10.0.0.30:8096", serverId: "old-server" });
  });
}

test("Connect to Jellystat from the card, with no sign-in and no inputs, asks for Jellyfin's administrator and connects", async () => {
  const { ctx, calls, questions, checkpoints } = apis({ inputs: {}, owner: { username: "owner", password: "password" } });
  await connectJellystat(ctx);
  expect(questions.map((q) => q.title)).toEqual(["Sign in to Jellyfin"]);
  expect(calls.find((c) => c.path === "/Users/AuthenticateByName")?.body).toMatchObject({ Username: "owner", Pw: "password" });
  expect(setconfig(calls)).toEqual({ JF_HOST: ctx.baseUrl, JF_API_KEY: "jf-api-key" });
  expect(checkpoints.at(-1)).toBe("verify");
});

test("Connect to Jellystat from the card steps aside when nobody gives Jellyfin's administrator", async () => {
  const { ctx, calls } = apis({ inputs: {}, owner: "skip" });
  await expect(connectJellystat(ctx)).rejects.toThrow(Skipped);
  expect(calls.some((c) => c.host === "jf.test" || c.path === "/api/setconfig")).toBe(false);
});

test("Jellystat refuses a configured account whose server cannot be verified", async () => {
  const { ctx, calls } = apis({ state: 2 });
  await expect(connectJellystat(ctx)).rejects.toThrow(/existing Jellyfin server/);
  expect(calls.some((c) => c.path === "/api/setconfig")).toBe(false);
});

test("Jellystat isn't moved while this Jellyfin doesn't say which server it is", async () => {
  const { ctx, calls } = apis({ state: 2, existingHost: "http://10.0.0.30:8096", serverId: THIS_SERVER, wizard: null, owner: { switch: true } });
  await expect(connectJellystat(ctx)).rejects.toThrow("Jellyfin didn't answer");
  expect(calls.some((c) => c.path === "/api/setconfig")).toBe(false);
});

for (const options of [{ statSetupStatus: 503 }, { statConfigStatus: 503 }]) {
  test(`Jellystat refuses an unreadable preflight (${Object.keys(options)[0]})`, async () => {
    const { ctx, calls } = apis(options);
    await expect(connectJellystat(ctx)).rejects.toThrow();
    expect(calls.some((c) => c.path === "/api/setconfig")).toBe(false);
  });
}

test("Jellystat takes the run's sign-in over inherited answers", async () => {
  const { ctx, calls } = apis();
  (ctx as unknown as { signIn: { username: string; password: string } }).signIn = { username: "chosen", password: "chosen-password" };
  await connectJellystat(ctx);
  expect(calls.find((c) => c.path === "/Users/AuthenticateByName")?.body).toMatchObject({ Username: "chosen", Pw: "chosen-password" });
  expect(calls.find((c) => c.path === "/auth/createuser")?.body.username).toBe("chosen");
});

// A Jellyfin the owner already had keeps its own administrator (Aaron, 2026-11-08), which the run's
// new sign-in never became
test("Jellystat takes a kept Jellyfin's own administrator over the run's sign-in", async () => {
  const { ctx, calls } = apis();
  Object.assign(ctx, {
    resourceId: "jellyfin",
    signIn: { username: "chosen", password: "chosen-password" },
    existingSignIns: { jellyfin: { username: "jellyadmin", password: "their-own" } },
  });
  await connectJellystat(ctx);
  expect(calls.find((c) => c.path === "/Users/AuthenticateByName")?.body).toMatchObject({ Username: "jellyadmin", Pw: "their-own" });
});

test("Jellystat reuses its named API key", async () => {
  const { ctx, calls } = apis({ keyExists: true });
  await connectJellystat(ctx);
  expect(calls.some((c) => c.path === "/Auth/Keys" && c.method === "POST")).toBe(false);
});

test("Jellystat refuses a non-admin Jellyfin account", async () => {
  const { ctx, calls } = apis({ admin: false });
  await expect(connectJellystat(ctx)).rejects.toThrow(/administrator/);
  expect(calls.some((c) => c.path === "/Auth/Keys" || c.path === "/api/setconfig")).toBe(false);
});

for (const wizard of [true, false, null]) {
  test(`Fladder checks the link without writes (wizard ${wizard})`, async () => {
    const { ctx, calls } = apis({ wizard });
    if (wizard === true) await checkFladder(ctx);
    else await expect(checkFladder(ctx)).rejects.toThrow();
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });
}
