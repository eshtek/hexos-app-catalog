// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve
import { readFileSync, writeFileSync } from "node:fs";

import type { ContextMount, HookContext, HookInputDeclaration } from "../_lib/hook_context";

/**
 * Crafty makes its admin password on its first start and writes it to default-creds.txt, which it
 * never reads again. HexOS shows the owner that file, so this changes the password through Crafty's
 * own API, which restarts nothing, then writes the new one to the file. Read at Crafty 4.11.0
 * (main.py, app/classes/web/routes/api/auth/login.py and users/user/index.py), which serves its API
 * over HTTPS alone with a certificate it signs itself.
 */

const CREDENTIALS_FILE = "default-creds.txt";

type Credentials = { username: string; password: string } & Record<string, unknown>;

const CURRENT_PASSWORD: HookInputDeclaration = {
  type: "question",
  id: "current_password",
  question: { question: "Current password", type: "password", key: "current_password", required: true },
};

function credentialsPath(mounts: ContextMount[]): string | null {
  const config = mounts.find((mount) => mount.hostPath.endsWith("/config"));
  return config ? `${config.localPath}/${CREDENTIALS_FILE}` : null;
}

/** Crafty answers on the port the deck links to, in HTTPS only. */
const httpsUrl = (baseUrl: string, path: string) => `${baseUrl.replace(/^http:/, "https:")}${path}`;

const crafty = (url: string, init: RequestInit) =>
  fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
    tls: { rejectUnauthorized: false },
  } as RequestInit);

async function logIn(baseUrl: string, username: string, password: string): Promise<string | null> {
  const response = await crafty(httpsUrl(baseUrl, "/api/v2/auth/login"), {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { data?: { token?: string } };
  return body.data?.token ?? null;
}

export async function run(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "signedIn", message: "Signed in to Crafty" },
    { id: "changed", message: "Password changed" },
  ]);

  const path = credentialsPath(ctx.mounts);
  if (!path) ctx.fail("HexOS can't find Crafty's config folder");

  const next = String(ctx.inputs.password ?? "");
  const held = JSON.parse(readFileSync(path, "utf8")) as Credentials;

  // The file goes stale if the owner changed the password in Crafty itself
  let token = await logIn(ctx.baseUrl, held.username, held.password);
  if (!token) {
    const answers = await ctx.askForInputs([CURRENT_PASSWORD], {
      title: "Enter Crafty's current password",
      description: "It no longer matches the one HexOS has, so it was probably changed in Crafty.",
    });
    token = await logIn(ctx.baseUrl, held.username, String(answers.current_password ?? ""));
    if (!token) ctx.fail("Crafty didn't accept that password, so nothing changed");
  }
  await ctx.emitCheckpoint("signedIn");

  const response = await crafty(httpsUrl(ctx.baseUrl, "/api/v2/users/@me"), {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ password: next }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error_data?: string } | null;
    ctx.fail(`Crafty refused the new password${body?.error_data ? `: ${body.error_data}` : ""}`);
  }

  // Its keys stay as Crafty wrote them, and the same inode keeps the file's owner and mode
  writeFileSync(path, JSON.stringify({ ...held, password: next }, null, 4));
  await ctx.emitCheckpoint("changed");
}
