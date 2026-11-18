// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { chownSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

import type { ContextMount, HookContext } from "../_lib/hook_context";

/**
 * OpenCloud answers at one address only: its Web address (`opencloud.app_url`, the chart's OC_URL).
 * Opened at any other address it shows "Missing or invalid configuration", and its apps can't sign in.
 * So its Anywhere address only works once the Web address is that address, and then its home address
 * stops working. That is a trade the owner makes, so HexOS never moves it on its own:
 *
 * - "Use its Anywhere address" (useAnywhere) is the owner's click. It sets the Web address, and the
 *   linked office's address when the office has an Anywhere address too, in one update.
 * - "Keep its Anywhere address up to date" (follow) runs again when the names change. It only follows
 *   an OpenCloud the owner moved, by the click or by typing the Anywhere address in the Web address.
 * - "Use its home address" (useHome) moves it back. A paused licence leaves the names on the box with
 *   no relay behind them, so follow never fires then, and this is the way home.
 *
 * What HexOS set lives in hexos/anywhere.json in OpenCloud's data folder. Not in an env: a script
 * update writes `additional_envs` back whole. A Web address or office address the owner typed is
 * never written over: HexOS only changes an address that is a home address (an IP), one it set, or
 * one of the app's own Anywhere names.
 */

export interface AnywhereState {
  /** The Web address HexOS set. */
  url: string;
  /** The Web address before it, put back by useHome or when the names are gone. */
  previousUrl: string;
  /** The office address HexOS set, when it set one. */
  officeUrl?: string;
  /** The office address before it. */
  previousOfficeUrl?: string;
}

export interface Current {
  appUrl: string;
  /** The office address, when an office is linked (`collaboration.enabled`). */
  officeUrl?: string;
}

/** What a step changes: the new addresses (absent = leave), and the state to keep (null = none). */
export interface Plan {
  appUrl?: string;
  officeUrl?: string;
  state: AnywhereState | null;
  /** What the owner reads when the step ends. */
  message: string;
}

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

const trim = (url: string) => url.replace(/\/+$/, "");
export const same = (a: string | undefined, b: string | undefined) =>
  typeof a === "string" && typeof b === "string" && trim(a).toLowerCase() === trim(b).toLowerCase();

export function hostOf(url: unknown): string | undefined {
  if (typeof url !== "string" || !URL.canParse(url)) return undefined;
  return new URL(url).hostname.toLowerCase();
}

/** A home address: an IP, as the install's default `https://<LAN IP>:<port>` is. */
export function isHomeAddress(url: unknown): boolean {
  const host = hostOf(url);
  return host !== undefined && (/^[\d.]+$/.test(host) || host.startsWith("["));
}

/** The first name that is a plain hostname, as the https address HexOS writes. */
export function addressOf(names: readonly string[]): string | undefined {
  const name = names.find((candidate) => HOSTNAME.test(candidate));
  return name ? `https://${name.toLowerCase()}` : undefined;
}

const isOneOf = (url: unknown, names: readonly string[]) => {
  const host = hostOf(url);
  return host !== undefined && names.some((name) => name.toLowerCase() === host);
};

const ownAddress = "OpenCloud uses an address of your own, so HexOS leaves it as it is";

/**
 * The office part of a move to Anywhere: its new address and what it was, or why it stays. An office
 * address the owner typed stays theirs.
 */
function officeToAnywhere(
  current: Current,
  officeNames: readonly string[],
  state: AnywhereState | null,
  officeName: string,
): { officeUrl?: string; previousOfficeUrl?: string; note?: string } {
  if (current.officeUrl === undefined) return {};
  const target = addressOf(officeNames);
  if (!target) return { note: `Turn on HexOS Anywhere for ${officeName} too, then run this again, so documents open away from home.` };
  if (same(current.officeUrl, target)) {
    return { officeUrl: target, previousOfficeUrl: state?.officeUrl ? state.previousOfficeUrl : undefined };
  }
  const ours = state?.officeUrl !== undefined && same(current.officeUrl, state.officeUrl);
  if (ours || isHomeAddress(current.officeUrl) || isOneOf(current.officeUrl, officeNames)) {
    const previous = ours ? state!.previousOfficeUrl : isHomeAddress(current.officeUrl) ? current.officeUrl : undefined;
    return { officeUrl: target, previousOfficeUrl: previous };
  }
  return { note: `${officeName} uses an address of your own, so HexOS leaves it as it is.` };
}

