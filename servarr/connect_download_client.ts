// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { chownSync, existsSync, mkdirSync, readFileSync } from "node:fs";

import type { ContextMount, HookContext, HookInputDeclaration } from "../_lib/hook_context";

/**
 * Adds a download client to Radarr, Sonarr, Lidarr, Chaptarr or Prowlarr: the hook each of them declares per
 * client (connect-qbittorrent, connect-deluge, connect-sabnzbd, connect-nzbget). Prowlarr's is for
 * what the owner grabs in Prowlarr's own search, which lands in a prowlarr category no manager imports. The client is added
 * through the manager's own schema, so a field the manager renames is still filled, and saved with
 * the manager's own connection test, so a client it can't reach is refused rather than kept.
 *
 * Every manager sees the whole Downloads location at /downloads, and every client keeps its
 * downloads in its own folder there, at the same path in its own container (qBittorrent's is
 * /config/Downloads, which the managers mount too). So a finished download is where the manager
 * looks, with no remote path mapping: a mapping belongs to the box's address, not to one client,
 * and would send every other client's downloads astray.
 *
 * A client installed after the manager started gets its folder of Downloads as a dataset of its own,
 * which TrueNAS mounts after the manager's bind mount of Downloads was made. That mount passes no
 * later mount on (rprivate, the apps library's default), so the manager sees an empty folder there
 * until it restarts, and reports the client's downloads folder missing. So the link asks the manager
 * whether it sees a folder the client has made, and restarts the manager once when it doesn't.
 *
 * The manager gets the client's sign-in HexOS has just signed in with: for a Deluge the owner
 * already had, the password they gave for it (`ctx.existingSignIns`), else the one the owner chose
 * for the install or collection (`ctx.signIn`), else the one in the client's own settings, else
 * HexOS's default. Only when HexOS knows none does the manager keep what it has, and the owner is asked when
 * that fails too. The manager's own may be an old password, and qBittorrent locks out an address
 * after five failed sign-ins, so it is never tried ahead of one HexOS knows works.
 *
 * Run again, a link puts back how the manager reaches the client and its sign-in, and fills only the
 * choices the owner left empty. A manager names each client once, so an entry under the client's name
 * that it reaches at another address (the box's address or the client's port changed) is moved to
 * this client: with proof it was this one, or with the owner's yes once nothing answers there. One
 * that may be another client the owner chose is left as it is, and the link says which.
 */

/** The user the TrueNAS charts run the download clients as. */
const APPS_UID = 568;

const MANAGERS = {
  radarr: { name: "Radarr", api: "v3", categoryField: "movieCategory" },
  sonarr: { name: "Sonarr", api: "v3", categoryField: "tvCategory" },
  lidarr: { name: "Lidarr", api: "v1", categoryField: "musicCategory" },
  // Chaptarr sorts books and audiobooks with a field each, and both land in one category
  chaptarr: { name: "Chaptarr", api: "v1", categoryField: "ebookCategory", alsoCategoryField: "audiobookCategory" },
  prowlarr: { name: "Prowlarr", api: "v1", categoryField: "category" },
} as const;

type ManagerId = keyof typeof MANAGERS;

/** Each manager's category: the manager's own choice in a torrent client, the client's own for Usenet. */
const CATEGORIES: Record<string, Record<ManagerId, string>> = {
  qbittorrent: { radarr: "radarr", sonarr: "tv-sonarr", lidarr: "lidarr", chaptarr: "chaptarr", prowlarr: "prowlarr" },
  deluge: { radarr: "radarr", sonarr: "tv-sonarr", lidarr: "lidarr", chaptarr: "chaptarr", prowlarr: "prowlarr" },
  sabnzbd: { radarr: "movies", sonarr: "tv", lidarr: "audio", chaptarr: "books", prowlarr: "prowlarr" },
  nzbget: { radarr: "Movies", sonarr: "Series", lidarr: "Music", chaptarr: "Books", prowlarr: "Prowlarr" },
};

interface Field {
  name: string;
  value?: unknown;
}

interface DownloadClient {
  id?: number;
  name: string;
  implementation: string;
  enable?: boolean;
  priority?: number;
  fields: Field[];
  [key: string]: unknown;
}

