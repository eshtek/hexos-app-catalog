// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { readFileSync } from "node:fs";

import type { ContextMount, HookContext } from "../_lib/hook_context";

/**
 * Adds Radarr or Sonarr to Seerr as its default service, so a request made in Seerr lands in the
 * manager (connect-radarr, connect-sonarr). Seerr needs a quality profile and a root folder from the
 * manager: Profilarr's everyday profile when Profilarr has sent it, else the first that isn't one
 * the manager made itself, else its first, and its first root folder, made at the library the HexOS
 * install mounts when it has none yet. Run again, it puts back how Seerr reaches the manager, and
 * keeps the profile, folder and other choices the owner made in Seerr while the manager still has
 * them. Seerr knows the manager by its address, or by its API key once the box's address or the
 * manager's port changed: each install makes its key at random, so the key is the same manager
 * whatever its address.
 *
 * Radarr and Sonarr make six profiles of their own at their first start, and Profilarr's link takes
 * out the ones nothing uses once the manager has Profilarr's six (profilarr/profilarr_hook.ts). A
 * Seerr linked before Profilarr sent them defaults to one of those starters, which is then the only
 * thing holding it. So on a manager HexOS may tidy, a default that names a starter nothing else
 * uses moves to Profilarr's everyday profile, and the same tidy runs here, after Seerr's entry is
 * saved and read back. A manager or a Seerr the owner already had keeps what it has.
 */

/** The profile Profilarr's link sends both managers for everyday requests. */
const PREFERRED_PROFILE = "1080p Balanced";

/** The six profiles Profilarr's link sends a manager (PROFILES in profilarr/profilarr_hook.ts). */
const PROFILES = ["1080p Balanced", "1080p Quality", "1080p Quality HDR", "2160p Balanced", "2160p Quality", "2160p Remux"];

/** The profiles Radarr and Sonarr make at their first start (QualityProfileService, read at Radarr 6.4.4 and Sonarr 5.0.0). */
const STARTER_PROFILES = ["Any", "SD", "HD-720p", "HD-1080p", "Ultra-HD", "HD - 720p/1080p"];

const MANAGERS = {
  radarr: { name: "Radarr", library: "/movies", path: "radarr" },
  sonarr: { name: "Sonarr", library: "/shows", path: "sonarr" },
} as const;

type ManagerId = keyof typeof MANAGERS;

/**
 * Where a manager lists what a quality profile is given to, and how the step names each. These are
 * what its own delete refuses over (QualityProfileService.Delete); auto tagging rules are read apart.
 */
const HOLDERS: Record<ManagerId, Array<{ path: string; one: string; many: string }>> = {
  radarr: [
    { path: "/movie", one: "a movie", many: "movies" },
    { path: "/importlist", one: "an import list", many: "import lists" },
    { path: "/collection", one: "a collection", many: "collections" },
  ],
  sonarr: [
    { path: "/series", one: "a show", many: "shows" },
    { path: "/importlist", one: "an import list", many: "import lists" },
  ],
};

function configMount(mounts: ContextMount[], appId: string): ContextMount | undefined {
  return (
    mounts.find((m) => m.containerPath === "/config" || m.containerPath === "/app/config") ??
    mounts.find((m) => new RegExp(`/${appId}(-\\d+)?/config$`).test(m.hostPath))
  );
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

/** Seerr's settings for one Radarr or Sonarr, as its `/settings/radarr` and `/settings/sonarr` list them. */
type SeerrServer = Record<string, unknown> & { id: number; name?: string; hostname: string; port: number; apiKey?: string; is4k?: boolean; isDefault?: boolean };

/** Waits up to about a minute for an app that has only just started, and fails plainly when it doesn't answer. */
async function waitFor(ctx: HookContext, name: string, url: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    // Any answer counts: the app's web server is up
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2_000) }).catch(() => undefined);
    await response?.body?.cancel().catch(() => undefined);
    if (response) return;
    await ctx.sleep(1_000);
  }
  ctx.fail(`${name} isn't answering yet. Try again once it has started.`);
}

