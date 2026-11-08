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
import { configure as configureQbittorrent } from "../qbittorrent/configure";
import type { HookContext } from "./hook_context";

// An app the owner already had keeps its own admin account when a collection sets it up (Aaron,
// 2026-11-08). Its setup gets no sign-in to set, only the account the owner gave for it in the walk
// (`ctx.existingSignIns`): it signs in with that, and never makes another account or changes a
// password. A refused account is tried once in the whole run, since an app may lock it after a few
// refusals: the owner gets one chance to put it right, then the run forgets it and every hook that
// needed it stops and says so, naming no username.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const OWN = { username: "owner", password: "their-own-password" };
const TYPO = { username: "owner", password: "a typo" };
const CHOSEN = { username: "admin", password: "a-new-password" };

class Skipped extends Error {}

interface Seen {
  /** Every request, as `METHOD /path`. */
  requests: string[];
  asked: number;
  refused: string[];
  replaced: Array<{ app: string; username: string; password: string }>;
}

interface Run {
  /** The account the owner gave, absent for one an earlier hook found refused. */
  given?: { username: string; password: string };
  /** An earlier hook of the run found the given account refused. */
  refusedBefore?: boolean;
  /** What the owner answers when asked to put a refused account right; unanswered when absent. */
  putRight?: { username?: string; password: string };
  extra?: Record<string, unknown>;
}

/** A kept app's hook context in a collection run. */
function context(appId: string, run: Run = { given: OWN }): { ctx: HookContext; seen: Seen } {
  const seen: Seen = { requests: [], asked: 0, refused: [], replaced: [] };
  const ctx = {
    resourceId: appId,
    catalogAppId: appId,
    baseUrl: `http://${appId}.test`,
    event: "action",
    mounts: [],
    inputs: {},
    keptApps: [appId],
    ...(run.given ? { existingSignIns: { [appId]: run.given } } : {}),
    ...(run.refusedBefore ? { refusedSignIns: [appId] } : {}),
    // As the box does it: once, one chance to put it right, then forgotten
    tryExistingSignIn: async <T>(
      app: string,
      signsIn: (account: { username: string; password: string }) => Promise<T | undefined>,
      ask: { username: boolean },
    ): Promise<T | "refused" | undefined> => {
      if (run.refusedBefore) return "refused";
      if (!run.given) return undefined;
      const taken = await signsIn(run.given);
      if (taken !== undefined) return taken;
      seen.asked++;
      if (run.putRight) {
        const again = { username: ask.username ? (run.putRight.username ?? "") : "", password: run.putRight.password };
        const retaken = await signsIn(again);
        if (retaken !== undefined) {
          seen.replaced.push({ app, ...again });
          return retaken;
        }
      }
      seen.refused.push(app);
      return "refused";
    },
    registerCheckpoints: async () => {},
    emitCheckpoint: async () => {},
    updateCheckpointMessage: async () => {},
    skipCheckpoint: async () => {},
    awaitCheckpointRetry: async () => "skip",
    askForInputs: async () => {
      seen.asked++;
      if (run.putRight) return run.putRight;
      throw Object.assign(new Error("skipped"), { name: "HookInputsUnanswered" });
    },
    getInstalledAppUrl: async () => null,
    log: () => {},
    sleep: async () => {},
    skip: (message: string) => {
      throw new Skipped(message);
    },
    fail: (message: string) => {
      throw new Error(message);
    },
    ...run.extra,
  } as unknown as HookContext;
  return { ctx, seen };
}

/** A fetch that records each request and answers with `answer`'s result. */
function serve(seen: Seen, answer: (method: string, path: string, body: string) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    seen.requests.push(`${method} ${url.pathname}`);
    const body = typeof init?.body === "string" || init?.body instanceof URLSearchParams ? String(init.body) : "";
    return answer(method, url.pathname + url.search, body);
  }) as typeof fetch;
}

const count = (seen: Seen, request: string) => seen.requests.filter((each) => each === request).length;

