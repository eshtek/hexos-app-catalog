// authentik/post_install.ts
// onAfterInstall hook: wait until Authentik is actually reachable (it runs DB
// migrations on first boot), then hand the dashboard widget an API token so its
// counts light up — all best-effort, so it never blocks the install.
import { writeFileSync } from "node:fs";

import type { HookContext } from "../_lib/hook_context";

/** The certs mount, where the widget looks for its token file. */
function certsLocalPath(ctx: HookContext): string | null {
  const certs =
    ctx.mounts.find((m) => m.containerPath === "/certs") ??
    ctx.mounts.find((m) => m.hostPath.endsWith("/authentik/certs"));
  return certs?.localPath ?? null;
}

/**
 * The non-expiring API token Authentik creates on first boot from
 * AUTHENTIK_BOOTSTRAP_TOKEN. We read it back from the app's own stored values
 * rather than re-authenticating — no admin login, no guessing.
 */
async function bootstrapToken(ctx: HookContext): Promise<string | null> {
  if (!ctx.getAppValues) return null;
  try {
    const values = await ctx.getAppValues();
    const authentik = (values?.authentik ?? {}) as {
      additional_envs?: Array<{ name?: string; value?: string }>;
    };
    const entry = (authentik.additional_envs ?? []).find(
      (e) => e?.name === "AUTHENTIK_BOOTSTRAP_TOKEN",
    );
    return typeof entry?.value === "string" && entry.value.length > 0 ? entry.value : null;
  } catch {
    return null;
  }
}

export async function run(ctx: HookContext): Promise<void> {
  await ctx.registerCheckpoints([
    { id: "ready", message: "Waiting for Authentik to finish starting" },
    { id: "widget", message: "Enabling the dashboard widget" },
  ]);

  // Authentik returns 204 on /-/health/ready/ only once the database and cache
  // are reachable and migrations are done.
  await ctx.waitForApp("/-/health/ready/", {
    expectedStatus: 204,
    maxAttempts: 50,
    initialDelayMs: 5000,
    maxDelayMs: 10000,
  });
  await ctx.emitCheckpoint("ready", "Authentik is up");

  // Give the widget a token to read. Purely optional — the widget still shows
  // ready-state without it.
  const token = await bootstrapToken(ctx);
  const dir = certsLocalPath(ctx);
  if (token && dir) {
    try {
      writeFileSync(`${dir}/hexos_widget_token`, token, { mode: 0o600 });
      await ctx.emitCheckpoint("widget", "Dashboard widget enabled");
      return;
    } catch (err) {
      ctx.log(`Could not write widget token: ${String(err)}`);
    }
  }
  const msg = "Dashboard widget counts can be enabled later";
  if (ctx.skipCheckpoint) await ctx.skipCheckpoint("widget", msg);
  else await ctx.emitCheckpoint("widget", msg);
}