async function call<T>(url: string, apiKey: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text.slice(0, 300) || `${response.status} ${response.statusText}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

// --- the profiles a manager starts with --------------------------------------
// The same rules as Profilarr's link (profilarr/profilarr_hook.ts): scripts are compiled standalone.

interface ArrProfile {
  id: number;
  name: string;
  upgradeAllowed?: boolean;
  minFormatScore?: number;
  cutoffFormatScore?: number;
  formatItems?: Array<{ score?: number }>;
}

interface StarterPlan {
  /** Why nothing is removed, when nothing may be. */
  leave?: string;
  /** Each starter profile the manager still has, and what in the manager uses it. */
  starters: Array<{ profile: ArrProfile; heldBy?: string }>;
}

type ArrApi = <T>(path: string, init?: RequestInit) => Promise<T>;

/** A starter profile as the manager made it: no upgrades and no scores (GetDefaultProfile). */
const asStarted = (profile: ArrProfile) =>
  profile.upgradeAllowed === false &&
  profile.minFormatScore === 0 &&
  profile.cutoffFormatScore === 0 &&
  Array.isArray(profile.formatItems) &&
  profile.formatItems.every((item) => item.score === 0);

/**
 * The starter profiles a manager still has, and what in the manager itself uses each. Nothing is
 * planned for a manager the owner already had, or one without all six of Profilarr's profiles, and
 * a list the manager doesn't give says nothing about what's unused.
 */
async function starterPlan(ctx: HookContext, managerId: ManagerId, name: string, api: ArrApi): Promise<StarterPlan> {
  const leave = (why: string): StarterPlan => ({ leave: why, starters: [] });
  if (ctx.keptApps?.includes(ctx.linkedApp?.(managerId)?.name ?? managerId)) {
    return leave(`${name} is one you already had, so it keeps every profile it has`);
  }
  const read = <T>(path: string) => api<T>(path).catch(() => undefined);
  const profiles = await read<ArrProfile[]>("/qualityprofile");
  if (!Array.isArray(profiles)) return leave(`HexOS couldn't read ${name}'s profiles, so it removed none`);
  if (!PROFILES.every((wanted) => profiles.some((profile) => profile.name === wanted))) {
    return leave(`${name} doesn't have all of Profilarr's profiles, so it keeps the ones it started with`);
  }
  const starters = profiles.filter((profile) => STARTER_PROFILES.includes(profile.name));
  if (starters.length === 0) return leave(`${name} has none of the profiles it started with`);

  const unread = leave(`HexOS couldn't read what uses ${name}'s profiles, so it removed none`);
  const heldBy = new Map<number, string>();
  for (const holder of HOLDERS[managerId]) {
    const rows = await read<Array<{ qualityProfileId?: number }>>(holder.path);
    if (!Array.isArray(rows)) return unread;
    for (const { id } of starters) {
      const count = rows.filter((row) => row.qualityProfileId === id).length;
      if (count > 0 && !heldBy.has(id)) heldBy.set(id, count === 1 ? `${holder.one} uses it` : `${count} ${holder.many} use it`);
    }
  }
  // A rule that tags by quality profile names it by id too, and the manager's delete doesn't look
  const rules = await read<Array<{ specifications?: Array<{ implementation?: string; fields?: Array<{ name?: string; value?: unknown }> }> }>>(
    "/autotagging",
  );
  if (!Array.isArray(rules)) return unread;
  for (const specification of rules.flatMap((rule) => rule.specifications ?? [])) {
    if (specification.implementation !== "QualityProfileSpecification") continue;
    const id = Number(specification.fields?.find((field) => field.name === "value")?.value);
    if (!heldBy.has(id)) heldBy.set(id, "an auto tagging rule uses it");
  }
  return { starters: starters.map((profile) => ({ profile, heldBy: heldBy.get(profile.id) })) };
}

/**
 * Takes out each planned starter profile that nothing uses, in the manager or in Seerr (`inSeerr`,
 * undefined when HexOS couldn't tell), and that is still as the manager made it. The manager's own
 * check stands behind each one: a profile it won't remove stays, and isn't tried again. Then the
 * manager's list is read back, for the ones removed and for Profilarr's six.
 */
async function removeStarters(ctx: HookContext, name: string, api: ArrApi, plan: StarterPlan, inSeerr: Map<number, string> | undefined) {
  if (plan.leave) return ctx.skipCheckpoint("tidy", plan.leave);
  if (!inSeerr) return ctx.skipCheckpoint("tidy", `HexOS couldn't read which profiles Seerr uses, so it removed none from ${name}`);
  const kept: string[] = [];
  const removed: ArrProfile[] = [];
  for (const { profile, heldBy } of plan.starters) {
    let why = heldBy ?? inSeerr.get(profile.id) ?? (asStarted(profile) ? undefined : "its settings were changed");
    if (!why) {
      const refused = await api(`/qualityprofile/${profile.id}`, { method: "DELETE" }).then(
        () => false,
        () => true,
      );
      if (!refused) {
        removed.push(profile);
        continue;
      }
      why = `${name} wouldn't remove it`;
    }
    kept.push(`${name} keeps ${profile.name} because ${why}.`);
  }
  if (removed.length > 0) {
    const after = await api<ArrProfile[]>("/qualityprofile").catch(() => undefined);
    if (!Array.isArray(after)) ctx.fail(`HexOS couldn't read ${name}'s profiles after removing the ones it started with. Run this again.`);
    const still = removed.filter((profile) => after.some((entry) => entry.id === profile.id));
    if (still.length > 0) ctx.fail(`${name} answered, but still has ${still.map((profile) => profile.name).join(", ")}. Run this again.`);
    const lost = PROFILES.filter((wanted) => !after.some((entry) => entry.name === wanted));
    if (lost.length > 0) {
      ctx.fail(`${name} is missing some of Profilarr's profiles. Run Connect to ${name} from Profilarr's Connections tab to send them again.`, [
        { label: "Missing", value: lost.join(", ") },
      ]);
    }
  }
  const note = kept.join(" ") || undefined;
  if (removed.length === 0) return ctx.skipCheckpoint("tidy", note);
  await ctx.emitCheckpoint("tidy", note);
}

