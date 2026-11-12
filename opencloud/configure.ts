// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import type { HookContext, HookInputDeclaration } from "../_lib/hook_context";

/**
 * Makes the owner's sign-in OpenCloud's administrator. The TrueNAS chart hard-codes admin/admin and
 * refuses another value for it, and OpenCloud reads it only when it first creates its accounts. So
 * this signs in as admin/admin once through OpenCloud's own login, makes the owner's account, then
 * deletes the built-in admin, so OpenCloud has one administrator with the owner's sign-in. If that's
 * refused, the built-in admin gets a long random password nobody keeps instead. Family accounts are
 * made in OpenCloud itself. A later install with another sign-in adds it as an administrator. Read
 * at OpenCloud 9.0.
 */

const CLIENT_ID = "web";

// OpenCloud serves https only, on the box's default certificate. `tls` is Bun's fetch option.
const insecure = { tls: { rejectUnauthorized: false } } as RequestInit;

type SignIn = { username: string; password: string; email?: string };
type User = { id: string; onPremisesSamAccountName: string };

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomPassword(length = 40): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) => letters[byte % letters.length]).join("");
}

/** Signs in the way the web page does. Returns an access token, or null when the password is wrong. */
export async function login(url: string, username: string, password: string): Promise<string | null> {
  const redirect = `${url}/oidc-callback.html`;
  const scope = "openid profile email";
  const logon = await fetch(`${url}/signin/v1/identifier/_/logon`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Kopano-Konnect-XSRF": "1", Referer: `${url}/signin/v1/identifier`, Origin: url },
    body: JSON.stringify({ params: [username, password, "1"], hello: { scope, client_id: CLIENT_ID, redirect_uri: redirect, flow: "oidc" } }),
    signal: AbortSignal.timeout(20_000),
    ...insecure,
  });
  if (logon.status === 204 || logon.status === 401 || logon.status === 403) return null;
  if (!logon.ok) throw new Error(`the sign-in page answered HTTP ${logon.status}`);
  const cookie = logon.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const query = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: redirect,
    scope,
    state: b64url(crypto.getRandomValues(new Uint8Array(12))),
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "none",
  });
  const authorize = await fetch(`${url}/signin/v1/identifier/_/authorize?${query}`, {
    headers: { Cookie: cookie },
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
    ...insecure,
  });
  const code = new URL(authorize.headers.get("location") ?? "", url).searchParams.get("code");
  if (!code) throw new Error(`the sign-in gave no code (HTTP ${authorize.status})`);
  const token = await fetch(`${url}/konnect/v1/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: CLIENT_ID, code_verifier: verifier }),
    signal: AbortSignal.timeout(20_000),
    ...insecure,
  });
  if (!token.ok) throw new Error(`the token request answered HTTP ${token.status}`);
  return ((await token.json()) as { access_token?: string }).access_token ?? null;
}

async function graph<T>(url: string, token: string, path: string, method = "GET", body?: unknown): Promise<{ status: number; data: T }> {
  const answer = await fetch(`${url}/graph${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
    ...insecure,
  });
  const text = await answer.text();
  return { status: answer.status, data: (text ? JSON.parse(text) : {}) as T };
}

async function findUser(url: string, token: string, username: string): Promise<User | undefined> {
  const found = await graph<{ value?: User[] }>(url, token, `/v1.0/users?$search=${encodeURIComponent(`"${username}"`)}`);
  return found.data.value?.find((user) => user.onPremisesSamAccountName === username);
}

async function giveAdminRole(url: string, token: string, userId: string): Promise<void> {
  const apps = await graph<{ value?: Array<{ id: string; appRoles?: Array<{ id: string; displayName: string }> }> }>(url, token, "/v1.0/applications");
  const app = apps.data.value?.[0];
  const role = app?.appRoles?.find((each) => each.displayName === "Admin");
  if (!app || !role) throw new Error("OpenCloud lists no Admin role");
  const has = await graph<{ value?: Array<{ appRoleId: string }> }>(url, token, `/v1.0/users/${userId}/appRoleAssignments`);
  if (has.data.value?.some((assignment) => assignment.appRoleId === role.id)) return;
  const given = await graph(url, token, `/v1.0/users/${userId}/appRoleAssignments`, "POST", { principalId: userId, appRoleId: role.id, resourceId: app.id });
  if (given.status >= 300) throw new Error(`giving the Admin role answered HTTP ${given.status}`);
}

async function changeOwnPassword(url: string, token: string, current: string, next: string): Promise<void> {
  const changed = await graph(url, token, "/v1.0/me/changePassword", "POST", { currentPassword: current, newPassword: next });
  if (changed.status >= 300) throw new Error(`changing the password answered HTTP ${changed.status}`);
}

/** Makes or updates the owner's account with the Admin role, signed in as an administrator. */
async function makeAdministrator(url: string, token: string, signIn: SignIn): Promise<void> {
  const username = signIn.username.toLowerCase();
  let user = await findUser(url, token, username);
  if (user) {
    const updated = await graph(url, token, `/v1.0/users/${user.id}`, "PATCH", { passwordProfile: { password: signIn.password } });
    if (updated.status >= 300) throw new Error(`setting ${username}'s password answered HTTP ${updated.status}`);
  } else {
    const made = await graph<User & { error?: { message?: string } }>(url, token, "/v1.0/users", "POST", {
      onPremisesSamAccountName: username,
      displayName: signIn.username,
      ...(signIn.email ? { mail: signIn.email } : {}),
      passwordProfile: { password: signIn.password },
    });
    if (made.status >= 300) throw new Error(`creating ${username} answered HTTP ${made.status}: ${made.data.error?.message ?? ""}`);
    user = made.data;
  }
  await giveAdminRole(url, token, user.id);
}

