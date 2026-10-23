import { afterEach, describe, expect, test } from "bun:test";
import type { HookContext } from "./hook_context";
import { run as connectJellystat } from "../jellyfin/connect_jellystat";
import { run as checkFladder } from "../jellyfin/check_fladder";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Options {
  state?: number | null;
  existingHost?: string;
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
  let statHost = options.existingHost ?? "";
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
    if (url.hostname === "jf.test") {
      if (url.pathname === "/Users/AuthenticateByName")
        return json({ AccessToken: "jf-session", User: { Policy: { IsAdministrator: options.admin ?? true } } });
      if (url.pathname === "/Auth/Keys" && call.method === "GET")
        return json({ Items: keyExists ? [{ AppName: "Jellystat", AccessToken: "jf-api-key" }] : [] });
      if (url.pathname === "/Auth/Keys" && call.method === "POST") {
        keyExists = true;
        return json({});
      }
      if (url.pathname === "/System/Info/Public")
        return json(
          options.wizard === null ? {} : { StartupWizardCompleted: options.wizard ?? true, ServerName: "Test library" },
        );
    }
    if (url.hostname === "stats.test") {
      if (url.pathname === "/auth/isConfigured")
        return json({ state: options.state === undefined ? 0 : options.state }, options.statSetupStatus ?? 200);
      if (url.pathname === "/auth/createuser")
        return options.state === 2 ? json({}, 403) : json({ token: "stat-session" });
      if (url.pathname === "/auth/login")
        return options.statLoginFails ? json({}, 401) : json({ token: "stat-session" });
      if (url.pathname === "/api/getconfig") return json({ JF_HOST: statHost }, options.statConfigStatus ?? 200);
      if (url.pathname === "/api/setconfig") {
        statHost = String(body.JF_HOST);
        return json({});
      }
    }
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
    throw new Error(`Unexpected request: ${call.method} ${url.hostname}${url.pathname}`);
  }) as typeof fetch;
  const inputs = { admin_username: "owner", admin_password: options.password ?? "password" };
  const ctx = {
    baseUrl: "http://jf.test:8096",
    host: "jf.test",
    port: 8096,
    getInstalledAppUrl: async (id: string) =>
      ({ jellystat: "http://stats.test", seerr: "http://seer.test", fladder: "http://fladder.test" })[id] ?? null,
    getInput: (id: keyof typeof inputs) => inputs[id],
    registerCheckpoints: async () => {},
    emitCheckpoint: async (id: string) => {
      checkpoints.push(id);
    },
    log: () => {},
    fail: (message: string) => {
      throw new Error(message);
    },
  } as unknown as HookContext;
  return { ctx, calls, checkpoints };
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

test("Jellystat preserves an existing binding to another Jellyfin server", async () => {
  const { ctx, calls } = apis({ state: 2, existingHost: "http://another.test:8096" });
  await expect(connectJellystat(ctx)).rejects.toThrow();
  expect(calls.some((c) => c.path === "/api/setconfig")).toBe(false);
});

test("Jellystat refuses a configured account whose server cannot be verified", async () => {
  const { ctx, calls } = apis({ state: 2 });
  await expect(connectJellystat(ctx)).rejects.toThrow(/existing Jellyfin server/);
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