/** The step stops, skipped with words that name no username, having kept no account put right. */
async function stopsRefused(run: Promise<unknown>, seen: Seen, words: RegExp) {
  const error = await run.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Skipped);
  expect((error as Error).message).toMatch(words);
  expect((error as Error).message).not.toContain(OWN.username);
  expect(seen.replaced).toEqual([]);
}

describe.each([
  { name: "Jellyfin", appId: "jellyfin", setUp: setUpJellyfin, prefix: "" },
  { name: "Emby", appId: "emby", setUp: setUpEmby, prefix: "/emby" },
])("$name the owner already had", ({ name, appId, setUp, prefix }) => {
  const LIBRARIES = ["/movies", "/shows", "/music", "/photos", "/videos"];
  const signIn = `POST ${prefix}/Users/AuthenticateByName`;
  function server(run: Run = { given: OWN }, admin = true) {
    const { ctx, seen } = context(appId, run);
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
  const refusedWords = new RegExp(`${name} refused the admin account you gave`);

  test("signs in as the owner's own administrator once, and makes or changes no account", async () => {
    const { ctx, seen } = server();
    await setUp(ctx);
    expect(count(seen, signIn)).toBe(1);
    expect(changesAccounts(seen.requests)).toEqual([]);
    expect(seen.asked).toBe(0);
  });

  test("asks once about a refused account, then forgets it for the rest of the run and stops, having made none", async () => {
    const { ctx, seen } = server({ given: TYPO });
    await stopsRefused(setUp(ctx), seen, refusedWords);
    expect(count(seen, signIn)).toBe(1);
    expect(seen.asked).toBe(1);
    expect(seen.refused).toEqual([appId]);
    expect(changesAccounts(seen.requests)).toEqual([]);
    expect(seen.requests.some((request) => request.includes("/Library/VirtualFolders"))).toBe(false);
  });

  test("keeps the account the owner puts right for the hooks after it", async () => {
    const { ctx, seen } = server({ given: TYPO, putRight: OWN });
    await setUp(ctx);
    expect(count(seen, signIn)).toBe(2);
    expect(seen.replaced).toEqual([{ app: appId, ...OWN }]);
    expect(seen.refused).toEqual([]);
    expect(changesAccounts(seen.requests)).toEqual([]);
  });

  test("never tries an account an earlier hook of the run found refused", async () => {
    const { ctx, seen } = server({ refusedBefore: true });
    await stopsRefused(setUp(ctx), seen, refusedWords);
    expect(count(seen, signIn)).toBe(0);
    expect(seen.asked).toBe(0);
  });

  test("takes an account that isn't an administrator as no way in, rather than making it one", async () => {
    const { ctx, seen } = server({ given: OWN }, false);
    await stopsRefused(setUp(ctx), seen, refusedWords);
    expect(seen.refused).toEqual([appId]);
    expect(changesAccounts(seen.requests)).toEqual([]);
  });
});

describe("Deluge the owner already had", () => {
  function deluge(password: string, run: Run) {
    const config = mkdtempSync(join(tmpdir(), "deluge-"));
    const { ctx, seen } = context("deluge", {
      ...run,
      extra: { mounts: [{ hostPath: "/mnt/a/deluge/config", containerPath: "/config", localPath: config }], ...run.extra },
    });
    const calls: string[] = [];
    let current = password;
    serve(seen, (_method, _path, body) => {
      const { method, params } = JSON.parse(body) as { method: string; params: unknown[] };
      calls.push(method);
      if (method === "auth.change_password") current = String(params[1]);
      const result =
        method === "auth.login"
          ? params[0] === current
          : method === "core.get_config_values"
            ? { download_location: "/downloads/deluge/incomplete", move_completed: true, move_completed_path: "/downloads/deluge/complete" }
            : true;
      return Response.json({ result, error: null, id: 1 });
    });
    return { ctx, seen, calls };
  }
  const logins = (calls: string[]) => calls.filter((call) => call === "auth.login").length;

  test("signs in with the owner's password and changes it in no way, whatever sign-in the run has", async () => {
    const { ctx, calls } = deluge(OWN.password, { given: { username: "", password: OWN.password }, extra: { signIn: CHOSEN } });
    await configureDeluge(ctx);
    expect(calls).not.toContain("auth.change_password");
    expect(logins(calls)).toBe(1);
  });

  test("tries a refused password once, guesses no other, asks once, then forgets it and stops", async () => {
    const { ctx, seen, calls } = deluge("deluge", { given: { username: "", password: TYPO.password }, extra: { signIn: CHOSEN } });
    await stopsRefused(configureDeluge(ctx), seen, /Deluge refused the password you gave/);
    expect(logins(calls)).toBe(1);
    expect(seen.asked).toBe(1);
    expect(seen.refused).toEqual(["deluge"]);
    expect(calls).not.toContain("auth.change_password");
  });

  test("never tries a password an earlier hook of the run found refused", async () => {
    const { ctx, seen, calls } = deluge(OWN.password, { refusedBefore: true });
    await stopsRefused(configureDeluge(ctx), seen, /Deluge refused the password you gave/);
    expect(logins(calls)).toBe(0);
  });

  // A fresh install still takes the chosen password in place of Deluge's own
  test("a Deluge HexOS just installed still takes the chosen password", async () => {
    const { ctx, calls } = deluge("deluge", { extra: { signIn: CHOSEN, keptApps: undefined } });
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
])("$name the owner already had", ({ name, appId, configure, hasAccount, signIn, makesAccount, signedIn, noLibraries, libraries, addsLibrary }) => {
  function server(run: Run) {
    const { ctx, seen } = context(appId, run);
    serve(seen, (method, path, body) => {
      if (hasAccount(path)) return appId === "kavita" ? Response.json(true) : Response.json({ isInit: true });
      if (signIn(path)) {
        const given = JSON.parse(body) as { password: string };
        return given.password === OWN.password ? signedIn("owners-token") : new Response("no", { status: 401 });
      }
      if (/metadata-providers/.test(path)) return Response.json([0]);
      if (libraries.test(path) && method === "GET") return noLibraries();
      return Response.json({});
    });
    return { ctx, seen };
  }
  const signIns = (seen: Seen) => seen.requests.filter((request) => request.startsWith("POST ") && signIn(request.slice(5))).length;
  const refusedWords = new RegExp(`${name} refused the account you gave`);

  test("signs in as the owner's account to add its libraries, and makes none", async () => {
    const { ctx, seen } = server({ given: OWN });
    await configure(ctx);
    expect(signIns(seen)).toBe(1);
    expect(seen.requests.some((request) => makesAccount.test(request))).toBe(false);
    expect(seen.requests.filter((request) => addsLibrary.test(request))).not.toEqual([]);
  });

  test("tries a refused account once, asks once, then forgets it and stops", async () => {
    const { ctx, seen } = server({ given: TYPO });
    await stopsRefused(configure(ctx), seen, refusedWords);
    expect(signIns(seen)).toBe(1);
    expect(seen.asked).toBe(1);
    expect(seen.refused).toEqual([appId]);
    expect(seen.requests.some((request) => makesAccount.test(request))).toBe(false);
  });

  test("never tries an account an earlier hook of the run found refused", async () => {
    const { ctx, seen } = server({ refusedBefore: true });
    await stopsRefused(configure(ctx), seen, refusedWords);
    expect(signIns(seen)).toBe(0);
  });
});

describe("Profilarr the owner already had", () => {
  function profilarr(run: Run) {
    const config = mkdtempSync(join(tmpdir(), "profilarr-"));
    const { ctx, seen } = context("profilarr", {
      ...run,
      extra: { mounts: [{ hostPath: "/mnt/a/profilarr/config", containerPath: "/config", localPath: config }], signIn: CHOSEN },
    });
    serve(seen, (_method, path, body) => {
      if (path === "/api/v1/status") return new Response(null, { status: 401 });
      if (path === "/auth/login") {
        const form = new URLSearchParams(body);
        if (form.get("password") !== OWN.password) return Response.json({ type: "failure", status: 400 });
        return new Response(JSON.stringify({ type: "redirect", status: 303 }), { headers: { "Set-Cookie": "session=abc; Path=/" } });
      }
      return Response.json({ type: "success" });
    });
    return { ctx, seen };
  }

  test("signs in with the owner's account once and changes its password in no way", async () => {
    const { ctx, seen } = profilarr({ given: OWN });
    await configureProfilarr(ctx);
    expect(count(seen, "POST /auth/login")).toBe(1);
    expect(seen.requests.some((request) => request.includes("changePassword") || request.includes("/auth/setup"))).toBe(false);
    expect(seen.asked).toBe(0);
  });

  test("tries a refused account once, never the run's sign-in, asks once, then forgets it and stops", async () => {
    const { ctx, seen } = profilarr({ given: TYPO });
    await stopsRefused(configureProfilarr(ctx), seen, /Profilarr refused the account you gave/);
    expect(count(seen, "POST /auth/login")).toBe(1);
    expect(seen.asked).toBe(1);
    expect(seen.refused).toEqual(["profilarr"]);
    expect(seen.requests.some((request) => request.includes("changePassword"))).toBe(false);
  });

  test("never tries an account an earlier hook of the run found refused", async () => {
    const { ctx, seen } = profilarr({ refusedBefore: true });
    await stopsRefused(configureProfilarr(ctx), seen, /Profilarr refused the account you gave/);
    expect(count(seen, "POST /auth/login")).toBe(0);
  });
});

describe("qBittorrent the owner already had", () => {
  function qbittorrent(run: Run, homeNetworkLetIn: boolean) {
    const config = mkdtempSync(join(tmpdir(), "qbittorrent-"));
    const { ctx, seen } = context("qbittorrent", {
      ...run,
      extra: { mounts: [{ hostPath: "/mnt/a/qbittorrent/config", containerPath: "/config", localPath: config }] },
    });
    const logins: string[] = [];
    serve(seen, (method, path, body) => {
      if (path === "/api/v2/app/version") return new Response("v5.3.0", { status: homeNetworkLetIn ? 200 : 403 });
      if (path === "/api/v2/auth/login") {
        const form = new URLSearchParams(body);
        logins.push(form.get("password") ?? "");
        // From the home network qBittorrent takes any sign-in
        const ok = homeNetworkLetIn || (form.get("username") === OWN.username && form.get("password") === OWN.password);
        return new Response(ok ? "" : "Fails.", { status: ok ? 204 : 200, headers: ok ? { "Set-Cookie": "SID=abc; Path=/" } : {} });
      }
      if (path === "/api/v2/app/preferences") return Response.json({ save_path: "/config/Downloads", temp_path_enabled: true });
      if (path === "/api/v2/app/setPreferences" && method === "POST") return new Response(null, { status: 200 });
      return new Response(null, { status: 404 });
    });
    return { ctx, seen, logins };
  }

  test("lets the home network in as it does, trying no sign-in at all", async () => {
    const { ctx, seen, logins } = qbittorrent({ given: TYPO }, true);
    await configureQbittorrent(ctx);
    expect(logins).toEqual([]);
    expect(seen.requests).not.toContain("POST /api/v2/app/setPreferences");
  });

  test("signs in with the owner's account once when the home network isn't let in, and changes no sign-in", async () => {
    const { ctx, seen, logins } = qbittorrent({ given: OWN }, false);
    await configureQbittorrent(ctx);
    expect(logins).toEqual([OWN.password]);
    expect(seen.requests).not.toContain("POST /api/v2/app/setPreferences");
  });

  test("tries a refused account once, never HexOS's own default, asks once, then forgets it and stops", async () => {
    const { ctx, seen, logins } = qbittorrent({ given: TYPO }, false);
    await stopsRefused(configureQbittorrent(ctx), seen, /qBittorrent refused the account you gave/);
    expect(logins).toEqual([TYPO.password]);
    expect(seen.asked).toBe(1);
    expect(seen.refused).toEqual(["qbittorrent"]);
  });

  test("never tries an account an earlier hook of the run found refused", async () => {
    const { ctx, seen, logins } = qbittorrent({ refusedBefore: true }, false);
    await stopsRefused(configureQbittorrent(ctx), seen, /qBittorrent refused the account you gave/);
    expect(logins).toEqual([]);
  });
});
