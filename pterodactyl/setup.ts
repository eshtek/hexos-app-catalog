// Sibling files are type imports only: each script is compiled standalone, so runtime imports of them wouldn't resolve.
import { existsSync, statfsSync, writeFileSync } from "node:fs";
import { totalmem } from "node:os";

import type { ContextMount, HookContext } from "../_lib/hook_context";

// Pterodactyl comes in two apps. Pterodactyl Panel is the website, from TrueNAS's catalog; Pterodactyl
// Wings runs the game servers, each as a container of its own beside it on the box's Docker.
//
// createAdmin: the panel makes its first account only from its own console, so once it's up this
// runs `p:user:make` in its container with the owner's sign-in.
// joinPanel: before Wings first starts, adds this server to the panel as a node with a block of game
// ports, and writes Wings' config.yml from the panel's own copy, pointed at the folders and
// network Wings has here. Wings never starts without it.
// sftpPort: once Wings is placed, tells the panel the port its file transfers ended up on.
//
// Everything in the panel goes through its console (`php artisan`) in its container, over the Docker
// socket the HexOS container has for its host commands. A value from the owner reaches PHP only as
// base64, so no quote in it can end the string it's in.

const DOCKER_SOCKET = "/var/run/docker.sock";
const PANEL = "pterodactyl-panel";
const PANEL_SERVICE = "pterodactyl";
/** The panel's files belong to nginx, so its console runs as nginx too and leaves them that way. */
const PANEL_USER = "nginx";
const NODE_NAME = "HexOS";
const LOCATION_SHORT = "home";
/** The game ports Wings hands its servers. Fixed: HexOS's port planner doesn't know them yet. */
export const GAME_PORTS = "27100-27119";
/** Where Wings listens inside its container; the script publishes them on the ports HexOS picks. */
const WINGS_API_PORT = 8080;
const WINGS_SFTP_PORT = 2022;
const WINGS_NETWORK = "pterodactyl_nw";
/** A first start migrates the panel's database, which takes a minute or two on a slow pool. */
const PANEL_READY_MS = 5 * 60_000;
const EXEC_TIMEOUT_MS = 60_000;
const MARKER = "HEXOS:";

type Exec = { ok: boolean; output: string };

const docker = (path: string, body?: unknown, timeoutMs = EXEC_TIMEOUT_MS) =>
  fetch(`http://docker${path}`, {
    unix: DOCKER_SOCKET,
    signal: AbortSignal.timeout(timeoutMs),
    ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });

/** The container of a compose service, by project, as TrueNAS names them (ix-<app>); running only, unless `any`. */
async function containerOf(app: string, service: string, any = false): Promise<string | null> {
  const filters = encodeURIComponent(
    JSON.stringify({
      label: [`com.docker.compose.project=ix-${app}`, `com.docker.compose.service=${service}`],
      ...(any ? {} : { status: ["running"] }),
    }),
  );
  try {
    const response = await docker(`/containers/json?all=${any}&filters=${filters}`);
    if (!response.ok) return null;
    const listed = (await response.json()) as Array<{ Id: string }>;
    return listed[0]?.Id ?? null;
  } catch {
    return null;
  }
}

async function exec(container: string, cmd: string[]): Promise<Exec> {
  try {
    const created = await docker(`/containers/${container}/exec`, {
      Cmd: cmd,
      User: PANEL_USER,
      WorkingDir: "/app",
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    });
    if (!created.ok) return { ok: false, output: await created.text() };
    const { Id } = (await created.json()) as { Id: string };
    const output = (await (await docker(`/exec/${Id}/start`, { Detach: false, Tty: true })).text()).replaceAll("\r", "");
    const { ExitCode } = (await (await docker(`/exec/${Id}/json`)).json()) as { ExitCode: number };
    return { ok: ExitCode === 0, output };
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}

const php = (value: string) => `base64_decode('${Buffer.from(value).toString("base64")}')`;

/** Runs PHP in the panel and reads back the one value it prints after the marker. */
async function tinker<T>(container: string, code: string): Promise<T | null> {
  const { ok, output } = await exec(container, ["php", "artisan", "tinker", `--execute=${code}`]);
  if (!ok) return null;
  const line = output.split("\n").find((l) => l.startsWith(MARKER));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(MARKER.length)) as T;
  } catch {
    return null;
  }
}

