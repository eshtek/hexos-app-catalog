// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import type { ContextMount, HookContext } from "../_lib/hook_context";

/**
 * Nextcloud's apps and their settings can only be changed from inside it, with its occ command, and
 * HexOS has no way to run a command in an app. Nextcloud's image runs every executable *.sh in
 * /docker-entrypoint-hooks.d/before-starting at each start, as www-data, so HexOS mounts a folder of
 * its own there and keeps one script in it. A link writes what it wants into hexos/<name>.wanted and
 * restarts Nextcloud. The script applies it and records that it did.
 *
 * The image stops the container when one of these scripts fails, and TrueNAS gives up on a start
 * that isn't healthy in about 90 seconds. So the script always exits 0, does its work in the
 * background, and time-limits every occ call. What it couldn't do is tried again at the next start. A wanted file is
 * applied once and kept beside it as <name>.applied, which also tells a link it took: occ's own
 * checks passed, as richdocuments:activate-config's reach Collabora and back. A setting the owner
 * changes later stays changed until a link asks for something new. With no wanted files the script does nothing, so a Nextcloud
 * with no links starts exactly as it did.
 */

const WWW_DATA = 33;
const SCRIPT = "hexos-start.sh";
const STATE_DIR = "hexos";
/** Where Nextcloud's image looks for the scripts, and where HexOS mounts its folder. */
export const START_FOLDER = "/docker-entrypoint-hooks.d/before-starting";

export const START_SCRIPT = `#!/bin/sh
# Written by HexOS. Runs at each Nextcloud start. It must never stop Nextcloud from starting.
dir=${START_FOLDER}/${STATE_DIR}
[ -d "$dir" ] || exit 0

# TrueNAS gives the container about 90 seconds to turn healthy, and the app store can take longer,
# so the work runs beside the start and this script returns at once.
if [ "$1" != "--work" ]; then
  setsid nohup /bin/sh "$0" --work >/dev/null 2>&1 &
  exit 0
fi

occ_try() { timeout 180 php /var/www/html/occ "$@"; }
value_of() { sed -n "s/^$2=//p" "$1" | head -n 1; }
app_on() { occ_try app:enable "$1"; }

apply_collabora() {
  url=$(value_of "$1" url)
  [ -n "$url" ] || return 1
  app_on richdocuments &&
    occ_try config:app:set richdocuments wopi_url --value="$url" &&
    occ_try config:app:set richdocuments public_wopi_url --value="$url" &&
    occ_try richdocuments:activate-config
}

apply_drawio() {
  url=$(value_of "$1" url)
  [ -n "$url" ] || return 1
  app_on drawio && occ_try config:app:set drawio DrawioUrl --value="$url"
}

apply_paperless() {
  url=$(value_of "$1" url)
  [ -n "$url" ] || return 1
  app_on integration_paperless && occ_try config:app:set integration_paperless default_url --value="$url"
}

apply_ollama() {
  url=$(value_of "$1" url)
  [ -n "$url" ] || return 1
  app_on integration_openai && app_on assistant &&
    occ_try config:app:set integration_openai url --value="$url"
}

# One of Nextcloud's list settings, a value a line, and nothing when it isn't set.
list_of() { occ_try config:system:get "$1" 2>/dev/null; }

# Writes a list setting over the one there, index by index, so it is never empty on the way.
write_list() {
  key=$1
  old=$(list_of "$key" | grep -c .)
  shift
  i=0
  for value in "$@"; do
    occ_try config:system:set "$key" "$i" --value="$value" >/dev/null || return 1
    i=$((i + 1))
  done
  while [ "$i" -lt "$old" ]; do
    occ_try config:system:delete "$key" "$i" >/dev/null || return 1
    i=$((i + 1))
  done
}

# Where a request from the server itself arrives from: this container's default gateway.
gateway_of() {
  php -r 'foreach (file("/proc/net/route") as $l) { $f = preg_split("/\\s+/", trim($l)); if (($f[1] ?? "") === "00000000") { echo long2ip(unpack("V", hex2bin($f[2]))[1]); break; } }'
}

# Nextcloud answers only at the addresses it trusts, and believes only a proxy it trusts about the
# address and scheme a visitor used. names= holds the app's Anywhere names. The names and the proxy
# added last time are taken out first, so a name that is gone stops being trusted.
apply_anywhere() (
  set -f
  names=$(value_of "$1" names)
  before=$(value_of "$dir/anywhere.applied" names 2>/dev/null)
  domains=$(list_of trusted_domains)
  [ -n "$domains" ] || exit 1
  set --
  for domain in $domains; do
    case " $before " in *" $domain "*) ;; *) set -- "$@" "$domain" ;; esac
  done
  for name in $names; do
    case " $* " in *" $name "*) ;; *) set -- "$@" "$name" ;; esac
  done
  write_list trusted_domains "$@" || exit 1

  gateway=$(gateway_of)
  added=$(cat "$dir/anywhere.proxy" 2>/dev/null)
  set --
  for proxy in $(list_of trusted_proxies); do
    [ "$proxy" = "$added" ] || set -- "$@" "$proxy"
  done
  rm -f "$dir/anywhere.proxy"
  if [ -n "$names" ] && [ -n "$gateway" ]; then
    case " $* " in
      *" $gateway "*) ;;
      *)
        set -- "$@" "$gateway"
        printf '%s\\n' "$gateway" >"$dir/anywhere.proxy"
        ;;
    esac
  fi
  write_list trusted_proxies "$@"
)

{
  for file in "$dir"/*.wanted; do
    [ -f "$file" ] || continue
    name=$(basename "$file" .wanted)
    cmp -s "$file" "$dir/$name.applied" && continue
    echo "$(date -u +%FT%TZ) applying $name"
    case "$name" in
      collabora) apply_collabora "$file" ;;
      drawio) apply_drawio "$file" ;;
      paperless) apply_paperless "$file" ;;
      ollama) apply_ollama "$file" ;;
      anywhere) apply_anywhere "$file" ;;
      *) false ;;
    esac
    if [ $? -eq 0 ]; then
      cp "$file" "$dir/$name.applied"
      echo "$(date -u +%FT%TZ) applied $name"
    else
      echo "$(date -u +%FT%TZ) failed $name"
    fi
  done
  tail -n 200 "$dir/start.log" >"$dir/start.log.next" 2>/dev/null && mv "$dir/start.log.next" "$dir/start.log"
} >>"$dir/start.log" 2>&1
exit 0
`;

