// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { readFileSync, writeFileSync } from "node:fs";

import type { HookContext } from "../_lib/hook_context";

/**
 * Gives a chat app private web search through SearXNG: Open WebUI (read at 0.12) and AnythingLLM
 * (read at 1.19). SearXNG answers only html until its settings allow json, and reads them at its
 * start, so each link first adds json to settings.yml in its own folder and restarts it.
 */

const FORMATS = "search:\n  formats:\n    - html\n    - json\n";

/** Lets SearXNG answer json, the one format a chat app's search reads. */
async function allowJson(ctx: HookContext, app: string) {
  const config = ctx.mounts.find((mount) => mount.containerPath === "/etc/searxng") ?? ctx.mounts.find((mount) => mount.hostPath.endsWith("/searxng/config"));
  if (!config) ctx.fail("HexOS couldn't find SearXNG's settings folder");
  const path = `${config.localPath}/settings.yml`;
  const settings = readFileSync(path, "utf-8");
  if (/^\s+- json\s*$/m.test(settings)) {
    await ctx.skipCheckpoint("formats", `SearXNG already answers ${app}`);
    return;
  }
  if (/^search:/m.test(settings)) ctx.fail(`SearXNG's settings already have a search section. Add json to its formats there, then run this again.`);
  if (typeof ctx.restartApp !== "function") ctx.fail("This server's HexOS needs an update first. Try again after it updates.");
  writeFileSync(path, `${settings.trimEnd()}\n\n${FORMATS}`);
  await ctx.restartApp();
  await ctx.waitForApp("/healthz", { maxAttempts: 30 });
  await ctx.emitCheckpoint("formats");
}

async function openWebuiToken(ctx: HookContext, url: string): Promise<string> {
  let account = ctx.signIn?.email ? { email: ctx.signIn.email, password: ctx.signIn.password } : undefined;
  if (!account) {
    const answers = await ctx.askForInputs(
      [
        { type: "question", id: "email", question: { question: "Open WebUI email", type: "text", key: "email", required: true } },
        { type: "question", id: "password", question: { question: "Open WebUI password", type: "password", key: "password", required: true } },
      ],
      { title: "Sign in to Open WebUI", description: "Enter an administrator's sign-in, so HexOS can turn on web search." },
    );
    account = { email: String(answers.email), password: String(answers.password) };
  }
  const response = await fetch(`${url}/api/v1/auths/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(account),
    signal: AbortSignal.timeout(30_000),
  });
  const token = response.ok ? ((await response.json()) as { token?: string }).token : undefined;
  if (!token) ctx.fail("Open WebUI didn't accept that sign-in. Run this again.");
  return token;
}

/** Turns on web search through Open WebUI's API, which takes an administrator's sign-in: the run's, or the owner's when asked. */
export async function openWebui(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "formats", message: "Letting SearXNG answer Open WebUI" },
    { id: "configure", message: "Turning on web search in Open WebUI" },
  ]);
  const url = await ctx.getInstalledAppUrl("open-webui");
  if (!url) ctx.fail("Open WebUI isn't installed, or HexOS can't find its port");
  await allowJson(ctx, "Open WebUI");

  const token = await openWebuiToken(ctx, url);
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  const current = (await fetch(`${url}/api/v1/retrieval/config`, { headers, signal: AbortSignal.timeout(30_000) }).then((response) => response.json())) as {
    web?: Record<string, unknown>;
  };
  const response = await fetch(`${url}/api/v1/retrieval/config/update`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      web: { ...current.web, ENABLE_WEB_SEARCH: true, WEB_SEARCH_ENGINE: "searxng", SEARXNG_QUERY_URL: `${ctx.baseUrl}/search?q=<query>` },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) ctx.fail("Open WebUI didn't turn on web search", [{ label: "Reason", value: (await response.text()).slice(0, 200) }]);
  await ctx.emitCheckpoint("configure");
}

/**
 * Points AnythingLLM's Web Search skill, on from its first start, at SearXNG instead of the
 * keyless You.com tier it uses with no engine chosen. It adds the query and json to the address
 * itself. The settings take no sign-in on a fresh AnythingLLM; one given a password refuses them,
 * and the owner picks SearXNG under Agent Skills.
 */
export async function anythingLlm(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "formats", message: "Letting SearXNG answer AnythingLLM" },
    { id: "configure", message: "Turning on private web search in AnythingLLM" },
  ]);
  const url = await ctx.getInstalledAppUrl("anything-llm");
  if (!url) ctx.fail("AnythingLLM isn't installed, or HexOS can't find its port");
  await allowJson(ctx, "AnythingLLM");

  const send = (path: string, body: Record<string, string>) =>
    fetch(`${url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  const refused = (response: Response) =>
    ctx.fail(
      response.status === 401 || response.status === 403
        ? `AnythingLLM has a password, so HexOS can't change its settings. In AnythingLLM, open Agent Skills, then Web Search, choose SearXNG and enter ${ctx.baseUrl}/search`
        : "AnythingLLM didn't take SearXNG's address",
      [{ label: "Reason", value: `${response.status} ${response.statusText}` }],
    );
  // The address first, so the engine is never chosen without one to search
  const address = await send("/api/system/update-env", { AgentSearXNGApiUrl: `${ctx.baseUrl}/search` });
  if (!address.ok) refused(address);
  const engine = await send("/api/admin/system-preferences", { agent_search_provider: "searxng-engine" });
  if (!engine.ok) refused(engine);
  await ctx.emitCheckpoint("configure");
}
