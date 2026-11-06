// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { readFileSync, writeFileSync } from "node:fs";

import type { HookContext } from "../_lib/hook_context";

/**
 * Gives Open WebUI private web search through SearXNG. SearXNG answers only html until its settings
 * allow json, and reads them at its start, so the link adds json to settings.yml in its own folder
 * and restarts it. It then turns web search on through Open WebUI's API, which takes an
 * administrator's sign-in: the run's, or the owner's when asked. Read at Open WebUI 0.12.
 */

const FORMATS = "search:\n  formats:\n    - html\n    - json\n";

type SignInResult = { token: string } | { refused: string } | { unreachable: string };

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Ends the link for something only the owner can change, so a collection doesn't offer Try again. */
function refuse(ctx: HookContext, message: string, context?: Array<{ label: string; value: string }>): never {
  if (ctx.skip) ctx.skip(message, context);
  return ctx.fail(message, context);
}

/** A token, or whether Open WebUI said no or didn't answer at all. */
async function signIn(url: string, email: string, password: string): Promise<SignInResult> {
  const response = await fetch(`${url}/api/v1/auths/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(30_000),
  }).catch((error: unknown) => new Error(reasonOf(error)));
  if (response instanceof Error) return { unreachable: response.message };
  if (!response.ok) return { refused: `${response.status} ${(await response.text().catch(() => "")).slice(0, 200)}` };
  const body = (await response.json().catch(() => undefined)) as { token?: string; next_step?: string } | undefined;
  if (body?.token) return { token: body.token };
  // A second step (two-factor), or an account an administrator hasn't approved yet
  return { refused: body?.next_step ? `Open WebUI asks this account for another step: ${body.next_step}` : "Open WebUI gave no token" };
}

function unreachable(ctx: HookContext, reason: string): never {
  return ctx.fail("Open WebUI stopped answering while HexOS signed in. Run this again.", [{ label: "Reason", value: reason }]);
}

/** Waits a little for Open WebUI, which turns away every sign-in while it's still starting. */
async function openWebUiAnswers(ctx: HookContext, url: string): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
    await response?.body?.cancel();
    if (response?.ok) return true;
    await ctx.sleep(5_000);
  }
  return false;
}

/** The owner's answers, or undefined when they skip, the wait runs out, or this HexOS can't ask. */
async function askAccount(ctx: HookContext): Promise<{ email: string; password: string } | undefined> {
  if (typeof ctx.askForInputs !== "function") return undefined;
  const answers = await ctx
    .askForInputs(
      [
        { type: "question", id: "email", question: { question: "Open WebUI email", type: "text", key: "email", required: true } },
        { type: "question", id: "password", question: { question: "Open WebUI password", type: "password", key: "password", required: true } },
      ],
      { title: "Sign in to Open WebUI", description: "Enter an administrator's sign-in, so HexOS can turn on web search." },
    )
    .catch((error: unknown) => {
      if (error instanceof Error && error.name === "HookInputsUnanswered") return undefined;
      throw error;
    });
  const email = String(answers?.email ?? "").trim();
  const password = String(answers?.password ?? "");
  return email && password ? { email, password } : undefined;
}

/** An administrator's token: the run's sign-in, else the owner's, asked for. */
async function adminToken(ctx: HookContext, url: string): Promise<string> {
  if (!(await openWebUiAnswers(ctx, url))) ctx.fail("Open WebUI isn't answering yet. Wait a minute for it to start, then run this again.");
  if (ctx.signIn?.email) {
    const result = await signIn(url, ctx.signIn.email, ctx.signIn.password);
    if ("token" in result) return result.token;
    if ("unreachable" in result) unreachable(ctx, result.unreachable);
    // An Open WebUI the owner had before keeps the account they made, so they're asked for it
  }
  const account = await askAccount(ctx);
  if (!account) refuse(ctx, "HexOS needs an Open WebUI administrator's sign-in to turn on web search. Run this again to give it.");
  const result = await signIn(url, account.email, account.password);
  if ("unreachable" in result) unreachable(ctx, result.unreachable);
  if ("refused" in result) ctx.fail("Open WebUI didn't accept that sign-in. Run this again.", [{ label: "Reason", value: result.refused }]);
  return result.token;
}

export async function run(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "formats", message: "Letting SearXNG answer Open WebUI" },
    { id: "configure", message: "Turning on web search in Open WebUI" },
  ]);
  const config = ctx.mounts.find((mount) => mount.containerPath === "/etc/searxng") ?? ctx.mounts.find((mount) => mount.hostPath.endsWith("/searxng/config"));
  if (!config) ctx.fail("HexOS couldn't find SearXNG's settings folder");
  const url = await ctx.getInstalledAppUrl("open-webui");
  if (!url) ctx.fail("Open WebUI isn't installed, or HexOS can't find its port");

  const path = `${config.localPath}/settings.yml`;
  const settings = readFileSync(path, "utf-8");
  if (/^\s+- json\s*$/m.test(settings)) {
    await ctx.skipCheckpoint("formats", "SearXNG already answers Open WebUI");
  } else {
    if (/^search:/m.test(settings)) ctx.fail("SearXNG's settings already have a search section. Add json to its formats there, then run this again.");
    if (typeof ctx.restartApp !== "function") ctx.fail("This server's HexOS needs an update first. Try again after it updates.");
    writeFileSync(path, `${settings.trimEnd()}\n\n${FORMATS}`);
    await ctx.restartApp();
    await ctx.waitForApp("/healthz", { maxAttempts: 30 });
    await ctx.emitCheckpoint("formats");
  }

  const token = await adminToken(ctx, url);
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  const current = (await fetch(`${url}/api/v1/retrieval/config`, { headers, signal: AbortSignal.timeout(30_000) })
    .then((response) => response.json())
    .catch((error: unknown) => new Error(reasonOf(error)))) as { web?: Record<string, unknown> } | Error;
  if (current instanceof Error) ctx.fail("Open WebUI stopped answering. Run this again.", [{ label: "Reason", value: current.message }]);
  const response = await fetch(`${url}/api/v1/retrieval/config/update`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      web: { ...current.web, ENABLE_WEB_SEARCH: true, WEB_SEARCH_ENGINE: "searxng", SEARXNG_QUERY_URL: `${ctx.baseUrl}/search?q=<query>` },
    }),
    signal: AbortSignal.timeout(30_000),
  }).catch((error: unknown) => new Error(reasonOf(error)));
  if (response instanceof Error) ctx.fail("Open WebUI stopped answering. Run this again.", [{ label: "Reason", value: response.message }]);
  if (!response.ok) ctx.fail("Open WebUI didn't turn on web search", [{ label: "Reason", value: (await response.text()).slice(0, 200) }]);
  await ctx.emitCheckpoint("configure");
}
