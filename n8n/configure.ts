// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import type { HookContext } from "../_lib/hook_context";

/**
 * n8n's first account is its owner, made from the sign-in the owner chose, so n8n opens on its sign-in
 * page rather than on "Set up owner account". Read at n8n 2.47: `POST /rest/owner/setup` takes an
 * email, a first and last name (one character or more each) and a password of 8 to 64 characters
 * with a number and a capital letter, and is refused once an owner exists.
 */

/** n8n's password rule, written without a regex range so nothing that rewrites the script can bend it. */
const meetsPasswordRule = (password: string) =>
  password.length >= 8 && password.length <= 64 && /\d/.test(password) && /[A-Z]/.test(password);

/** The sign-in's username as a first and last name: "aaron.roach" is Aaron Roach, "aaron" is Aaron Owner. */
export function namesOf(username: string): { firstName: string; lastName: string } {
  const parts = username.split(/[\s._-]+/).filter(Boolean);
  const title = (part: string) => part.charAt(0).toUpperCase() + part.slice(1);
  if (parts.length >= 2) return { firstName: title(parts[0]!), lastName: parts.slice(1).map(title).join(" ") };
  return { firstName: title(parts[0] ?? username), lastName: "Owner" };
}

/** Ends the setup for something only the owner can change, so a collection doesn't offer Try again. */
function refuse(ctx: HookContext, message: string): never {
  if (ctx.skip) ctx.skip(message);
  return ctx.fail(message);
}

export async function configure(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "start", message: "Waiting for n8n to start" },
    { id: "account", message: "Setting n8n's sign-in" },
  ]);
  await ctx.waitForApp("/healthz", { maxAttempts: 60 });
  await ctx.emitCheckpoint("start");

  const wanted = ctx.signIn;
  if (!wanted?.email) {
    await ctx.skipCheckpoint("account", "n8n asks you to set up its account the first time you open it");
    return;
  }
  const settings = (await fetch(`${ctx.baseUrl}/rest/settings`, { signal: AbortSignal.timeout(15_000) })
    .then((response) => response.json())
    .catch(() => undefined)) as { data?: { userManagement?: { showSetupOnFirstLoad?: boolean } } } | undefined;
  if (settings?.data?.userManagement?.showSetupOnFirstLoad === false) {
    await ctx.skipCheckpoint("account", "n8n keeps the account it has");
    return;
  }
  if (!meetsPasswordRule(wanted.password)) {
    refuse(ctx, "n8n needs a password with a number and a capital letter, so set up its account the first time you open n8n.");
  }

  // n8n answers its health check and settings before it mounts the owner route, which answers 404 until then
  const body = JSON.stringify({ email: wanted.email, ...namesOf(wanted.username), password: wanted.password });
  let response: Response | Error = new Error("n8n didn't answer");
  for (let attempt = 0; attempt < 24; attempt++) {
    response = await fetch(`${ctx.baseUrl}/rest/owner/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(30_000),
    }).catch((error: unknown) => new Error(error instanceof Error ? error.message : String(error)));
    if (response instanceof Error || response.status !== 404) break;
    await response.body?.cancel();
    await ctx.sleep(5_000);
  }
  if (response instanceof Error) ctx.fail("n8n stopped answering. Run this again.", [{ label: "Reason", value: response.message }]);
  if (!response.ok) ctx.fail("n8n didn't take your sign-in", [{ label: "Reason", value: (await response.text()).slice(0, 200) }]);
  await ctx.emitCheckpoint("account");
}
