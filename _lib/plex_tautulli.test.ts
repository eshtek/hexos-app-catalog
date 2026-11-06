import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookContext } from "./hook_context";
import { run as connectTautulli } from "../plex/connect_tautulli";

// Plex to Tautulli against fakes of the two apps, read at Tautulli 2.18.2, the version TrueNAS pins.
// A fresh Tautulli is set up with this server. Run again, Tautulli moves to this server when its own
// is gone (Plex reinstalled, or this server at an address that no longer reaches it), asks the owner
// when its server doesn't answer, and never leaves another server that still answers.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setSystemTime();
});

/** This Plex server, at plex.test:32400. A reinstall gives the same address a new identifier. */
const THIS_SERVER = "this-machine";

const timeoutOf = (hook: string): number => {
  const script = JSON.parse(readFileSync(join(import.meta.dir, "../plex.json"), "utf-8")) as { hooks: Array<{ id: string; timeout: number }> };
  return script.hooks.find((h) => h.id === hook)!.timeout;
};

/** Tautulli's checkboxes: configUpdate saves one its form leaves out as off. */
const CHECKED = ["api_enabled", "pms_ssl", "pms_is_remote", "refresh_users_on_startup"];

interface Options {
  /** Tautulli's settings beside a fresh one's, as config.ini holds them. */
  settings?: Record<string, string>;
  /** What answers at each Plex address, by "host:port"; this server always answers at plex.test:32400. */
  servers?: Record<string, string>;
  /** What Tautulli reaches at an address, over what answers there for anyone else (a name only its own network gives), by "host:port". */
  tautulliReaches?: Record<string, string>;
  /** Tautulli doesn't say which server it reaches (its own wait for Plex outlasts HexOS's). */
  tautulliIdentityFails?: boolean;
  /** The owner's answer when asked, "skip" to skip the question, or "none" for a box that can't ask. */
  owner?: boolean | "skip" | "none";
  /** How long the owner takes to answer, in ms. */
  ownerTakes?: number;
  /** The look at which Tautulli first reports it's monitoring, counted after the settings change. */
  connectsAtLook?: number;
  /** Every answer from Tautulli and every Plex address that doesn't answer takes its whole timeout. */
  slow?: boolean;
  /** config.ini appears only after this many waits, as on Tautulli's first start. */
  iniAfterWaits?: number;
}

interface Call {
  host: string;
  path: string;
  method: string;
  cmd?: string;
  form?: URLSearchParams;
}

class Skipped extends Error {}