export function startMount(mounts: ContextMount[]): ContextMount | undefined {
  return mounts.find((m) => m.containerPath === START_FOLDER);
}

function own(path: string) {
  chownSync(path, WWW_DATA, WWW_DATA);
}

/**
 * Put the script in place: a new one under another name and renamed, so a start never reads half.
 * The image runs these scripts as www-data, and a folder it can't enter stops the container, so the
 * script's `start_mount` has HexOS give the folder to www-data before Nextcloud starts on it.
 */
export function writeStartScript(mount: ContextMount) {
  const state = `${mount.localPath}/${STATE_DIR}`;
  if (!existsSync(state)) mkdirSync(state, { recursive: true, mode: 0o750 });
  own(state);
  const path = `${mount.localPath}/${SCRIPT}`;
  let current: string | undefined;
  try {
    current = readFileSync(path, "utf-8");
  } catch {}
  if (current === START_SCRIPT) return;
  writeFileSync(`${path}.next`, START_SCRIPT, { mode: 0o755 });
  own(`${path}.next`);
  chmodSync(`${path}.next`, 0o755);
  renameSync(`${path}.next`, path);
}

/** Before the first start: the script goes in with an empty list of what's wanted. */
export async function seed(ctx: HookContext) {
  await ctx.registerCheckpoints([{ id: "script", message: "Preparing Nextcloud's start-up folder" }]);
  const mount = startMount(ctx.mounts);
  if (!mount) {
    await ctx.skipCheckpoint("script", "This Nextcloud has no start-up folder");
    return;
  }
  writeStartScript(mount);
  await ctx.emitCheckpoint("script");
}

// --- once it's up ------------------------------------------------------------

/**
 * Waits out Nextcloud's first start, which installs its database and takes minutes, so what comes
 * next in a run finds it ready. For a Nextcloud that predates its start-up folder, or lost its
 * script, this also puts the script back.
 */
export async function configure(ctx: HookContext) {
  await ctx.registerCheckpoints([{ id: "ready", message: "Waiting for Nextcloud to finish starting" }]);
  const mount = startMount(ctx.mounts);
  if (mount) {
    // A box that can't reach this folder still waits for Nextcloud, and a link says what's missing
    try {
      writeStartScript(mount);
    } catch {}
  }
  for (let attempt = 0; attempt < 170; attempt++) {
    if (await nextcloudUp(ctx)) {
      await ctx.emitCheckpoint("ready");
      return;
    }
    await ctx.sleep(5_000);
  }
  ctx.fail("Nextcloud didn't finish starting. Try again once it's running.");
}

// --- links -------------------------------------------------------------------

const readText = (path: string) => {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
};

