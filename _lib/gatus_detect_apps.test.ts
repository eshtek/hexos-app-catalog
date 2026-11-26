// Mocked unit test for the Gatus "Detect installed apps" hook.
// Run from the repo root on the `feature/gatus` branch:
//   bun test _lib/gatus_detect_apps.test.ts
// No network — getInstalledAppUrl is stubbed and the config file is written to a temp dir.
import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../gatus/detect_apps";

function makeCtx(dataDir: string, urls: Record<string, string>) {
  const emitted: string[] = [];
  const skipped: string[] = [];
  const ctx = {
    mounts: [
      { containerPath: "/app/data", hostPath: "/mnt/pool/apps/gatus/data", localPath: dataDir },
      { containerPath: null, hostPath: "/mnt/pool/apps/gatus/other", localPath: "/tmp/other" },
    ],
    async getInstalledAppUrl(id: string) {
      return urls[id] ?? null;
    },
    async registerCheckpoints() {},
    async emitCheckpoint(id: string) {
      emitted.push(id);
    },
    async skipCheckpoint(id: string) {
      skipped.push(id);
    },
    fail(message: string): never {
      throw new Error(message);
    },
    log() {},
  };
  return { ctx, emitted, skipped };
}

test("writes detected apps to config.d with HTTP and TCP checks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gatus-"));
  const { ctx, emitted } = makeCtx(dir, {
    jellyfin: "http://192.168.1.50:8096",
    // minecraft is a TCP candidate -> should become a tcp:// endpoint with a CONNECTED check
    minecraft: "http://192.168.1.50:25565",
  });

  await run(ctx as any);

  const file = join(dir, "config.d", "hexos-detected.yaml");
  expect(existsSync(file)).toBe(true);
  const yaml = readFileSync(file, "utf-8");

  // HTTP app -> response-time condition on the real URL
  expect(yaml).toContain('name: "Jellyfin"');
  expect(yaml).toContain('url: "http://192.168.1.50:8096"');
  expect(yaml).toContain('"[RESPONSE_TIME] < 10000"');

  // TCP app -> tcp:// endpoint + CONNECTED condition
  expect(yaml).toContain('name: "Minecraft"');
  expect(yaml).toContain('url: "tcp://192.168.1.50:25565"');
  expect(yaml).toContain('"[CONNECTED] == true"');

  // grouped and completed
  expect(yaml).toContain('group: "Detected by HexOS"');
  expect(emitted).toContain("scan");

  rmSync(dir, { recursive: true, force: true });
});

test("skips and writes nothing when no other apps are found", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gatus-"));
  const { ctx, skipped } = makeCtx(dir, {});

  await run(ctx as any);

  expect(existsSync(join(dir, "config.d", "hexos-detected.yaml"))).toBe(false);
  expect(skipped).toContain("scan");

  rmSync(dir, { recursive: true, force: true });
});
