// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";

import type { ContextMount, HookContext } from "../_lib/hook_context";

/**
 * AdGuard Home starts on a setup page that asks for its ports and a first account. Pre-configure
 * AdGuard Home answers it (`/control/install/configure`, the call the page itself makes) with the
 * ports the app was installed on and the sign-in the owner chose, so it answers DNS at once. An
 * AdGuard Home that is already set up keeps its account.
 *
 * AdGuard Home runs on the server's own network, because TrueNAS only publishes a port on one
 * address when that address is set by hand, and most servers get theirs from the router. So AdGuard
 * Home has to pick its own DNS address, and it gets the server's: on every address it would fight
 * the mesh client for port 53 and never start (v0.107.80 ends with "address already in use"). Enable Anywhere for
 * AdGuard Home puts that right too, when AdGuard Home's settings name every address
 * or one the server no longer has.
 *
 * Enable Anywhere for AdGuard Home keeps one DNS rewrite per Anywhere name the box answers on the
 * standard web ports, each pointing at the box's own address, so a device on the owner's network
 * that asks AdGuard Home reaches the box without going through the relay. The box runs it again
 * when the names change (`rerunsOn: home-addresses`), when nobody is there to type a password, so
 * HexOS keeps an account of its own in AdGuard Home's settings file, with its password in `hexos/`
 * beside it. It only ever adds, moves and removes the rewrites it made itself, which it lists in
 * `hexos/home-addresses.json`: a rewrite the owner made for the same name stays and wins.
 */

const HEXOS_ACCOUNT = "hexos-anywhere";
const EVERY_ADDRESS = ["0.0.0.0", "::"];

interface Account {
  name: string;
  password: string;
}
interface Rewrite {
  domain: string;
  answer: string;
}

function configMount(mounts: ContextMount[]): ContextMount | undefined {
  return mounts.find((m) => m.containerPath === "/opt/adguardhome/conf") ?? mounts.find((m) => /\/adguard-home(-\d+)?\/config$/.test(m.hostPath));
}

const basic = (account: Account): string => `Basic ${Buffer.from(`${account.name}:${account.password}`).toString("base64")}`;

async function api(ctx: HookContext, account: Account, path: string, body?: unknown): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: basic(account), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
}

/** Whether the app runs on the server's own network. A box that can't say installed it that way. */
async function onHostNetwork(ctx: HookContext): Promise<boolean> {
  const values = await ctx.getAppValues?.().catch(() => undefined);
  return values === undefined || (values.network as { host_network?: unknown } | undefined)?.host_network !== false;
}

/**
 * The settings file with AdGuard Home's DNS on the server's address, or undefined when it is fine
 * as it is or can't be read. Only two cases change: every address, and one address the server
 * doesn't have (`local` is every address it does have). Anything else is the owner's choice.
 */
