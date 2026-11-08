import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configure as configureAudiobookshelf } from "../audiobookshelf/configure";
import { configure as configureDeluge } from "../deluge/configure";
import { afterInstall as setUpEmby } from "../emby/emby_hook";
import { afterInstall as setUpJellyfin } from "../jellyfin/jellyfin_hook";
import { configure as configureKavita } from "../kavita/configure";
import { configure as configureProfilarr } from "../profilarr/profilarr_hook";
import type { HookContext } from "./hook_context";

// An app the owner already had keeps its own admin account when a collection sets it up (Aaron,
// 2026-11-08). The box hands its setup no sign-in to set, only the account the owner gave for it in
// the walk (`ctx.existingSignIns`): the setup signs in with that, and never makes another account or
// changes a password. When the app refuses it, the setup stops and says so, having changed nothing.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const OWN = { username: "owner", password: "their-own-password" };
const CHOSEN = { username: "admin", password: "a-new-password" };

interface Seen {
  /** Every request, as `METHOD /path`. */
  requests: string[];
  asked: number;
}

function context(appId: string, extra: Record<string, unknown> = {}): { ctx: HookContext; seen: Seen } {
  const seen: Seen = { requests: [], asked: 0 };
  const ctx = {
    resourceId: appId,
    catalogAppId: appId,
    baseUrl: `http://${appId}.test`,
    event: "action",
    mounts: [],
    inputs: {},
    registerCheckpoints: async () => {},
    emitCheckpoint: async () => {},
    updateCheckpointMessage: async () => {},
    skipCheckpoint: async () => {},
    awaitCheckpointRetry: async () => "skip",
    askForInputs: async () => {
      seen.asked++;
      throw Object.assign(new Error("skipped"), { name: "HookInputsUnanswered" });
    },
    log: () => {},
    sleep: async () => {},
    fail: (message: string) => {
      throw new Error(message);
    },
    ...extra,
  } as unknown as HookContext;
  return { ctx, seen };
}

const kept = (appId: string, signIn: { username: string; password: string } = OWN) => ({ existingSignIns: { [appId]: signIn } });

/** A fetch that records each request and answers with `answer`'s result. */
function serve(seen: Seen, answer: (method: string, path: string, body: string) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    seen.requests.push(`${method} ${url.pathname}`);
    return answer(method, url.pathname + url.search, typeof init?.body === "string" ? init.body : "");
  }) as typeof fetch;
}