function apps(options: Options = {}) {
  const calls: Call[] = [];
  const checkpoints: string[] = [];
  const questions: string[] = [];
  const servers: Record<string, string> = { "plex.test:32400": THIS_SERVER, ...options.servers };
  let now = Date.UTC(2026, 10, 5, 12);
  const advance = (ms: number) => {
    now += ms;
    setSystemTime(new Date(now));
  };
  advance(0);
  const started = now;

  const plexDir = mkdtempSync(join(tmpdir(), "plex-config-"));
  const prefs = join(plexDir, "Library/Application Support/Plex Media Server");
  mkdirSync(prefs, { recursive: true });
  writeFileSync(
    join(prefs, "Preferences.xml"),
    `<?xml version="1.0" encoding="utf-8"?>\n<Preferences PlexOnlineToken="plex-token" ProcessedMachineIdentifier="${THIS_SERVER}" FriendlyName="HexOS Plex"/>\n`,
  );
  const tautulliDir = mkdtempSync(join(tmpdir(), "tautulli-config-"));
  const settings: Record<string, string> = {
    api_enabled: "1",
    api_key: "tautulli-key",
    first_run_complete: "0",
    pms_identifier: "",
    pms_ip: "127.0.0.1",
    pms_port: "32400",
    pms_ssl: "0",
    pms_is_remote: "0",
    pms_name: "",
    pms_token: "",
    refresh_users_on_startup: "1",
    ...options.settings,
  };
  // Tautulli writes its whole config.ini on every change (CONFIG.write)
  const writeIni = () =>
    writeFileSync(join(tautulliDir, "config.ini"), `[General]\n${Object.entries(settings).map(([k, v]) => `${k} = ${v}`).join("\n")}\n`);
  let waits = 0;
  if (!options.iniAfterWaits) writeIni();

  /** The server at an address, as Tautulli reaches it. */
  const reached = () => {
    const address = `${settings.pms_ip}:${settings.pms_port}`;
    return options.tautulliReaches?.[address] ?? servers[address];
  };
  let changed = false;
  let looks = 0;
  const monitoring = () => {
    if (settings.first_run_complete !== "1" || settings.pms_token !== "plex-token" || !reached()) return false;
    if (!changed) return true;
    looks += 1;
    return looks >= (options.connectsAtLook ?? 1);
  };

  const json = (value: unknown, status = 200) => Response.json(value, { status });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const form = init?.body instanceof URLSearchParams ? init.body : undefined;
    calls.push({ host: url.host, path: url.pathname, method, cmd: url.searchParams.get("cmd") ?? undefined, form });
    if (url.host === "tautulli.test:8181") {
      if (options.slow) advance(5_000);
      if (url.pathname === "/api/v2") {
        if (url.searchParams.get("apikey") !== settings.api_key) return json({ response: { result: "error", message: "Invalid apikey" } });
        const cmd = url.searchParams.get("cmd");
        if (cmd === "get_server_identity") {
          const id = options.tautulliIdentityFails ? undefined : reached();
          return json({ response: { result: id ? "success" : "error", data: id ? { machine_identifier: id, version: "1.41.0" } : {} } });
        }
        if (cmd === "server_status") return json({ response: { result: "success", data: { result: "success", connected: monitoring() } } });
        if (cmd === "restart") return json({ response: { result: "success", message: "Restarting Tautulli" } });
      }
      if (url.pathname === "/save_pms_token" && method === "POST" && form) {
        settings.pms_token = form.get("token") ?? settings.pms_token;
        writeIni();
        return new Response(null, { status: 200 });
      }
      if (url.pathname === "/configUpdate" && method === "POST" && form) {
        for (const key of CHECKED) settings[key] = form.has(key) ? "1" : "0";
        for (const key of ["pms_ip", "pms_port", "pms_identifier", "pms_name"]) if (form.has(key)) settings[key] = form.get(key)!;
        if (form.has("first_run")) settings.first_run_complete = "1";
        changed = true;
        writeIni();
        if (options.slow) {
          // The wizard's path restarts Tautulli's web server, which drops the reply
          advance(25_000);
          throw new TypeError("fetch failed");
        }
        return json({ result: "success", message: "Settings saved." });
      }
      throw new Error(`Unexpected request: ${method} ${url.host}${url.pathname}`);
    }
    const id = servers[url.host];
    if (!id) {
      if (options.slow) advance(10_000);
      throw new TypeError("fetch failed");
    }
    if (url.pathname === "/identity") return json({ MediaContainer: { size: 0, claimed: true, machineIdentifier: id, version: "1.41.0" } });
    throw new Error(`Unexpected request: ${method} ${url.host}${url.pathname}`);
  }) as typeof fetch;

  const ctx = {
    baseUrl: "http://plex.test:32400",
    host: "plex.test",
    port: 32400,
    inputs: {},
    mounts: [{ containerPath: null, hostPath: "/mnt/pool/apps/plex/config", localPath: plexDir }],
    getInstalledAppUrl: async (id: string) => (id === "tautulli" ? "http://tautulli.test:8181" : null),
    getInstalledAppMounts: async (id: string) =>
      id === "tautulli" ? [{ containerPath: "/config", hostPath: "/mnt/pool/apps/tautulli/config", localPath: tautulliDir }] : [],
    registerCheckpoints: async () => {},
    emitCheckpoint: async (id: string) => {
      checkpoints.push(id);
    },
    skipCheckpoint: async (id: string) => {
      checkpoints.push(`skipped:${id}`);
    },
    ...(options.owner === "none"
      ? {}
      : {
          askForInputs: async (_inputs: unknown, prompt?: { description?: string }) => {
            questions.push(prompt?.description ?? "");
            advance(options.ownerTakes ?? 0);
            if (options.owner === "skip" || options.owner === undefined) {
              throw Object.assign(new Error("unanswered"), { name: "HookInputsUnanswered" });
            }
            return { switch: options.owner };
          },
        }),
    sleep: async (ms: number) => {
      advance(ms);
      waits += 1;
      if (options.iniAfterWaits && waits === options.iniAfterWaits) writeIni();
    },
    log: () => {},
    fail: (message: string) => {
      throw new Error(message);
    },
    skip: (message: string) => {
      throw new Skipped(message);
    },
  } as unknown as HookContext;
  return { ctx, calls, checkpoints, questions, settings, elapsed: () => now - started, asked: () => questions.length };
}