interface ClientPlan {
  name: string;
  implementation: string;
  /** How the manager reaches the client, by the manager's field name: put back on every run. */
  connection: Record<string, unknown>;
  /**
   * The client's sign-in, by the manager's field name: `known`, one HexOS just signed in to the
   * client with (undefined when it knows none), and `ask` as a last resort, checked the same way.
   */
  signIn?: { known: () => Promise<Record<string, unknown> | undefined>; ask: () => Promise<Record<string, unknown> | undefined> };
  /** The manager's choices for the client: filled only where they're empty. */
  preferences?: Record<string, unknown>;
  /**
   * For a client that locks out an address after failed sign-ins, what the step says when it has
   * locked the manager out: the manager is given the sign-in anyway and connects once it ends.
   */
  lockout?: (managerName: string) => string;
  /**
   * What it proves when the manager's test of an entry's saved secret passes against this client:
   * "key", a key only this client has (SABnzbd's); "sign-in", one the owner may use for another
   * client too, so it counts only once nothing answers at the entry's address. Absent where a pass
   * proves nothing: qBittorrent lets its home network in with any sign-in and counts each refused
   * one toward its lockout, and a sign-in every install starts with is anyone's.
   */
  proof?: "key" | "sign-in";
  /**
   * A folder the client has made in its own folder of Downloads, at the path the manager sees it
   * at: the one the manager reports missing when it can't see the client's folder.
   */
  folder?: string;
}

interface Client {
  url: string;
  host: string;
  port: number;
  managerName: string;
  category: string;
  mounts: ContextMount[];
}

function configMount(mounts: ContextMount[], appId: string): ContextMount | undefined {
  return mounts.find((m) => m.containerPath === "/config") ?? mounts.find((m) => new RegExp(`/${appId}(-\\d+)?/config$`).test(m.hostPath));
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

const isEmpty = (value: unknown) => value === undefined || value === null || value === "";

/** The fields that say where a manager reaches a client: what moving an entry to this client rewrites. */
const ADDRESS_FIELDS = ["host", "port", "useSsl", "urlBase"];

async function until(ctx: HookContext, check: () => Promise<boolean>, attempts: number): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await check().catch(() => false)) return true;
    await ctx.sleep(1_000);
  }
  return false;
}

/** Whether anything answers at this address now. An app that's off, or an address nobody has any more, doesn't. */
async function answering(url: string, timeoutMs = 10_000): Promise<boolean> {
  // Any answer counts, so a certificate made for another name isn't taken for silence; nothing is sent
  const init = { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), tls: { rejectUnauthorized: false } };
  const response = await fetch(url, init as RequestInit).catch(() => undefined);
  await response?.body?.cancel().catch(() => undefined);
  return response !== undefined;
}

