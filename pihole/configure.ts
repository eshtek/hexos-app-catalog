// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { Resolver } from "node:dns/promises";
import { chownSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

import type { ContextMount, HookContext } from "../_lib/hook_context";

/**
 * Pi-hole's web page asks for a password and nothing else. TrueNAS's app hands it to Pi-hole as
 * `FTLCONF_webserver_api_password` at every start, so the app's TrueNAS values are where it lives:
 * a password changed inside Pi-hole lasts only until Pi-hole's next start. The script installs
 * Pi-hole with a password nobody knows, and Pre-configure Pi-hole puts the owner's chosen one in
 * those values (`ctx.updateAppValues`), which restarts Pi-hole once.
 *
 * Pi-hole runs on the server's own network, because TrueNAS only publishes a port on one address
 * when that address is set by hand, and most servers get theirs from the router. There TrueNAS's app
 * always starts Pi-hole listening on every address (`FTLCONF_dns_listeningMode=all`, which an extra
 * env can't replace), and Pi-hole 6.9 then finds port 53 taken by the mesh client and answers
 * nowhere. So before Pi-hole's first start, Keep Pi-hole on this server's address writes a file
 * into `/etc/dnsmasq.d`, which Pi-hole reads with `FTLCONF_misc_etc_dnsmasq_d=true`. The file names
 * the server's network connection (`interface=`), so Pi-hole follows the server to a new address
 * from the router, and `bind-dynamic`, so it binds that connection's addresses and its own loopback
 * one by one and starts even when the file has gone stale. Pi-hole needs the loopback address to
 * look up the names of the devices it shows. A server whose connection can't be named gets its
 * address in the file instead. Use Anywhere addresses at home puts the file right again when it runs.
 *
 * Use Anywhere addresses at home keeps three dnsmasq lines per Anywhere name the box answers on
 * the standard web ports, the same three HexOS's own DNS service writes. `host-record` answers the
 * name with the box's address. `local` makes Pi-hole answer every other record type for the name
 * with nothing instead of asking upstream, where an AAAA or HTTPS record would send the device back
 * out through the relay. `server=/*.name/#` leaves the name's subdomains to the usual upstream.
 *
 * The lines live in Pi-hole's `misc.dnsmasq_lines` setting. Pi-hole 6.9 refuses that setting from
 * its web API (FTL `src/config/config.c`), so the hook sets it the way Pi-hole's notes say to, with
 * `pihole-FTL --config` in the app's container, which needs no password. That command tests the
 * lines with dnsmasq before it keeps them, and Pi-hole restarts its DNS by itself when the setting
 * changes. HexOS only ever adds and removes the lines it made itself, which it lists in
 * `hexos/home-addresses.json` beside Pi-hole's settings: a name the owner already answers their own
 * way, in a line or a Local DNS record, stays theirs.
 */

const DOCKER_SOCKET = "/var/run/docker.sock";
const SETTING = "misc.dnsmasq_lines";
const LISTEN_FILE = "hexos-listen.conf";
/** The apps user, which the script makes Pi-hole's own (PIHOLE_UID). */
const APPS_ID = 568;
/** What Linux allows in a connection's name, so one can never end its line early. */
const INTERFACE = /^[A-Za-z0-9_.:@-]{1,15}$/;
/** One label after another, in the letters a web address can hold, so a name can never end a line early. */
const NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

function configMount(mounts: ContextMount[]): ContextMount | undefined {
  return mounts.find((m) => m.containerPath === "/etc/pihole") ?? mounts.find((m) => /\/pihole(-\d+)?\/config$/.test(m.hostPath));
}

function dnsmasqMount(mounts: ContextMount[]): ContextMount | undefined {
  return mounts.find((m) => m.containerPath === "/etc/dnsmasq.d") ?? mounts.find((m) => /\/pihole(-\d+)?\/dnsmasq$/.test(m.hostPath));
}

/** The name of the network connection that holds an address, among the server's connections. */
export function interfaceOf(interfaces: Record<string, Array<{ address: string }> | undefined>, address: string): string | undefined {
  return Object.entries(interfaces).find(([, entries]) => entries?.some((entry) => entry.address === address))?.[0];
}

/**
 * The file that keeps Pi-hole's DNS off every address but the server's own: by the connection's
 * name when there is one, by the address otherwise. Undefined when neither can be written safely.
 */
export function listenFile(name: string | undefined, address: string | undefined): string | undefined {
  const head = "# Kept by HexOS. Pi-hole answers DNS on this server's own address and nowhere else.";
  if (name && INTERFACE.test(name) && name !== "lo") return [head, `interface=${name}`, "bind-dynamic", ""].join("\n");
  if (address && isIP(address)) return [head, `listen-address=${address}`, "listen-address=127.0.0.1", "bind-dynamic", ""].join("\n");
  return undefined;
}

/** Writes the file when it isn't already right, and says whether it changed. */
function keepListenFile(ctx: HookContext): boolean {
  const folder = dnsmasqMount(ctx.mounts);
  if (!folder) ctx.fail("HexOS couldn't find Pi-hole's dnsmasq folder");
  const name = ((): string | undefined => {
    try {
      return ctx.host ? interfaceOf(networkInterfaces(), ctx.host) : undefined;
    } catch {
      return undefined;
    }
  })();
  const wanted = listenFile(name, ctx.host);
  if (!wanted) ctx.fail("HexOS couldn't tell which address this server has on your network");
  const path = `${folder.localPath}/${LISTEN_FILE}`;
  const current = ((): string | undefined => {
    try {
      return readFileSync(path, "utf-8");
    } catch {
      return undefined;
    }
  })();
  if (current === wanted) return false;
  writeFileSync(path, wanted, { mode: 0o640 });
  chownSync(path, APPS_ID, APPS_ID);
  return true;
}

/** Whether the app runs on the server's own network. A box that can't say installed it that way. */
async function onHostNetwork(ctx: HookContext): Promise<boolean> {
  const values = await ctx.getAppValues?.().catch(() => undefined);
  return values === undefined || (values.network as { host_network?: unknown } | undefined)?.host_network !== false;
}

/** True once Pi-hole's web page answers at all: its sign-in check says 200 or 401. */
async function isUp(ctx: HookContext): Promise<boolean> {
  const response = await fetch(`${ctx.baseUrl}/api/auth`, { redirect: "manual", signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  await response?.body?.cancel();
  return response !== undefined && response.status < 500;
}

async function waitForPihole(ctx: HookContext): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await isUp(ctx)) return;
    await ctx.sleep(5_000);
  }
  ctx.fail("Pi-hole didn't start. Try again once it's running.");
}

