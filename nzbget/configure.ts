// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { existsSync, readFileSync, rmSync } from "node:fs";

import type { ContextMount, HookContext } from "../_lib/hook_context";

/** What NZBGet's own settings file starts with (nzbget.conf at v26.3, the version TrueNAS pins). */
const STOCK = { password: "tegbzn6789", authorizedIp: "127.0.0.1", mainDir: "/downloads" };
/** The sign-in a fresh NZBGet gets when the owner chose none. */
const DEFAULT_SIGN_IN = { username: "admin", password: "admin" };
/** The private address ranges, which NZBGet lets in without a sign-in once they're listed. */
const HOME_NETWORK = ["127.0.0.1", "10.*", "192.168.*", ...Array.from({ length: 16 }, (_, i) => `172.${16 + i}.*`)].join(", ");
/** The Downloads folder HexOS gives NZBGet, at the path Radarr, Sonarr and Lidarr see it at too. */
const MAIN_DIR = "/downloads/nzbget";

interface SignIn {
  username: string;
  password: string;
}

interface Option {
  Name: string;
  Value: string;
}

class SignInRefused extends Error {}

function configMount(mounts: ContextMount[]): ContextMount | undefined {
  return mounts.find((m) => m.containerPath === "/config") ?? mounts.find((m) => m.hostPath.endsWith("/nzbget/config"));
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

/** The sign-in NZBGet's settings file names now. */
function signInOf(conf: string): SignIn {
  return {
    username: conf.match(/^ControlUsername=(.*)$/m)?.[1] ?? "nzbget",
    password: conf.match(/^ControlPassword=(.*)$/m)?.[1] ?? STOCK.password,
  };
}

async function rpc<T>(url: string, signIn: SignIn, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(`${url}/jsonrpc`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${signIn.username}:${signIn.password}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ method, params, id: 1 }),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 401) {
    await response.body?.cancel();
    throw new SignInRefused("NZBGet refused the sign-in");
  }
  const body = (await response.json()) as { result?: T; error?: { message?: string } | null };
  if (body.error) throw new Error(body.error.message ?? `${method} failed`);
  return body.result as T;
}

/** Waits for NZBGet to answer with this sign-in. */
async function waitForNzbget(ctx: HookContext, url: string, signIn: SignIn, attempts: number): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await rpc(url, signIn, "version");
      return true;
    } catch (error) {
      if (error instanceof SignInRefused) return false;
    }
    await ctx.sleep(5_000);
  }
  return false;
}

/**
 * After NZBGet's first start (configure-nzbget), gives it the sign-in the owner chose for the install
 * or collection in place of the one every NZBGet starts with, and lets the home network open it
 * without one, as NZBGet's AuthorizedIP allows. Its downloads go to the path Radarr, Sonarr and
 * Lidarr see them at. NZBGet keeps the sign-in in its own settings file, where the links read it. An
 * NZBGet the owner already had, which a collection brings in, gets the owner's sign-in too; with
 * none chosen (a run from the app's card, or a deck from before they chose one) a fresh NZBGet gets
 * admin/admin and one set up before keeps its own. Its news server is the owner's own account, so
 * HexOS adds none.
 */
export async function configure(ctx: HookContext) {
  await ctx.registerCheckpoints([{ id: "signIn", message: "Setting NZBGet's sign-in" }]);

  const config = configMount(ctx.mounts);
  if (!config) ctx.fail("HexOS couldn't find NZBGet's settings folder");
  const confPath = `${config.localPath}/nzbget.conf`;

  // NZBGet writes its settings file at its first start
  for (let attempt = 0; attempt < 36 && !existsSync(confPath); attempt++) await ctx.sleep(5_000);
  const conf = readText(confPath);
  if (!conf) ctx.fail("NZBGet didn't start. Try again once it's running.");
  const current = signInOf(conf);
  if (!(await waitForNzbget(ctx, ctx.baseUrl, current, 36))) {
    ctx.fail("HexOS couldn't sign in to NZBGet. Try again once it's running.");
  }

  const options = await rpc<Option[]>(ctx.baseUrl, current, "loadconfig");
  const valueOf = (name: string) => options.find((option) => option.Name === name)?.Value;
  const fresh = valueOf("ControlPassword") === STOCK.password;
  // The owner's choice, else HexOS's default for an NZBGet nobody has set up
  const wanted = ctx.signIn ?? (fresh ? DEFAULT_SIGN_IN : undefined);

  const changes = new Map<string, string>();
  if (wanted && (current.username !== wanted.username || current.password !== wanted.password)) {
    changes.set("ControlUsername", wanted.username);
    changes.set("ControlPassword", wanted.password);
  }
  // A NZBGet set up before keeps how it lets the network in, and where it downloads
  if (fresh || ctx.signIn) {
    if (valueOf("AuthorizedIP") === STOCK.authorizedIp) changes.set("AuthorizedIP", HOME_NETWORK);
    // The same folder as /downloads in NZBGet's container, at the path the other apps find it at
    if (valueOf("MainDir") === STOCK.mainDir) changes.set("MainDir", MAIN_DIR);
  }
  // Older HexOS kept the default beside the settings; NZBGet's own file says what it uses
  rmSync(`${config.localPath}/hexos/webui.json`, { force: true });

  if (changes.size === 0) {
    await ctx.skipCheckpoint("signIn", wanted ? "NZBGet already has its sign-in" : "NZBGet keeps the sign-in it had");
    return;
  }
  const signIn = changes.has("ControlPassword") && wanted ? wanted : current;

  const updated = options.map((option) =>
    changes.has(option.Name) ? { Name: option.Name, Value: changes.get(option.Name) as string } : option,
  );
  if (!(await rpc<boolean>(ctx.baseUrl, current, "saveconfig", [updated]))) {
    ctx.fail("NZBGet didn't save its new settings. Try again once it's running.");
  }
  await rpc(ctx.baseUrl, current, "reload");
  await ctx.sleep(3_000);
  if (!(await waitForNzbget(ctx, ctx.baseUrl, signIn, 24))) {
    ctx.fail("NZBGet didn't come back with its new sign-in. Restart NZBGet, then try again.");
  }

  // What NZBGet runs with now, checked against what was saved
  const active = await rpc<Option[]>(ctx.baseUrl, signIn, "config");
  const wrong = [...changes].filter(([name, value]) => active.find((option) => option.Name === name)?.Value !== value);
  if (wrong.length > 0) {
    ctx.fail("NZBGet saved its new settings but isn't using all of them. Restart NZBGet, then try again.", [
      { label: "Settings", value: wrong.map(([name]) => name).join(", ") },
    ]);
  }
  ctx.log("NZBGet's sign-in and home network access are set");
  await ctx.emitCheckpoint(
    "signIn",
    ctx.signIn ? "NZBGet uses the sign-in you chose, and opens on your home network without it" : "NZBGet opens on your home network without a password",
  );
}
