// Mocked unit tests for the Authentik dashboard widget.
// Run from the repo root on the `authentik` branch: bun test _lib/authentik_widget_status.test.ts
// fetch is stubbed; the token is read from a temp dir.
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../authentik/widget_status";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(routes: Array<[string, () => Response]>) {
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    for (const [fragment, make] of routes) {
      if (u.includes(fragment)) return make();
    }
    return new Response("not found", { status: 404 });
  }) as any;
}

function ctxWith(dir: string, withToken: boolean) {
  if (withToken) writeFileSync(join(dir, "hexos_widget_token"), "tok_abc123");
  return {
    appId: "authentik",
    host: "127.0.0.1",
    port: 30140,
    mounts: [{ containerPath: "/certs", hostPath: "/mnt/pool/apps/authentik/certs", localPath: dir }],
    log() {},
  };
}

test("populates the counts when a token is present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "authentik-widget-"));
  mockFetch([
    ["/-/health/ready/", () => new Response(null, { status: 204 })],
    ["/api/v3/core/users/", () => new Response(JSON.stringify({ pagination: { count: 5 } }), { status: 200 })],
    ["/api/v3/core/applications/", () => new Response(JSON.stringify({ pagination: { count: 3 } }), { status: 200 })],
    ["/api/v3/events/events/", () => new Response(JSON.stringify({ pagination: { count: 2 } }), { status: 200 })],
  ]);

  const res: any = await run(ctxWith(dir, true) as any);

  expect(res.fields.status.value).toBe("Ready");
  expect(res.fields.users.value).toBe("5");
  expect(res.fields.applications.value).toBe("3");
  expect(res.fields.failed.value).toBe("2");

  rmSync(dir, { recursive: true, force: true });
});

test("shows ready-state but dashes when no token is present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "authentik-widget-"));
  mockFetch([["/-/health/ready/", () => new Response(null, { status: 204 })]]);

  const res: any = await run(ctxWith(dir, false) as any);

  expect(res.fields.status.value).toBe("Ready");
  expect(res.fields.users.value).toBe("—");
  expect(res.fields.applications.value).toBe("—");
  expect(res.fields.failed.value).toBe("—");

  rmSync(dir, { recursive: true, force: true });
});
