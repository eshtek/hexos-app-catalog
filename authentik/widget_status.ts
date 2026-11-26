// authentik/widget_status.ts
// One cached query behind the Authentik dashboard card.
//
// Type imports only — each widget script is compiled standalone, so a runtime
// import of a sibling catalog file would not resolve. Copy small helpers inline.
import { readFileSync } from "node:fs";

import type { WidgetContext, WidgetQueryResult } from "../_lib/widget_context";

/**
 * Long-lived Authentik API token, read from a file on the certs mount.
 *
 * The onAfterInstall hook (authentik/post_install.ts) writes this file from the
 * AUTHENTIK_BOOTSTRAP_TOKEN created on first boot, so the counts light up on
 * their own. You can also drop a token there by hand (Directory -> Tokens,
 * intent "API", non-expiring) at:
 *     <certs mount>/hexos_widget_token
 * Without it the card still shows Authentik's live ready state.
 */
function readToken(ctx: WidgetContext): string | null {
  const certs =
    ctx.mounts.find((m) => m.containerPath === "/certs") ??
    ctx.mounts.find((m) => m.hostPath.endsWith("/authentik/certs"));
  if (!certs?.localPath) return null;
  try {
    const raw = readFileSync(`${certs.localPath}/hexos_widget_token`, "utf-8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Public health endpoint — no auth. 204/200 means DB + cache are reachable. */
async function readyState(base: string): Promise<string> {
  try {
    const res = await fetch(`${base}/-/health/ready/`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok || res.status === 204 ? "Ready" : "Starting";
  } catch {
    // appRunning gates the card, so a throw here means the server is still
    // coming up (migrations, first boot). Show that rather than erroring.
    return "Starting";
  }
}

/** A paginated Authentik list endpoint returns the total in pagination.count. */
async function count(base: string, path: string, token: string): Promise<string> {
  try {
    const res = await fetch(`${base}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return "—";
    const body = (await res.json()) as { pagination?: { count?: number } };
    const n = body.pagination?.count;
    return typeof n === "number" ? String(n) : "—";
  } catch {
    return "—";
  }
}

export async function run(ctx: WidgetContext): Promise<WidgetQueryResult> {
  // First declared catalog port (30140, the published HTTP port). Use HTTP to
  // avoid the self-signed cert on the HTTPS port.
  const base = `http://${ctx.host}:${ctx.port ?? 30140}`;
  const token = readToken(ctx);

  const status = await readyState(base);

  let users = "—";
  let applications = "—";
  let failed = "—";
  if (token) {
    [users, applications, failed] = await Promise.all([
      count(base, "/api/v3/core/users/?page_size=1", token),
      count(base, "/api/v3/core/applications/?page_size=1", token),
      count(base, "/api/v3/events/events/?action=login_failed&page_size=1", token),
    ]);
  }

  return {
    fields: {
      status: { type: "stat", label: "Status", value: status },
      users: { type: "stat", label: "Users", value: users },
      applications: { type: "stat", label: "Applications", value: applications },
      failed: { type: "stat", label: "Failed sign-ins", value: failed },
    },
  };
}