// Anything that changes Tautulli: its sign-in, its settings, a restart
const changes = (calls: Call[]) => calls.filter((c) => c.host === "tautulli.test:8181" && (c.method === "POST" || c.cmd === "restart"));
const configUpdate = (calls: Call[]) => calls.find((c) => c.path === "/configUpdate")?.form;

test("a fresh Tautulli is set up with this server through the setup wizard's path", async () => {
  const { ctx, calls, checkpoints, settings } = apps();
  await connectTautulli(ctx);
  expect(configUpdate(calls)?.get("first_run")).toBe("1");
  expect(settings).toMatchObject({ pms_ip: "plex.test", pms_port: "32400", pms_identifier: THIS_SERVER, pms_token: "plex-token", first_run_complete: "1" });
  // Every setting that was on is still on
  expect(settings).toMatchObject({ api_enabled: "1", refresh_users_on_startup: "1" });
  expect(checkpoints).toEqual(["locate", "credentials", "configure", "verify"]);
});

test("a Tautulli already watching this server with its sign-in is left as it is", async () => {
  const settings = { first_run_complete: "1", pms_identifier: THIS_SERVER, pms_ip: "plex.test", pms_token: "plex-token", pms_name: "HexOS Plex" };
  const { ctx, calls, checkpoints } = apps({ settings });
  await connectTautulli(ctx);
  expect(changes(calls)).toHaveLength(0);
  expect(checkpoints).toContain("skipped:configure");
});

test("after Plex is reinstalled, Tautulli at the address it had moves to the new server without asking", async () => {
  const settings = { first_run_complete: "1", pms_identifier: "old-machine", pms_ip: "plex.test", pms_token: "old-token", pms_name: "HexOS Plex" };
  const { ctx, calls, questions, settings: after } = apps({ settings, owner: true });
  await connectTautulli(ctx);
  expect(configUpdate(calls)?.get("server_changed")).toBe("1");
  expect(after).toMatchObject({ pms_ip: "plex.test", pms_identifier: THIS_SERVER, pms_token: "plex-token" });
  expect(questions).toHaveLength(0);
});

test("after Plex is reinstalled at another port, Tautulli at this box's old port, where nothing answers, moves without asking", async () => {
  const settings = { first_run_complete: "1", pms_identifier: "old-machine", pms_ip: "plex.test", pms_port: "32401", pms_token: "plex-token" };
  const { ctx, questions, settings: after } = apps({ settings, owner: true });
  await connectTautulli(ctx);
  expect(after).toMatchObject({ pms_ip: "plex.test", pms_port: "32400", pms_identifier: THIS_SERVER });
  expect(questions).toHaveLength(0);
});

for (const [label, address] of [
  ["the box's address changed", { pms_ip: "10.0.0.30", pms_port: "32400" }],
  ["Plex's port changed", { pms_ip: "plex.test", pms_port: "32401" }],
] as const) {
  test(`Tautulli watching this server at an address that no longer reaches it (${label}) moves to this one without asking`, async () => {
    const settings = { first_run_complete: "1", pms_identifier: THIS_SERVER, pms_token: "plex-token", ...address };
    const { ctx, calls, questions, settings: after } = apps({ settings, owner: true });
    await connectTautulli(ctx);
    expect(configUpdate(calls)?.get("server_changed")).toBe("1");
    expect(after).toMatchObject({ pms_ip: "plex.test", pms_port: "32400", pms_identifier: THIS_SERVER });
    expect(questions).toHaveLength(0);
  });
}

