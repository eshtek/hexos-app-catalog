import type { HookContext } from "../_lib/hook_context";

export async function run(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "fladder", message: "Checking Fladder is up" },
    { id: "jellyfin", message: "Checking Jellyfin answers at Fladder's address" },
    { id: "wizard", message: "Checking Jellyfin's setup is complete" },
  ]);

  const fladderUrl = await ctx.getInstalledAppUrl("fladder");
  if (!fladderUrl) throw new Error("Fladder is not installed or has no reachable port");
  const fladderResponse = await fetch(fladderUrl).catch(() => null);
  if (!fladderResponse?.ok) {
    throw new Error(`Fladder did not respond at ${fladderUrl}${fladderResponse ? ` (${fladderResponse.status})` : ""}`);
  }
  await ctx.emitCheckpoint("fladder");

  // Fladder's baked URL derives exactly like ctx.baseUrl, so probing baseUrl
  // probes what Fladder will actually dial.
  if (!ctx.baseUrl) throw new Error("Missing Jellyfin host/port in action context");
  const infoResponse = await fetch(`${ctx.baseUrl}/System/Info/Public`).catch(() => null);
  if (!infoResponse?.ok) {
    throw new Error(`Jellyfin did not respond at ${ctx.baseUrl}${infoResponse ? ` (${infoResponse.status})` : ""}`);
  }
  const info = (await infoResponse.json()) as { StartupWizardCompleted?: boolean; ServerName?: string };
  await ctx.emitCheckpoint("jellyfin");

  if (info.StartupWizardCompleted === false) {
    ctx.fail("Jellyfin's first-run setup isn't finished", [
      { label: "Why", value: "Until the Jellyfin setup wizard is completed, no account exists for Fladder to sign in with" },
      { label: "Fix", value: `Open Jellyfin at ${ctx.baseUrl} and finish the setup wizard, then run this check again` },
    ]);
  }
  await ctx.emitCheckpoint("wizard", `Fladder is linked to ${info.ServerName ?? "Jellyfin"}`);
}
