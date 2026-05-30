import type { HookContext } from "../_lib/hook_context";

export async function beforeInstall(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "validateContext", message: "Validating install context" },
    { id: "validateMetadata", message: "Verifying hook metadata" },
  ]);

  if (ctx.resourceType !== "app") throw new Error(`Wrong resourceType: ${ctx.resourceType}`);
  if (ctx.resourceId !== "hexos-test") throw new Error(`Wrong resourceId: ${ctx.resourceId}`);
  if (ctx.event !== "onBeforeInstall") throw new Error(`Wrong event: ${ctx.event}`);
  await ctx.emitCheckpoint("validateContext");

  if (!ctx.host) throw new Error("Missing host in context");
  if (!ctx.port) throw new Error("Missing port in context");
  if (!ctx.baseUrl) throw new Error("Missing baseUrl in context");
  ctx.log(`Context: host=${ctx.host}, port=${ctx.port}, baseUrl=${ctx.baseUrl}`);
  await ctx.emitCheckpoint("validateMetadata");
}

export async function afterInstall(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "inputsValidated", message: "Validating collected inputs" },
    { id: "dynamicProgress", message: "Testing dynamic progress updates" },
    { id: "appReachable", message: "Waiting for app to start" },
    { id: "appIdentity", message: "Verifying app identity" },
    { id: "healthCheck", message: "Running health checks" },
    { id: "stressTest", message: "Stress testing checkpoint updates" },
  ]);

  // Validate all collected inputs
  const oauth = ctx.getInput<{ authToken: string }>("test_oauth");
  if (!oauth.authToken) throw new Error("Missing OAuth authToken");
  const password = ctx.getInput<string>("test_password");
  if (!password) throw new Error("Missing password input");
  const choice = ctx.getInput<string>("test_select");
  if (choice !== "a" && choice !== "b") throw new Error(`Invalid select value: ${choice}`);
  const appName = getAppName(ctx);
  ctx.log(`Inputs received: oauth=${!!oauth.authToken}, password=${!!password}, choice=${choice}, appName=${appName}`);
  await ctx.emitCheckpoint("inputsValidated");

  // Test dynamic checkpoint message updates (updateCheckpointMessage)
  for (let i = 1; i <= 3; i++) {
    await ctx.updateCheckpointMessage("dynamicProgress", `Testing dynamic progress (step ${i} of 3)...`);
    await ctx.sleep(1000);
  }
  await ctx.emitCheckpoint("dynamicProgress", "Dynamic progress updates verified");

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
  for (let i = 0; i < endpoints.length; i++) {
    const ep = endpoints[i];
    await ctx.updateCheckpointMessage("healthCheck", `Checking endpoint ${i + 1} of ${endpoints.length}: ${ep}`);
    try {
      const check = await fetch(`${ctx.baseUrl}${ep}`, { signal: AbortSignal.timeout(3000) });
      ctx.log(`Health check ${ep}: ${check.status}`);
    } catch (e) {
      ctx.log(`Health check ${ep}: ${e}`);
    }
  }
  await ctx.emitCheckpoint("healthCheck", `All ${endpoints.length} endpoints checked`);

  // Stress test: rapid checkpoint updates to verify stale cleaner doesn't kill active hooks
  for (let i = 1; i <= 5; i++) {
    await ctx.updateCheckpointMessage("stressTest", `Rapid update ${i} of 5`);
    await ctx.sleep(500);
  }
  await ctx.emitCheckpoint("stressTest", "All rapid updates completed");
}

export async function beforeUpgrade(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "validateVersions", message: "Validating version context" },
    { id: "patch", message: "Applying pre-upgrade patch" },
  ]);

  if (!ctx.fromVersion) throw new Error("Missing fromVersion for upgrade hook");
  if (!ctx.toVersion) throw new Error("Missing toVersion for upgrade hook");
  ctx.log(`Upgrading from ${ctx.fromVersion} to ${ctx.toVersion}`);
  await ctx.emitCheckpoint("validateVersions");

  await ctx.updateCheckpointMessage("patch", "Simulating pre-upgrade work...");
  await ctx.sleep(1000);
  await ctx.emitCheckpoint("patch");
}

export async function afterUpgrade(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "verifyUpgrade", message: "Verifying upgrade" },
    { id: "cleanup", message: "Post-upgrade cleanup" },
  ]);

  await ctx.waitForApp("/");
  await ctx.emitCheckpoint("verifyUpgrade", "App responding after upgrade");

  await ctx.emitCheckpoint("cleanup");
}

export async function optionalFail(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "willFail", message: "About to fail intentionally" },
  ]);

  await ctx.updateCheckpointMessage("willFail", "Failing now...");
  ctx.log("This hook intentionally fails");
  throw new Error("Intentional failure for testing optional hook behavior");
}

function getAppName(ctx: HookContext): string {
  try {
    return ctx.getInput<string>("test_app_name") || "HexOS Test App";
  } catch {
    return "HexOS Test App";
  }
}