/** A fresh OpenCloud: the owner's account replaces the built-in admin. */
async function replaceBuiltinAdmin(url: string, builtin: string, signIn: SignIn): Promise<void> {
  const username = signIn.username.toLowerCase();
  if (username === "admin") return changeOwnPassword(url, builtin, "admin", signIn.password);
  await makeAdministrator(url, builtin, signIn);
  // Only once the new administrator works does the built-in one go. It stays gone across restarts.
  const token = await login(url, username, signIn.password);
  if (!token) throw new Error(`${username} was made but can't sign in`);
  const admin = await findUser(url, token, "admin");
  const removed = admin ? await graph(url, token, `/v1.0/users/${admin.id}`, "DELETE") : { status: 204 };
  if (removed.status >= 300) await changeOwnPassword(url, builtin, "admin", randomPassword());
}

const signInQuestions: HookInputDeclaration[] = [
  { type: "question", id: "username", question: { question: "OpenCloud username", type: "text", key: "username", required: true } },
  { type: "question", id: "password", question: { question: "OpenCloud password", type: "password", key: "password", required: true } },
];

async function ask(ctx: HookContext, prompt: { title: string; description: string }): Promise<SignIn | undefined> {
  if (typeof ctx.askForInputs !== "function") return undefined;
  const answers = await ctx.askForInputs(signInQuestions, prompt).catch((error: unknown) => {
    if (error instanceof Error && error.name === "HookInputsUnanswered") return undefined;
    throw error;
  });
  const username = typeof answers?.username === "string" ? answers.username.trim() : "";
  const password = typeof answers?.password === "string" ? answers.password : "";
  return username && password ? { username, password } : undefined;
}

/** ctx.waitForApp asks over plain http, which OpenCloud answers with a 400, so this asks over https. */
async function waitForOpenCloud(ctx: HookContext, url: string, minutes: number): Promise<{ issuer: string } | { last: string }> {
  const until = Date.now() + minutes * 60_000;
  let last = "no answer";
  while (Date.now() < until) {
    try {
      const answer = await fetch(`${url}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8_000), ...insecure });
      if (answer.ok) return { issuer: ((await answer.json()) as { issuer?: string }).issuer?.replace(/\/+$/, "") || url };
      last = `HTTP ${answer.status}`;
    } catch (error) {
      last = (error as Error).message;
    }
    await ctx.sleep(5_000);
  }
  return { last };
}

/** OpenCloud's sign-in page answers before its accounts are ready, so a fresh install gets a minute or two. */
async function whenReady<T>(ctx: HookContext, step: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      return await step();
    } catch (error) {
      last = error;
      await ctx.sleep(10_000);
    }
  }
  throw last;
}

/** Ends the run without the sign-in it needs: a collection goes on, anywhere else it fails with this. */
function stop(ctx: HookContext, message: string): never {
  if (ctx.skip) ctx.skip(message);
  return ctx.fail(message);
}

export async function configure(ctx: HookContext): Promise<void> {
  await ctx.registerCheckpoints([
    { id: "up", message: "Waiting for OpenCloud" },
    { id: "admin", message: "Making your administrator account" },
  ]);
  const up = await waitForOpenCloud(ctx, `https://${ctx.host}:${ctx.port}`, 8);
  if ("last" in up) ctx.fail("OpenCloud didn't start in time. Run Pre-configure OpenCloud from its Connections tab to try again.", [{ label: "Last answer", value: up.last }]);
  await ctx.emitCheckpoint("up");
  const url = up.issuer;
  const done = `Sign in at ${url} with the sign-in you chose.`;

  const builtin = await whenReady(ctx, () => login(url, "admin", "admin"));
  if (builtin) {
    const signIn =
      ctx.signIn ??
      (await ask(ctx, { title: "Choose your OpenCloud sign-in", description: "OpenCloud makes this its administrator. You'll sign in to OpenCloud with it." }));
    if (!signIn) stop(ctx, "OpenCloud has no sign-in chosen yet, so it still has its default one. Run Pre-configure OpenCloud from its Connections tab to choose one.");
    await whenReady(ctx, () => replaceBuiltinAdmin(url, builtin, signIn));
    await ctx.emitCheckpoint("admin", done, 100);
    return;
  }

  // Run from the card, an administrator already chosen stays as it is
  if (!ctx.signIn) {
    await ctx.skipCheckpoint("admin", "OpenCloud already has its administrator");
    return;
  }
  if (await login(url, ctx.signIn.username.toLowerCase(), ctx.signIn.password)) {
    await ctx.emitCheckpoint("admin", done, 100);
    return;
  }

  // OpenCloud has accounts from before and doesn't know this sign-in, so it gets a new administrator
  const current = await ask(ctx, { title: "Sign in to OpenCloud", description: "OpenCloud already has accounts. Enter an administrator's sign-in, so yours can become an administrator too." });
  const token = current && (await login(url, current.username.toLowerCase(), current.password));
  if (!token) stop(ctx, "OpenCloud already has accounts, and HexOS couldn't sign in to add yours. Its sign-ins stay as they are.");
  await makeAdministrator(url, token, ctx.signIn);
  await ctx.emitCheckpoint("admin", done, 100);
}