const signInNote = "Use this address everywhere, at home too. If Require sign-in is on for OpenCloud, turn it off so its apps work.";

/** The owner's click: move OpenCloud, and its office when it can, to the Anywhere address. */
export function planUseAnywhere(
  current: Current,
  names: readonly string[],
  officeNames: readonly string[],
  state: AnywhereState | null,
  home: string,
  officeName = "your office app",
): Plan | { skip: string } {
  const target = addressOf(names);
  if (!target) return { skip: "Turn on HexOS Anywhere for OpenCloud first, then run this again" };
  const ours = state !== null && same(current.appUrl, state.url);
  if (!same(current.appUrl, target) && !ours && !isHomeAddress(current.appUrl) && !isOneOf(current.appUrl, names)) {
    return { skip: ownAddress };
  }
  const previousUrl = ours ? state!.previousUrl : isHomeAddress(current.appUrl) ? trim(current.appUrl) : home;
  const office = officeToAnywhere(current, officeNames, state, officeName);
  const next: AnywhereState = { url: target, previousUrl };
  if (office.officeUrl) {
    next.officeUrl = office.officeUrl;
    if (office.previousOfficeUrl) next.previousOfficeUrl = office.previousOfficeUrl;
  }
  return {
    ...(same(current.appUrl, target) ? {} : { appUrl: target }),
    ...(office.officeUrl && !same(current.officeUrl, office.officeUrl) ? { officeUrl: office.officeUrl } : {}),
    state: next,
    message: [`OpenCloud opens at ${target}.`, signInNote, office.note].filter(Boolean).join(" "),
  };
}

/**
 * The office part of a move home. Only an office address HexOS set, or with no record one of the
 * office's own Anywhere names, goes back.
 */
function officeHome(current: Current, officeNames: readonly string[], state: AnywhereState | null, officeHomeUrl: string | null) {
  if (current.officeUrl === undefined) return undefined;
  const ours = state?.officeUrl !== undefined && same(current.officeUrl, state.officeUrl);
  if (!ours && !(state?.officeUrl === undefined && isOneOf(current.officeUrl, officeNames))) return undefined;
  const back = (ours ? state!.previousOfficeUrl : undefined) ?? officeHomeUrl ?? undefined;
  return back && !same(back, current.officeUrl) ? back : undefined;
}

/** The owner's way back: OpenCloud, and the office HexOS moved, return to their home addresses. */
export function planUseHome(
  current: Current,
  names: readonly string[],
  officeNames: readonly string[],
  state: AnywhereState | null,
  home: string,
  officeHomeUrl: string | null,
): Plan | { skip: string } {
  const ours = state !== null && same(current.appUrl, state.url);
  if (!ours) {
    if (isHomeAddress(current.appUrl)) return { skip: "OpenCloud already uses its home address" };
    if (state !== null || !isOneOf(current.appUrl, names)) return { skip: ownAddress };
  }
  const back = (ours ? state!.previousUrl : undefined) ?? home;
  const officeUrl = officeHome(current, officeNames, state, officeHomeUrl);
  return {
    appUrl: back,
    ...(officeUrl ? { officeUrl } : {}),
    state: null,
    message: `OpenCloud opens at its home address again, ${back}. Devices set up with its Anywhere address need it again.`,
  };
}

/**
 * The follower, run again whenever the names change. It acts only on an OpenCloud the owner moved:
 * with no record it adopts a Web address already at the Anywhere address and changes nothing else.
 */