const otherServers: Array<[string, Options]> = [
  [
    "at another address",
    { settings: { pms_ip: "10.0.0.80", pms_port: "32400", pms_name: "Friend's Plex" }, servers: { "10.0.0.80:32400": "friends-machine" } },
  ],
  [
    "at another port of this box",
    { settings: { pms_ip: "plex.test", pms_port: "32401", pms_name: "Friend's Plex" }, servers: { "plex.test:32401": "friends-machine" } },
  ],
  [
    "that only Tautulli reaches",
    { settings: { pms_ip: "plex-friend", pms_port: "32400", pms_name: "Friend's Plex" }, tautulliReaches: { "plex-friend:32400": "friends-machine" } },
  ],
  [
    "while Tautulli doesn't say which server it reaches",
    {
      settings: { pms_ip: "10.0.0.80", pms_port: "32400", pms_name: "Friend's Plex" },
      servers: { "10.0.0.80:32400": "friends-machine" },
      tautulliIdentityFails: true,
    },
  ],
  [
    "to Tautulli, though its settings' address answers as this server to HexOS",
    { settings: { pms_ip: "plex.test", pms_port: "32400", pms_name: "Friend's Plex" }, tautulliReaches: { "plex.test:32400": "friends-machine" } },
  ],
];
for (const [label, options] of otherServers) {
  test(`Tautulli watching another Plex server that still answers ${label} is never moved, nor is the owner asked`, async () => {
    const settings = { first_run_complete: "1", pms_identifier: "friends-machine", pms_token: "friends-token", ...options.settings };
    const { ctx, calls, questions, settings: after } = apps({ ...options, settings, owner: true });
    const refused = await connectTautulli(ctx).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Skipped);
    expect((refused as Error).message).toBe(
      "Tautulli already watches another Plex server, Friend's Plex. Change it in Tautulli's own settings, then run Connect to Tautulli from Plex.",
    );
    expect(changes(calls)).toHaveLength(0);
    expect(questions).toHaveLength(0);
    expect(after).toMatchObject({ pms_identifier: "friends-machine", pms_token: "friends-token" });
  });
}

test("Tautulli whose other server doesn't answer asks the owner, and moves when they say so", async () => {
  const settings = { first_run_complete: "1", pms_identifier: "old-machine", pms_ip: "10.0.0.30", pms_token: "old-token", pms_name: "Old Plex" };
  const { ctx, questions, settings: after } = apps({ settings, owner: true });
  await connectTautulli(ctx);
  expect(questions).toEqual(["Tautulli watches Old Plex at 10.0.0.30:32400, which isn't answering."]);
  expect(after).toMatchObject({ pms_ip: "plex.test", pms_identifier: THIS_SERVER, pms_token: "plex-token" });
});

for (const owner of [false, "skip", "none"] as const) {
  test(`Tautulli whose other server doesn't answer stays as it is when the owner doesn't move it (${owner})`, async () => {
    const settings = { first_run_complete: "1", pms_identifier: "old-machine", pms_ip: "10.0.0.30", pms_token: "old-token" };
    const { ctx, calls, settings: after } = apps({ settings, owner });
    await expect(connectTautulli(ctx)).rejects.toThrow(/another Plex server/);
    expect(changes(calls)).toHaveLength(0);
    expect(after).toMatchObject({ pms_identifier: "old-machine", pms_ip: "10.0.0.30", pms_token: "old-token" });
  });
}

test("a Tautulli that never connects fails with what it sees before the hook's timeout, at the slowest of every step", async () => {
  // config.ini appears at the last look, every reply takes its whole timeout, the settings change's
  // reply is lost, and the address Tautulli had doesn't answer, so the owner is asked
  const settings = { first_run_complete: "1", pms_identifier: "old-machine", pms_ip: "10.0.0.30", pms_token: "old-token" };
  const { ctx, elapsed } = apps({ settings, owner: true, slow: true, iniAfterWaits: 23, connectsAtLook: Number.POSITIVE_INFINITY, ownerTakes: 0 });
  await expect(connectTautulli(ctx)).rejects.toThrow("Tautulli saved this Plex server but hasn't connected to it");
  expect(elapsed()).toBeLessThan(timeoutOf("connect-tautulli") * 1000);
});

test("the time the owner takes to answer doesn't count against the run's own time", async () => {
  // The platform stops the hook's timeout while the owner is asked
  const settings = { first_run_complete: "1", pms_identifier: "old-machine", pms_ip: "10.0.0.30", pms_token: "old-token" };
  const { ctx, calls, elapsed } = apps({ settings, owner: true, ownerTakes: 9 * 60_000, connectsAtLook: 5 });
  await connectTautulli(ctx);
  expect(calls.filter((c) => c.cmd === "server_status").length).toBeGreaterThan(5);
  expect(elapsed()).toBeGreaterThan(9 * 60_000);
});
