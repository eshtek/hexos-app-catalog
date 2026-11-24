// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import type { HookContext } from "../_lib/hook_context";

/**
 * Sets Navidrome up as HexOS ships it. Fresh, it opens on a screen that makes the owner create the
 * first admin, so HexOS makes that admin from the sign-in the owner chose (`ctx.signIn`). Navidrome
 * scans the Music folder on its own, so there is no library to add. One that already has a user keeps
 * it: Navidrome refuses a second first admin with 403. Read at Navidrome 0.64.2 (`server/auth.go`),
 * the version TrueNAS pins.
 */

/** Waits for Navidrome's heartbeat, which answers before the first scan ends. */
async function waitForStart(ctx: HookContext): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`${ctx.baseUrl}/ping`, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    await response?.body?.cancel();
    if (response?.ok) return;
    await ctx.sleep(5_000);
  }
  ctx.fail("Navidrome didn't start. Try again once it's running.");
}

export async function configure(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "start", message: "Waiting for Navidrome to start" },
    { id: "signIn", message: "Setting Navidrome's sign-in" },
  ]);

  await waitForStart(ctx);
  await ctx.emitCheckpoint("start");

  // A kept Navidrome has its own users, and the chosen sign-in was never meant for it
  const kept = ctx.keptApps?.includes(ctx.resourceId) === true;
  if (kept || !ctx.signIn) {
    await ctx.skipCheckpoint("signIn", kept ? "Navidrome keeps the account it has" : "Navidrome asks you to create your account the first time you open it");
    return;
  }

  const response = await fetch(`${ctx.baseUrl}/auth/createAdmin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: ctx.signIn.username, password: ctx.signIn.password }),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => undefined);
  if (!response) ctx.fail("Navidrome didn't answer. Try again once it's running.");
  const text = await response.text();
  if (response.status === 403) {
    await ctx.skipCheckpoint("signIn", "Navidrome keeps the account it has");
    return;
  }
  if (!response.ok) {
    ctx.fail("Navidrome didn't take your sign-in", [{ label: "Reason", value: text.slice(0, 200) || `${response.status} ${response.statusText}` }]);
  }
  await ctx.emitCheckpoint("signIn");
}