async function connect(ctx: HookContext, managerId: ManagerId) {
  const manager = { ...MANAGERS[managerId], name: ctx.linkedApp?.(managerId)?.displayName ?? MANAGERS[managerId].name };
  await ctx.registerCheckpoints([
    { id: "locate", message: `Finding ${manager.name}` },
    { id: "library", message: `Reading ${manager.name}'s profile and library` },
    { id: "configure", message: `Adding ${manager.name} to Seerr` },
    { id: "tidy", message: `Removing the profiles ${manager.name} started with` },
  ]);

  const settings = readText(`${configMount(ctx.mounts, "seerr")?.localPath}/settings.json`);
  const seerrKey = settings ? (JSON.parse(settings) as { main?: { apiKey?: string } }).main?.apiKey : undefined;
  if (!seerrKey) ctx.fail("HexOS couldn't read Seerr's API key yet. Try again once it has started.");
  await waitFor(ctx, "Seerr", `${ctx.baseUrl}/api/v1/status`);
  // Seerr's API key acts as its first admin, who exists only once Seerr is set up with a media server
  const setUp = await fetch(`${ctx.baseUrl}/api/v1/settings/public`, { signal: AbortSignal.timeout(15_000) })
    .then((response) => response.json() as Promise<{ initialized?: boolean }>)
    .catch(() => undefined);
  // The owner skipped the media server's link that sets Seerr up, so trying again can't help
  if (setUp?.initialized === false) {
    const message = `Seerr isn't set up yet. Open Seerr and sign in with your media server, then connect ${manager.name} from Seerr's Connections tab.`;
    if (ctx.skip) ctx.skip(message);
    ctx.fail(message);
  }
  const managerUrl = await ctx.getInstalledAppUrl(managerId);
  if (!managerUrl) ctx.fail(`${manager.name} isn't installed, or HexOS can't find its port`);
  const managerKey = readText(
    `${configMount(await ctx.getInstalledAppMounts(managerId), managerId)?.localPath}/config.xml`,
  )?.match(/<ApiKey>([^<]+)<\/ApiKey>/)?.[1];
  if (!managerKey) ctx.fail(`HexOS couldn't read ${manager.name}'s API key yet. Try again once it has started.`);
  await waitFor(ctx, manager.name, `${managerUrl}/ping`);
  await ctx.emitCheckpoint("locate");

  const managerApi = `${managerUrl}/api/v3`;
  const profiles = await call<Array<{ id: number; name: string }>>(`${managerApi}/qualityprofile`, managerKey);
  const preferred = profiles.find((entry) => entry.name === PREFERRED_PROFILE);
  const profile = preferred ?? profiles.find((entry) => !STARTER_PROFILES.includes(entry.name)) ?? profiles[0];
  if (!profile) ctx.fail(`${manager.name} has no quality profile yet`);
  const api: ArrApi = (path, init) => call(`${managerApi}${path}`, managerKey, init);
  const plan = await starterPlan(ctx, managerId, manager.name, api);
  let folders = await call<Array<{ path: string }>>(`${managerApi}/rootfolder`, managerKey);
  if (folders.length === 0) {
    await call(`${managerApi}/rootfolder`, managerKey, { method: "POST", body: JSON.stringify({ path: manager.library }) });
    folders = await call<Array<{ path: string }>>(`${managerApi}/rootfolder`, managerKey);
  }
  const directory = folders[0]?.path ?? manager.library;
  await ctx.emitCheckpoint("library");

  const { hostname, port } = new URL(managerUrl);
  const service = {
    name: manager.name,
    hostname,
    port: Number(port),
    apiKey: managerKey,
    useSsl: false,
    baseUrl: "",
    activeProfileId: profile.id,
    activeProfileName: profile.name,
    activeDirectory: directory,
    is4k: false,
    isDefault: true,
    externalUrl: "",
    syncEnabled: true,
    preventSearch: false,
    tags: [],
    ...(managerId === "radarr"
      ? { minimumAvailability: "released" }
      : {
          activeAnimeProfileId: profile.id,
          activeAnimeProfileName: profile.name,
          activeAnimeDirectory: directory,
          animeTags: [],
          enableSeasonFolders: true,
          seriesType: "standard",
          animeSeriesType: "anime",
        }),
  };

  const seerrApi = `${ctx.baseUrl}/api/v1/settings/${manager.path}`;
  // Seerr's list gives each key as it is. A copy has a key of its own, so another copy's entry
  // never matches.
  const ours = (servers: SeerrServer[]) =>
    servers.find((entry) => entry.hostname === hostname && entry.port === Number(port)) ?? servers.find((entry) => entry.apiKey === managerKey);
  // Seerr's override rules send some requests to a profile of their own, by its id. Only read when
  // there is something to remove, and a Seerr that won't list them says nothing about what's unused.
  const rules = plan.leave
    ? undefined
    : await call<Array<Record<string, unknown>>>(`${ctx.baseUrl}/api/v1/overrideRule`, seerrKey).then(
        (list) => (Array.isArray(list) ? list : undefined),
        () => undefined,
      );
  /** The profiles Seerr sends this manager's requests to, through these entries: their defaults and their rules. */
  const heldThrough = (entries: SeerrServer[]) => {
    const held = new Map<number, string>();
    for (const id of entries.flatMap((each) => [each.activeProfileId, each.activeAnimeProfileId])) {
      if (typeof id === "number") held.set(id, "Seerr sends requests to it");
    }
    const service = managerId === "radarr" ? "radarrServiceId" : "sonarrServiceId";
    for (const rule of rules ?? []) {
      if (typeof rule.profileId !== "number" || !entries.some((each) => each.id === rule[service])) continue;
      if (!held.has(rule.profileId)) held.set(rule.profileId, "a Seerr override rule uses it");
    }
    return held;
  };
  const thisManager = (servers: SeerrServer[]) =>
    servers.filter((each) => each.apiKey === managerKey || (each.hostname === hostname && each.port === Number(port)));
  let note: string | undefined;
  try {
    const servers = await call<SeerrServer[]>(seerrApi, seerrKey);
    const existing = ours(servers);
    if (existing) {
      // What the owner chose in Seerr stays while the manager still has it
      const kept: Record<string, unknown> = { ...existing };
      delete kept.id;
      const stillThere = (profileId: unknown, folder: unknown) =>
        profiles.some((entry) => entry.id === profileId) && folders.some((entry) => entry.path === folder);
      if (!stillThere(existing.activeProfileId, existing.activeDirectory)) {
        Object.assign(kept, { activeProfileId: profile.id, activeProfileName: profile.name, activeDirectory: directory });
      }
      if (managerId === "sonarr" && !stillThere(existing.activeAnimeProfileId, existing.activeAnimeDirectory)) {
        Object.assign(kept, { activeAnimeProfileId: profile.id, activeAnimeProfileName: profile.name, activeAnimeDirectory: directory });
      }
      // A default on a starter profile that this default alone keeps in the manager, which HexOS
      // may tidy, moves to Profilarr's everyday profile. Held by anything else, or in a Seerr the
      // owner already had, it is the owner's choice and stays.
      if (preferred && rules && !ctx.keptApps?.includes(ctx.resourceId)) {
        const elsewhere = heldThrough(thisManager(servers).filter((each) => each !== existing));
        const rule = heldThrough([{ ...existing, activeProfileId: undefined, activeAnimeProfileId: undefined }]);
        const onlyThisHolds = (profileId: unknown) =>
          plan.starters.find(
            ({ profile: starter, heldBy }) =>
              starter.id === profileId && !heldBy && asStarted(starter) && !elsewhere.has(starter.id) && !rule.has(starter.id),
          )?.profile.name;
        const from = [onlyThisHolds(kept.activeProfileId), managerId === "sonarr" ? onlyThisHolds(kept.activeAnimeProfileId) : undefined];
        if (from[0]) Object.assign(kept, { activeProfileId: preferred.id, activeProfileName: preferred.name });
        if (from[1]) Object.assign(kept, { activeAnimeProfileId: preferred.id, activeAnimeProfileName: preferred.name });
        const names = [...new Set(from.filter((name) => name !== undefined))];
        if (names.length > 0) note = `Seerr sent ${manager.name}'s requests to ${names.join(" and ")}. It sends them to ${PREFERRED_PROFILE} now.`;
      }
      const connection = { hostname, port: Number(port), apiKey: managerKey, useSsl: false, baseUrl: "" };
      await call(`${seerrApi}/${existing.id}`, seerrKey, { method: "PUT", body: JSON.stringify({ ...kept, ...connection }) });
    } else {
      // Saving a default takes it from the server that had it (one of the same 4K or not), so this
      // one joins beside a default Seerr has, as a second copy does beside the first
      const first = servers.find((entry) => entry.isDefault && !entry.is4k);
      await call(seerrApi, seerrKey, { method: "POST", body: JSON.stringify({ ...service, isDefault: !first }) });
      // That default may be a manager that's gone, so the owner hears where requests go
      if (first) note = `Seerr sends requests to ${first.name ?? manager.name} at ${first.hostname}:${first.port} by default. ${manager.name} was added beside it.`;
    }
  } catch (error) {
    ctx.fail(`Seerr didn't accept ${manager.name}`, [
      { label: "Reason", value: error instanceof Error ? error.message : String(error) },
    ]);
  }

  // What Seerr holds now, read back from Seerr
  const saved = await call<SeerrServer[]>(seerrApi, seerrKey).catch(() => undefined);
  const entry = saved ? ours(saved) : undefined;
  if (!entry) ctx.fail(`Seerr saved ${manager.name}, but HexOS couldn't find it there. Run this again.`);
  if (!profiles.some((each) => each.id === entry.activeProfileId)) {
    ctx.fail(`Seerr saved ${manager.name}, but its default profile isn't one ${manager.name} has. Run this again.`);
  }
  await ctx.emitCheckpoint("configure", note);

  await removeStarters(ctx, manager.name, api, plan, rules && saved ? heldThrough(thisManager(saved)) : undefined);
}

export const radarr = (ctx: HookContext) => connect(ctx, "radarr");
export const sonarr = (ctx: HookContext) => connect(ctx, "sonarr");
