// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { chownSync, mkdirSync, readFileSync } from "node:fs";

import type { ContextMount, HookContext, HookInputDeclaration } from "../_lib/hook_context";

/**
 * Adds a download client to Sportarr: the hook Sportarr declares per client (connect-qbittorrent,
 * connect-deluge, connect-sabnzbd, connect-nzbget). The link gets each client ready the same way the
 * links from Radarr and Sonarr do (servarr/connect_download_client.ts), with a sportarr category.
 * Sportarr has its own API, with one flat record per client and no schema, so the link builds the
 * record. Sportarr saves a client without a test. So the link runs Sportarr's connection test first
 * and saves only a client that passes. The one exception is a qBittorrent that has locked Sportarr
 * out, which gets the sign-in HexOS has just checked.
 *
 * Sportarr sees the whole Downloads location at /downloads and qBittorrent's folder at
 * /config/Downloads, the paths each client keeps its downloads at in its own container. So a
 * finished download is where Sportarr looks, with no remote path mapping.
 *
 * The client's sign-in comes in the same order as for the arr apps: the one the owner chose for the
 * install or collection (`ctx.signIn`), else the one in the client's own settings, else HexOS's
 * default, and the owner is asked last. Run again, a link puts back how Sportarr reaches the client
 * and its sign-in, and fills the category only when the owner left it empty.
 */

/** The user the TrueNAS charts run the download clients as. */
const APPS_UID = 568;
const MANAGER = "Sportarr";
/** Sportarr's own default category, used in every client. */
const CATEGORY = "sportarr";
/** Sportarr's client types (DownloadClientType at 4.1.11), sent as numbers. */
const TYPES = { qbittorrent: 0, deluge: 2, sabnzbd: 5, nzbget: 6 } as const;

type ClientId = keyof typeof TYPES;

interface DownloadClient {
  id?: number;
  name: string;
  type: number;
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
  apiKey?: string | null;
  urlBase?: string | null;
  category?: string | null;
  useSsl?: boolean;
  enabled?: boolean;
  priority?: number;
  [field: string]: unknown;
}

type Fields = Record<string, string>;

interface ClientPlan {
  name: string;
  /** How Sportarr reaches the client, beyond host and port: put back on every run. */
  connection?: Fields;
  /**
   * The client's sign-in, by Sportarr's field name: `known`, one HexOS just signed in to the client
   * with (undefined when it knows none), and `ask` as a last resort, checked the same way.
   */
  signIn: { known: () => Promise<Fields | undefined>; ask: () => Promise<Fields | undefined> };
  /** For a client that locks out an address after failed sign-ins, what the link says when it has locked Sportarr out. */
  lockout?: string;
}

interface Client {
  url: string;
  host: string;
  port: number;
  mounts: ContextMount[];
}

function configMount(mounts: ContextMount[], appId: string): ContextMount | undefined {
  return mounts.find((m) => m.containerPath === "/config") ?? mounts.find((m) => m.hostPath.endsWith(`/${appId}/config`));
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readText(path) ?? "") as T;
  } catch {
    return undefined;
  }
}

async function until(ctx: HookContext, check: () => Promise<boolean>, attempts: number): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await check().catch(() => false)) return true;
    await ctx.sleep(1_000);
  }
  return false;
}

