import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Nginx Proxy Manager has to run as root. TrueNAS's chart defaults to 568, which the chart passes on
// as PUID and PGID, and with any user but root the image hands every certbot package folder to that
// user on each start: 10 to 53 minutes on TrueNAS (NginxProxyManager/nginx-proxy-manager#4778).
// SKIP_CERTBOT_OWNERSHIP skips that step but leaves the folders root's, so the backend can't install
// a DNS certificate's plugin into them.

const script = JSON.parse(readFileSync(join(import.meta.dir, "..", "nginx-proxy-manager.json"), "utf-8"));
const text = JSON.stringify(script);

test("Nginx Proxy Manager runs as root", () => {
  expect(script.app_values.run_as).toEqual({ user: 0, group: 0 });
});

test("no variable sets another user, or skips the certbot step instead", () => {
  expect(text).not.toContain("SKIP_CERTBOT_OWNERSHIP");
  expect(text).not.toMatch(/"(PUID|PGID)"/);
});
