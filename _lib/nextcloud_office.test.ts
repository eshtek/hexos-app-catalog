import { afterEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextMount, HookContext } from "./hook_context";

// Giving a file to Nextcloud's user needs root, so the ownership is checked on a real install
mock.module("node:fs", () => ({ ...require("node:fs"), chownSync: () => {} }));
const { collabora, START_FOLDER, writeStartScript } = await import("../nextcloud/startup");

// Nextcloud's links to the offices, against the real start-up script with a stand-in for occ.

const realFetch = globalThis.fetch;
const dirs: string[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function respond(answers: Record<string, () => Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = decodeURIComponent(String(input instanceof Request ? input.url : input));
    const match = Object.keys(answers).find((part) => url.includes(part));
    return match ? answers[match]() : new Response("", { status: 503 });
  }) as typeof fetch;
}

function nextcloud() {
  const base = mkdtempSync(join(tmpdir(), "nextcloud-")).replace(/\\/g, "/");
  dirs.push(base);
  const mount: ContextMount = { hostPath: "/mnt/tank/Applications/nextcloud/startup", containerPath: START_FOLDER, localPath: base };
  writeStartScript(mount);
  return { base, mount, state: `${base}/hexos` };
}

/** Runs the real start-up script as Nextcloud's image would, with a stand-in for occ that logs. */
async function start(base: string, occExit = 0): Promise<string[]> {
  const bin = `${base}/bin`;
  mkdirSync(bin, { recursive: true });
  writeFileSync(`${bin}/php`, `#!/bin/sh\nshift\necho "$*" >> "${base}/occ.log"\nexit ${occExit}\n`);
  chmodSync(`${bin}/php`, 0o755);
  writeFileSync(`${base}/run.sh`, readFileSync(`${base}/hexos-start.sh`, "utf-8").replaceAll(START_FOLDER, base));
  const run = Bun.spawn(["sh", `${base}/run.sh`, "--work"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "ignore", stderr: "ignore" });
  await run.exited;
  return occ(base);
}

const occ = (base: string) => (existsSync(`${base}/occ.log`) ? readFileSync(`${base}/occ.log`, "utf-8").trim().split("\n") : []);

function context(mount: ContextMount, base: string, address: string) {
  return {
    baseUrl: "http://10.0.0.5:30027",
    mounts: [mount],
    getInstalledAppUrl: async () => address,
    registerCheckpoints: async () => {},
    emitCheckpoint: async () => {},
    skipCheckpoint: async () => {},
    sleep: async () => {},
    // Stands in for the restart that makes Nextcloud run its start-up script
    restartApp: async () => void (await start(base)),
    fail: (message: string) => {
      throw new Error(message);
    },
  } as unknown as HookContext;
}

describe("Nextcloud's link to Collabora", () => {
  test.each([
    ["on https, as beside OpenCloud, Nextcloud skips the check of the server's own certificate", "https://10.0.0.5:9980", () => new Response(""), "yes"],
    ["on http, as beside Nextcloud alone, the check stays on", "http://10.0.0.5:9980", () => new Response("", { status: 503 }), "no"],
  ])("%s", async (_name, address, discovery, verify) => {
    const { base, mount } = nextcloud();
    respond({ "/hosting/discovery": discovery, "status.php": () => Response.json({ installed: true, maintenance: false }) });
    await collabora(context(mount, base, "http://10.0.0.5:9980"));
    const log = occ(base);
    expect(log).toContain(`config:app:set richdocuments disable_certificate_verification --value=${verify}`);
    expect(log).toContain(`config:app:set richdocuments wopi_url --value=${address}`);
  });
});