async function sportarrApi<T>(ctx: HookContext, apiKey: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${ctx.baseUrl}/api${path}`, {
    ...init,
    headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) {
    let reason = text.slice(0, 300);
    try {
      const body = JSON.parse(text) as { message?: string; error?: string };
      reason = body.message || body.error || reason;
    } catch {}
    throw new Error(reason || `${response.status} ${response.statusText}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * Finds Sportarr and the client, gets the client ready, and adds or updates the client in Sportarr.
 * `prepare` signs in to the client and makes there what Sportarr's test needs.
 */
async function link(ctx: HookContext, appId: ClientId, name: string, prepare: (client: Client) => Promise<ClientPlan>) {
  await ctx.registerCheckpoints([
    { id: "locate", message: `Finding ${name}` },
    { id: "prepare", message: `Getting ${name} ready` },
    { id: "configure", message: `Adding ${name} as a download client` },
  ]);

  const apiKey = readText(`${configMount(ctx.mounts, "sportarr")?.localPath}/config.xml`)?.match(/<ApiKey>([^<]+)<\/ApiKey>/)?.[1];
  if (!apiKey) ctx.fail(`HexOS couldn't read ${MANAGER}'s API key yet. Try again once it has started.`);
  const url = await ctx.getInstalledAppUrl(appId);
  if (!url) ctx.fail(`${name} isn't installed, or HexOS can't find its port`);
  const parsed = new URL(url);
  const client: Client = { url, host: parsed.hostname, port: Number(parsed.port), mounts: await ctx.getInstalledAppMounts(appId) };
  await ctx.emitCheckpoint("locate");

  const plan = await prepare(client);
  await ctx.emitCheckpoint("prepare");

  // The oldest of the owner's clients at this address, when they added it more than once
  const existing = (await sportarrApi<DownloadClient[]>(ctx, apiKey, "/downloadclient"))
    .filter((entry) => entry.type === TYPES[appId] && entry.host === client.host && entry.port === client.port)
    .sort((a, b) => (a.id ?? 0) - (b.id ?? 0))[0];

  const definition = (signIn: Fields): DownloadClient => ({
    ...existing,
    name: existing?.name ?? plan.name,
    type: TYPES[appId],
    host: client.host,
    port: client.port,
    useSsl: false,
    urlBase: "",
    enabled: existing?.enabled ?? true,
    priority: existing?.priority ?? 1,
    category: existing?.category || CATEGORY,
    ...plan.connection,
    ...signIn,
  });
  const test = (signIn: Fields) =>
    sportarrApi(ctx, apiKey, "/downloadclient/test", { method: "POST", body: JSON.stringify(definition(signIn)) });
  const save = (signIn: Fields) =>
    existing?.id !== undefined
      ? sportarrApi(ctx, apiKey, `/downloadclient/${existing.id}`, { method: "PUT", body: JSON.stringify(definition(signIn)) })
      : sportarrApi(ctx, apiKey, "/downloadclient", { method: "POST", body: JSON.stringify(definition(signIn)) });
  const attempt = (signIn: Fields) =>
    test(signIn)
      .then(() => save(signIn))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
  const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

  // A sign-in HexOS just signed in to the client with goes first. Without one, Sportarr keeps what it
  // has, and the owner is asked only when that fails too.
  const known = await plan.signIn.known();
  let signIn: Fields = known ?? {};
  let verified = known !== undefined;
  let refused = await attempt(signIn);
  if (refused !== undefined && !verified) {
    const answered = await plan.signIn.ask();
    if (answered && JSON.stringify(answered) !== JSON.stringify(signIn)) {
      signIn = answered;
      verified = true;
      refused = await attempt(signIn);
    }
  }
  // The client took this sign-in from HexOS at the same address, so a refusal to Sportarr means
  // Sportarr's own address is locked out. Sportarr saves without a test, so it gets the sign-in now
  // and connects once the lockout ends. Sportarr's test says only pass or fail, never why.
  if (refused !== undefined && verified && plan.lockout) {
    refused = await save(signIn).then(
      () => undefined,
      (error: unknown) => error,
    );
    if (refused === undefined) {
      await ctx.emitCheckpoint("configure", plan.lockout);
      return;
    }
  }
  if (refused !== undefined) ctx.fail(`${MANAGER} couldn't connect to ${name}`, [{ label: "Reason", value: reasonOf(refused) }]);
  await ctx.emitCheckpoint("configure");
}

/** The owner's answers, or undefined when they skip, the wait runs out, or this HexOS can't ask. */
async function ask(ctx: HookContext, inputs: HookInputDeclaration[], prompt: { title: string; description: string }) {
  if (typeof ctx.askForInputs !== "function") return undefined;
  return ctx.askForInputs(inputs, prompt).catch((error: unknown) => {
    if (error instanceof Error && error.name === "HookInputsUnanswered") return undefined;
    throw error;
  });
}

const usernameQuestion = (app: string): HookInputDeclaration => ({
  type: "question",
  id: "username",
  question: { question: `${app} username`, type: "text", key: "username", required: true },
});
const passwordQuestion = (app: string): HookInputDeclaration => ({
  type: "question",
  id: "password",
  question: { question: `${app} password`, type: "password", key: "password", required: true },
});

// --- qBittorrent -------------------------------------------------------------

/** The WebUI checks a request comes from its own pages when CSRF protection is on. */
const qbittorrentHeaders = (url: string, extra: Record<string, string> = {}) => ({ Referer: `${url}/`, Origin: url, ...extra });

/**
 * Whether qBittorrent takes this sign-in: 204 (5.x) or "Ok." (4.x), "Fails." when it doesn't. Each
 * refusal counts toward its ban, so the link tries few. From an address its whitelist lets in it
 * takes any sign-in, and so does Sportarr's test.
 */
async function qbittorrentSignsIn(url: string, signIn: { username: string; password: string }): Promise<boolean> {
  const response = await fetch(`${url}/api/v2/auth/login`, {
    method: "POST",
    headers: qbittorrentHeaders(url, { "Content-Type": "application/x-www-form-urlencoded" }),
    body: new URLSearchParams(signIn),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
  if (!response) return false;
  return response.ok && (await response.text()).trim() !== "Fails.";
}

/** Whether the WebUI lets this caller in as it is, as the home network gets in. */
async function qbittorrentOpen(url: string): Promise<boolean> {
  const response = await fetch(`${url}/api/v2/app/version`, { headers: qbittorrentHeaders(url), signal: AbortSignal.timeout(10_000) }).catch(
    () => undefined,
  );
  await response?.body?.cancel();
  return response?.status === 200;
}

export const qbittorrent = (ctx: HookContext) =>
  link(ctx, "qbittorrent", "qBittorrent", async ({ url, mounts }) => {
    // A download in progress kept apart from the finished ones, when qBittorrent lets HexOS in to say so
    if (await qbittorrentOpen(url)) {
      const preferences = await fetch(`${url}/api/v2/app/preferences`, { headers: qbittorrentHeaders(url), signal: AbortSignal.timeout(15_000) })
        .then((response) => (response.ok ? (response.json() as Promise<{ save_path?: string; temp_path_enabled?: boolean }>) : undefined))
        .catch(() => undefined);
      if (preferences && !preferences.temp_path_enabled) {
        const savePath = (preferences.save_path || "/config/Downloads").replace(/\/+$/, "");
        await fetch(`${url}/api/v2/app/setPreferences`, {
          method: "POST",
          headers: qbittorrentHeaders(url, { "Content-Type": "application/x-www-form-urlencoded" }),
          body: new URLSearchParams({ json: JSON.stringify({ temp_path_enabled: true, temp_path: `${savePath}/incomplete/` }) }),
          signal: AbortSignal.timeout(15_000),
        })
          .then((response) => response.body?.cancel())
          .catch((error) => ctx.log(`qBittorrent's folder for downloads in progress wasn't set: ${error}`));
      }
    }
    const saved = readJson<{ username: string; password: string }>(`${configMount(mounts, "qbittorrent")?.localPath}/hexos/webui.json`);
    return {
      name: "qBittorrent",
      // Five failed sign-ins lock an address out for an hour by default (WebApplication at qBittorrent 5.3.0)
      lockout: `qBittorrent is locking ${MANAGER} out for now after sign-ins with an old password failed. ${MANAGER} has the new sign-in and connects on its own within the hour.`,
      signIn: {
        known: async () => {
          for (const candidate of [ctx.signIn, saved]) {
            if (candidate && (await qbittorrentSignsIn(url, candidate))) {
              return { username: candidate.username, password: candidate.password };
            }
          }
          return undefined;
        },
        ask: async () => {
          const answers = await ask(ctx, [usernameQuestion("qBittorrent"), passwordQuestion("qBittorrent")], {
            title: "Sign in to qBittorrent",
            description: `Enter the sign-in you use for qBittorrent, so ${MANAGER} can send it downloads.`,
          });
          const given = { username: String(answers?.username ?? "").trim(), password: String(answers?.password ?? "") };
          if (!given.username || !given.password) return undefined;
          if (!(await qbittorrentSignsIn(url, given))) ctx.fail("qBittorrent didn't accept that username and password. Run this again.");
          return given;
        },
      },
    };
  });

// --- Deluge ------------------------------------------------------------------

/** Deluge's web password when nobody set one: the one Deluge starts with. */
const DELUGE_STOCK_PASSWORD = "deluge";

interface DelugeSession {
  url: string;
  cookie?: string;
}

/** One call to Deluge's web API (ui/web/json_api.py at 2.2.0), which also passes calls on to its daemon. */
async function delugeApi<T>(session: DelugeSession, method: string, params: unknown[] = []): Promise<T> {
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

/** The plugins Deluge's settings file says to turn on at its start, or undefined when it can't be read. */
function delugeStartPlugins(configDir: string | undefined): string[] | undefined {
  const text = configDir ? readText(`${configDir}/core.conf`) : undefined;
  try {
    return text ? (JSON.parse(text.slice(text.indexOf("}") + 1)) as { enabled_plugins?: string[] }).enabled_plugins : undefined;
  } catch {
    return undefined;
  }
}

export const deluge = (ctx: HookContext) =>
  link(ctx, "deluge", "Deluge", async ({ url, mounts }) => {
    const configDir = configMount(mounts, "deluge")?.localPath;
    const saved = readJson<{ password: string }>(`${configDir}/hexos/webui.json`);
    const session: DelugeSession = { url };
    const signsIn = (password: string) =>
      delugeApi<boolean>(session, "auth.login", [password]).catch((error: unknown) =>
        ctx.fail("HexOS couldn't reach Deluge. Try again once it's running.", [
          { label: "Reason", value: error instanceof Error ? error.message : String(error) },
        ]),
      );
    let password: string | undefined;
    for (const candidate of new Set([ctx.signIn?.password, saved?.password, DELUGE_STOCK_PASSWORD])) {
      if (candidate && (await signsIn(candidate))) {
        password = candidate;
        break;
      }
    }
    if (!password) {
      const answers = await ask(ctx, [passwordQuestion("Deluge")], {
        title: "Sign in to Deluge",
        description: `Enter the password you use for Deluge's web page, so ${MANAGER} can send it downloads.`,
      });
      const given = typeof answers?.password === "string" ? answers.password : "";
      if (!given) ctx.fail(`HexOS needs Deluge's password to add it to ${MANAGER}. Run this again to give it.`);
      if (!(await signsIn(given))) ctx.fail("Deluge didn't accept that password. Run this again.");
      password = given;
    }

    // The page passes calls on to Deluge's daemon only once connected to it, as HexOS's setup does at start
    if (!(await delugeApi<boolean>(session, "web.connected"))) {
      const local = (await delugeApi<unknown[][]>(session, "web.get_hosts")).find((host) => host[1] === "127.0.0.1");
      if (local) await delugeApi(session, "web.connect", [local[0]]).catch(() => undefined);
      if (!(await until(ctx, () => delugeApi<boolean>(session, "web.connected"), 15))) {
        ctx.fail("Deluge's web page couldn't reach Deluge itself. Restart Deluge, then try again.");
      }
    }

    // Sportarr sorts what it sends Deluge with a label, which needs Deluge's Label plugin
    const labels = async () => (await delugeApi<string[]>(session, "system.listMethods")).includes("label.get_labels");
    if (!(await labels())) {
      await delugeApi(session, "core.enable_plugin", ["Label"]);
      if (!(await until(ctx, labels, 20))) {
        ctx.fail(
          `Deluge didn't turn on its Label plugin, which ${MANAGER} sorts downloads with. Turn it on in Deluge's Preferences, under Plugins, then try again.`,
        );
      }
    }
    // Deluge turns a plugin on without saving that it did (pluginmanagerbase.py at 2.2.0), so it would
    // be off after a restart. Its settings save when one changes, so the list is set without the plugin
    // and back: only the saved list changes, and the plugin stays on throughout.
    if (!delugeStartPlugins(configDir)?.includes("Label")) {
      const plugins = await delugeApi<string[]>(session, "core.get_enabled_plugins");
      await delugeApi(session, "core.set_config", [{ enabled_plugins: plugins.filter((plugin) => plugin !== "Label") }]);
      await delugeApi(session, "core.set_config", [{ enabled_plugins: plugins }]);
      if (delugeStartPlugins(configDir) && !(await until(ctx, async () => !!delugeStartPlugins(configDir)?.includes("Label"), 15))) {
        ctx.fail("Deluge turned on its Label plugin but didn't save that it did. Restart Deluge, then try again.");
      }
    }

    const signIn = { password };
    return { name: "Deluge", signIn: { known: async () => signIn, ask: async () => signIn } };
  });

// --- SABnzbd -----------------------------------------------------------------

/** SABnzbd's folders when nothing set them: in its settings folder, which Sportarr can't see. */
const SABNZBD_STOCK_FOLDERS = { download_dir: "Downloads/incomplete", complete_dir: "Downloads/complete" };
const SABNZBD_FOLDERS = { download_dir: "/downloads/sabnzbd/incomplete", complete_dir: "/downloads/sabnzbd/complete" };

async function sabnzbdApi<T>(url: string, apiKey: string, params: Record<string, string>): Promise<T> {
  const query = new URLSearchParams({ ...params, apikey: apiKey, output: "json" });
  const response = await fetch(`${url}/api?${query}`, { signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let body: T & { error?: string };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${response.status} ${text.slice(0, 200)}`);
  }
  if (!response.ok || body.error) throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  return body;
}

export const sabnzbd = (ctx: HookContext) =>
  link(ctx, "sabnzbd", "SABnzbd", async ({ url, mounts }) => {
    const apiKey = readText(`${configMount(mounts, "sabnzbd")?.localPath}/sabnzbd.ini`)?.match(/^api_key\s*=\s*(\S+)/m)?.[1];
    if (!apiKey) ctx.fail("HexOS couldn't read SABnzbd's API key yet. Try again once it has started.");
    // Listing the categories is what makes SABnzbd's own (movies, tv, audio, software) the first time
    const categories = async () => (await sabnzbdApi<{ categories: string[] }>(url, apiKey, { mode: "get_cats" })).categories;
    try {
      const { misc } = (await sabnzbdApi<{ config: { misc: Record<string, unknown> } }>(url, apiKey, { mode: "get_config", section: "misc" })).config;
      // A SABnzbd HexOS didn't set up finishes downloads where Sportarr can see them
      for (const [keyword, stock] of Object.entries(SABNZBD_STOCK_FOLDERS) as Array<[keyof typeof SABNZBD_FOLDERS, string]>) {
        if (misc[keyword] === stock) {
          await sabnzbdApi(url, apiKey, { mode: "set_config", section: "misc", keyword, value: SABNZBD_FOLDERS[keyword] });
        }
      }
      if (!(await categories()).includes(CATEGORY)) {
        await sabnzbdApi(url, apiKey, { mode: "set_config", section: "categories", keyword: CATEGORY });
      }
    } catch (error) {
      ctx.fail("HexOS couldn't get SABnzbd ready. Try again once it has started.", [
        { label: "Reason", value: error instanceof Error ? error.message : String(error) },
      ]);
    }
    if (!(await categories()).includes(CATEGORY)) ctx.fail(`SABnzbd didn't make its ${CATEGORY} category`);
    const signIn = { apiKey };
    return { name: "SABnzbd", signIn: { known: async () => signIn, ask: async () => signIn } };
  });

// --- NZBGet ------------------------------------------------------------------

/** What NZBGet's settings file starts with (nzbget.conf at v26.3, the version TrueNAS pins). */
const NZBGET_STOCK = { username: "nzbget", password: "tegbzn6789", mainDir: "/downloads" };
/** The Downloads folder HexOS gives NZBGet, which it also sees at /downloads. */
const NZBGET_MAIN_DIR = "/downloads/nzbget";

interface NzbgetOption {
  Name: string;
  Value: string;
}

async function nzbgetApi<T>(url: string, signIn: { username: string; password: string }, method: string, params: unknown[] = []) {
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
    throw new Error("NZBGet refused the sign-in in its settings");
  }
  const body = (await response.json()) as { result?: T; error?: { message?: string } | null };
  if (body.error) throw new Error(body.error.message ?? `${method} failed`);
  return body.result as T;
}

/**
 * NZBGet makes a category's folder at its first download, and until then a manager's health check
 * says the folder is missing. It's made now, worked out as NZBGet works it out.
 */
async function makeCategoryFolder(url: string, signIn: { username: string; password: string }, mounts: ContextMount[]) {
  const active = await nzbgetApi<NzbgetOption[]>(url, signIn, "config");
  const valueOf = (name: string) => active.find((option) => option.Name === name)?.Value ?? "";
  const index = active.find((option) => /^Category\d+\.Name$/.test(option.Name) && option.Value === CATEGORY)?.Name.match(/\d+/)?.[0];
  let folder = valueOf(`Category${index}.DestDir`);
  if (!folder) {
    folder = valueOf("DestDir").replace("${MainDir}", valueOf("MainDir"));
    if (valueOf("AppendCategoryDir") !== "no") folder = `${folder}/${CATEGORY}`;
  }
  const downloads = mounts.find((m) => m.containerPath === NZBGET_MAIN_DIR);
  if (!downloads || !folder.startsWith(`${NZBGET_MAIN_DIR}/`)) return;
  const local = `${downloads.localPath}${folder.slice(NZBGET_MAIN_DIR.length)}`;
  const first = mkdirSync(local, { recursive: true });
  if (!first) return;
  for (let dir = local; dir.length >= first.length; dir = dir.slice(0, dir.lastIndexOf("/"))) {
    chownSync(dir, APPS_UID, APPS_UID);
  }
}

export const nzbget = (ctx: HookContext) =>
  link(ctx, "nzbget", "NZBGet", async ({ url, mounts }) => {
    // NZBGet keeps its sign-in in its settings file, so this is the one it uses now
    const conf = readText(`${configMount(mounts, "nzbget")?.localPath}/nzbget.conf`) ?? "";
    const signIn = {
      username: conf.match(/^ControlUsername=(.*)$/m)?.[1] ?? NZBGET_STOCK.username,
      password: conf.match(/^ControlPassword=(.*)$/m)?.[1] ?? NZBGET_STOCK.password,
    };
    try {
      const options = await nzbgetApi<NzbgetOption[]>(url, signIn, "loadconfig");
      const changes: NzbgetOption[] = [];
      const categories = options.filter((option) => /^Category\d+\.Name$/.test(option.Name));
      if (!categories.some((option) => option.Value === CATEGORY)) {
        const next = Math.max(0, ...categories.map((option) => Number(option.Name.match(/\d+/)?.[0]))) + 1;
        changes.push({ Name: `Category${next}.Name`, Value: CATEGORY });
      }
      // A NZBGet HexOS didn't set up reports its downloads at the path Sportarr sees them at
      if (options.find((option) => option.Name === "MainDir")?.Value === NZBGET_STOCK.mainDir) {
        changes.push({ Name: "MainDir", Value: NZBGET_MAIN_DIR });
      }
      if (changes.length > 0) {
        const updated = options.map((option) => changes.find((change) => change.Name === option.Name) ?? option);
        const added = changes.filter((change) => !options.some((option) => option.Name === change.Name));
        if (!(await nzbgetApi<boolean>(url, signIn, "saveconfig", [[...updated, ...added]]))) {
          throw new Error("NZBGet didn't save its settings");
        }
        await nzbgetApi(url, signIn, "reload");
        await ctx.sleep(3_000);
        const taken = await until(
          ctx,
          async () => {
            const active = await nzbgetApi<NzbgetOption[]>(url, signIn, "config");
            return changes.every((change) => active.some((option) => option.Name === change.Name && option.Value === change.Value));
          },
          60,
        );
        if (!taken) throw new Error("NZBGet didn't take its new settings");
      }
      await makeCategoryFolder(url, signIn, mounts);
    } catch (error) {
      ctx.fail(`HexOS couldn't get NZBGet ready for ${MANAGER}. Try again once it's running.`, [
        { label: "Reason", value: error instanceof Error ? error.message : String(error) },
      ]);
    }
    // NZBGet's own settings file says what it takes now, so it's what Sportarr is given
    const current = { username: signIn.username, password: signIn.password };
    return { name: "NZBGet", signIn: { known: async () => current, ask: async () => current } };
  });
