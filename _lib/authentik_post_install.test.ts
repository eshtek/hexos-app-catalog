// Mocked unit tests for the Authentik onAfterInstall hook.
// Run from the repo root on the `authentik` branch: bun test _lib/authentik_post_install.test.ts
// No network — getAppValues and waitForApp are stubbed; the file write goes to a temp dir.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../authentik/post_install";

function makeCtx(opts: { certsDir: string; envs: Array<{ name: string; value: string }> }) {
  const emitted: string[] = [];
  const skipped: string[] = [];
  const ctx = {
    mounts: [
      { containerPath: "/certs", hostPath: "/mnt/pool/apps/authentik/certs", localPath: opts.certsDir },
      { containerPath: null, hostPath: "/mnt/pool/apps/authentik/data", localPath: "/tmp/data" },
    ],
    async getAppValues() {
      return { authentik: { additional_envs: opts.envs } };
    },
    async waitForApp() {
      return new Response(null, { status: 204 });
    },
    async registerCheckpoints() {},
    async emitCheckpoint(id: string) {
      emitted.push(id);
    },
    async skipCheckpoint(id: string) {
      skipped.push(id);
    },
    log() {},
  };
  return { ctx, emitted, skipped };
}

test("writes the bootstrap token to the certs mount for the widget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "authentik-hook-"));
  const { ctx, emitted } = makeCtx({
    certsDir: dir,
    envs: [
      { name: "AUTHENTIK_BOOTSTRAP_EMAIL", value: "admin@example.com" },
      { name: "AUTHENTIK_BOOTSTRAP_TOKEN", value: "tok_abc123" },
    ],
  });

  await run(ctx as any);

  const tokenFile = join(dir, "hexos_widget_token");
  expect(existsSync(tokenFile)).toBe(true);
  expect(readFileSync(tokenFile, "utf-8")).toBe("tok_abc123");
  expect(emitted).toContain("ready");
  expect(emitted).toContain("widget");

  rmSync(dir, { recursive: true, force: true });
});

test("skips the widget step (no file) when no bootstrap token is present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "authentik-hook-"));
  const { ctx, emitted, skipped } = makeCtx({
    certsDir: dir,
    envs: [{ name: "AUTHENTIK_BOOTSTRAP_EMAIL", value: "admin@example.com" }],
  });

  await run(ctx as any);

  expect(existsSync(join(dir, "hexos_widget_token"))).toBe(false);
  expect(emitted).toContain("ready");
  expect(skipped).toContain("widget");

  rmSync(dir, { recursive: true, force: true });
});
