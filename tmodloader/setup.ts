// Sibling files are type imports only: each script is compiled standalone, so runtime imports of them wouldn't resolve.
import { existsSync } from "node:fs";

import type { ContextMount, HookContext } from "../_lib/hook_context";

// tModLoader's dashboard holds the game back until someone creates its admin token: the container
// prints a one-time setup code to its log, and the dashboard's /api/setup takes that code with the
// token. This reads the code from the container's log over the Docker socket the HexOS container
// has, and sets the owner's chosen password as the token, so the dashboard opens ready and the
// world starts. The dashboard accepts setup from private addresses only, which the box's own is.

const DOCKER_SOCKET = "/var/run/docker.sock";
const SERVICE = "tmodloader";
const TOKEN_FILE = "admin/token.argon2";
const SETUP_CODE = /One-time setup code: ([A-Za-z0-9_-]+)/g;
/** What the dashboard takes as a token: 8 to 256 ASCII characters, no whitespace. */
const VALID_TOKEN = /^[\x21-\x7e]{8,256}$/;
/** A first start pulls tModLoader and its runtime before the dashboard prints its code. */
const CODE_WAIT_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

const docker = (path: string) =>
  fetch(`http://docker${path}`, { unix: DOCKER_SOCKET, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

/** The app's container, by compose project, since a later copy's is ix-tmodloader-2-tmodloader-1. */
async function containerOf(app: string): Promise<string | null> {
  const filters = encodeURIComponent(
    JSON.stringify({ label: [`com.docker.compose.project=ix-${app}`, `com.docker.compose.service=${SERVICE}`] }),
  );
  try {
    const response = await docker(`/containers/json?all=true&filters=${filters}`);
    if (!response.ok) return null;
    return ((await response.json()) as Array<{ Id: string }>)[0]?.Id ?? null;
  } catch {
    return null;
  }
}

/** The latest setup code in a log, or null. A restart prints a new one, so the last one counts. */
export function latestSetupCode(log: string): string | null {
  const codes = [...log.matchAll(SETUP_CODE)].map((match) => match[1]);
  return codes.at(-1) ?? null;
}

async function setupCode(container: string): Promise<string | null> {
  try {
    const response = await docker(`/containers/${container}/logs?stdout=true&stderr=true&tail=500`);
    return response.ok ? latestSetupCode(await response.text()) : null;
  } catch {
    return null;
  }
}

const dataMount = (ctx: HookContext): ContextMount | undefined =>
  ctx.mounts.find((m) => m.containerPath === "/data") ?? ctx.mounts.find((m) => /\/tmodloader(-\d+)?\/data$/.test(m.hostPath));

/** The owner's password when the dashboard can take it as a token, else one asked for. */
async function tokenFor(ctx: HookContext): Promise<string> {
  const chosen = ctx.signIn?.password;
  if (chosen && VALID_TOKEN.test(chosen)) return chosen;
  const answers = await ctx
    .askForInputs(
      [
        {
          type: "question",
          id: "password",
          question: { question: "Password (at least 8 characters, no spaces)", type: "password", key: "password", required: true },
        },
      ],
      { title: "tModLoader's dashboard", description: "You sign in to tModLoader's dashboard with this." },
    )
    .catch(() => null);
  const asked = answers ? String(answers.password) : "";
  if (!VALID_TOKEN.test(asked)) ctx.fail("tModLoader's dashboard needs a password of at least 8 characters with no spaces.");
  return asked;
}

export async function setAdmin(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "ready", message: "Waiting for tModLoader" },
    { id: "admin", message: "Setting the dashboard's sign-in" },
  ]);
  const data = dataMount(ctx);
  if (data && existsSync(`${data.localPath}/${TOKEN_FILE}`)) {
    await ctx.skipCheckpoint("ready", "tModLoader keeps its sign-in from before");
    await ctx.skipCheckpoint("admin", "tModLoader keeps its sign-in from before");
    return;
  }
  if (!ctx.host || !ctx.port) ctx.fail("HexOS couldn't read this server's address.");

  let code: string | null = null;
  for (const deadline = Date.now() + CODE_WAIT_MS; Date.now() < deadline; await ctx.sleep(5000)) {
    const container = await containerOf(ctx.resourceId);
    if (container) code = await setupCode(container);
    if (code) break;
  }
  if (!code) ctx.fail("tModLoader didn't finish starting in time. Try again once its dashboard opens.");
  await ctx.emitCheckpoint("ready", "tModLoader is up", 50);

  const token = await tokenFor(ctx);
  const url = `http://${ctx.host}:${ctx.port}/api/setup`;
  for (let attempt = 0; attempt < 5; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, token, confirm: token }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      await ctx.sleep(3000); // the dashboard may still be binding its port
      continue;
    }
    if (response.ok) {
      await ctx.emitCheckpoint("admin", "Sign in to the dashboard with your password", 100);
      return;
    }
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    // One try a second: a quick retry is refused until the second is up
    if (/Wait a moment/i.test(detail)) {
      await ctx.sleep(1500);
      continue;
    }
    // Someone finished setup in the dashboard first: there's nothing left for HexOS to do
    if (/Setup is unavailable/i.test(detail) && data && existsSync(`${data.localPath}/${TOKEN_FILE}`)) {
      await ctx.skipCheckpoint("admin", "tModLoader's dashboard already has a sign-in");
      return;
    }
    ctx.fail(`tModLoader's dashboard refused the sign-in: ${detail || response.status}`);
  }
  ctx.fail("HexOS couldn't reach tModLoader's dashboard to set its sign-in.");
}
