import type { HookContext } from "../_lib/hook_context";

/** The plain HTTP port the script publishes. The hook avoids the self-signed HTTPS port. */
const HTTP_PORT = 31017;
/** Portainer's default minimum password length. */
const MIN_PASSWORD_LENGTH = 12;
/** EndpointCreationType 1 is a local Docker environment on the mounted socket. */
const LOCAL_DOCKER = "1";
/** The admin monitor sends this redirect reason when no admin was made in time. */
const TIMEOUT_REASON = "AdminInitTimeout";

const READINESS_ATTEMPTS = 20;
const READINESS_INTERVAL_MS = 5000;

export async function setup(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "ready",       message: "Starting Portainer" },
    { id: "admin",       message: "Creating the admin account" },
    { id: "environment", message: "Connecting the local Docker environment" },
  ]);

  const username = ctx.getInput<string>("admin_username") || "admin";
  const password = ctx.getInput<string>("admin_password");
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    ctx.fail(`The admin password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (!ctx.host) ctx.fail("The server's LAN address is not known.");

  const base = `http://${ctx.host}:${HTTP_PORT}`;
  const hasAdmin = await waitForPortainer(ctx, base);
  await ctx.emitCheckpoint("ready");

  if (hasAdmin) {
    await ctx.skipCheckpoint("admin", "The admin account already exists");
  } else {
    // Portainer shuts down five minutes after start if no admin exists, so this runs first.
    const init = await fetch(`${base}/api/users/admin/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Username: username, Password: password }),
      signal: AbortSignal.timeout(15000),
    });
    if (!init.ok) await refuse(ctx, "Portainer refused the admin account.", init);
    await ctx.emitCheckpoint("admin", "Admin account created");
  }

  const auth = await fetch(`${base}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Username: username, Password: password }),
    signal: AbortSignal.timeout(15000),
  });
  if (!auth.ok) {
    if (hasAdmin) ctx.fail("Portainer already has an admin. Run this again with that admin's username and password.");
    await refuse(ctx, "Portainer refused the sign-in.", auth);
  }
  const { jwt } = await auth.json() as { jwt: string };
  const headers = { "Authorization": `Bearer ${jwt}` };

  const list = await fetch(`${base}/api/endpoints`, { headers, signal: AbortSignal.timeout(15000) });
  if (!list.ok) await refuse(ctx, "Portainer did not list its environments.", list);
  const environments = await list.json() as Array<{ URL?: string }>;
  if (environments.some((e) => e.URL?.startsWith("unix://"))) {
    await ctx.skipCheckpoint("environment", "The local environment already exists");
    return;
  }
  const form = new FormData();
  form.append("Name", "local");
  form.append("EndpointCreationType", LOCAL_DOCKER);
  const create = await fetch(`${base}/api/endpoints`, {
    method: "POST",
    headers,
    body: form,
    signal: AbortSignal.timeout(20000),
  });
  if (!create.ok) await refuse(ctx, "Portainer did not add the local environment.", create);
  await ctx.emitCheckpoint("environment", "Local Docker environment connected");
}

/**
 * Wait until Portainer answers. The admin check returns 404 before an admin
 * exists and 204 after. Five minutes after start with no admin, Portainer
 * locks its API and redirects every request with a timeout reason.
 */
async function waitForPortainer(ctx: HookContext, base: string): Promise<boolean> {
  for (let i = 0; i < READINESS_ATTEMPTS; i++) {
    let resp: Response;
    try {
      resp = await fetch(`${base}/api/users/admin/check`, {
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      ctx.log(`Waiting for Portainer to start... (${i + 1}/${READINESS_ATTEMPTS})`);
      await ctx.sleep(READINESS_INTERVAL_MS);
      continue;
    }
    // This check stays outside the try, so that the catch cannot swallow the failure.
    if (resp.headers.get("redirect-reason") === TIMEOUT_REASON) {
      ctx.fail("Portainer stopped waiting for setup. Restart Portainer, then run Set up Portainer from its card.");
    }
    if (resp.status === 404) return false;
    if (resp.status === 204) return true;
    ctx.log(`Waiting for Portainer... status=${resp.status} (${i + 1}/${READINESS_ATTEMPTS})`);
    await ctx.sleep(READINESS_INTERVAL_MS);
  }
  return ctx.fail("Portainer did not start in time.");
}

async function refuse(ctx: HookContext, message: string, resp: Response): Promise<never> {
  return ctx.fail(message, [
    { label: "Status", value: String(resp.status) },
    { label: "Reason", value: (await resp.text()).trim() },
  ]);
}