describe.each([
  { name: "Jellyfin", appId: "jellyfin", setUp: setUpJellyfin, prefix: "" },
  { name: "Emby", appId: "emby", setUp: setUpEmby, prefix: "/emby" },
])("$name the owner already had", ({ appId, setUp, prefix }) => {
  const LIBRARIES = ["/movies", "/shows", "/music", "/photos", "/videos"];
  function server(admin = true) {
    const { ctx, seen } = context(appId, kept(appId));
    serve(seen, (method, path, body) => {
      const at = path.startsWith(prefix) ? path.slice(prefix.length) : path;
      if (at === "/Startup/User") return new Response(null, { status: 401 });
      if (at === "/System/Info/Public") return Response.json({ StartupWizardCompleted: true });
      if (at === "/Users/AuthenticateByName") {
        const { Username, Pw } = JSON.parse(body) as { Username: string; Pw: string };
        if (Username !== OWN.username || Pw !== OWN.password) return new Response(null, { status: 401 });
        return Response.json({ AccessToken: "owners-session", User: { Id: "u1", Policy: { IsAdministrator: admin } } });
      }
      if (at.startsWith("/Library/VirtualFolders") && method === "GET") {
        return Response.json(LIBRARIES.map((path, i) => ({ Name: `Library${i}`, Locations: [path] })));
      }
      if (at.startsWith("/Auth/Keys")) return Response.json({ Items: [{ AppName: "HexOS" }] });
      if (at.startsWith("/System/Configuration")) return Response.json({ RemoteClientBitrateLimit: 1 });
      return Response.json({});
    });
    return { ctx, seen };
  }
  const changesAccounts = (requests: string[]) => requests.filter((request) => /\/Users\/(New|[^/]+\/(Password|Policy))$/.test(request));

  test("signs in as the owner's own administrator, and makes or changes no account", async () => {
    const { ctx, seen } = server();
    await setUp(ctx);
    expect(seen.requests).toContain(`POST ${prefix}/Users/AuthenticateByName`);
    expect(changesAccounts(seen.requests)).toEqual([]);
    expect(seen.asked).toBe(0);
  });

  test("stops and says so when it refuses the account, having made none", async () => {
    const { ctx, seen } = server();
    (ctx as unknown as { existingSignIns: unknown }).existingSignIns = kept(appId, { username: OWN.username, password: "a typo" }).existingSignIns;
    await expect(setUp(ctx)).rejects.toThrow(/didn't accept the sign-in you gave/);
    expect(changesAccounts(seen.requests)).toEqual([]);
    expect(seen.requests.some((request) => request.includes("/Library/VirtualFolders"))).toBe(false);
  });

  test("stops when the account isn't an administrator, rather than making it one", async () => {
    const { ctx, seen } = server(false);
    await expect(setUp(ctx)).rejects.toThrow(/isn't an? \w+ administrator/);
    expect(changesAccounts(seen.requests)).toEqual([]);
  });
});

describe("Deluge the owner already had", () => {
  function deluge(password: string, extra: Record<string, unknown> = {}) {
    const { ctx, seen } = context("deluge", { mounts: [{ hostPath: "/mnt/a/deluge/config", containerPath: "/config", localPath: mkdtempSync(join(tmpdir(), "deluge-")) }], ...extra });
    const calls: string[] = [];
    let current = password;
    serve(seen, (_method, _path, body) => {
      const { method, params } = JSON.parse(body) as { method: string; params: unknown[] };
      calls.push(method);
      if (method === "auth.change_password") current = String(params[1]);
      const result =
        method === "auth.login"
          ? params[0] === current
          : method === "auth.change_password" || method === "web.connected"
            ? true
            : method === "core.get_config_values"
              ? { download_location: "/downloads/deluge/incomplete", move_completed: true, move_completed_path: "/downloads/deluge/complete" }
              : true;
      return Response.json({ result, error: null, id: 1 });
    });
    return { ctx, calls };
  }

  test("signs in with the owner's password and changes it in no way, whatever sign-in the run has", async () => {
    const { ctx, calls } = deluge(OWN.password, { ...kept("deluge", { username: "", password: OWN.password }), signIn: CHOSEN });
    await configureDeluge(ctx);
    expect(calls).not.toContain("auth.change_password");
    expect(calls.filter((call) => call === "auth.login")).toHaveLength(1);
  });

  test("stops and says so when it refuses the password, trying no other and changing nothing", async () => {
    const { ctx, calls } = deluge("deluge", { ...kept("deluge", { username: "", password: "a typo" }), signIn: CHOSEN });
    await expect(configureDeluge(ctx)).rejects.toThrow(/didn't accept the password you gave/);
    expect(calls.filter((call) => call === "auth.login")).toHaveLength(1);
    expect(calls).not.toContain("auth.change_password");
  });

  // A fresh install still takes the chosen password in place of Deluge's own
  test("a Deluge HexOS just installed still takes the chosen password", async () => {
    const { ctx, calls } = deluge("deluge", { signIn: CHOSEN });
    await configureDeluge(ctx);
    expect(calls).toContain("auth.change_password");
  });
});

describe.each([
  {
    name: "Kavita",
    appId: "kavita",
    configure: configureKavita,
    hasAccount: (path: string) => path === "/api/Admin/exists",
    signIn: (path: string) => path === "/api/Account/login",
    makesAccount: /\/api\/Account\/register/,
    signedIn: (token: string) => Response.json({ token }),
    noLibraries: () => Response.json([]),
    libraries: /\/api\/Library\/libraries/,
    addsLibrary: /^POST \/api\/Library\/create$/,
  },
  {
    name: "Audiobookshelf",
    appId: "audiobookshelf",
    configure: configureAudiobookshelf,
    hasAccount: (path: string) => path === "/status",
    signIn: (path: string) => path === "/login",
    makesAccount: /\/init$/,
    signedIn: (token: string) => Response.json({ user: { accessToken: token } }),
    noLibraries: () => Response.json({ libraries: [] }),
    libraries: /\/api\/libraries/,
    addsLibrary: /^POST \/api\/libraries$/,
  },
])("$name the owner already had", ({ appId, configure, hasAccount, signIn, makesAccount, signedIn, noLibraries, libraries, addsLibrary }) => {
  function server(password: string, extra: Record<string, unknown>) {
    const { ctx, seen } = context(appId, extra);
    serve(seen, (method, path, body) => {
      if (hasAccount(path)) return appId === "kavita" ? Response.json(true) : Response.json({ isInit: true });
      if (signIn(path)) {
        const given = JSON.parse(body) as { password: string };
        return given.password === password ? signedIn("owners-token") : new Response("no", { status: 401 });
      }
      if (/metadata-providers/.test(path)) return Response.json([0]);
      if (libraries.test(path) && method === "GET") return noLibraries();
      return Response.json({});
    });
    return { ctx, seen };
  }

  test("signs in as the owner's account to add its libraries, and makes none", async () => {
    const { ctx, seen } = server(OWN.password, kept(appId));
    await configure(ctx);
    expect(seen.requests.some((request) => makesAccount.test(request))).toBe(false);
    expect(seen.requests.filter((request) => addsLibrary.test(request))).not.toEqual([]);
  });

  test("stops and says so when it refuses the account, rather than leaving quietly", async () => {
    const { ctx, seen } = server(OWN.password, kept(appId, { username: OWN.username, password: "a typo" }));
    await expect(configure(ctx)).rejects.toThrow(/didn't accept the sign-in you gave/);
    expect(seen.requests.some((request) => makesAccount.test(request))).toBe(false);
  });
});

describe("Profilarr the owner already had", () => {
  function profilarr(password: string, extra: Record<string, unknown>) {
    const config = mkdtempSync(join(tmpdir(), "profilarr-"));
    const { ctx, seen } = context("profilarr", {
      mounts: [{ hostPath: "/mnt/a/profilarr/config", containerPath: "/config", localPath: config }],
      ...extra,
    });
    serve(seen, (_method, path, body) => {
      if (path === "/api/v1/status") return new Response(null, { status: 401 });
      if (path === "/auth/login") {
        const form = new URLSearchParams(body);
        if (form.get("password") !== password) return Response.json({ type: "failure", status: 400 });
        return new Response(JSON.stringify({ type: "redirect", status: 303 }), { headers: { "Set-Cookie": "session=abc; Path=/" } });
      }
      return Response.json({ type: "success" });
    });
    return { ctx, seen };
  }

  test("signs in with the owner's account and changes its password in no way", async () => {
    const { ctx, seen } = profilarr(OWN.password, { ...kept("profilarr"), signIn: CHOSEN });
    await configureProfilarr(ctx);
    expect(seen.requests).toContain("POST /auth/login");
    expect(seen.requests.some((request) => request.includes("changePassword") || request.includes("/auth/setup"))).toBe(false);
    expect(seen.asked).toBe(0);
  });

  test("stops and says so when it refuses the account, trying no other", async () => {
    const { ctx, seen } = profilarr(CHOSEN.password, { ...kept("profilarr", { username: OWN.username, password: "a typo" }), signIn: CHOSEN });
    await expect(configureProfilarr(ctx)).rejects.toThrow(/didn't accept the sign-in you gave/);
    expect(seen.requests.filter((request) => request === "POST /auth/login")).toHaveLength(1);
    expect(seen.requests.some((request) => request.includes("changePassword"))).toBe(false);
  });
});
