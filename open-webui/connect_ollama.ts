// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import type { HookContext } from "../_lib/hook_context";

/**
 * Open WebUI's first account is its administrator, made from the sign-in the owner chose, and its
 * link to Ollama. It reads Ollama's address from its env only at its first start and keeps it in its
 * own database after, so a link goes through its API, which needs an administrator's sign-in. Read
 * at Open WebUI 0.12, and the same at 0.13.
 *
 * Open WebUI keeps a list of Ollama connections, each with settings of its own kept by its place in
 * the list. The link replaces only this box's Ollama in it: the connection at its address, else one
 * on this box where no Ollama answers any more (its port changed). It adds one when none is, and
 * keeps every other connection with its settings.
 */

type Json = Record<string, unknown>;

interface OllamaConfig {
  ENABLE_OLLAMA_API?: boolean | null;
  OLLAMA_BASE_URLS?: string[];
  OLLAMA_API_CONFIGS?: Json;
}

type SignInResult = { token: string } | { refused: string } | { unreachable: string };

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const trimmed = (address: string) => address.trim().replace(/\/+$/, "");

function hostOf(address: string): string | undefined {
  try {
    return new URL(address).hostname;
  } catch {
    return undefined;
  }
}

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

/** The owner's answers, or undefined when they skip, the wait runs out, or this HexOS can't ask. */
async function askAccount(ctx: HookContext): Promise<{ email: string; password: string } | undefined> {
  if (typeof ctx.askForInputs !== "function") return undefined;
  const answers = await ctx
    .askForInputs(
      [
        { type: "question", id: "email", question: { question: "Open WebUI email", type: "text", key: "email", required: true } },
        { type: "question", id: "password", question: { question: "Open WebUI password", type: "password", key: "password", required: true } },
      ],
      { title: "Sign in to Open WebUI", description: "Enter an administrator's sign-in, so HexOS can connect it to Ollama." },
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
async function adminToken(ctx: HookContext): Promise<string> {
  // One the owner already had in a collection run never took the run's sign-in, so it isn't tried
  if (ctx.signIn?.email && !ctx.keptApps?.includes(ctx.resourceId)) {
    const result = await signIn(ctx.baseUrl, ctx.signIn.email, ctx.signIn.password);
    if ("token" in result) return result.token;
    if ("unreachable" in result) unreachable(ctx, result.unreachable);
    // An Open WebUI the owner had before keeps the account they made, so they're asked for it
  }
  const account = await askAccount(ctx);
  if (!account) refuse(ctx, "HexOS needs an Open WebUI administrator's sign-in to connect it to Ollama. Run this again to give it.");
  const result = await signIn(ctx.baseUrl, account.email, account.password);
  if ("unreachable" in result) unreachable(ctx, result.unreachable);
  if ("refused" in result) ctx.fail("Open WebUI didn't accept that sign-in. Run this again.", [{ label: "Reason", value: result.refused }]);
  return result.token;
}

/** Whether an Ollama answers at this address now. */
async function answersAsOllama(address: string): Promise<boolean> {
  const response = await fetch(`${trimmed(address)}/api/version`, { signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
  if (!response?.ok) {
    await response?.body?.cancel();
    return false;
  }
  const body = (await response.json().catch(() => undefined)) as { version?: unknown } | undefined;
  return typeof body?.version === "string";
}

/**
 * Where this box's Ollama is in the list: at its address, else on this box at an address where no
 * Ollama answers now. -1 when it isn't there. An Ollama that answers is someone's, so it stays.
 */
async function ourConnection(urls: string[], url: string, host: string | undefined): Promise<number> {
  const same = urls.findIndex((each) => trimmed(each) === trimmed(url));
  if (same !== -1) return same;
  for (const [index, each] of urls.entries()) {
    if (host && hostOf(each) === host && !(await answersAsOllama(each))) return index;
  }
  return -1;
}

/**
 * The connections with `url` in place of the one at `ours`, or added at the end when that's -1. Each
 * keeps its settings, keyed by its place as Open WebUI keeps them; an older Open WebUI keyed them by
 * address, which it still reads but drops on its next save. Ours is turned on.
 */
export function withConnection(current: OllamaConfig, url: string, ours: number): Required<OllamaConfig> {
  const urls = current.OLLAMA_BASE_URLS ?? [];
  const configs = current.OLLAMA_API_CONFIGS ?? {};
  const next = ours === -1 ? [...urls, url] : urls.map((each, index) => (index === ours ? url : each));
  const keyed: Json = {};
  for (const index of urls.keys()) {
    const config = configs[String(index)] ?? configs[urls[index]];
    if (config === undefined) continue;
    keyed[String(index)] = index === ours && isRecord(config) && config.enable === false ? { ...config, enable: true } : config;
  }
  return { ENABLE_OLLAMA_API: true, OLLAMA_BASE_URLS: next, OLLAMA_API_CONFIGS: keyed };
}

/** Makes the first account, which Open WebUI makes its administrator. */
export async function configure(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "start", message: "Waiting for Open WebUI to start" },
    { id: "account", message: "Setting Open WebUI's sign-in" },
  ]);
  await ctx.waitForApp("/health", { maxAttempts: 60 });
  await ctx.emitCheckpoint("start");

  const wanted = ctx.signIn;
  if (!wanted?.email) {
    await ctx.skipCheckpoint("account", "Open WebUI asks you to create your account the first time you open it");
    return;
  }
  const config = (await fetch(`${ctx.baseUrl}/api/config`, { signal: AbortSignal.timeout(15_000) }).then((response) => response.json())) as {
    onboarding?: boolean;
  };
  if (!config.onboarding) {
    await ctx.skipCheckpoint("account", "Open WebUI keeps the account it has");
    return;
  }
  const response = await fetch(`${ctx.baseUrl}/api/v1/auths/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: wanted.username, email: wanted.email, password: wanted.password }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) ctx.fail("Open WebUI didn't take your sign-in", [{ label: "Reason", value: (await response.text()).slice(0, 200) }]);
  await ctx.emitCheckpoint("account");
}

export async function connect(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "locate", message: "Finding Ollama" },
    { id: "configure", message: "Connecting Open WebUI to Ollama" },
  ]);
  const url = await ctx.getInstalledAppUrl("ollama");
  if (!url) ctx.fail("Ollama isn't installed, or HexOS can't find its port");
  await ctx.emitCheckpoint("locate");

  // An Open WebUI that's still starting turns away every sign-in, so wait for it first
  await ctx.waitForApp("/health", { maxAttempts: 10 }).catch(() => ctx.fail("Open WebUI isn't answering yet. Wait a minute for it to start, then run this again."));
  const token = await adminToken(ctx);
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const read = await fetch(`${ctx.baseUrl}/ollama/config`, { headers, signal: AbortSignal.timeout(30_000) }).catch((error: unknown) => new Error(reasonOf(error)));
  if (read instanceof Error) ctx.fail("Open WebUI stopped answering. Run this again.", [{ label: "Reason", value: read.message }]);
  if (read.status === 401 || read.status === 403) {
    await read.body?.cancel();
    ctx.fail("That Open WebUI account isn't an administrator. Run this again and sign in as one.");
  }
  if (!read.ok) ctx.fail("HexOS couldn't read Open WebUI's Ollama connections", [{ label: "Reason", value: (await read.text()).slice(0, 200) }]);
  const current = (await read.json()) as OllamaConfig;
  const ours = await ourConnection(current.OLLAMA_BASE_URLS ?? [], url, ctx.host ?? hostOf(url));
  const next = withConnection(current, url, ours);
  const before = { ENABLE_OLLAMA_API: current.ENABLE_OLLAMA_API, OLLAMA_BASE_URLS: current.OLLAMA_BASE_URLS ?? [], OLLAMA_API_CONFIGS: current.OLLAMA_API_CONFIGS ?? {} };
  if (JSON.stringify(next) === JSON.stringify(before)) {
    await ctx.skipCheckpoint("configure", "Open WebUI already uses this Ollama");
    return;
  }

  const response = await fetch(`${ctx.baseUrl}/ollama/config/update`, {
    method: "POST",
    headers,
    body: JSON.stringify(next),
    signal: AbortSignal.timeout(30_000),
  }).catch((error: unknown) => new Error(reasonOf(error)));
  if (response instanceof Error) ctx.fail("Open WebUI stopped answering. Run this again.", [{ label: "Reason", value: response.message }]);
  if (!response.ok) ctx.fail("Open WebUI didn't take Ollama's address", [{ label: "Reason", value: (await response.text()).slice(0, 200) }]);
  await ctx.emitCheckpoint("configure");
}
