import type { HookContext } from "../_lib/hook_context";

export async function beforeInstall(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "validateContext", message: "Validating install context" },
  ]);

  if (ctx.resourceType !== "app") throw new Error(`Wrong resourceType: ${ctx.resourceType}`);
  if (ctx.resourceId !== "hexos-test") throw new Error(`Wrong resourceId: ${ctx.resourceId}`);
  if (ctx.event !== "onBeforeInstall") throw new Error(`Wrong event: ${ctx.event}`);
  await ctx.emitCheckpoint("validateContext");
}

export async function afterInstall(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "inputsValidated", message: "Validating collected inputs" },
    { id: "appReachable", message: "Waiting for app to start" },
    { id: "appIdentity", message: "Verifying app identity" },
    { id: "healthCheck", message: "Running health check" },
  ]);

  // Validate all collected inputs
  const oauth = ctx.getInput<{ authToken: string }>("test_oauth");
  if (!oauth.authToken) throw new Error("Missing OAuth authToken");
  const password = ctx.getInput<string>("test_password");
  if (!password) throw new Error("Missing password input");
  const choice = ctx.getInput<string>("test_select");
  if (choice !== "a" && choice !== "b") throw new Error(`Invalid select value: ${choice}`);
  ctx.log(`Inputs received: oauth=${!!oauth.authToken}, password=${!!password}, choice=${choice}`);
  await ctx.emitCheckpoint("inputsValidated");

  // Wait for the app to be reachable
  await ctx.waitForApp("/");
  await ctx.emitCheckpoint("appReachable");

  // Verify app identity by checking whoami response
  const resp = await fetch(`${ctx.baseUrl}/api`, {
    headers: { "X-HexOS-Test": "hook-validation" },
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) throw new Error(`App identity check failed: ${resp.status}`);
  const body = await resp.text();
  ctx.log(`App responded: ${body.substring(0, 200)}`);
  await ctx.emitCheckpoint("appIdentity");

  // Health check — hit multiple endpoints to confirm the app is fully operational
  const endpoints = ["/", "/health", "/bench"];
  for (const ep of endpoints) {
    try {
      const check = await fetch(`${ctx.baseUrl}${ep}`, { signal: AbortSignal.timeout(3000) });
      ctx.log(`Health check ${ep}: ${check.status}`);
    } catch (e) {
      ctx.log(`Health check ${ep}: ${e}`);
    }
  }
  await ctx.emitCheckpoint("healthCheck");
}

export async function beforeUpgrade(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "patch", message: "Applying pre-upgrade patch" },
  ]);

  ctx.log(`Upgrading from ${ctx.fromVersion} to ${ctx.toVersion}`);
  await ctx.emitCheckpoint("patch");
}

export async function afterUpgrade(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "cleanup", message: "Post-upgrade cleanup" },
  ]);

  await ctx.emitCheckpoint("cleanup");
}

export async function optionalFail(ctx: HookContext) {
  ctx.log("This hook intentionally fails");
  throw new Error("Intentional failure for testing optional hook behavior");
}