const echo = (expression: string) => `echo '${MARKER}'.json_encode(${expression});`;

/** The last lines of a console run, for a failure the owner can report. Never holds a password. */
const tail = (output: string) => output.trim().split("\n").slice(-3).join(" ").slice(0, 300);

/** The panel's container once its database answers, or a failure naming what to do. */
async function readyPanel(ctx: HookContext): Promise<string> {
  if (!(await containerOf(PANEL, PANEL_SERVICE, true))) ctx.fail("Install Pterodactyl Panel first, then install Pterodactyl Wings.");
  const deadline = Date.now() + PANEL_READY_MS;
  let container: string | null = null;
  while (Date.now() < deadline) {
    container = await containerOf(PANEL, PANEL_SERVICE);
    if (container && (await tinker<number>(container, echo("\\Pterodactyl\\Models\\User::count()"))) !== null) return container;
    await ctx.sleep(5000);
  }
  if (!container) ctx.fail("Pterodactyl Panel isn't running. Start it, then try again.");
  ctx.fail("Pterodactyl Panel didn't finish starting in time. Try again once its page opens.");
}

/** The owner's sign-in for this install, else asked for. */
async function signInFor(ctx: HookContext): Promise<{ username: string; password: string; email: string }> {
  let { username, password, email } = ctx.signIn ?? {};
  if (!username || !password) {
    const answers = await ctx
      .askForInputs(
        [
          { type: "question", id: "username", question: { question: "Username", type: "text", key: "username", required: true } },
          { type: "question", id: "email", question: { question: "Email", type: "text", key: "email", required: true } },
          {
            type: "question",
            id: "password",
            question: { question: "Password (at least 8 characters)", type: "password", key: "password", required: true },
          },
        ],
        { title: "Your Pterodactyl account", description: "You sign in to Pterodactyl Panel with these." },
      )
      .catch(() => null);
    if (!answers) ctx.fail("Pterodactyl Panel needs an account to sign in with. Install it again to choose one.");
    username = String(answers.username);
    password = String(answers.password);
    email = String(answers.email);
  }
  return { username, password, email: email || `${username}@hexos.local` };
}

export async function createAdmin(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "ready", message: "Starting Pterodactyl Panel" },
    { id: "admin", message: "Creating your account" },
  ]);
  const panel = await readyPanel(ctx);
  await ctx.emitCheckpoint("ready", "Pterodactyl Panel is up", 50);

  const { username, password, email } = await signInFor(ctx);
  const existing = await tinker<string | null>(
    panel,
    echo(`\\Pterodactyl\\Models\\User::where('username', ${php(username)})->orWhere('email', ${php(email)})->value('username')`),
  );
  if (existing) {
    await ctx.skipCheckpoint("admin", `Pterodactyl Panel keeps its account ${existing}`);
    return;
  }

  const made = await exec(panel, [
    "php",
    "artisan",
    "p:user:make",
    `--email=${email}`,
    `--username=${username}`,
    `--name-first=${username}`,
    "--name-last=Admin",
    `--password=${password}`,
    "--admin=1",
    "--no-interaction",
  ]);
  if (!made.ok) ctx.fail(`Pterodactyl Panel couldn't create your account: ${tail(made.output)}`);
  await ctx.emitCheckpoint("admin", `Signed in as ${username}`, 100);
}

const mountAt = (ctx: HookContext, containerPath: string): ContextMount | undefined =>
  ctx.mounts.find((m) => m.containerPath === containerPath);

/** Wings' own folder, mounted at its host path because Wings hands that path to Docker for each server. */
const dataMount = (ctx: HookContext): ContextMount | undefined =>
  ctx.mounts.find((m) => m.containerPath === m.hostPath && /\/pterodactyl-wings\/data$/.test(m.hostPath));

type Subnet = { subnet: string; gateway: string };

const ipToInt = (ip: string) => ip.split(".").reduce((n, octet) => (n << 8) + Number(octet), 0) >>> 0;

function overlaps(a: string, b: string): boolean {
  const [aBase, aBits] = a.split("/");
  const [bBase, bBits] = b.split("/");
  const bits = Math.min(Number(aBits), Number(bBits));
  if (!aBase?.includes(".") || !bBase?.includes(".") || Number.isNaN(bits)) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipToInt(aBase) & mask) === (ipToInt(bBase) & mask);
}

