import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, untar } from "../plex/connect_tautulli";
import type { ContextMount, HookContext } from "./hook_context";

// On a box whose app config predates the pool mounts, the HexOS container can't see Plex's or
// Tautulli's dataset, so this hook reads their settings out of their containers through Docker.

const PREFS = "/Library/Application Support/Plex Media Server/Preferences.xml";
const PLEX_FILE = `/config${PREFS}`;
const TAUTULLI_FILE = "/config/config.ini";
const SIGNED_IN = '<Preferences PlexOnlineToken="plex-token" ProcessedMachineIdentifier="machine-1" FriendlyName="mnemosyne" />';
const NOT_SIGNED_IN = '<Preferences ProcessedMachineIdentifier="machine-1" />';
const FRESH_INI = 'api_key = "tautulli-key"\nfirst_run_complete = 0\nhttp_username = ""\nhttp_password = ""\n';
const SAVED_INI = `${FRESH_INI}pms_token = plex-token\n`;
const NOT_SIGNED_IN_MESSAGE = "Plex isn't signed in yet. Run Pre-configure Plex, then connect Tautulli from Plex's Connections tab.";
const NOT_READ_MESSAGE = "HexOS couldn't read Tautulli's settings yet. Try again once it has started.";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const header = (name: string, size: number, type: string) => {
  const block = new Uint8Array(512);
  const put = (text: string, at: number) => block.set(new TextEncoder().encode(text), at);
  put(name, 0);
  put(`${size.toString(8).padStart(11, "0")}\0`, 124);
  put(type, 156);
  return block;
};
const padded = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  const body = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
  body.set(bytes);
  return body;
};
const tar = (...blocks: Uint8Array[]) => {
  const all = new Uint8Array(blocks.reduce((sum, block) => sum + block.length, 0) + 1024);
  let at = 0;
  for (const block of blocks) {
    all.set(block, at);
    at += block.length;
  }
  return all;
};
const tarOf = (text: string) => tar(header("file", new TextEncoder().encode(text).length, "0"), padded(text));

const NOT_MOUNTED = (app: string): ContextMount => ({
  hostPath: `/mnt/tank/Applications/${app}/config`,
  containerPath: null,
  localPath: join(tmpdir(), `connect-tautulli-not-mounted-${app}`),
});

class Stopped extends Error {
  constructor(
    message: string,
    readonly how: "fail" | "skip",
  ) {
    super(message);
  }
}

function context(plex: ContextMount, tautulli: ContextMount) {
  const checkpoints: string[] = [];
  const ctx = {
    host: "10.0.0.2",
    port: 32400,
    mounts: [plex],
    getInstalledAppUrl: async () => "http://tautulli.test",
    getInstalledAppMounts: async () => [tautulli],
    registerCheckpoints: async () => {},
    emitCheckpoint: async (id: string) => {
      checkpoints.push(id);
    },
    skipCheckpoint: async (id: string) => {
      checkpoints.push(`${id}:skipped`);
    },
    sleep: async () => {},
    log: () => {},
    fail: (message: string) => {
      throw new Stopped(message, "fail");
    },
    skip: (message: string) => {
      throw new Stopped(message, "skip");
    },
  } as unknown as HookContext;
  return { ctx, checkpoints };
}

/** Docker's archive endpoint holding the two files, and a Tautulli that takes the settings it's given. */
function box(files: Record<string, string>, options: { connected?: boolean } = {}) {
  const seen = { docker: [] as string[], token: "", form: new URLSearchParams() };
  let connected = options.connected ?? false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit & { unix?: string }) => {
    const url = new URL(String(input));
    if (url.hostname === "docker") {
      expect(init?.unix).toBe("/var/run/docker.sock");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const path = url.searchParams.get("path") ?? "";
      const container = url.pathname.split("/")[2];
      expect(container).toBe(path === PLEX_FILE ? "ix-plex-plex-1" : "ix-tautulli-tautulli-1");
      seen.docker.push(path);
      const text = files[path];
      return text === undefined ? new Response("", { status: 404 }) : new Response(tarOf(text));
    }
    if (url.pathname === "/save_pms_token") {
      seen.token = new URLSearchParams(String(init?.body)).get("token") ?? "";
      files[TAUTULLI_FILE] = SAVED_INI;
      return new Response("{}");
    }
    if (url.pathname === "/configUpdate") {
      seen.form = new URLSearchParams(String(init?.body));
      connected = true;
      return new Response("{}");
    }
    const cmd = url.searchParams.get("cmd");
    if (cmd === "get_server_identity") {
      const data = connected ? { machine_identifier: "machine-1" } : {};
      return Response.json({ response: { result: "success", data } });
    }
    return Response.json({ response: { result: "success", data: { connected } } });
  }) as typeof fetch;
  return seen;
}

const stopped = async (ctx: HookContext) => {
  try {
    await run(ctx);
  } catch (error) {
    if (error instanceof Stopped) return error;
    throw error;
  }
  return undefined;
};