/** Whether Nextcloud is up and out of maintenance, by its own status page. */
async function nextcloudUp(ctx: HookContext): Promise<boolean> {
  const response = await fetch(`${ctx.baseUrl}/status.php`, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  if (!response?.ok) {
    await response?.body?.cancel();
    return false;
  }
  const status = (await response.json().catch(() => undefined)) as { installed?: boolean; maintenance?: boolean } | undefined;
  return status?.installed === true && status.maintenance === false;
}

interface Link {
  appId: string;
  name: string;
  file: string;
}

async function connect(ctx: HookContext, link: Link) {
  await ctx.registerCheckpoints([
    { id: "locate", message: `Finding ${link.name}` },
    { id: "restart", message: "Restarting Nextcloud to connect it" },
    { id: "confirm", message: `Checking Nextcloud connected to ${link.name}` },
  ]);

  const mount = startMount(ctx.mounts);
  if (!mount) ctx.fail(`This Nextcloud can't connect to ${link.name} yet. Update its setup from the app's page, then try again.`);
  const url = await ctx.getInstalledAppUrl(link.appId);
  if (!url) ctx.fail(`${link.name} isn't installed, or HexOS can't find its port`);
  await ctx.emitCheckpoint("locate");

  await apply(ctx, mount, {
    file: link.file,
    wanted: `url=${url}\n`,
    already: `Nextcloud already uses this ${link.name}`,
    unfinished: `Nextcloud didn't finish connecting to ${link.name}. It tries again each time it starts.`,
  });
}

interface Wanted {
  file: string;
  wanted: string;
  /** Said when Nextcloud already has it, and no restart is needed. */
  already: string;
  /** Said when Nextcloud restarted and didn't take it. */
  unfinished: string;
}

/** Writes what a link wants, restarts Nextcloud so its script applies it, and waits until it has. */
async function apply(ctx: HookContext, mount: ContextMount, { file, wanted, already, unfinished }: Wanted) {
  writeStartScript(mount);
  const state = `${mount.localPath}/${STATE_DIR}`;
  const applied = () => readText(`${state}/${file}.applied`) === wanted;
  writeFileSync(`${state}/${file}.wanted`, wanted, { mode: 0o640 });
  own(`${state}/${file}.wanted`);

  if (applied()) {
    await ctx.skipCheckpoint("restart", already);
  } else {
    if (typeof ctx.restartApp !== "function") ctx.fail("This server's HexOS needs an update before it can change Nextcloud's settings. Try again after it updates.");
    await ctx.restartApp();
    await ctx.emitCheckpoint("restart");
    let done = false;
    for (let attempt = 0; attempt < 90 && !done; attempt++) {
      await ctx.sleep(5_000);
      done = applied() && (await nextcloudUp(ctx));
    }
    if (!done) {
      const log = (readText(`${state}/start.log`) ?? "").trim().split("\n").slice(-4).join(" ").slice(0, 400);
      ctx.fail(unfinished, log ? [{ label: "Reason", value: log }] : []);
    }
  }
  await ctx.emitCheckpoint("confirm");
}

export const collabora = (ctx: HookContext) => connect(ctx, { appId: "collabora", name: "Collabora", file: "collabora" });
export const drawio = (ctx: HookContext) => connect(ctx, { appId: "drawio", name: "Draw.io", file: "drawio" });
export const paperless = (ctx: HookContext) => connect(ctx, { appId: "paperless-ngx", name: "Paperless", file: "paperless" });
export const ollama = (ctx: HookContext) => connect(ctx, { appId: "ollama", name: "Ollama", file: "ollama" });

// --- its Anywhere address ------------------------------------------------------

/** A name that is safe in the wanted file, which the start script reads word by word. */
const HOSTNAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;

/**
 * Lets Nextcloud open at its Anywhere addresses, which it otherwise refuses as an untrusted domain.
 * HexOS runs this again whenever the app's addresses change, and with none left the names come back
 * out. Nextcloud is restarted only when the list differs from the one it has.
 */
export async function anywhere(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "names", message: "Reading this app's Anywhere addresses" },
    { id: "restart", message: "Restarting Nextcloud to use them" },
    { id: "confirm", message: "Checking Nextcloud took the change" },
  ]);
  const read = await ctx.readRemoteAddresses?.();
  if (!read) ctx.fail("This server's HexOS needs an update before Nextcloud can open at an Anywhere address. Try again after it updates.");
  const mount = startMount(ctx.mounts);
  if (!mount) ctx.fail("This Nextcloud can't be told its Anywhere address yet. Update its setup from the app's page, then try again.");
  const names = read.names.filter((name) => HOSTNAME.test(name)).sort();
  await ctx.emitCheckpoint("names");

  // A Nextcloud that never had an address has nothing to take back out
  if (names.length === 0 && readText(`${mount.localPath}/${STATE_DIR}/anywhere.applied`) === undefined) {
    await ctx.skipCheckpoint("restart", "This app has no Anywhere address");
    await ctx.skipCheckpoint("confirm");
    return;
  }
  await apply(ctx, mount, {
    file: "anywhere",
    wanted: `names=${names.join(" ")}\n`,
    already: "Nextcloud already uses these addresses",
    unfinished: "Nextcloud didn't take its Anywhere address. It tries again each time it starts.",
  });
}