export function planFollow(
  current: Current,
  names: readonly string[],
  officeNames: readonly string[],
  state: AnywhereState | null,
  home: string,
  officeHomeUrl: string | null,
): Plan | { skip: string } {
  if (state === null) {
    const target = addressOf(names);
    if (target && same(current.appUrl, target)) {
      const adopted: AnywhereState = { url: target, previousUrl: home };
      const officeTarget = addressOf(officeNames);
      if (officeTarget && same(current.officeUrl, officeTarget)) adopted.officeUrl = officeTarget;
      return { state: adopted, message: `OpenCloud already opens at ${target}. HexOS keeps it up to date from now on.` };
    }
    return { skip: "OpenCloud keeps the address it has. Use its Anywhere address moves it" };
  }
  if (!same(current.appUrl, state.url)) {
    // The owner typed another Web address: it is theirs now, and HexOS forgets what it set
    return { state: null, message: "OpenCloud's Web address was changed by hand, so HexOS leaves it as it is." };
  }
  const target = addressOf(names);
  if (!target) return planUseHome(current, names, officeNames, state, home, officeHomeUrl);
  const next: AnywhereState = { ...state, url: target };
  let officeUrl: string | undefined;
  if (state.officeUrl !== undefined && same(current.officeUrl, state.officeUrl)) {
    const officeTarget = addressOf(officeNames);
    if (officeTarget) {
      next.officeUrl = officeTarget;
      if (!same(current.officeUrl, officeTarget)) officeUrl = officeTarget;
    } else {
      const back = state.previousOfficeUrl ?? officeHomeUrl ?? undefined;
      delete next.officeUrl;
      delete next.previousOfficeUrl;
      if (back && !same(back, current.officeUrl)) officeUrl = back;
    }
  }
  const appUrl = same(current.appUrl, target) ? undefined : target;
  if (!appUrl && !officeUrl && JSON.stringify(next) === JSON.stringify(state)) {
    return { skip: `OpenCloud already opens at ${target}` };
  }
  return { ...(appUrl ? { appUrl } : {}), ...(officeUrl ? { officeUrl } : {}), state: next, message: `OpenCloud opens at ${target}.` };
}

// ---- running on the box ----

const APPS_UID = 568;
const insecure = { tls: { rejectUnauthorized: false } } as RequestInit;
const OFFICES: Record<string, { appId: string; name: string }> = {
  collabora: { appId: "collabora", name: "Collabora" },
  eurooffice: { appId: "eurooffice-document-server", name: "Euro-Office" },
  onlyoffice: { appId: "onlyoffice-document-server", name: "ONLYOFFICE" },
};

type OpenCloudValues = { app_url?: unknown; collaboration?: { enabled?: unknown; type?: unknown; url?: unknown } };

const dataMount = (ctx: HookContext): ContextMount | undefined =>
  ctx.mounts.find((m) => m.containerPath === "/var/lib/opencloud") ??
  ctx.mounts.find((m) => m.hostPath.replace(/\/+$/, "").endsWith("/opencloud/data"));

export function parseState(text: string | undefined): AnywhereState | null {
  if (!text) return null;
  try {
    const state = JSON.parse(text) as Partial<AnywhereState>;
    if (typeof state.url !== "string" || typeof state.previousUrl !== "string") return null;
    return {
      url: state.url,
      previousUrl: state.previousUrl,
      ...(typeof state.officeUrl === "string" ? { officeUrl: state.officeUrl } : {}),
      ...(typeof state.previousOfficeUrl === "string" ? { previousOfficeUrl: state.previousOfficeUrl } : {}),
    };
  } catch {
    return null;
  }
}