export function withDnsAddress(yaml: string, address: string, local: string[]): string | undefined {
  const lines = yaml.split("\n");
  const dns = lines.findIndex((line) => /^dns:\s*$/.test(line));
  if (dns === -1) return undefined;
  let at = dns + 1;
  while (at < lines.length && /^\s/.test(lines[at]!) && !/^  bind_hosts:\s*$/.test(lines[at]!)) at++;
  if (at >= lines.length || !/^  bind_hosts:\s*$/.test(lines[at]!)) return undefined;
  let end = at + 1;
  while (end < lines.length && /^    - \S/.test(lines[end]!)) end++;
  const hosts = lines.slice(at + 1, end).map((line) => line.slice(6).trim().replace(/^["']|["']$/g, ""));
  const everywhere = hosts.length > 0 && hosts.every((host) => EVERY_ADDRESS.includes(host));
  const gone = hosts.length === 1 && local.length > 0 && !EVERY_ADDRESS.includes(hosts[0]!) && !local.includes(hosts[0]!);
  if (!everywhere && !gone) return undefined;
  lines.splice(at + 1, end - at - 1, `    - ${address}`);
  return lines.join("\n");
}

/** Every address the server has, as the HexOS container on the server's own network sees them. */
function localAddresses(): string[] {
  try {
    return Object.values(networkInterfaces()).flatMap((entries) => (entries ?? []).map((entry) => entry.address));
  } catch {
    return [];
  }
}

/** Moves AdGuard Home's DNS back to the server's address when its settings can't work, and restarts it. */
async function keepDnsAddress(ctx: HookContext, config: ContextMount): Promise<void> {
  if (!ctx.host || !ctx.restartApp || !(await onHostNetwork(ctx))) return;
  const settingsPath = `${config.localPath}/AdGuardHome.yaml`;
  if (!existsSync(settingsPath)) return;
  const next = withDnsAddress(readFileSync(settingsPath, "utf-8"), ctx.host, localAddresses());
  if (!next) return;
  writeFileSync(settingsPath, next);
  ctx.log("AdGuard Home's DNS is back on the server's address");
  // AdGuard Home reads its settings file only when it starts
  await ctx.restartApp();
}

/** "setup" while AdGuard Home shows its setup page, "ready" once it is set up, undefined while it doesn't answer. */
async function stateOf(ctx: HookContext): Promise<"setup" | "ready" | undefined> {
  const response = await fetch(`${ctx.baseUrl}/control/install/get_addresses`, { redirect: "manual", signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  await response?.body?.cancel();
  if (!response) return undefined;
  return response.status === 200 ? "setup" : "ready";
}

async function waitForState(ctx: HookContext): Promise<"setup" | "ready"> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const state = await stateOf(ctx);
    if (state) return state;
    await ctx.sleep(5_000);
  }
  return ctx.fail("AdGuard Home didn't start. Try again once it's running.");
}

/** The settings file with HexOS's account in its `users` list, or undefined when the list can't be found. */
export function withAccount(yaml: string, name: string, hash: string): string | undefined {
  const entry = `  - name: ${name}\n    password: ${hash}\n`;
  const lines = yaml.split("\n");
  const at = lines.findIndex((line) => /^users:\s*(\[\s*\])?\s*$/.test(line));
  if (at === -1) return undefined;
  // An account of this name from an earlier run goes, with its password line
  const kept = lines.filter((line, index) => !(index > at && (line === `  - name: ${name}` || (lines[index - 1] === `  - name: ${name}` && /^    password:/.test(line)))));
  kept[at] = "users:";
  kept.splice(at + 1, 0, ...entry.trimEnd().split("\n"));
  return kept.join("\n");
}

/** HexOS's own account in AdGuard Home, made in its settings file when it isn't there or no longer signs in. */
async function hexosAccount(ctx: HookContext, config: ContextMount): Promise<Account> {
  const accountPath = `${config.localPath}/hexos/account.json`;
  const stored = ((): Account | undefined => {
    try {
      return JSON.parse(readFileSync(accountPath, "utf-8")) as Account;
    } catch {
      return undefined;
    }
  })();
  if (stored && (await api(ctx, stored, "/control/status").then((r) => r.status === 200, () => false))) return stored;

  if (!ctx.restartApp) return ctx.fail("This server needs a HexOS update before it can keep AdGuard Home's addresses up to date.");
  const settingsPath = `${config.localPath}/AdGuardHome.yaml`;
  const account: Account = { name: HEXOS_ACCOUNT, password: crypto.randomUUID() + crypto.randomUUID() };
  const hash = await Bun.password.hash(account.password, { algorithm: "bcrypt", cost: 10 });
  const next = withAccount(readFileSync(settingsPath, "utf-8"), account.name, hash);
  if (!next) return ctx.fail("HexOS couldn't read AdGuard Home's settings file");
  writeFileSync(settingsPath, next);
  if (!existsSync(`${config.localPath}/hexos`)) mkdirSync(`${config.localPath}/hexos`, { recursive: true });
  writeFileSync(accountPath, JSON.stringify(account), { mode: 0o600 });
  // AdGuard Home reads its settings file only when it starts
  await ctx.restartApp();
  for (let attempt = 0; attempt < 36; attempt++) {
    await ctx.sleep(5_000);
    if (await api(ctx, account, "/control/status").then((r) => r.status === 200, () => false)) return account;
  }
  return ctx.fail("AdGuard Home didn't come back after HexOS added its account");
}

/** What to add and what to remove so the rewrites HexOS made match the names, leaving every other rewrite alone. */
export function rewriteChanges(current: Rewrite[], ours: Rewrite[], names: string[], address: string): { add: Rewrite[]; remove: Rewrite[]; ours: Rewrite[] } {
  const has = (list: Rewrite[], rewrite: Rewrite) => list.some((other) => other.domain === rewrite.domain && other.answer === rewrite.answer);
  // Ours are the ones we recorded that AdGuard Home still has
  const live = ours.filter((rewrite) => has(current, rewrite));
  const wanted = names
    // A name the owner already answers their own way stays theirs
    .filter((domain) => !current.some((rewrite) => rewrite.domain === domain && !has(live, rewrite)))
    .map((domain) => ({ domain, answer: address }));
  return {
    add: wanted.filter((rewrite) => !has(live, rewrite)),
    remove: live.filter((rewrite) => !has(wanted, rewrite)),
    ours: wanted,
  };
}

async function syncRewrites(ctx: HookContext, config: ContextMount, account: Account): Promise<number> {
  const home = await ctx.readHomeAddresses?.();
  if (!home) return ctx.fail("This server needs a HexOS update before AdGuard Home can answer its Anywhere addresses.");
  const oursPath = `${config.localPath}/hexos/home-addresses.json`;
  const ours = ((): Rewrite[] => {
    try {
      return JSON.parse(readFileSync(oursPath, "utf-8")) as Rewrite[];
    } catch {
      return [];
    }
  })();
  const listed = await api(ctx, account, "/control/rewrite/list");
  if (!listed.ok) return ctx.fail("AdGuard Home refused to list its DNS rewrites", [{ label: "Status", value: String(listed.status) }]);
  const current = (await listed.json()) as Rewrite[];
  const changes = rewriteChanges(current, ours, home.address ? home.names : [], home.address ?? "");
  for (const [path, rewrites] of [["/control/rewrite/delete", changes.remove], ["/control/rewrite/add", changes.add]] as const) {
    for (const rewrite of rewrites) {
      const response = await api(ctx, account, path, { domain: rewrite.domain, answer: rewrite.answer });
      await response.body?.cancel();
      if (!response.ok) return ctx.fail("AdGuard Home refused a DNS rewrite", [{ label: "Name", value: rewrite.domain }, { label: "Status", value: String(response.status) }]);
    }
  }
  writeFileSync(oursPath, JSON.stringify(changes.ours), { mode: 0o600 });
  return changes.ours.length;
}

export async function configure(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "start", message: "Waiting for AdGuard Home to start" },
    { id: "setup", message: "Finishing AdGuard Home's setup" },
  ]);
  const state = await waitForState(ctx);
  await ctx.emitCheckpoint("start");
  if (state === "ready") {
    await ctx.emitCheckpoint("setup", "AdGuard Home was already set up");
    return;
  }
  // On the server's own network AdGuard Home listens where it is told, and every address is the mesh client's too
  const dnsAddress = (await onHostNetwork(ctx)) ? ctx.host : "0.0.0.0";
  if (!dnsAddress) ctx.fail("HexOS couldn't tell which address this server has on your network");
  if (!ctx.signIn) {
    await ctx.skipCheckpoint(
      "setup",
      dnsAddress === "0.0.0.0" ? "Open AdGuard Home to finish its setup page" : `Open AdGuard Home to finish its setup page. For its DNS server, pick this server's address, ${dnsAddress}.`,
    );
    return;
  }
  const response = await fetch(`${ctx.baseUrl}/control/install/configure`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      web: { ip: "0.0.0.0", port: ctx.port },
      dns: { ip: dnsAddress, port: 53 },
      username: ctx.signIn.username,
      password: ctx.signIn.password,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) ctx.fail("AdGuard Home refused its setup", [{ label: "Status", value: String(response.status) }, { label: "Response", value: (await response.text()).slice(0, 300) }]);
  await response.body?.cancel();
  await ctx.emitCheckpoint("setup", "AdGuard Home uses the sign-in you chose");
}

export async function homeAddresses(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "start", message: "Waiting for AdGuard Home to start" },
    { id: "addresses", message: "Pointing your Anywhere addresses at this server" },
  ]);
  const config = configMount(ctx.mounts);
  if (!config) ctx.fail("HexOS couldn't find AdGuard Home's settings folder");
  // Before the wait: with its DNS on every address AdGuard Home never comes up
  await keepDnsAddress(ctx, config);
  const state = await waitForState(ctx);
  if (state === "setup") {
    const message = "AdGuard Home isn't set up yet. Open it, finish its setup page, then run this again.";
    if (ctx.skip) ctx.skip(message);
    ctx.fail(message);
  }
  await ctx.emitCheckpoint("start");
  const account = await hexosAccount(ctx, config);
  const count = await syncRewrites(ctx, config, account);
  await ctx.emitCheckpoint(
    "addresses",
    count > 0 ? `Devices at home now reach ${count} Anywhere ${count === 1 ? "address" : "addresses"} without going out to the internet` : "This server isn't answering Anywhere addresses on your network yet",
  );
}
