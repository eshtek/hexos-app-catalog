// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import type { HookContext } from "../_lib/hook_context";

/**
 * Open WebUI's first account is its administrator, made from the sign-in the owner chose, and its
 * link to Ollama. It reads Ollama's address from its env only at its first start and keeps it in its
 * own database after, so a link goes through its API, which needs an administrator's sign-in. Read
 * at Open WebUI 0.12.
 */

async function signIn(ctx: HookContext, email: string, password: string): Promise<string | undefined> {
  const response = await fetch(`${ctx.baseUrl}/api/v1/auths/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => undefined);
  if (!response?.ok) {
    await response?.body?.cancel();
    return undefined;
  }
  return ((await response.json()) as { token?: string }).token;
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

  let account = ctx.signIn?.email ? { email: ctx.signIn.email, password: ctx.signIn.password } : undefined;
  if (!account) {
    const answers = await ctx.askForInputs(
      [
        { type: "question", id: "email", question: { question: "Open WebUI email", type: "text", key: "email", required: true } },
        { type: "question", id: "password", question: { question: "Open WebUI password", type: "password", key: "password", required: true } },
      ],
      { title: "Sign in to Open WebUI", description: "Enter an administrator's sign-in, so HexOS can connect it to Ollama." },
    );
    account = { email: String(answers.email), password: String(answers.password) };
  }
  const token = await signIn(ctx, account.email, account.password);
  if (!token) ctx.fail("Open WebUI didn't accept that sign-in. Run this again.");

  const response = await fetch(`${ctx.baseUrl}/ollama/config/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ENABLE_OLLAMA_API: true, OLLAMA_BASE_URLS: [url], OLLAMA_API_CONFIGS: {} }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) ctx.fail("Open WebUI didn't take Ollama's address", [{ label: "Reason", value: (await response.text()).slice(0, 200) }]);
  await ctx.emitCheckpoint("configure");
}
