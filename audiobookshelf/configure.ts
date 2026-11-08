// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import type { HookContext } from "../_lib/hook_context";

/**
 * Sets Audiobookshelf up as HexOS ships it. Fresh, it opens on a screen that makes the owner create
 * a root user, so HexOS makes that user from the sign-in the owner chose (`ctx.signIn`) and adds the
 * Audiobooks and Podcasts folders it mounts. One that already has a root user keeps it: its API
 * needs that user's own password, which the owner gives in a collection's walk for an Audiobookshelf
 * they already had (`ctx.existingSignIns`), and a run with nothing to sign in with stops quietly
 * rather than ask. Read at Audiobookshelf 2.37.2, the version TrueNAS pins.
 */

const LIBRARIES = [
  { name: "Audiobooks", mediaType: "book", provider: "audible", folder: "/audiobooks" },
  { name: "Podcasts", mediaType: "podcast", provider: "itunes", folder: "/podcasts" },
];

async function shelf<T>(ctx: HookContext, path: string, init: { body?: unknown; token?: string; method?: string } = {}): Promise<T> {
  const response = await fetch(`${ctx.baseUrl}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json", ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text.slice(0, 200) || `${response.status} ${response.statusText}`);
  try {
    return (text ? JSON.parse(text) : undefined) as T;
  } catch {
    return text as T;
  }
}

/** Whether a root user exists yet, once the server answers. */
async function isInitialized(ctx: HookContext): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const status = await shelf<{ isInit?: boolean }>(ctx, "/status").catch(() => undefined);
    if (status) return status.isInit === true;
    await ctx.sleep(5_000);
  }
  ctx.fail("Audiobookshelf didn't start. Try again once it's running.");
}

/** The owner's own account's token, on one they already had: undefined when Audiobookshelf refuses it. */
async function ownToken(ctx: HookContext, account: { username: string; password: string }): Promise<string | undefined> {
  const response = await fetch(`${ctx.baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: account.username, password: account.password }),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => undefined);
  if (!response) ctx.fail("Audiobookshelf didn't answer. Try again once it's running.");
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    return undefined;
  }
  if (!response.ok) ctx.fail(`Audiobookshelf didn't answer its sign-in (${response.status}). Try again once it's running.`);
  const answer = (await response.json().catch(() => undefined)) as { user?: { token?: string; accessToken?: string } } | undefined;
  return answer?.user?.accessToken ?? answer?.user?.token;
}

const logIn = (ctx: HookContext, username: string, password: string) =>
  shelf<{ user?: { token?: string; accessToken?: string } }>(ctx, "/login", { body: { username, password } })
    .then((answer) => answer.user?.accessToken ?? answer.user?.token)
    .catch(() => undefined);

export async function configure(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "start", message: "Waiting for Audiobookshelf to start" },
    { id: "signIn", message: "Setting Audiobookshelf's sign-in" },
    ...LIBRARIES.map((library) => ({ id: library.folder, message: `Adding your ${library.name} library to Audiobookshelf` })),
  ]);

  const initialized = await isInitialized(ctx);
  await ctx.emitCheckpoint("start");

  const kept = ctx.keptApps?.includes(ctx.resourceId) === true;
  const given = kept && !ctx.refusedSignIns?.includes(ctx.resourceId) ? ctx.existingSignIns?.[ctx.resourceId] : undefined;
  // One with no root user yet makes the chosen account, else the one the owner gave
  const wanted = ctx.signIn ?? (given?.username ? given : undefined);
  if (!initialized) {
    if (!wanted) {
      await ctx.skipCheckpoint("signIn", "Audiobookshelf asks you to create your account the first time you open it");
      for (const library of LIBRARIES) await ctx.skipCheckpoint(library.folder, "Add your libraries once you've created your account");
      return;
    }
    try {
      await shelf(ctx, "/init", { body: { newRoot: { username: wanted.username, password: wanted.password } } });
    } catch (error) {
      ctx.fail("Audiobookshelf didn't take your sign-in", [{ label: "Reason", value: error instanceof Error ? error.message : String(error) }]);
    }
    await ctx.emitCheckpoint("signIn");
  }

  // One the owner already had signs in as their own account, tried once in the run
  const own =
    initialized && kept
      ? await ctx.tryExistingSignIn?.(ctx.resourceId, (account) => ownToken(ctx, account), {
          title: "Sign in to Audiobookshelf",
          description: "Audiobookshelf refused the account you gave. Enter it again so HexOS can use it.",
          username: true,
          app: "Audiobookshelf",
        })
      : undefined;
  if (own === "refused") {
    const message = "Audiobookshelf refused the account you gave, so HexOS left Audiobookshelf as it is. Add your libraries in Audiobookshelf's settings.";
    if (ctx.skip) ctx.skip(message);
    ctx.fail(message);
  }
  const token = initialized && kept ? own : wanted ? await logIn(ctx, wanted.username, wanted.password) : undefined;
  if (!token) {
    if (initialized) {
      await ctx.skipCheckpoint("signIn", "Audiobookshelf keeps the account it has");
      for (const library of LIBRARIES) await ctx.skipCheckpoint(library.folder, "Audiobookshelf keeps the libraries it has");
      return;
    }
    ctx.fail("Audiobookshelf took your sign-in but won't sign in with it. Try again.");
  }
  if (initialized) {
    await ctx.skipCheckpoint("signIn", kept ? "Audiobookshelf keeps the account it has" : "Audiobookshelf already uses the sign-in you chose");
  }

  const present = await shelf<{ libraries: Array<{ folders?: Array<{ fullPath?: string }> }> }>(ctx, "/api/libraries", { token });
  const folders = new Set(present.libraries.flatMap((library) => (library.folders ?? []).map((folder) => folder.fullPath)));
  for (const library of LIBRARIES) {
    if (folders.has(library.folder)) {
      await ctx.skipCheckpoint(library.folder, `Audiobookshelf already has your ${library.name} library`);
      continue;
    }
    try {
      await shelf(ctx, "/api/libraries", {
        token,
        body: { name: library.name, folders: [{ fullPath: library.folder }], mediaType: library.mediaType, provider: library.provider },
      });
    } catch (error) {
      ctx.fail(`Audiobookshelf didn't add your ${library.name} library`, [
        { label: "Reason", value: error instanceof Error ? error.message : String(error) },
      ]);
    }
    await ctx.emitCheckpoint(library.folder);
  }
}
