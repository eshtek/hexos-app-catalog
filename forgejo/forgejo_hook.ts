import type { HookContext } from "../_lib/hook_context";

/** The web port the script publishes. */
const WEB_PORT = 30142;
/** Forgejo's default MIN_PASSWORD_LENGTH (modules/setting/security.go). */
const MIN_PASSWORD_LENGTH = 8;

const READINESS_ATTEMPTS = 15;
const READINESS_INTERVAL_MS = 5000;

export async function setup(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "ready",   message: "Starting Forgejo" },
    { id: "install", message: "Completing first-run setup" },
    { id: "admin",   message: "Checking the admin account" },
  ]);

  const username = (ctx.getInput<string>("admin_username") || "").trim();
  const email = (ctx.getInput<string>("admin_email") || "").trim();
  const password = ctx.getInput<string>("admin_password");
  // Forgejo reserves the name "admin" (models/user/user.go).
  if (!username || username.toLowerCase() === "admin") ctx.fail("Choose an admin username other than admin.");
  // Setup locks Forgejo before it creates the admin, so a rejected email would leave no admin.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ctx.fail("Enter a full email address for the admin, such as you@example.com.");
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    ctx.fail(`The admin password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (!ctx.host) ctx.fail("The server's LAN address is not known.");

  const base = `http://${ctx.host}:${WEB_PORT}`;
  const installPage = await waitForForgejo(ctx, base);
  await ctx.emitCheckpoint("ready");

  if (installPage === null) {
    await ctx.skipCheckpoint("install", "Forgejo is already set up");
  } else {
    // Post the form back as Forgejo prefilled it, with the admin fields added.
    const form = readForm(installPage);
    form.set("admin_name", username);
    form.set("admin_email", email);
    form.set("admin_passwd", password);
    form.set("admin_confirm_passwd", password);
    // The setup page answers 200 even when it rejects the form, and setup restarts
    // Forgejo, so the sign-in check below decides whether setup worked.
    try {
      const resp = await fetch(`${base}/`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        redirect: "manual",
        signal: AbortSignal.timeout(60000),
      });
      ctx.log(`Setup form returned ${resp.status}`);
    } catch (e) {
      ctx.log(`Setup form request ended early: ${e}`);
    }
    await ctx.emitCheckpoint("install", "Setup submitted");
  }

  const user = await signIn(ctx, base, username, password);
  if (!user) {
    ctx.fail(installPage === null
      ? "Forgejo is already set up. Run this again with its admin's username and password."
      : "Forgejo did not accept the setup. Open Forgejo to see what it needs.");
  }
  if (!user.is_admin) ctx.fail(`${username} signed in but is not an admin.`);
  await ctx.emitCheckpoint("admin", `Signed in as ${username}`);
}

/**
 * Wait until Forgejo answers. Before setup, the root page is the install form,
 * which has a db_type field. Returns that page, or null when setup is done.
 */
async function waitForForgejo(ctx: HookContext, base: string): Promise<string | null> {
  for (let i = 0; i < READINESS_ATTEMPTS; i++) {
    let body: string;
    try {
      const resp = await fetch(`${base}/`, { signal: AbortSignal.timeout(5000) });
      body = await resp.text();
      if (!resp.ok) throw new Error(`status ${resp.status}`);
    } catch (e) {
      ctx.log(`Waiting for Forgejo to start... ${e} (${i + 1}/${READINESS_ATTEMPTS})`);
      await ctx.sleep(READINESS_INTERVAL_MS);
      continue;
    }
    return body.includes('name="db_type"') ? body : null;
  }
  return ctx.fail("Forgejo did not start in time.");
}

/** Read every field of the install form with the value Forgejo gave it. */
function readForm(html: string): URLSearchParams {
  const form = new URLSearchParams();
  const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
  for (const [tag] of html.matchAll(/<input\b[^>]*>/g)) {
    const name = attr(tag, "name");
    if (!name) continue;
    const type = (attr(tag, "type") || "text").toLowerCase();
    if (type === "checkbox") {
      if (/\schecked\b/.test(tag)) form.set(name, "on");
    } else if (type !== "submit" && type !== "button") {
      form.set(name, decodeEntities(attr(tag, "value") || ""));
    }
  }
  for (const [, name, options] of html.matchAll(/<select\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const chosen = options.match(/<option\b[^>]*value="([^"]*)"[^>]*\sselected\b/) ?? options.match(/<option\b[^>]*value="([^"]*)"/);
    if (chosen) form.set(name, decodeEntities(chosen[1]));
  }
  return form;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#34;|&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&#43;/g, "+")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Sign in through the API. Setup restarts Forgejo, so wait for it to answer. */
async function signIn(ctx: HookContext, base: string, username: string, password: string): Promise<{ is_admin: boolean } | null> {
  const auth = `Basic ${btoa(`${username}:${password}`)}`;
  for (let i = 0; i < READINESS_ATTEMPTS; i++) {
    let resp: Response;
    try {
      resp = await fetch(`${base}/api/v1/user`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(5000) });
    } catch {
      await ctx.sleep(READINESS_INTERVAL_MS);
      continue;
    }
    if (resp.ok) return await resp.json() as { is_admin: boolean };
    if (resp.status === 401 || resp.status === 403) return null;
    await ctx.sleep(READINESS_INTERVAL_MS);
  }
  return null;
}