function readState(path: string): AnywhereState | null {
  try {
    return parseState(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/** Written whole through a temporary file, so a stopped run never leaves half of one. */
function writeState(folder: string, path: string, state: AnywhereState | null): void {
  if (state === null) {
    if (existsSync(path)) rmSync(path);
    return;
  }
  mkdirSync(folder, { recursive: true });
  chownSync(folder, APPS_UID, APPS_UID);
  const temporary = `${path}.hexos-tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chownSync(temporary, APPS_UID, APPS_UID);
  renameSync(temporary, path);
}

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(15_000), ...insecure })).ok;
  } catch {
    return false;
  }
}

type Planner = (
  current: Current,
  names: readonly string[],
  officeNames: readonly string[],
  state: AnywhereState | null,
  home: string,
  officeHomeUrl: string | null,
  officeName: string,
) => Plan | { skip: string };

async function run(ctx: HookContext, plan: Planner): Promise<void> {
  await ctx.registerCheckpoints([
    { id: "read", message: "Reading OpenCloud's address and its Anywhere address" },
    { id: "update", message: "Updating OpenCloud's address" },
    { id: "confirm", message: "Checking OpenCloud came back" },
  ]);
  if (typeof ctx.readRemoteAddresses !== "function" || typeof ctx.updateAppValues !== "function" || typeof ctx.getAppValues !== "function") {
    ctx.fail("This server's HexOS needs an update before OpenCloud can use its Anywhere address. Try again after it updates.");
  }
  const data = dataMount(ctx);
  if (!data) ctx.fail("HexOS couldn't find OpenCloud's data folder. Run this again.");
  const folder = `${data!.localPath}/hexos`;
  const statePath = `${folder}/anywhere.json`;

  const values = ((await ctx.getAppValues!())?.opencloud ?? {}) as OpenCloudValues;
  const collaboration = values.collaboration;
  const linked = collaboration?.enabled === true && typeof collaboration.url === "string";
  const office = linked && typeof collaboration!.type === "string" ? OFFICES[collaboration!.type] : undefined;
  const current: Current = {
    appUrl: typeof values.app_url === "string" ? values.app_url : "",
    ...(linked ? { officeUrl: collaboration!.url as string } : {}),
  };
  const names = (await ctx.readRemoteAddresses!()).names;
  const officeNames = office ? (await ctx.readRemoteAddresses!(office.appId)).names : [];
  const officeLan = office ? await ctx.getInstalledAppUrl(office.appId).catch(() => null) : null;
  const officeHomeUrl = officeLan ? trim(officeLan.replace(/^http:/, "https:")) : null;
  const home = `https://${ctx.host}:${ctx.port}`;
  const state = readState(statePath);
  await ctx.emitCheckpoint("read");

  const result = plan(current, names, officeNames, state, home, officeHomeUrl, office?.name ?? "your office app");
  if ("skip" in result) {
    await ctx.skipCheckpoint("update", result.skip);
    await ctx.skipCheckpoint("confirm");
    return;
  }
  // The note goes first: a note that can't be saved stops the run before OpenCloud changes, and an
  // update that fails puts the note back, so the note never says HexOS set an address it didn't
  try {
    writeState(folder, statePath, result.state);
  } catch (error) {
    ctx.fail("HexOS couldn't save its note in OpenCloud's folder, so OpenCloud was left as it was. Run this again.", [
      { label: "Reason", value: error instanceof Error ? error.message : String(error) },
    ]);
  }
  let changed = false;
  if (result.appUrl !== undefined || result.officeUrl !== undefined) {
    try {
      changed = await ctx.updateAppValues!((next) => {
        const opencloud = (next.opencloud ??= {}) as OpenCloudValues & Record<string, unknown>;
        if (result.appUrl !== undefined) opencloud.app_url = result.appUrl;
        if (result.officeUrl !== undefined) opencloud.collaboration = { ...(opencloud.collaboration ?? {}), url: result.officeUrl };
      });
    } catch (error) {
      try {
        writeState(folder, statePath, state);
      } catch {
        // The update's own error is the one the owner needs
      }
      throw error;
    }
  }
  if (!changed) {
    await ctx.skipCheckpoint("update", result.message);
    await ctx.skipCheckpoint("confirm");
    return;
  }
  await ctx.emitCheckpoint("update", result.message);
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await answers(`${home}/.well-known/openid-configuration`)) {
      await ctx.emitCheckpoint("confirm");
      return;
    }
    await ctx.sleep(5_000);
  }
  ctx.fail("OpenCloud didn't come back after its address changed. Look at its logs on the app's card.");
}

export const useAnywhere = (ctx: HookContext) =>
  run(ctx, (current, names, officeNames, state, home, _officeHome, officeName) =>
    planUseAnywhere(current, names, officeNames, state, home, officeName),
  );
export const follow = (ctx: HookContext) => run(ctx, planFollow);
export const useHome = (ctx: HookContext) => run(ctx, planUseHome);
