// Sibling files are type imports only: each script is compiled standalone, so runtime imports of them wouldn't resolve.
import { existsSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { totalmem } from "node:os";

import type { ContextMount, HookContext } from "../_lib/hook_context";

// Pelican comes in two apps: Pelican Panel, the website, and Pelican Wings, which runs the game
// servers, each as a container of its own beside it on the box's Docker.
//
// setUpPanel: Pelican sets itself up from a web installer. This does what the installer does,
// with its defaults (SQLite, file cache and sessions), from the panel's console in its container:
// runs the migrations, makes the owner's administrator, adds a starter set of games from Pelican's
// egg index, and marks the panel installed. The entrypoint reads that mark only at start, so the
// panel restarts last.
// joinPanel: before Wings first starts, adds this server to the panel as a node with a block of
// game ports, and writes Wings' config.yml from the panel's own copy, pointed at the folders Wings
// has here. Wings never starts without it. Its game network gets a subnet Docker picks.
// sftpPort: once Wings is placed, tells the panel the port its file transfers ended up on.
//
// Everything in the panel goes through its console (`php artisan`) over the Docker socket the HexOS
// container has for its host commands. A value from the owner reaches PHP only as base64, so no
// quote in it can end the string it's in.

const DOCKER_SOCKET = "/var/run/docker.sock";
const PANEL = "pelican-panel";
/** The panel's files belong to www-data, so its console runs as www-data and leaves them that way. */
const PANEL_USER = "www-data";
const PANEL_DIR = "/var/www/html";
const NODE_NAME = "HexOS";
/** The game ports Wings hands its servers, clear of Pterodactyl Wings' 27100 to 27119. */
const GAME_PORTS = "27200-27219";
/** Where Wings listens inside its container; the script publishes them on the ports HexOS picks. */
const WINGS_API_PORT = 8080;
const WINGS_SFTP_PORT = 2022;
/** The installer's choice made for the owner: the games most asked for, by their names in Pelican's egg index. */
const STARTER_EGGS: Record<string, string[]> = {
  Minecraft: ["Paper", "Vanilla Minecraft", "Vanilla Bedrock", "Fabric", "Forge Minecraft"],
  "Games Steamcmd": [
    "Valheim",
    "Satisfactory",
    "Palworld",
    "Project Zomboid",
    "Ark: Survival Evolved",
    "Rust",
    "Counter-Strike 2",
    "Garrys Mod",
    "7 Days To Die",
    "Enshrouded",
    "V Rising",
    "Don't Starve Together",
    "Core Keeper",
  ],
  "Games Standalone": ["Terraria Vanilla", "tModloader", "Factorio"],
};
/** A first start can take a minute or two before the console answers. */
const PANEL_READY_MS = 5 * 60_000;
const EXEC_TIMEOUT_MS = 120_000;
const MARKER = "HEXOS:";

type Exec = { ok: boolean; output: string };

const docker = (path: string, body?: unknown, timeoutMs = EXEC_TIMEOUT_MS) =>
  fetch(`http://docker${path}`, {
    unix: DOCKER_SOCKET,
    signal: AbortSignal.timeout(timeoutMs),
    ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });

/** The container of a custom app, by compose project (ix-<app>); running only, unless `any`. */
async function containerOf(app: string, any = false): Promise<string | null> {
  const filters = encodeURIComponent(
    JSON.stringify({ label: [`com.docker.compose.project=ix-${app}`], ...(any ? {} : { status: ["running"] }) }),
  );
  try {
    const response = await docker(`/containers/json?all=${any}&filters=${filters}`);
    if (!response.ok) return null;
    return ((await response.json()) as Array<{ Id: string }>)[0]?.Id ?? null;
  } catch {
    return null;
  }
}

async function exec(container: string, cmd: string[]): Promise<Exec> {
  try {
    const created = await docker(`/containers/${container}/exec`, {
      Cmd: cmd,
      User: PANEL_USER,
      WorkingDir: PANEL_DIR,
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
const echo = (expression: string) => `echo '${MARKER}'.json_encode(${expression});`;

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

/** The last lines of a console run, for a failure the owner can report. Never holds a password. */
const tail = (output: string) => output.trim().split("\n").slice(-3).join(" ").slice(0, 300);

/** The panel's container once its console answers (`ready`), or once it can read its database (`installed`). */
async function readyPanel(ctx: HookContext, app: string, until: "ready" | "installed"): Promise<string> {
  if (!(await containerOf(app, true))) ctx.fail("Install Pelican Panel first, then install Pelican Wings.");
  const deadline = Date.now() + PANEL_READY_MS;
  let container: string | null = null;
  while (Date.now() < deadline) {
    container = await containerOf(app);
    if (container) {
      const answered =
        until === "ready"
          ? (await exec(container, ["php", "artisan", "--version"])).ok
          : (await tinker<number>(container, echo("\\App\\Models\\User::count()"))) !== null;
      if (answered) return container;
    }
    await ctx.sleep(5000);
  }
  if (!container) ctx.fail("Pelican Panel isn't running. Start it, then try again.");
  ctx.fail(
    until === "ready"
      ? "Pelican Panel didn't finish starting in time. Try again once its page opens."
      : "Pelican Panel isn't set up yet. Install it again, or finish its setup, then try again.",
  );
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
        { title: "Your Pelican account", description: "You sign in to Pelican Panel with these." },
      )
      .catch(() => null);
    if (!answers) ctx.fail("Pelican Panel needs an account to sign in with. Install it again to choose one.");
    username = String(answers.username);
    password = String(answers.password);
    email = String(answers.email);
  }
  return { username, password, email: email || `${username}@hexos.local` };
}

const dataMountOf = (ctx: HookContext, pattern: RegExp): ContextMount | undefined =>
  ctx.mounts.find((m) => pattern.test(m.hostPath));

/** Whether the panel's .env already says the installer has run. */
export const installedIn = (env: string): boolean => /^APP_INSTALLED=true\s*$/m.test(env);

export async function setUpPanel(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "ready", message: "Starting Pelican Panel" },
    { id: "database", message: "Setting up its database" },
    { id: "admin", message: "Creating your account" },
    { id: "games", message: "Adding games" },
  ]);
  const data = ctx.mounts.find((m) => m.containerPath === "/pelican-data") ?? dataMountOf(ctx, /\/pelican-panel\/data$/);
  const envFile = data ? `${data.localPath}/.env` : null;
  if (envFile && existsSync(envFile) && installedIn(readFileSync(envFile, "utf8"))) {
    for (const id of ["ready", "database", "admin", "games"]) await ctx.skipCheckpoint(id, "Pelican Panel keeps its setup from before");
    return;
  }

  const panel = await readyPanel(ctx, ctx.resourceId, "ready");
  await ctx.emitCheckpoint("ready", "Pelican Panel is up", 10);

  const migrated = await exec(panel, ["php", "artisan", "migrate", "--force", "--seed", "--no-interaction"]);
  if (!migrated.ok) ctx.fail(`Pelican Panel couldn't set up its database: ${tail(migrated.output)}`);
  await ctx.emitCheckpoint("database", "Database ready", 30);

  const { username, password, email } = await signInFor(ctx);
  const existing = await tinker<string | null>(
    panel,
    echo(`\\App\\Models\\User::where('username', ${php(username)})->orWhere('email', ${php(email)})->value('username')`),
  );
  if (existing) {
    await ctx.skipCheckpoint("admin", `Pelican Panel keeps its account ${existing}`);
  } else {
    const made = await exec(panel, [
      "php",
      "artisan",
      "p:user:make",
      `--email=${email}`,
      `--username=${username}`,
      `--password=${password}`,
      "--admin=1",
      "--no-interaction",
    ]);
    if (!made.ok) ctx.fail(`Pelican Panel couldn't create your account: ${tail(made.output)}`);
    await ctx.emitCheckpoint("admin", `Signed in as ${username}`, 50);
  }

  // The starter games come from Pelican's egg index on GitHub; a game that can't be fetched is left
  // for the owner to add from the panel, and never holds the setup back
  await exec(panel, ["php", "artisan", "p:egg:update-index"]);
  const wanted = Buffer.from(JSON.stringify(STARTER_EGGS)).toString("base64");
  const added = await tinker<{ added: number; failed: number }>(
    panel,
    [
      `$want = json_decode(base64_decode('${wanted}'), true); $index = cache()->get('eggs.index', []); $have = \\App\\Models\\Egg::pluck('name')->all(); $added = 0; $failed = 0;`,
      `foreach ($want as $category => $names) { foreach (($index[$category] ?? []) as $url => $name) { if (!in_array($name, $names) || in_array($name, $have)) continue;`,
      `try { app(\\App\\Services\\Eggs\\Sharing\\EggImporterService::class)->fromUrl($url); $added++; } catch (\\Throwable $e) { $failed++; } } }`,
      echo("['added' => $added, 'failed' => $failed]"),
    ].join(" "),
  );
  if (added) await ctx.emitCheckpoint("games", `Added ${added.added} games`, 80);
  else await ctx.skipCheckpoint("games", "Add games from the panel's Eggs page");

  const marked = await exec(panel, ["sh", "-c", "sed -i 's/^APP_INSTALLED=.*/APP_INSTALLED=true/' /pelican-data/.env && grep -q '^APP_INSTALLED=true' /pelican-data/.env"]);
  if (!marked.ok) ctx.fail(`Pelican Panel couldn't finish its setup: ${tail(marked.output)}`);
  // The entrypoint reads APP_INSTALLED only as the container starts
  if (ctx.restartApp) await ctx.restartApp();
  else await docker(`/containers/${panel}/restart`, {});
}