/** Whether Pi-hole takes the password. It signs straight back out, since Pi-hole keeps only 16 sessions. */
async function signsIn(ctx: HookContext, password: string): Promise<boolean> {
  const response = await fetch(`${ctx.baseUrl}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
  if (!response?.ok) {
    await response?.body?.cancel();
    return false;
  }
  const { session } = (await response.json()) as { session?: { valid?: boolean; sid?: string | null } };
  if (session?.sid) {
    const out = await fetch(`${ctx.baseUrl}/api/auth`, { method: "DELETE", headers: { sid: session.sid }, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
    await out?.body?.cancel();
  }
  return session?.valid === true;
}

/** The app's TrueNAS values with the web page's password in them. */
export function withPassword(values: Record<string, unknown>, password: string): void {
  const pihole = typeof values.pihole === "object" && values.pihole !== null ? (values.pihole as Record<string, unknown>) : {};
  pihole.web_password = password;
  values.pihole = pihole;
}

/**
 * A list of strings from Pi-hole's settings file, by its table and key, or undefined when it isn't
 * there in a form this can read. Pi-hole writes each entry as a quoted string with JSON's escapes.
 */
export function tomlArray(toml: string, table: string, key: string): string[] | undefined {
  let inTable = false;
  let offset = 0;
  for (const line of toml.split("\n")) {
    const start = offset;
    offset += line.length + 1;
    const text = line.trim();
    const header = text.match(/^\[([^\]"]+)\]/);
    if (header) {
      inTable = header[1]!.trim() === table;
      continue;
    }
    if (!inTable) continue;
    const opening = text.match(/^([A-Za-z0-9_-]+)\s*=\s*\[/);
    if (opening?.[1] !== key) continue;

    const entries: string[] = [];
    let at = toml.indexOf("[", start) + 1;
    while (at < toml.length) {
      const char = toml[at]!;
      if (char === "]") return entries;
      if (char === "#") {
        const end = toml.indexOf("\n", at);
        at = end === -1 ? toml.length : end;
      } else if (char === '"') {
        let end = at + 1;
        while (end < toml.length && toml[end] !== '"') end += toml[end] === "\\" ? 2 : 1;
        try {
          entries.push(JSON.parse(toml.slice(at, end + 1)) as string);
        } catch {
          return undefined;
        }
        at = end + 1;
      } else if (/[\s,]/.test(char)) {
        at++;
      } else {
        return undefined;
      }
    }
    return undefined;
  }
  return undefined;
}

/** The three lines that answer one name at home. */
export const linesFor = (name: string, address: string): string[] => [`host-record=${name},${address}`, `local=/${name}/`, `server=/*.${name}/#`];

/** Whether a dnsmasq line, or a Local DNS record ("address name name"), is about this very name. */
const names = (entry: string, name: string): boolean => entry.toLowerCase().split(/[\s=,/]+/).includes(name);

/**
 * Pi-hole's dnsmasq lines with the ones HexOS made brought in step with the names, and every other
 * line where it was. `hosts` are the owner's Local DNS records.
 */
export function lineChanges(
  current: string[],
  ours: string[],
  hosts: string[],
  wantedNames: string[],
  address: string | null,
): { lines: string[]; ours: string[]; changed: boolean } {
  // Ours are the ones we recorded that Pi-hole still has
  const live = ours.filter((line) => current.includes(line));
  const theirs = [...current.filter((line) => !live.includes(line)), ...hosts];
  const wanted =
    address && isIP(address)
      ? [...new Set(wantedNames.map((name) => name.toLowerCase()))]
          .filter((name) => NAME.test(name))
          // A name the owner already answers their own way stays theirs
          .filter((name) => !theirs.some((entry) => names(entry, name)))
          .flatMap((name) => linesFor(name, address))
      : [];
  const lines = [...current.filter((line) => !live.includes(line) || wanted.includes(line)), ...wanted.filter((line) => !current.includes(line))];
  return { lines, ours: wanted, changed: lines.length !== current.length || lines.some((line, index) => line !== current[index]) };
}

/**
 * The name and address to ask Pi-hole for after a change, and whether the address should be in the
 * answer: a line that was added, or else one that was taken out. The answer only changes once
 * Pi-hole has restarted its DNS.
 */
export function probeFor(before: string[], after: string[]): { name: string; address: string; answered: boolean } | undefined {
  const record = (lines: string[], others: string[]) => lines.filter((line) => !others.includes(line)).map((line) => line.match(/^host-record=([^,]+),([^,]+)$/)).find((match) => match);
  const added = record(after, before);
  if (added) return { name: added[1]!, address: added[2]!, answered: true };
  const removed = record(before, after);
  return removed ? { name: removed[1]!, address: removed[2]!, answered: false } : undefined;
}

const docker = (path: string, body?: unknown) =>
  fetch(`http://docker${path}`, {
    unix: DOCKER_SOCKET,
    signal: AbortSignal.timeout(60_000),
    ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  } as RequestInit);

/** Runs a command in Pi-hole's running container, found by the compose project TrueNAS names after the app. */
async function exec(ctx: HookContext, cmd: string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=ix-${ctx.resourceId}`], status: ["running"] }));
    const container = ((await (await docker(`/containers/json?filters=${filters}`)).json()) as Array<{ Id: string }>)[0]?.Id;
    if (!container) return { ok: false, output: "Pi-hole isn't running" };
    const created = await docker(`/containers/${container}/exec`, { Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: true });
    if (!created.ok) return { ok: false, output: await created.text() };
    const { Id } = (await created.json()) as { Id: string };
    const output = (await (await docker(`/exec/${Id}/start`, { Detach: false, Tty: true })).text()).replaceAll("\r", "");
    const { ExitCode } = (await (await docker(`/exec/${Id}/json`)).json()) as { ExitCode: number };
    return { ok: ExitCode === 0, output };
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}

/** Waits until Pi-hole's DNS, back from its restart, answers the probe as the new lines say. */
async function waitForAnswer(ctx: HookContext, probe: { name: string; address: string; answered: boolean }): Promise<boolean> {
  const resolver = new Resolver({ timeout: 2_000, tries: 1 });
  resolver.setServers([ctx.host ?? probe.address]);
  const lookup = isIP(probe.address) === 6 ? (name: string) => resolver.resolve6(name) : (name: string) => resolver.resolve4(name);
  for (let attempt = 0; attempt < 30; attempt++) {
    await ctx.sleep(2_000);
    // No answer at all is Pi-hole still restarting; a name it has nothing for is an answer
    const answer = await lookup(probe.name).catch((error: { code?: string }): string[] | undefined => (error.code === "ENODATA" || error.code === "ENOTFOUND" ? [] : undefined));
    if (answer && answer.includes(probe.address) === probe.answered) return true;
  }
  return false;
}

function readOurs(path: string): string[] {
  try {
    const stored = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return Array.isArray(stored) ? stored.filter((line): line is string => typeof line === "string") : [];
  } catch {
    return [];
  }
}

export async function seedListen(ctx: HookContext) {
  await ctx.registerCheckpoints([{ id: "listen", message: "Keeping Pi-hole's DNS on this server's own address" }]);
  keepListenFile(ctx);
  await ctx.emitCheckpoint("listen");
}

export async function configure(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "start", message: "Waiting for Pi-hole to start" },
    { id: "password", message: "Setting Pi-hole's password" },
  ]);
  await waitForPihole(ctx);
  await ctx.emitCheckpoint("start");
  const password = ctx.signIn?.password;
  if (!password) {
    await ctx.skipCheckpoint("password", "Pi-hole keeps the password it has");
    return;
  }
  if (!ctx.updateAppValues) ctx.fail("This server needs a HexOS update before it can set Pi-hole's password.");
  const changed = await ctx.updateAppValues((values) => withPassword(values, password));
  if (!changed) {
    await ctx.emitCheckpoint("password", "Pi-hole already uses the password you chose");
    return;
  }
  // The update restarts Pi-hole, which reads its password as it starts
  for (let attempt = 0; attempt < 60; attempt++) {
    await ctx.sleep(5_000);
    if (await signsIn(ctx, password)) {
      await ctx.emitCheckpoint("password", "Pi-hole uses the password you chose");
      return;
    }
  }
  ctx.fail("Pi-hole didn't come back with its new password. Look at its logs on the app's card.");
}

export async function homeAddresses(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "start", message: "Waiting for Pi-hole to start" },
    { id: "addresses", message: "Pointing your Anywhere addresses at this server" },
  ]);
  const config = configMount(ctx.mounts);
  if (!config) ctx.fail("HexOS couldn't find Pi-hole's settings folder");
  // A file gone missing or stale leaves Pi-hole answering nowhere on the network, and it reads the file only at its start
  if ((await onHostNetwork(ctx)) && keepListenFile(ctx)) await ctx.restartApp?.();
  await waitForPihole(ctx);
  await ctx.emitCheckpoint("start");
  const home = await ctx.readHomeAddresses?.();
  if (!home) ctx.fail("This server needs a HexOS update before Pi-hole can answer its Anywhere addresses.");

  const toml = ((): string => {
    try {
      return readFileSync(`${config.localPath}/pihole.toml`, "utf-8");
    } catch {
      return "";
    }
  })();
  const current = tomlArray(toml, "misc", "dnsmasq_lines");
  const hosts = tomlArray(toml, "dns", "hosts");
  if (!current || !hosts) ctx.fail("HexOS couldn't read Pi-hole's settings file");

  const oursPath = `${config.localPath}/hexos/home-addresses.json`;
  const ours = readOurs(oursPath);
  const changes = lineChanges(current, ours, hosts, home.address ? home.names : [], home.address);
  mkdirSync(`${config.localPath}/hexos`, { recursive: true });
  if (changes.changed) {
    // Recorded before the change, so a run that dies halfway never leaves a line HexOS no longer knows is its own
    writeFileSync(oursPath, JSON.stringify([...new Set([...ours, ...changes.ours])]), { mode: 0o600 });
    const set = await exec(ctx, ["pihole-FTL", "--config", SETTING, JSON.stringify(changes.lines)]);
    if (!set.ok) ctx.fail("Pi-hole refused its new DNS lines", [{ label: "Response", value: set.output.trim().slice(-300) }]);
    const probe = probeFor(current, changes.lines);
    if (probe && !(await waitForAnswer(ctx, probe))) ctx.fail("Pi-hole didn't answer after restarting its DNS. Look at its logs on the app's card.");
  }
  writeFileSync(oursPath, JSON.stringify(changes.ours), { mode: 0o600 });
  const count = changes.ours.length / 3;
  await ctx.emitCheckpoint(
    "addresses",
    count > 0 ? `Pi-hole sends ${count} Anywhere ${count === 1 ? "address" : "addresses"} straight to this server` : "This server isn't answering Anywhere addresses on your network yet",
  );
}
