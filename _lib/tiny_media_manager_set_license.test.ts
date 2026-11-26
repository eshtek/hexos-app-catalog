// Mocked unit test for the tinyMediaManager set-license hook.
// Run from the repo root on the feature/tiny-media-manager branch:
//   bun test _lib/tiny_media_manager_set_license.test.ts
import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../tiny-media-manager/set_license";

function makeCtx(dataDir: string, licenseValue: string) {
  const emitted: string[] = [];
  const skipped: string[] = [];
  let restarted = false;
  const ctx = {
    mounts: [
      { containerPath: "/data", hostPath: "/mnt/pool/apps/tiny-media-manager/data", localPath: dataDir },
      { containerPath: "/media/Movies", hostPath: "/mnt/pool/movies", localPath: "/tmp/movies" },
    ],
    async getAppValues() {
      return { tiny_media_manager: { additional_envs: [{ name: "HEXOS_TMM_LICENSE", value: licenseValue }] } };
    },
    async registerCheckpoints() {},
    async emitCheckpoint(id: string) {
      emitted.push(id);
    },
    async skipCheckpoint(id: string) {
      skipped.push(id);
    },
    async restartApp() {
      restarted = true;
    },
    fail(message: string): never {
      throw new Error(message);
    },
    log() {},
  };
  return { ctx, emitted, skipped, restarted: () => restarted };
}

test("writes the license to tmm.lic (trimmed) and restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tmm-"));
  const { ctx, emitted, restarted } = makeCtx(dir, "  ABC-123-LICENSE  \n");

  await run(ctx as any);

  const file = join(dir, "tmm.lic");
  expect(existsSync(file)).toBe(true);
  expect(readFileSync(file, "utf-8")).toBe("ABC-123-LICENSE"); // trimmed, no newline
  expect(restarted()).toBe(true);
  expect(emitted).toContain("license");

  rmSync(dir, { recursive: true, force: true });
});

test("does nothing when no license is entered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tmm-"));
  const { ctx, skipped, restarted } = makeCtx(dir, "");

  await run(ctx as any);

  expect(existsSync(join(dir, "tmm.lic"))).toBe(false);
  expect(restarted()).toBe(false);
  expect(skipped).toContain("license");

  rmSync(dir, { recursive: true, force: true });
});