/**
 * The network Wings puts its game servers on: the one it already has, else a /24 at the top of
 * Docker's 172.16.0.0/12 that no network and not the box's own address uses. TrueNAS hands its apps
 * /24s from the bottom of that range, so the top stays clear.
 */
async function wingsSubnet(ctx: HookContext): Promise<Subnet> {
  const response = await docker("/networks");
  if (!response.ok) ctx.fail("HexOS couldn't read this server's Docker networks.");
  const networks = (await response.json()) as Array<{ Name: string; IPAM?: { Config?: Array<{ Subnet?: string; Gateway?: string }> } }>;
  const own = networks.find((n) => n.Name === WINGS_NETWORK)?.IPAM?.Config?.find((c) => c.Subnet?.includes("."));
  if (own?.Subnet && own.Gateway) return { subnet: own.Subnet, gateway: own.Gateway };

  const taken = networks.flatMap((n) => (n.IPAM?.Config ?? []).map((c) => c.Subnet).filter((s): s is string => !!s?.includes(".")));
  if (ctx.host) taken.push(`${ctx.host}/32`);
  for (let third = 254; third >= 0; third--) {
    const subnet = `172.31.${third}.0/24`;
    if (!taken.some((t) => overlaps(t, subnet))) return { subnet, gateway: `172.31.${third}.1` };
  }
  ctx.fail("HexOS couldn't find a free network for Pterodactyl's game servers.");
}

type NodeConfig = {
  api?: Record<string, unknown>;
  system?: Record<string, unknown>;
  docker?: Record<string, unknown>;
  [key: string]: unknown;
};