describe("when the HexOS container can't see the apps' datasets", () => {
  test("both apps' settings come through Docker, and Tautulli is pointed at Plex", async () => {
    const seen = box({ [PLEX_FILE]: SIGNED_IN, [TAUTULLI_FILE]: FRESH_INI });
    const { ctx, checkpoints } = context(NOT_MOUNTED("plex"), NOT_MOUNTED("tautulli"));
    expect(await stopped(ctx)).toBeUndefined();
    expect(seen.token).toBe("plex-token");
    expect(seen.form.get("pms_identifier")).toBe("machine-1");
    expect(checkpoints).toEqual(["locate", "credentials", "configure", "verify"]);
  });

  test("the saved Plex sign-in is checked through Docker too", async () => {
    const seen = box({ [PLEX_FILE]: SIGNED_IN, [TAUTULLI_FILE]: FRESH_INI });
    const { ctx } = context(NOT_MOUNTED("plex"), NOT_MOUNTED("tautulli"));
    await run(ctx);
    expect(seen.docker.filter((path) => path === TAUTULLI_FILE).length).toBe(2);
  });

  test("a Tautulli already watching this Plex is left alone", async () => {
    const seen = box({ [PLEX_FILE]: SIGNED_IN, [TAUTULLI_FILE]: SAVED_INI }, { connected: true });
    const { ctx, checkpoints } = context(NOT_MOUNTED("plex"), NOT_MOUNTED("tautulli"));
    expect(await stopped(ctx)).toBeUndefined();
    expect(seen.token).toBe("");
    expect(checkpoints).toEqual(["locate", "credentials", "configure:skipped", "verify"]);
  });

  test("a Plex that really isn't signed in still says so", async () => {
    box({ [PLEX_FILE]: NOT_SIGNED_IN, [TAUTULLI_FILE]: FRESH_INI });
    const { ctx } = context(NOT_MOUNTED("plex"), NOT_MOUNTED("tautulli"));
    const result = await stopped(ctx);
    expect(result?.how).toBe("skip");
    expect(result?.message).toBe(NOT_SIGNED_IN_MESSAGE);
  });

  test("a Tautulli that hasn't written its settings yet fails as it did", async () => {
    box({ [PLEX_FILE]: SIGNED_IN });
    const { ctx } = context(NOT_MOUNTED("plex"), NOT_MOUNTED("tautulli"));
    expect((await stopped(ctx))?.message).toBe(NOT_READ_MESSAGE);
  });

  test("a Tautulli still writing its settings is waited for", async () => {
    const files: Record<string, string> = { [PLEX_FILE]: SIGNED_IN };
    const seen = box(files);
    const { ctx } = context(NOT_MOUNTED("plex"), NOT_MOUNTED("tautulli"));
    let waits = 0;
    (ctx as { sleep: (ms: number) => Promise<void> }).sleep = async () => {
      if (++waits === 3) files[TAUTULLI_FILE] = FRESH_INI;
    };
    expect(await stopped(ctx)).toBeUndefined();
    expect(seen.token).toBe("plex-token");
  });

  test("an error from Docker is never read as the file", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL) => new Response(tarOf(SIGNED_IN), { status: 500 })) as typeof fetch;
    const { ctx } = context(NOT_MOUNTED("plex"), NOT_MOUNTED("tautulli"));
    expect((await stopped(ctx))?.message).toBe(NOT_SIGNED_IN_MESSAGE);
  });

  test("a box with no socket yet says what it did before", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL): Promise<Response> => {
      throw new Error("no such socket");
    }) as typeof fetch;
    const { ctx } = context(NOT_MOUNTED("plex"), NOT_MOUNTED("tautulli"));
    expect((await stopped(ctx))?.message).toBe(NOT_SIGNED_IN_MESSAGE);
  });
});

describe("when the mounts give the files", () => {
  test("Docker is never asked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "connect-tautulli-test-"));
    const plexDir = join(dir, "plex");
    const tautulliDir = join(dir, "tautulli");
    mkdirSync(join(plexDir, "Library/Application Support/Plex Media Server"), { recursive: true });
    mkdirSync(tautulliDir);
    writeFileSync(plexDir + PREFS, SIGNED_IN);
    writeFileSync(join(tautulliDir, "config.ini"), SAVED_INI);
    const seen = box({}, { connected: true });
    const { ctx } = context({ ...NOT_MOUNTED("plex"), localPath: plexDir }, { ...NOT_MOUNTED("tautulli"), localPath: tautulliDir });
    expect(await stopped(ctx)).toBeUndefined();
    expect(seen.docker).toEqual([]);
  });
});

test("a pax header ahead of the file is skipped", () => {
  const pax = padded("27 mtime=1761900000.000000\n");
  expect(untar(tar(header("pax", 27, "x"), pax, ...[header("file", SIGNED_IN.length, "0"), padded(SIGNED_IN)]))).toBe(SIGNED_IN);
});
