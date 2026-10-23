// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { readFileSync, rmSync } from "node:fs";

import type { ContextMount, HookContext, HookInputDeclaration } from "../_lib/hook_context";

/**
 * Once Deluge is up (configure-deluge), gives its web page the password the owner chose for the
 * install or collection, and keeps downloads in progress apart from finished ones, both in Deluge's
 * own folder of the Downloads location, where Radarr, Sonarr and Lidarr see them at the same path.
 * A Deluge HexOS just installed has its password from seed-webui, so this checks it; one the owner
 * already had, which a collection brings in, gets it here through the page's own settings. With no
 * password chosen (a run from the app's card) the password stays as it is. Read at Deluge 2.2.0
 * (ui/web/json_api.py, ui/web/auth.py), the version TrueNAS pins.
 */

/** Deluge's web password before anyone sets one. */
const STOCK_PASSWORD = "deluge";
/** Where the image starts Deluge's downloads: its folder of the Downloads location, as /downloads. */
const STOCK_DOWNLOADS = "/downloads";
/** The same folder at the path the managers see it at, which HexOS also mounts in Deluge. */
const FOLDERS = { download_location: "/downloads/deluge/incomplete", move_completed: true, move_completed_path: "/downloads/deluge/complete" };

interface Session {
  url: string;
  cookie?: string;
}

function configMount(mounts: ContextMount[]): ContextMount | undefined {
  return mounts.find((m) => m.containerPath === "/config") ?? mounts.find((m) => m.hostPath.endsWith("/deluge/config"));
}

function savedPassword(configDir: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(`${configDir}/hexos/webui.json`, "utf-8")) as { password?: string }).password || undefined;
  } catch {
    return undefined;
  }
}

async function delugeApi<T>(session: Session, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(`${session.url}/json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(session.cookie ? { Cookie: session.cookie } : {}) },
    body: JSON.stringify({ method, params, id: 1 }),
    signal: AbortSignal.timeout(30_000),
  });
  const cookie = response.headers
    .getSetCookie()
    .map((header) => header.split(";")[0])
    .find((pair) => pair.startsWith("_session_id="));
  if (cookie) session.cookie = cookie;
  const body = (await response.json()) as { result: T; error: { message?: string } | null };
  if (body.error) throw new Error(body.error.message ?? `${method} failed`);
  return body.result;
}

async function until(ctx: HookContext, check: () => Promise<boolean>, attempts: number): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await check().catch(() => false)) return true;
    await ctx.sleep(1_000);
  }
  return false;
}

async function ask(ctx: HookContext, inputs: HookInputDeclaration[], prompt: { title: string; description: string }) {
  if (typeof ctx.askForInputs !== "function") return undefined;
  return ctx.askForInputs(inputs, prompt).catch((error: unknown) => {
    if (error instanceof Error && error.name === "HookInputsUnanswered") return undefined;
    throw error;
  });
}

/** Signs the session in with the first password the page takes, and says which it was. */
async function signIn(ctx: HookContext, session: Session, configDir: string): Promise<string | undefined> {
  const tried = new Set<string>();
  for (const password of [ctx.signIn?.password, savedPassword(configDir), STOCK_PASSWORD]) {
    if (!password || tried.has(password)) continue;
    tried.add(password);
    if (await delugeApi<boolean>(session, "auth.login", [password])) return password;
  }
  if (!ctx.signIn) return undefined;
  const answers = await ask(
    ctx,
    [{ type: "question", id: "password", question: { question: "Deluge password", type: "password", key: "password", required: true } }],
    {
      title: "Sign in to Deluge",
      description: "Enter the password you use for Deluge's web page now, so HexOS can change it to the one you chose.",
    },
  );
  const given = typeof answers?.password === "string" ? answers.password : "";
  if (!given) return undefined;
  if (await delugeApi<boolean>(session, "auth.login", [given])) return given;
  ctx.fail("Deluge didn't accept that password. Run Pre-configure Deluge from its Connections tab to try again.");
}

export async function configure(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "start", message: "Waiting for Deluge to start" },
    { id: "signIn", message: "Checking Deluge's password" },
    { id: "folders", message: "Checking Deluge's download folders" },
  ]);
  const configDir = configMount(ctx.mounts)?.localPath;
  if (!configDir) ctx.fail("HexOS couldn't find Deluge's settings folder");

  const session: Session = { url: ctx.baseUrl };
  if (!(await until(ctx, () => delugeApi<boolean>(session, "auth.check_session").then(() => true), 120))) {
    ctx.fail("Deluge didn't start. Try again once it's running.");
  }
  await ctx.emitCheckpoint("start");

  const current = await signIn(ctx, session, configDir);
  if (!current) {
    await ctx.skipCheckpoint("signIn", "Deluge keeps the password it has");
    await ctx.skipCheckpoint("folders", "HexOS couldn't open Deluge's settings, so they stay as they are");
    return;
  }
  const wanted = ctx.signIn?.password;
  if (!wanted) {
    await ctx.skipCheckpoint("signIn", "Deluge keeps the password it has");
  } else if (current === wanted) {
    rmSync(`${configDir}/hexos/webui.json`, { force: true });
    await ctx.skipCheckpoint("signIn", "Deluge already uses the password you chose");
  } else {
    if (!(await delugeApi<boolean>(session, "auth.change_password", [current, wanted]))) {
      ctx.fail("Deluge didn't take the password you chose. Run this again.");
    }
    if (!(await delugeApi<boolean>({ url: ctx.baseUrl }, "auth.login", [wanted]))) {
      ctx.fail("Deluge changed its password, but doesn't take the one you chose. Run this again.");
    }
    rmSync(`${configDir}/hexos/webui.json`, { force: true });
    await ctx.emitCheckpoint("signIn", "Deluge uses the password you chose");
  }

  // The page passes calls on to Deluge's daemon only once connected to it
  if (!(await delugeApi<boolean>(session, "web.connected"))) {
    const local = (await delugeApi<unknown[][]>(session, "web.get_hosts")).find((host) => host[1] === "127.0.0.1");
    if (local) await delugeApi(session, "web.connect", [local[0]]).catch(() => undefined);
    if (!(await until(ctx, () => delugeApi<boolean>(session, "web.connected"), 15))) {
      ctx.fail("Deluge's web page couldn't reach Deluge itself. Restart Deluge, then try again.");
    }
  }
  // Folders the owner chose are theirs: only the image's own are changed
  const core = await delugeApi<Record<string, unknown>>(session, "core.get_config_values", [
    ["download_location", "move_completed", "move_completed_path"],
  ]);
  if (core.download_location !== STOCK_DOWNLOADS || core.move_completed) {
    await ctx.skipCheckpoint("folders", "Deluge keeps the folders it has");
    return;
  }
  await delugeApi(session, "core.set_config", [FOLDERS]);
  const after = await delugeApi<Record<string, unknown>>(session, "core.get_config_values", [Object.keys(FOLDERS)]);
  if (Object.entries(FOLDERS).some(([key, value]) => after[key] !== value)) {
    ctx.fail("Deluge didn't keep its download folders. Run this again.");
  }
  await ctx.emitCheckpoint("folders", "Deluge keeps downloads in progress apart");
}
