import type { HookContext } from "../_lib/hook_context";

/** The port the TrueNAS app gives AdGuard Home with --web-addr. Setup keeps it, so no restart is needed. */
const WEB_PORT = 30004;
const DNS_PORT = 53;
/** AdGuard Home refuses shorter passwords (PasswordMinRunes). */
const MIN_PASSWORD_LENGTH = 8;

const READINESS_ATTEMPTS = 20;
const READINESS_INTERVAL_MS = 5000;

export async function setup(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "ready",      message: "Starting AdGuard Home" },
    { id: "configured", message: "Completing first-run setup" },
  ]);

  const username = ctx.getInput<string>("admin_username") || "admin";
  const password = ctx.getInput<string>("admin_password");
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    ctx.fail(`The admin password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  // DNS binds to the LAN address only. Port 53 on other addresses can belong to
  // the TrueNAS virtualization service or to HexOS remote access.
  if (!ctx.host) ctx.fail("The server's LAN address is not known.");

  const base = `http://${ctx.host}:${WEB_PORT}`;
  const inSetup = await waitForAdGuard(ctx, base);
  await ctx.emitCheckpoint("ready");

  if (!inSetup) {
    await ctx.skipCheckpoint("configured", "AdGuard Home is already set up");
    return;
  }

  const resp = await fetch(`${base}/control/install/configure`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      password,
      web: { ip: "0.0.0.0", port: WEB_PORT },
      dns: { ip: ctx.host, port: DNS_PORT },
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) {
    ctx.fail("AdGuard Home refused the setup.", [
      { label: "Status", value: String(resp.status) },
      { label: "Reason", value: (await resp.text()).trim() },
    ]);
  }
  await ctx.emitCheckpoint("configured", "Setup complete");
}

/**
 * Wait until AdGuard Home answers. The setup endpoint returns 200 before
 * first-run setup. After setup it returns 403, and after a restart it does not
 * exist, so it returns 404.
 */
async function waitForAdGuard(ctx: HookContext, base: string): Promise<boolean> {
  for (let i = 0; i < READINESS_ATTEMPTS; i++) {
    try {
      const resp = await fetch(`${base}/control/install/get_addresses`, {
        signal: AbortSignal.timeout(5000),
      });
      if (resp.status === 200) return true;
      if (resp.status === 403 || resp.status === 404) return false;
      ctx.log(`Waiting for AdGuard Home... status=${resp.status} (${i + 1}/${READINESS_ATTEMPTS})`);
    } catch {
      ctx.log(`Waiting for AdGuard Home to start... (${i + 1}/${READINESS_ATTEMPTS})`);
    }
    await ctx.sleep(READINESS_INTERVAL_MS);
  }
  return ctx.fail("AdGuard Home did not start in time.");
}
