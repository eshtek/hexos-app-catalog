// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import type { HookContext } from "../_lib/hook_context";

/**
 * Turns on spelling and grammar checks in Collabora through LanguageTool. Collabora takes these
 * settings only at its start, from its command line (no shell, no settings folder in its image), so
 * the link puts them in the app's own extra_params and updates the app. Running it again changes
 * nothing unless LanguageTool has moved. A script update writes the script's own list back, which
 * this link's row on the Connections tab puts right. Read at Collabora 26.04.
 */

const PREFIX = "--o:languagetool.";

export async function run(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "locate", message: "Finding LanguageTool" },
    { id: "update", message: "Updating Collabora to connect it" },
    { id: "confirm", message: "Checking Collabora came back" },
  ]);

  const url = await ctx.getInstalledAppUrl("languagetool");
  if (!url) ctx.fail("LanguageTool isn't installed, or HexOS can't find its port");
  await ctx.emitCheckpoint("locate");

  if (typeof ctx.updateAppValues !== "function") ctx.fail("This server's HexOS needs an update before it can connect Collabora. Try again after it updates.");
  const wanted = [`${PREFIX}enabled=true`, `${PREFIX}base_url=${url}/v2`, `${PREFIX}ssl_verification=false`];
  const changed = await ctx.updateAppValues((values) => {
    const collabora = values.collabora as { extra_params?: string[] };
    const others = (collabora.extra_params ?? []).filter((param) => !param.startsWith(PREFIX));
    collabora.extra_params = [...others, ...wanted];
  });
  if (!changed) {
    await ctx.skipCheckpoint("update", "Collabora already uses this LanguageTool");
    await ctx.skipCheckpoint("confirm");
    return;
  }
  await ctx.emitCheckpoint("update");
  await ctx.waitForApp("/hosting/discovery", { maxAttempts: 40 });
  await ctx.emitCheckpoint("confirm");
}
