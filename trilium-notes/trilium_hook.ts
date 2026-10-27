import type { HookContext } from "../_lib/hook_context";

/** The web port the script publishes. */
const WEB_PORT = 30257;
/** Trilium refuses shorter passwords (apps/server/src/routes/login.ts, setPassword). */
const MIN_PASSWORD_LENGTH = 4;

const READINESS_ATTEMPTS = 24;
const READINESS_INTERVAL_MS = 5000;

interface SetupStatus {
  isInitialized: boolean;
  authRequired: boolean;
}

export async function setup(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "ready",    message: "Starting Trilium" },
    { id: "document", message: "Creating the notes database" },
    { id: "password", message: "Setting the password" },
    { id: "signin",   message: "Checking the password" },
  ]);

  const password = (ctx.getInput<string>("password") || "").trim();
  // Trilium trims the password before it saves it. Check the trimmed value.
  if (password.length < MIN_PASSWORD_LENGTH) {
    ctx.fail(`The password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (!ctx.host) ctx.fail("The server's LAN address is not known.");

  const base = `http://${ctx.host}:${WEB_PORT}`;
  const status = await waitForStatus(ctx, base);
  await ctx.emitCheckpoint("ready");

  if (status.isInitialized) {
    await ctx.skipCheckpoint("document", "Trilium already has a notes database");
  } else {
    // Trilium can restart into its setup and keep the old notes behind it.
    if (status.authRequired) ctx.fail("Trilium is in its setup with existing notes. Open Trilium to finish it.");
    // Create a database with the demo notes. This is the first choice in Trilium's setup.
    const resp = await request(ctx, `${base}/api/setup/new-document`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: "en" }),
      signal: AbortSignal.timeout(120000),
    });
    if (!resp.ok) ctx.fail(`Trilium did not create its database (status ${resp.status}).`);
    const after = await waitForStatus(ctx, base);
    if (!after.isInitialized) ctx.fail("Trilium did not finish creating its database.");
    await ctx.emitCheckpoint("document", "Notes database created");
  }

  // Bootstrap reports passwordSet false only while no password is set (apps/server/src/routes/index.ts).
  let setNow = false;
  if (await needsPassword(ctx, base)) {
    // Trilium redirects after this request. Ask bootstrap again to see if it saved.
    await request(ctx, `${base}/set-password`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password1: password, password2: password }).toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
    if (await needsPassword(ctx, base)) ctx.fail("Trilium did not save the password.");
    setNow = true;
    await ctx.emitCheckpoint("password", "Password set");
  } else {
    await ctx.skipCheckpoint("password", "Trilium already has a password");
  }

  const resp = await request(ctx, `${base}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password }).toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  // A good password redirects into the app. A failed sign-in answers 401 with the factor that failed.
  if (resp.status === 429) ctx.fail("Trilium blocked sign-in after too many tries. Wait 15 minutes and run this again.");
  if (resp.status === 401) {
    const body = await resp.json().catch(() => ({})) as { factor?: string };
    if (body.factor === "totp") ctx.fail("Trilium asks for a two-factor code, so open Trilium to sign in.");
    ctx.fail(setNow
      ? "Trilium did not accept the new password. Open Trilium to sign in."
      : "Trilium already has a password. Run this again with that password.");
  }
  if (resp.status !== 302 && resp.status !== 303) ctx.fail(`Trilium answered the sign-in with status ${resp.status}.`);
  await ctx.emitCheckpoint("signin", "Signed in");
}

/** Send one request. A timeout or a refused connection ends the hook with a plain message. */
async function request(ctx: HookContext, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    return ctx.fail(`Trilium stopped answering: ${e}`);
  }
}

/** True while the notes database exists but no password is set. */
async function needsPassword(ctx: HookContext, base: string): Promise<boolean> {
  const resp = await request(ctx, `${base}/bootstrap`, { redirect: "manual", signal: AbortSignal.timeout(10000) });
  if (!resp.ok) ctx.fail(`Trilium answered bootstrap with status ${resp.status}.`);
  const body = await resp.json().catch(() => ({})) as { passwordSet?: boolean };
  return body.passwordSet === false;
}

/** Wait until Trilium answers its setup status, which needs no sign-in. */
async function waitForStatus(ctx: HookContext, base: string): Promise<SetupStatus> {
  for (let i = 0; i < READINESS_ATTEMPTS; i++) {
    try {
      const resp = await fetch(`${base}/api/setup/status`, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) return await resp.json() as SetupStatus;
      ctx.log(`Waiting for Trilium... status ${resp.status} (${i + 1}/${READINESS_ATTEMPTS})`);
    } catch (e) {
      ctx.log(`Waiting for Trilium to start... ${e} (${i + 1}/${READINESS_ATTEMPTS})`);
    }
    await ctx.sleep(READINESS_INTERVAL_MS);
  }
  return ctx.fail("Trilium did not start in time.");
}