export async function joinPanel(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "panel", message: "Reaching Pterodactyl Panel" },
    { id: "node", message: "Adding this server to Pterodactyl Panel" },
    { id: "config", message: "Setting up Wings" },
  ]);
  const config = mountAt(ctx, "/etc/pterodactyl");
  const data = dataMount(ctx);
  if (!config || !data) ctx.fail("HexOS couldn't find Pterodactyl Wings' folders.");
  const configFile = `${config.localPath}/config.yml`;
  if (existsSync(configFile)) {
    for (const id of ["panel", "node", "config"]) await ctx.skipCheckpoint(id, "Wings keeps its settings from before");
    return;
  }
  if (!ctx.host || !ctx.port) ctx.fail("HexOS couldn't read this server's address.");

  const panel = await readyPanel(ctx);
  await ctx.emitCheckpoint("panel", "Pterodactyl Panel is up", 20);

  // A run that stopped partway left its location or node behind: carry on with them.
  let locationId = await tinker<number | null>(panel, echo(`\\Pterodactyl\\Models\\Location::where('short', '${LOCATION_SHORT}')->value('id')`));
  if (!locationId) {
    const made = await exec(panel, ["php", "artisan", "p:location:make", `--short=${LOCATION_SHORT}`, "--long=This server", "--no-interaction"]);
    locationId = await tinker<number | null>(panel, echo(`\\Pterodactyl\\Models\\Location::where('short', '${LOCATION_SHORT}')->value('id')`));
    if (!locationId) ctx.fail(`Pterodactyl Panel couldn't add a location: ${tail(made.output)}`);
  }

  const volumes = `${data.hostPath}/volumes`;
  let nodeId = await tinker<number | null>(panel, echo(`\\Pterodactyl\\Models\\Node::where('name', '${NODE_NAME}')->value('id')`));
  if (!nodeId) {
    const memoryMb = Math.floor(totalmem() / 1024 / 1024);
    let diskMb = 50_000;
    try {
      const fs = statfsSync(data.localPath);
      diskMb = Math.floor((fs.bavail * fs.bsize) / 1024 / 1024);
    } catch {
      // Overallocation is unlimited below, so this only sets what the panel shows.
    }
    const made = await exec(panel, [
      "php",
      "artisan",
      "p:node:make",
      `--name=${NODE_NAME}`,
      "--description=This server",
      `--locationId=${locationId}`,
      `--fqdn=${ctx.host}`,
      "--public=1",
      "--scheme=http",
      "--proxy=0",
      "--maintenance=0",
      `--maxMemory=${memoryMb}`,
      "--overallocateMemory=-1",
      `--maxDisk=${diskMb}`,
      "--overallocateDisk=-1",
      "--uploadSize=100",
      `--daemonListeningPort=${ctx.port}`,
      `--daemonSFTPPort=${WINGS_SFTP_PORT}`,
      `--daemonBase=${volumes}`,
      "--no-interaction",
    ]);
    nodeId = await tinker<number | null>(panel, echo(`\\Pterodactyl\\Models\\Node::where('name', '${NODE_NAME}')->value('id')`));
    if (!nodeId) ctx.fail(`Pterodactyl Panel couldn't add this server: ${tail(made.output)}`);
  }

  const allocations = await tinker<number>(
    panel,
    [
      `$n = \\Pterodactyl\\Models\\Node::find(${nodeId});`,
      `if ($n->allocations()->count() === 0) { app(\\Pterodactyl\\Services\\Allocations\\AssignmentService::class)->handle($n, ['allocation_ip' => '0.0.0.0', 'allocation_alias' => ${php(ctx.host)}, 'allocation_ports' => ['${GAME_PORTS}']]); }`,
      echo("$n->allocations()->count()"),
    ].join(" "),
  );
  if (!allocations) ctx.fail("Pterodactyl Panel couldn't add the game ports.");
  await ctx.emitCheckpoint("node", `Added this server with ${allocations} game ports`, 60);

  const exported = await exec(panel, ["php", "artisan", "p:node:configuration", String(nodeId), "--format=json"]);
  const json = exported.output.slice(exported.output.indexOf("{"), exported.output.lastIndexOf("}") + 1);
  let node: NodeConfig;
  try {
    node = JSON.parse(json) as NodeConfig;
  } catch {
    ctx.fail(`Pterodactyl Panel didn't give Wings its settings: ${tail(exported.output)}`);
  }
  if (typeof node.token !== "string" || typeof node.remote !== "string") ctx.fail("Pterodactyl Panel gave Wings incomplete settings.");

  const { subnet, gateway } = await wingsSubnet(ctx);
  // Every folder Wings hands to Docker sits in its data folder, at the path the host has it at.
  node.api = { ...node.api, host: "0.0.0.0", port: WINGS_API_PORT };
  node.system = {
    ...node.system,
    root_directory: data.hostPath,
    log_directory: `${data.hostPath}/logs`,
    data: volumes,
    archive_directory: `${data.hostPath}/archives`,
    backup_directory: `${data.hostPath}/backups`,
    tmp_directory: `${data.hostPath}/tmp`,
    sftp: { bind_port: WINGS_SFTP_PORT },
    machine_id: { enabled: true, directory: `${data.hostPath}/machine-id` },
  };
  node.docker = {
    ...node.docker,
    network: {
      interface: gateway,
      name: WINGS_NETWORK,
      network_mode: WINGS_NETWORK,
      interfaces: { v4: { subnet, gateway } },
    },
  };
  // YAML reads JSON as it is; Wings writes the file back as YAML once it starts.
  writeFileSync(configFile, `${JSON.stringify(node, null, 2)}\n`, { mode: 0o600 });
  await ctx.emitCheckpoint("config", "Wings is set up", 100);
}

export async function sftpPort(ctx: HookContext) {
  await ctx.registerCheckpoints([{ id: "sftp", message: "Setting the file transfer port" }]);
  const values = ctx.getAppValues ? await ctx.getAppValues().catch(() => null) : null;
  const ports = (values?.ports ?? []) as Array<{ container_port?: number; port_number?: number }>;
  const sftp = ports.find((p) => Number(p.container_port) === WINGS_SFTP_PORT)?.port_number;
  if (!sftp) {
    await ctx.skipCheckpoint("sftp", "HexOS couldn't read the port Wings was given");
    return;
  }
  const panel = await readyPanel(ctx);
  const saved = await tinker<number>(
    panel,
    [
      `\\Pterodactyl\\Models\\Node::where('name', '${NODE_NAME}')->update(['daemonSFTP' => ${Number(sftp)}${ctx.port ? `, 'daemonListen' => ${Number(ctx.port)}` : ""}]);`,
      echo(`\\Pterodactyl\\Models\\Node::where('name', '${NODE_NAME}')->value('daemonSFTP')`),
    ].join(" "),
  );
  if (saved !== Number(sftp)) ctx.fail("Pterodactyl Panel didn't take the file transfer port.");
  await ctx.emitCheckpoint("sftp", `File transfers use port ${sftp}`, 100);
}
