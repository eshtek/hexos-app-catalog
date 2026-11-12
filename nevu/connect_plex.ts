import type { HookContext } from "../_lib/hook_context";

/**
 * Points Nevu at the Plex server on this box. Nevu has one setting for it, the address in its
 * TrueNAS values (`nevu.plex_server`), which the install fills with Plex's usual port. Plex's port
 * can move, so the link reads where Plex answers now and updates the address when it differs.
 * Read at Nevu 1.4.3.
 *
 * Nevu has no account of its own: its sign-in page sends the owner to plex.tv, then looks for this
 * server among the ones that Plex account owns or is shared on. A Plex server nobody has signed in
 * to is on no account, and Nevu answers "You do not have access to this server", so the link says
 * so instead of leaving the owner at that message.
 */

type Values = Record<string, unknown>;

const isRecord = (value: unknown): value is Values => typeof value === "object" && value !== null && !Array.isArray(value);

const trimmed = (address: unknown) => (typeof address === "string" ? address.trim().replace(/\/+$/, "") : "");

/** Whether a Plex account owns the server, or undefined when it doesn't answer. */
async function plexClaimed(url: string): Promise<boolean | undefined> {
  const text = await fetch(`${url}/identity`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) })
    .then((response) => (response.ok ? response.text() : undefined))
    .catch(() => undefined);
  if (text === undefined) return undefined;
  return !/claimed="0"|"claimed"\s*:\s*false/.test(text);
}

export async function run(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "locate", message: "Finding Plex" },
    { id: "configure", message: "Pointing Nevu at Plex" },
  ]);
  const url = trimmed(await ctx.getInstalledAppUrl("plex"));
  if (!url) ctx.fail("Plex isn't installed, or HexOS can't find its port");
  const claimed = await plexClaimed(url);
  if (claimed === undefined) ctx.fail("Plex didn't answer. Wait a minute for it to start, then run this again.");
  await ctx.emitCheckpoint("locate");

  if (typeof ctx.getAppValues !== "function" || typeof ctx.updateAppValues !== "function")
    ctx.fail("This server's HexOS needs an update first. Try again after it updates.");
  const values = await ctx.getAppValues();
  const current = trimmed(isRecord(values.nevu) ? values.nevu.plex_server : undefined);
  if (current === url) {
    await ctx.skipCheckpoint("configure", "Nevu already uses this Plex server");
  } else {
    await ctx.updateAppValues((next) => {
      next.nevu = { ...(isRecord(next.nevu) ? next.nevu : {}), plex_server: url };
    });
    await ctx.emitCheckpoint("configure");
  }

  if (!claimed) {
    const message = "Nevu is pointed at Plex, but nobody has signed in to Plex yet. Open Plex and sign in with your Plex account, then sign in to Nevu with the same account.";
    if (ctx.skip) ctx.skip(message);
    ctx.fail(message);
  }
}
