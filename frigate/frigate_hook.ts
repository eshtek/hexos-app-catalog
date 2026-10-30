// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

import type { HookContext } from "../_lib/hook_context";

/** The authenticated web port the script publishes. */
const WEB_PORT = 30193;
/** Frigate refuses shorter passwords (frigate/api/auth.py, validate_password_strength). */
const MIN_PASSWORD_LENGTH = 12;
/** Frigate writes this file in /config on its first start (frigate/api/auth.py, get_jwt_secret). */
const JWT_SECRET_FILE = ".jwt_secret";
/** A short life for the token this hook signs. */
const TOKEN_LIFETIME_S = 300;

/** How long to wait for Frigate's first start. The hook timeout leaves room for the steps after it. */
const READINESS_DEADLINE_MS = 300000;
const READINESS_INTERVAL_MS = 5000;

/** Frigate serves 8971 with its own self-signed certificate (frigate/api/tls.py). */
const TLS = { tls: { rejectUnauthorized: false } };

export async function setPassword(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "ready",    message: "Starting Frigate" },
    { id: "password", message: "Setting the admin password" },
    { id: "signin",   message: "Checking the password" },
  ]);

  const password = ctx.getInput<string>("password") || "";
  // Frigate counts characters, not UTF-16 units.
  if ([...password].length < MIN_PASSWORD_LENGTH) {
    ctx.fail(`The password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (!ctx.host) ctx.fail("The server's LAN address is not known.");

  const config =
    ctx.mounts.find((m) => m.containerPath === "/config") ??
    ctx.mounts.find((m) => m.hostPath.endsWith("/frigate/config"));
  if (!config) ctx.fail("Frigate's config folder is not available to this action.");

  const base = `https://${ctx.host}:${WEB_PORT}`;
  const token = await waitForFrigate(ctx, base, `${config.localPath}/${JWT_SECRET_FILE}`);
  await ctx.emitCheckpoint("ready");

  // An admin token can set any password without the old one (frigate/api/auth.py, update_password).
  const resp = await request(ctx, `${base}/api/users/admin/password`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(30000),
    ...TLS,
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({})) as { message?: string; detail?: unknown };
    const reason = body.message ?? (typeof body.detail === "string" ? body.detail : `status ${resp.status}`);
    ctx.fail(`Frigate did not change the password: ${reason}.`);
  }
  await ctx.emitCheckpoint("password", "Password set");

  const login = await request(ctx, `${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: "admin", password }),
    signal: AbortSignal.timeout(30000),
    ...TLS,
  });
  if (!login.ok) ctx.fail(`Frigate did not accept the new password (status ${login.status}).`);
  await ctx.emitCheckpoint("signin", "Signed in as admin");
}

/**
 * Wait until Frigate has written its secret and answers a signed request.
 * Returns the signed admin token.
 */
async function waitForFrigate(ctx: HookContext, base: string, secretPath: string): Promise<string> {
  const deadline = Date.now() + READINESS_DEADLINE_MS;
  while (Date.now() < deadline) {
    const waited = `${Math.round((READINESS_DEADLINE_MS - (deadline - Date.now())) / 1000)}s`;
    let secret = "";
    try {
      // Frigate reads only the first line (frigate/api/auth.py, get_jwt_secret).
      secret = (readFileSync(secretPath, "utf-8").split("\n")[0] ?? "").trim();
    } catch (e) {
      // A missing file means Frigate has not started yet. Any other error will not go away.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") ctx.fail(`This action cannot read Frigate's secret: ${e}`);
    }
    if (secret) {
      const token = signAdminToken(secret);
      let resp: Response | null = null;
      try {
        resp = await fetch(`${base}/api/profile`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10000),
          ...TLS,
        });
      } catch (e) {
        ctx.log(`Waiting for Frigate to start... ${e} (${waited})`);
      }
      // Check outside the try, so that the catch above cannot swallow ctx.fail.
      if (resp) {
        // A 401 means Frigate signs with another secret, such as one set in FRIGATE_JWT_SECRET.
        if (resp.status === 401) ctx.fail("Frigate did not accept the signed request. Frigate may use a JWT secret from its environment.");
        if (resp.ok) return token;
        ctx.log(`Waiting for Frigate... status ${resp.status} (${waited})`);
      }
    } else {
      ctx.log(`Waiting for Frigate to write its secret (${waited})`);
    }
    await ctx.sleep(READINESS_INTERVAL_MS);
  }
  return ctx.fail("Frigate did not start in time.");
}

/** Sign an HS256 token the way Frigate does (frigate/api/auth.py, create_encoded_jwt). */
function signAdminToken(secret: string): string {
  // Frigate uses a hex secret as raw bytes (frigate/api/fastapi_app.py).
  const key = /^([0-9a-fA-F]{2})+$/.test(secret) ? Buffer.from(secret, "hex") : Buffer.from(secret, "utf-8");
  const now = Math.floor(Date.now() / 1000);
  const encode = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const unsigned = `${encode({ alg: "HS256" })}.${encode({ sub: "admin", role: "admin", exp: now + TOKEN_LIFETIME_S, iat: now })}`;
  return `${unsigned}.${createHmac("sha256", key).update(unsigned).digest("base64url")}`;
}

/** Send one request. A timeout or a refused connection ends the hook with a plain message. */
async function request(ctx: HookContext, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    return ctx.fail(`Frigate stopped answering: ${e}`);
  }
}
