import type { HookContext } from "../_lib/hook_context";

export async function requiredFail(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "connect", message: "Connecting to service" },
    { id: "auth", message: "Authenticating" },
    { id: "configure", message: "Applying configuration" },
    { id: "validate", message: "Validating setup" },
  ]);

  await ctx.sleep(1000);
  await ctx.emitCheckpoint("connect");

  await ctx.sleep(1000);
  await ctx.emitCheckpoint("auth");

  await ctx.updateCheckpointMessage("configure", "Applying configuration...");
  await ctx.sleep(1500);

  ctx.fail("Service rejected the configuration payload", [
    { label: "Endpoint", value: `POST ${ctx.baseUrl}/api/configure` },
    { label: "Status", value: "422 Unprocessable Entity" },
    { label: "Response", value: "Validation failed: required field 'api_key' is missing" },
    { label: "Hook", value: "required-fail" },
    { label: "App", value: ctx.resourceId },
  ]);
}