async function managerApi<T>(ctx: HookContext, apiKey: string, path: string, init: RequestInit = {}): Promise<T> {
  const manager = MANAGERS[(ctx.catalogAppId ?? ctx.resourceId) as ManagerId];
  const response = await fetch(`${ctx.baseUrl}/api/${manager.api}${path}`, {
    ...init,
    headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) {
    let reason = text.slice(0, 300);
    try {
      const body = JSON.parse(text) as Array<{ errorMessage?: string }> | { message?: string };
      reason = Array.isArray(body)
        ? body
            .map((entry) => entry.errorMessage)
            .filter(Boolean)
            .join("; ")
        : (body.message ?? reason);
    } catch {}
    throw new Error(reason || `${response.status} ${response.statusText}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * Finds the manager and the client, gets the client ready for it, and adds or updates the client in
 * the manager. `prepare` signs in to the client and makes there what the manager's test needs.
 */
async function link(ctx: HookContext, appId: string, name: string, prepare: (client: Client) => Promise<ClientPlan>) {
  await ctx.registerCheckpoints([
    { id: "locate", message: `Finding ${name}` },
    { id: "prepare", message: `Getting ${name} ready` },
    { id: "configure", message: `Adding ${name} as a download client` },
  ]);

  const managerId = (ctx.catalogAppId ?? ctx.resourceId) as ManagerId;
  const manager = MANAGERS[managerId];
  if (!manager) ctx.fail(`HexOS can't add a download client to ${ctx.resourceId}`);
  const apiKey = readText(`${configMount(ctx.mounts, managerId)?.localPath}/config.xml`)?.match(/<ApiKey>([^<]+)<\/ApiKey>/)?.[1];
  if (!apiKey) ctx.fail(`HexOS couldn't read ${manager.name}'s API key yet. Try again once it has started.`);
  // A manager that has only just started answers nothing for a while
  if (!(await until(ctx, () => answering(`${ctx.baseUrl}/ping`, 2_000), 30))) {
    ctx.fail(`${manager.name} isn't answering yet. Try again once it has started.`);
  }
  const url = await ctx.getInstalledAppUrl(appId);
  if (!url) ctx.fail(`${name} isn't installed, or HexOS can't find its port`);
  const parsed = new URL(url);
  const client: Client = {
    url,
    host: parsed.hostname,
    port: Number(parsed.port),
    managerName: manager.name,
    // A later copy has a category of its own: a manager imports whatever lands in its category
    category: `${CATEGORIES[appId][managerId]}${ctx.resourceId.slice(managerId.length)}`,
    mounts: await ctx.getInstalledAppMounts(appId),
  };
  await ctx.emitCheckpoint("locate");

  const plan = await prepare(client);
  if (plan.folder) await seeClientFolder(ctx, apiKey, client, name, plan.folder);
  await ctx.emitCheckpoint("prepare");

  const connection: Record<string, unknown> = { host: client.host, port: client.port, useSsl: false, ...plan.connection };
  const preferences: Record<string, unknown> = {
    [manager.categoryField]: client.category,
    ...("alsoCategoryField" in manager ? { [manager.alsoCategoryField]: client.category } : {}),
    ...plan.preferences,
  };
  const here = `${client.host}:${client.port}`;
  // An entry under the client's name at another address: the box's address or the client's port
  // changed, or it's another client the owner chose. It moves here with proof it was this client, or
  // with the owner's yes once nothing answers there, and is left as it is otherwise.
  const repair = async (entry: DownloadClient): Promise<DownloadClient> => {
    const value = (field: string) => entry.fields.find((each) => each.name === field)?.value;
    const at = `${value("host")}:${value("port")}`;
    if (entry.implementation === plan.implementation) {
      // The manager shows a secret it holds as ******** (SchemaBuilder) and tests an entry sent by id
      // with the one it holds, so a pass at this client's address says the saved secret is this client's
      const moved = {
        ...entry,
        fields: entry.fields.map((field) => (ADDRESS_FIELDS.includes(field.name) && field.name in connection ? { ...field, value: connection[field.name] } : field)),
      };
      const proven =
        plan.proof !== undefined &&
        (await managerApi(ctx, apiKey, "/downloadclient/test", { method: "POST", body: JSON.stringify(moved) }).then(
          () => true,
          () => false,
        ));
      if (proven && plan.proof === "key") return entry;
      const silent = !(await answering(`${value("useSsl") === true ? "https" : "http"}://${at}${value("urlBase") ?? ""}`));
      if (silent && (proven || (await ownerSwitches(ctx, manager.name, name, entry.name, at)))) return entry;
    }
    // It may be another client the owner chose, so it's theirs to change: trying again can't help
    const message = `${manager.name} already has a download client named ${entry.name}, at ${at}. Rename that one in ${manager.name}'s Settings, under Download Clients, then run Connect to ${name} again.`;
    const context = [
      { label: `${manager.name}'s ${entry.name}`, value: at },
      { label: `This ${name}`, value: here },
    ];
    if (ctx.skip) ctx.skip(message, context);
    ctx.fail(message, context);
  };
  const entries = await managerApi<DownloadClient[]>(ctx, apiKey, "/downloadclient");
  const atThisAddress = entries.find(
    (entry) =>
      entry.implementation === plan.implementation &&
      entry.fields.some((field) => field.name === "host" && field.value === client.host) &&
      entry.fields.some((field) => field.name === "port" && Number(field.value) === client.port),
  );
  // A manager refuses a second client under a name it has, whatever its case (ProviderControllerBase)
  const named = atThisAddress ? undefined : entries.find((entry) => entry.name.toLowerCase() === plan.name.toLowerCase());
  const existing = atThisAddress ?? (named ? await repair(named) : undefined);
  const template =
    existing ??
    (await managerApi<DownloadClient[]>(ctx, apiKey, "/downloadclient/schema")).find(
      (entry) => entry.implementation === plan.implementation,
    );
  if (!template) ctx.fail(`${manager.name} doesn't offer ${name} as a download client`);

  const definition = (signIn: Record<string, unknown>): DownloadClient => ({
    ...template,
    name: existing?.name ?? plan.name,
    enable: existing?.enable ?? true,
    priority: existing?.priority ?? 1,
    fields: template.fields.map((field) => {
      if (field.name in connection) return { ...field, value: connection[field.name] };
      if (field.name in signIn) return { ...field, value: signIn[field.name] };
      if (field.name in preferences && (!existing || isEmpty(field.value))) return { ...field, value: preferences[field.name] };
      return field;
    }),
  });
  // Saved with the manager's own connection test, which refuses a client it can't reach or sign in
  // to. The manager tests only a definition that changed, so an unchanged one proves nothing.
  const save = async (signIn: Record<string, unknown>, force = false) => {
    const query = force ? "?forceSave=true" : "";
    if (existing?.id !== undefined) {
      await managerApi(ctx, apiKey, `/downloadclient/${existing.id}${query}`, { method: "PUT", body: JSON.stringify(definition(signIn)) });
    } else {
      await managerApi(ctx, apiKey, `/downloadclient${query}`, { method: "POST", body: JSON.stringify(definition(signIn)) });
    }
  };
  // An update with forceSave skips the manager's test, but an enabled client is tested when created
  // whatever it says (ProviderControllerBase), so a new one is created off and then switched on
  const saveUntested = async (signIn: Record<string, unknown>) => {
    if (existing?.id !== undefined) return save(signIn, true);
    const off = { ...definition(signIn), enable: false };
    const created = await managerApi<DownloadClient>(ctx, apiKey, "/downloadclient?forceSave=true", { method: "POST", body: JSON.stringify(off) });
    await managerApi(ctx, apiKey, `/downloadclient/${created.id}?forceSave=true`, {
      method: "PUT",
      body: JSON.stringify({ ...off, id: created.id, enable: true }),
    });
  };
  const test = (signIn: Record<string, unknown>) =>
    managerApi(ctx, apiKey, "/downloadclient/test", { method: "POST", body: JSON.stringify(definition(signIn)) });
  // The manager's own sign-in, which HexOS can't vouch for, is tested on its own before it is kept
  const attempt = (signIn: Record<string, unknown>, vouched: boolean) =>
    (existing && !vouched ? test(signIn).then(() => save(signIn)) : save(signIn)).then(
      () => undefined,
      (error: unknown) => error,
    );
  const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const signInRefused = (error: unknown) => /authenticat/i.test(reasonOf(error));

  // A sign-in HexOS just signed in to the client with goes first: what the manager holds may be an
  // old password, and each try with it counts toward a client's lockout of the manager's address
  const known = await plan.signIn?.known();
  let signIn: Record<string, unknown> = known ?? {};
  let verified = known !== undefined;
  let refused = await attempt(signIn, verified);
  if (refused !== undefined && !verified && plan.signIn) {
    const answered = await plan.signIn.ask();
    if (answered && JSON.stringify(answered) !== JSON.stringify(signIn)) {
      signIn = answered;
      verified = true;
      refused = await attempt(signIn, verified);
    }
  }
  // The client took this sign-in from HexOS, so refusing it to the manager means the manager's own
  // address is locked out: saved untested, the manager connects once the lockout ends
  if (refused !== undefined && verified && plan.lockout && signInRefused(refused)) {
    refused = await saveUntested(signIn).then(
      () => undefined,
      (error: unknown) => error,
    );
    if (refused === undefined) {
      await ctx.emitCheckpoint("configure", plan.lockout(manager.name));
      return;
    }
  }
  // One added since the list was read: a run again finds it under the name
  if (refused !== undefined && /should be unique/i.test(reasonOf(refused))) {
    ctx.fail(`${manager.name} already has a download client named ${plan.name}. Run Connect to ${name} again to check it.`);
  }
  if (refused !== undefined) {
    const message = signInRefused(refused) ? `${name} didn't accept ${manager.name}'s sign-in` : `${manager.name} couldn't reach ${name}`;
    ctx.fail(message, [{ label: "Reason", value: reasonOf(refused) }]);
  }
  await ctx.emitCheckpoint("configure", existing && !atThisAddress ? `${manager.name} reaches ${name} at its new address` : undefined);
}

/**
 * Whether the manager sees a folder, by its own listing of the folder above it. A folder that isn't
 * there lists as an empty list of directories (FileSystemLookupService and FileSystemResult, the same
 * in Radarr, Sonarr, Lidarr and Chaptarr 0.9.965). Undefined for anything else: a refusal, or an
 * answer without that list.
 */
async function managerSees(ctx: HookContext, apiKey: string, folder: string): Promise<boolean | undefined> {
  const parent = folder.slice(0, folder.lastIndexOf("/") + 1);
  const listing = await managerApi<{ directories?: unknown }>(ctx, apiKey, `/filesystem?${new URLSearchParams({ path: parent })}`).catch(
    () => undefined,
  );
  if (!Array.isArray(listing?.directories)) return undefined;
  return listing.directories.some((entry) => (entry as { name?: unknown } | null)?.name === folder.slice(parent.length));
}

/**
 * A manager's restart in flight, by its TrueNAS name. A
 * manager's links all run in this one module, and two of them may run at once (Connect to SABnzbd
 * and Connect to NZBGet from the card), so a link that finds a folder missing while another link
 * restarts the manager waits for that restart rather than queue a second one (app.redeploy takes a
 * lock per app), which would stop the manager under the other link.
 */
const restarting = new Map<string, Promise<{ refused?: unknown; answered: boolean }>>();

/** Restarts the manager once for every link that needs it now, and waits until it answers again. */
function restartManager(ctx: HookContext) {
  const key = ctx.resourceId;
  const running = restarting.get(key);
  if (running) return running;
  const restart = (async () => {
    const refused = await ctx.restartApp?.().then(
      () => undefined,
      (error: unknown) => error ?? new Error("The restart failed"),
    );
    if (refused !== undefined) return { refused, answered: false };
    return { answered: await until(ctx, () => answering(`${ctx.baseUrl}/ping`, 2_000), 60) };
  })().finally(() => {
    restarting.delete(key);
  });
  restarting.set(key, restart);
  return restart;
}

/**
 * Makes sure the manager sees the client's folder, restarting the manager once when it doesn't: a
 * restart mounts Downloads again, with the client's folder in it. Only the manager restarts, never
 * the client. A manager without Downloads (Prowlarr imports nothing), a folder the box doesn't have,
 * and a manager that can't say what it sees are left as they are.
 */
async function seeClientFolder(ctx: HookContext, apiKey: string, client: Client, name: string, path: string) {
  const managerName = client.managerName;
  const folder = path.replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
  if (!ctx.mounts.some((m) => m.containerPath === "/downloads")) return;
  const own = client.mounts
    .filter((m) => m.containerPath && (folder === m.containerPath || folder.startsWith(`${m.containerPath}/`)))
    .sort((a, b) => (b.containerPath?.length ?? 0) - (a.containerPath?.length ?? 0))[0];
  if (!own?.containerPath || !existsSync(`${own.localPath}${folder.slice(own.containerPath.length)}`)) return;

  // A restart another link started may be all this one needs, so look once it's done
  await restarting.get(ctx.resourceId);
  const sees = await managerSees(ctx, apiKey, folder);
  if (sees === undefined) ctx.log(`${managerName} couldn't list ${folder}, so HexOS didn't check it sees ${name}'s folder`);
  if (sees !== false) return;

  const context = [{ label: "Folder", value: folder }];
  const stuck = `${managerName} can't see ${name}'s downloads folder yet. Stop ${managerName} and start it again, then run Connect to ${name} again.`;
  if (typeof ctx.restartApp !== "function") ctx.fail(stuck, context);
  await ctx.updateCheckpointMessage("prepare", `Restarting ${managerName} so it sees ${name}'s downloads folder`);
  const { refused, answered } = await restartManager(ctx);
  if (refused !== undefined) ctx.fail(stuck, [...context, { label: "Reason", value: refused instanceof Error ? refused.message : String(refused) }]);
  if (!answered) ctx.fail(`${managerName} didn't answer after HexOS restarted it. Try again once it has started.`);
  // Its API answers a little after its port does
  let after: boolean | undefined;
  for (let attempt = 0; attempt < 30 && after === undefined; attempt++) {
    after = await managerSees(ctx, apiKey, folder);
    if (after === undefined) await ctx.sleep(1_000);
  }
  if (!after) {
    ctx.fail(
      `${managerName} still can't see ${name}'s downloads folder after HexOS restarted it. Stop ${managerName} and start it again, then run Connect to ${name} again.`,
      context,
    );
  }
}

/**
 * Whether the owner wants a manager's entry moved to this client, once nothing answers at its
 * address. Nothing proves it was this one (it may be another computer that's switched off), so the
 * owner decides. False when they say no, skip the question, or this HexOS can't ask.
 */
async function ownerSwitches(ctx: HookContext, managerName: string, name: string, entryName: string, at: string): Promise<boolean> {
  const answers = await ask(
    ctx,
    [
      {
        type: "question",
        id: "switch",
        question: {
          question: `Switch ${managerName} to this ${name}`,
          description: `${managerName} keeps its other settings for it.`,
          type: "boolean",
          key: "switch",
          required: true,
        },
      },
    ],
    { title: `Switch ${managerName}'s ${name}`, description: `${managerName} sends downloads to ${entryName} at ${at}, which isn't answering.` },
  );
  return answers?.switch === true;
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
 * refusal counts toward its ban, so links try few. From an address its whitelist lets in it takes
 * any sign-in, and so does the manager's test, so there a sign-in only has to be one HexOS knows.
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
  link(ctx, "qbittorrent", "qBittorrent", async ({ url, mounts, managerName }) => {
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
      implementation: "QBittorrent",
      connection: {},
      // Five failed sign-ins lock an address out for an hour by default, checked only at sign-in
      // (WebApplication::validateCredentials and increaseFailedAttempts at qBittorrent 5.3.0)
      lockout: (managerName) =>
        `qBittorrent is locking ${managerName} out for now after sign-ins with its old password failed. ${managerName} has the new sign-in and connects on its own within the hour.`,
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
            description: `Enter the sign-in you use for qBittorrent, so ${managerName} can send it downloads.`,
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
/** Deluge's folder of the Downloads location, at the path the managers see it at. */
const DELUGE_FOLDERS = { downloadDirectory: "/downloads/deluge/incomplete", completedDirectory: "/downloads/deluge/complete" };

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
  link(ctx, "deluge", "Deluge", async ({ url, mounts, managerName }) => {
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
    // A Deluge the owner already had keeps its own password, which they gave in the walk
    const own = ctx.existingSignIns?.deluge?.password;
    for (const candidate of new Set([own, ctx.signIn?.password, saved?.password, DELUGE_STOCK_PASSWORD])) {
      if (candidate && (await signsIn(candidate))) {
        password = candidate;
        break;
      }
    }
    if (!password) {
      const answers = await ask(ctx, [passwordQuestion("Deluge")], {
        title: "Sign in to Deluge",
        description: `Enter the password you use for Deluge's web page, so ${managerName} can send it downloads.`,
      });
      const given = typeof answers?.password === "string" ? answers.password : "";
      if (!given) ctx.fail(`HexOS needs Deluge's password to add it to ${managerName}. Run this again to give it.`);
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

    // The managers sort what they send Deluge with labels, which need its Label plugin
    const labels = async () => (await delugeApi<string[]>(session, "system.listMethods")).includes("label.get_labels");
    if (!(await labels())) {
      await delugeApi(session, "core.enable_plugin", ["Label"]);
      if (!(await until(ctx, labels, 20))) {
        ctx.fail(
          `Deluge didn't turn on its Label plugin, which ${managerName} sorts downloads with. Turn it on in Deluge's Preferences, under Plugins, then try again.`,
        );
      }
    }
    // Deluge turns a plugin on without saving that it did (pluginmanagerbase.py at 2.2.0), so it would
    // be off after a restart. Its settings save when one changes, so the list is set without the plugin
    // and back: only the saved list changes, and the plugin stays on throughout.
    if (!delugeStartPlugins(configDir)?.includes("Label")) {
      const plugins = await delugeApi<string[]>(session, "core.get_enabled_plugins");
      await delugeApi(session, "core.set_config", [{ enabled_plugins: plugins.filter((name) => name !== "Label") }]);
      await delugeApi(session, "core.set_config", [{ enabled_plugins: plugins }]);
      if (
        delugeStartPlugins(configDir) &&
        !(await until(ctx, async () => !!delugeStartPlugins(configDir)?.includes("Label"), 15))
      ) {
        ctx.fail("Deluge turned on its Label plugin but didn't save that it did. Restart Deluge, then try again.");
      }
    }

    // Deluge makes these at its first download, and until then a manager's health check says the
    // completed folder is missing
    const downloads = mounts.find((m) => m.containerPath === "/downloads/deluge");
    if (downloads) {
      for (const folder of ["incomplete", "complete"]) {
        const local = `${downloads.localPath}/${folder}`;
        if (mkdirSync(local, { recursive: true })) chownSync(local, APPS_UID, APPS_UID);
      }
    }

    const signIn = { password };
    return {
      name: "Deluge",
      implementation: "Deluge",
      connection: { urlBase: "" },
      signIn: { known: async () => signIn, ask: async () => signIn },
      // Deluge's own folder in Downloads, which HexOS mounts in Deluge at the path the managers see it at
      preferences: DELUGE_FOLDERS,
      folder: DELUGE_FOLDERS.completedDirectory,
    };
  });

// --- SABnzbd -----------------------------------------------------------------

/** SABnzbd's folders when nothing set them: in its settings folder, which no manager can see. */
const SABNZBD_STOCK_FOLDERS = { download_dir: "Downloads/incomplete", complete_dir: "Downloads/complete" };
const SABNZBD_FOLDERS = { download_dir: "/downloads/sabnzbd/incomplete", complete_dir: "/downloads/sabnzbd/complete" };

interface SabnzbdConfig {
  misc: Record<string, unknown>;
}

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
  link(ctx, "sabnzbd", "SABnzbd", async ({ url, mounts, category }) => {
    const apiKey = readText(`${configMount(mounts, "sabnzbd")?.localPath}/sabnzbd.ini`)?.match(/^api_key\s*=\s*(\S+)/m)?.[1];
    if (!apiKey) ctx.fail("HexOS couldn't read SABnzbd's API key yet. Try again once it has started.");
    // Listing the categories is what makes SABnzbd's own (movies, tv, audio, software) the first time
    const categories = async () => (await sabnzbdApi<{ categories: string[] }>(url, apiKey, { mode: "get_cats" })).categories;
    // Where a category with no folder of its own finishes, which SABnzbd makes as it starts (cfg.py)
    let completeDir: string | undefined;
    try {
      const { misc } = (await sabnzbdApi<{ config: SabnzbdConfig }>(url, apiKey, { mode: "get_config", section: "misc" })).config;
      // A SABnzbd HexOS didn't set up finishes downloads where the managers can see them
      for (const [keyword, stock] of Object.entries(SABNZBD_STOCK_FOLDERS) as Array<[keyof typeof SABNZBD_FOLDERS, string]>) {
        if (misc[keyword] === stock) {
          await sabnzbdApi(url, apiKey, { mode: "set_config", section: "misc", keyword, value: SABNZBD_FOLDERS[keyword] });
          misc[keyword] = SABNZBD_FOLDERS[keyword];
        }
      }
      if (typeof misc.complete_dir === "string") completeDir = misc.complete_dir.replace(/\/+$/, "");
      if (!(await categories()).includes(category)) {
        await sabnzbdApi(url, apiKey, { mode: "set_config", section: "categories", keyword: category });
      }
    } catch (error) {
      ctx.fail("HexOS couldn't get SABnzbd ready. Try again once it has started.", [
        { label: "Reason", value: error instanceof Error ? error.message : String(error) },
      ]);
    }
    if (!(await categories()).includes(category)) ctx.fail(`SABnzbd didn't make its ${category} category`);
    // SABnzbd makes its API key at random when it first starts
    return { name: "SABnzbd", implementation: "Sabnzbd", connection: { apiKey, urlBase: "" }, proof: "key", folder: completeDir };
  });

// --- NZBGet ------------------------------------------------------------------

/** What NZBGet's settings file starts with (nzbget.conf at v26.3, the version TrueNAS pins). */
const NZBGET_STOCK = { username: "nzbget", password: "tegbzn6789", mainDir: "/downloads" };
/** Sign-ins many NZBGets have: its own to start with, and the one HexOS gives it when nobody chose one. */
const NZBGET_SHARED = [NZBGET_STOCK, { username: "admin", password: "admin" }];
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
 * NZBGet makes a category's folder at its first download, and until then the managers' health check
 * says the folder is missing. It's made now, worked out as the managers work it out (Nzbget.cs), and
 * returned when it's in NZBGet's own folder of Downloads.
 */
async function makeCategoryFolder(
  url: string,
  signIn: { username: string; password: string },
  category: string,
  mounts: ContextMount[],
): Promise<string | undefined> {
  const active = await nzbgetApi<NzbgetOption[]>(url, signIn, "config");
  const valueOf = (name: string) => active.find((option) => option.Name === name)?.Value ?? "";
  const index = active
    .find((option) => /^Category\d+\.Name$/.test(option.Name) && option.Value === category)
    ?.Name.match(/\d+/)?.[0];
  let folder = valueOf(`Category${index}.DestDir`);
  if (!folder) {
    folder = valueOf("DestDir").replace("${MainDir}", valueOf("MainDir"));
    if (valueOf("AppendCategoryDir") !== "no") folder = `${folder}/${category}`;
  }
  const downloads = mounts.find((m) => m.containerPath === NZBGET_MAIN_DIR);
  if (!downloads || !folder.startsWith(`${NZBGET_MAIN_DIR}/`)) return undefined;
  const local = `${downloads.localPath}${folder.slice(NZBGET_MAIN_DIR.length)}`;
  const first = mkdirSync(local, { recursive: true });
  if (first) {
    for (let dir = local; dir.length >= first.length; dir = dir.slice(0, dir.lastIndexOf("/"))) {
      chownSync(dir, APPS_UID, APPS_UID);
    }
  }
  return folder;
}

export const nzbget = (ctx: HookContext) =>
  link(ctx, "nzbget", "NZBGet", async ({ url, mounts, category, managerName }) => {
    // NZBGet keeps its sign-in in its settings file, so this is the one it uses now
    const conf = readText(`${configMount(mounts, "nzbget")?.localPath}/nzbget.conf`) ?? "";
    const signIn = {
      username: conf.match(/^ControlUsername=(.*)$/m)?.[1] ?? NZBGET_STOCK.username,
      password: conf.match(/^ControlPassword=(.*)$/m)?.[1] ?? NZBGET_STOCK.password,
    };
    let folder: string | undefined;
    try {
      const options = await nzbgetApi<NzbgetOption[]>(url, signIn, "loadconfig");
      const changes: NzbgetOption[] = [];
      const categories = options.filter((option) => /^Category\d+\.Name$/.test(option.Name));
      if (!categories.some((option) => option.Value === category)) {
        const next = Math.max(0, ...categories.map((option) => Number(option.Name.match(/\d+/)?.[0]))) + 1;
        changes.push({ Name: `Category${next}.Name`, Value: category });
      }
      // A NZBGet HexOS didn't set up reports its downloads at the path the managers see them at
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
            return changes.every((change) =>
              active.some((option) => option.Name === change.Name && option.Value === change.Value),
            );
          },
          60,
        );
        if (!taken) throw new Error("NZBGet didn't take its new settings");
      }
      folder = await makeCategoryFolder(url, signIn, category, mounts);
    } catch (error) {
      ctx.fail(`HexOS couldn't get NZBGet ready for ${managerName}. Try again once it's running.`, [
        { label: "Reason", value: error instanceof Error ? error.message : String(error) },
      ]);
    }
    // NZBGet's own settings file says what it takes now, so it's what the manager is given
    const current = { username: signIn.username, password: signIn.password };
    const shared = NZBGET_SHARED.some((each) => each.username === current.username && each.password === current.password);
    return {
      name: "NZBGet",
      implementation: "Nzbget",
      connection: { urlBase: "" },
      signIn: { known: async () => current, ask: async () => current },
      proof: shared ? undefined : "sign-in",
      folder,
    };
  });