const mountAt = (ctx: HookContext, containerPath: string): ContextMount | undefined =>
  ctx.mounts.find((m) => m.containerPath === containerPath);

/** Wings' own folder, mounted at its host path because Wings hands that path to Docker for each server. */
const wingsData = (ctx: HookContext): ContextMount | undefined =>
  ctx.mounts.find((m) => m.containerPath === m.hostPath && /\/pelican-wings\/data$/.test(m.hostPath));

type NodeConfig = { [key: string]: unknown; api?: Record<string, unknown>; system?: Record<string, unknown>; docker?: Record<string, unknown> };

export async function joinPanel(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "panel", message: "Reaching Pelican Panel" },
    { id: "node", message: "Adding this server to Pelican Panel" },
    { id: "config", message: "Setting up Wings" },
  ]);
  const config = mountAt(ctx, "/etc/pelican");
  const data = wingsData(ctx);
  if (!config || !data) ctx.fail("HexOS couldn't find Pelican Wings' folders.");
  const configFile = `${config.localPath}/config.yml`;
  if (existsSync(configFile)) {
    for (const id of ["panel", "node", "config"]) await ctx.skipCheckpoint(id, "Wings keeps its settings from before");
    return;
  }
  if (!ctx.host || !ctx.port) ctx.fail("HexOS couldn't read this server's address.");

  const panel = await readyPanel(ctx, PANEL, "installed");
  await ctx.emitCheckpoint("panel", "Pelican Panel is up", 20);

  const volumes = `${data.hostPath}/volumes`;
  const nodeId = async () => tinker<number | null>(panel, echo(`\\App\\Models\\Node::where('name', '${NODE_NAME}')->value('id')`));
  // A run that stopped partway left its node behind: carry on with it
  if (!(await nodeId())) {
    const memoryMb = Math.floor(totalmem() / 1024 / 1024);
    let diskMb = 50_000;
    try {
      const fs = statfsSync(data.localPath);
      diskMb = Math.floor((fs.bavail * fs.bsize) / 1024 / 1024);
    } catch {
      // Overallocation is unlimited below, so this only sets what the panel shows
    }
    const made = await exec(panel, [
      "php",
      "artisan",
      "p:node:make",
      `--name=${NODE_NAME}`,
      "--description=This server",
      `--fqdn=${ctx.host}`,
      "--public=1",
      "--scheme=http",
      "--proxy=0",
      "--maintenance=0",
      `--maxMemory=${memoryMb}`,
      "--overallocateMemory=-1",
      `--maxDisk=${diskMb}`,
      "--overallocateDisk=-1",
      "--maxCpu=0",
      "--overallocateCpu=-1",
      "--uploadSize=256",
      `--daemonListeningPort=${WINGS_API_PORT}`,
      `--daemonConnectingPort=${ctx.port}`,
      `--daemonSFTPPort=${WINGS_SFTP_PORT}`,
      "--daemonSFTPAlias=",
      `--daemonBase=${volumes}`,
      "--no-interaction",
    ]);
    if (!(await nodeId())) ctx.fail(`Pelican Panel couldn't add this server: ${tail(made.output)}`);
  }
  const id = await nodeId();

  const allocations = await tinker<number>(
    panel,
    [
      `$n = \\App\\Models\\Node::find(${id});`,
      `if ($n->allocations()->count() === 0) { app(\\App\\Services\\Allocations\\AssignmentService::class)->handle($n, ['allocation_ip' => '0.0.0.0', 'allocation_alias' => ${php(ctx.host)}, 'allocation_ports' => ['${GAME_PORTS}']]); }`,
      echo("$n->allocations()->count()"),
    ].join(" "),
  );
  if (!allocations) ctx.fail("Pelican Panel couldn't add the game ports.");
  await ctx.emitCheckpoint("node", `Added this server with ${allocations} game ports`, 60);

  const exported = await exec(panel, ["php", "artisan", "p:node:configuration", String(id), "--format=json"]);
  const json = exported.output.slice(exported.output.indexOf("{"), exported.output.lastIndexOf("}") + 1);
  let node: NodeConfig;
  try {
    node = JSON.parse(json) as NodeConfig;
  } catch {
    ctx.fail(`Pelican Panel didn't give Wings its settings: ${tail(exported.output)}`);
  }
  if (typeof node.token !== "string" || typeof node.remote !== "string") ctx.fail("Pelican Panel gave Wings incomplete settings.");

  // Every folder Wings hands to Docker for a game server sits in its data folder, at the path the host has it at
  const system = (node.system ?? {}) as Record<string, unknown>;
  node.api = { ...node.api, host: "0.0.0.0", port: WINGS_API_PORT };
  node.system = {
    ...system,
    root_directory: data.hostPath,
    log_directory: `${data.hostPath}/logs`,
    data: volumes,
    archive_directory: `${data.hostPath}/archives`,
    backup_directory: `${data.hostPath}/backups`,
    tmp_directory: `${data.hostPath}/tmp`,
    sftp: { ...((system.sftp as Record<string, unknown>) ?? {}), bind_port: WINGS_SFTP_PORT },
    user: { ...((system.user as Record<string, unknown>) ?? {}), passwd: { enable: true, directory: `${data.hostPath}/passwd` } },
    machine_id: { enable: true, directory: `${data.hostPath}/machine-id` },
  };
  // YAML reads JSON as it is; Wings writes the file back as YAML once it starts
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
  const panel = await readyPanel(ctx, PANEL, "installed");
  // The panel shows players this port for file transfers; Wings itself listens on 2022 in its container
  const saved = await tinker<number>(
    panel,
    [
      `\\App\\Models\\Node::where('name', '${NODE_NAME}')->update(['daemon_sftp' => ${Number(sftp)}${ctx.port ? `, 'daemon_connect' => ${Number(ctx.port)}` : ""}]);`,
      echo(`\\App\\Models\\Node::where('name', '${NODE_NAME}')->value('daemon_sftp')`),
    ].join(" "),
  );
  if (saved !== Number(sftp)) ctx.fail("Pelican Panel didn't take the file transfer port.");
  await ctx.emitCheckpoint("sftp", `File transfers use port ${sftp}`, 100);
}
