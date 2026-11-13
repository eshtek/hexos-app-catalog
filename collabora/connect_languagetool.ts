// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import type { HookContext } from "../_lib/hook_context";

/**
 * Turns on spelling and grammar checks in Collabora through LanguageTool. Collabora takes these
 * settings only at its start, from its command line (no shell, no settings folder in its image), so
 * the link puts them in the app's own extra_params and updates the app. Running it again changes
 * nothing unless LanguageTool has moved. A script update writes the script's own list back, which
 * this link's row on the Connections tab puts right. Read at Collabora 26.04.
 *
 * Beside OpenCloud, Collabora serves https (Pre-configure Collabora), and ctx.waitForApp only asks over
 * http, so the link waits for whichever of the two Collabora answers on.
 */

const PREFIX = "--o:languagetool.";

const insecure = { tls: { rejectUnauthorized: false } } as RequestInit;

/** Waits until Collabora's discovery answers over https or http, as it restarts with its new values. */
export async function waitForCollabora(ctx: HookContext, attempts = 40): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    for (const scheme of ["https", "http"]) {
      const up = await fetch(`${scheme}://${ctx.host}:${ctx.port}/hosting/discovery`, { signal: AbortSignal.timeout(10_000), ...insecure }).then(
        (response) => response.ok,
        () => false,
      );
      if (up) return true;
    }
    await ctx.sleep(5_000);
  }
  return false;
}

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
    // Settings already right stay where they are, so a run after Pre-configure Collabora changes nothing
    const kept = (collabora.extra_params ?? []).filter((param) => !param.startsWith(PREFIX) || wanted.includes(param));
    collabora.extra_params = [...kept, ...wanted.filter((param) => !kept.includes(param))];
  });
  if (!changed) {
    await ctx.skipCheckpoint("update", "Collabora already uses this LanguageTool");
    await ctx.skipCheckpoint("confirm");
    return;
  }
  await ctx.emitCheckpoint("update");
  if (!(await waitForCollabora(ctx))) ctx.fail("Collabora didn't come back. Look at its logs on the app's card.");
  await ctx.emitCheckpoint("confirm");
}
