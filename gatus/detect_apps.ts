// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { mkdirSync, writeFileSync } from "node:fs";

import type { ContextMount, HookContext } from "../_lib/hook_context";

/**
 * Apps in this catalog worth checking for and monitoring automatically.
 * There's no way to list every installed app, only to probe known ids one at a time
 * (ctx.getInstalledAppUrl), so this list has to be maintained by hand as the catalog grows.
 */
const CANDIDATES: [id: string, name: string][] = [
  ["actual-budget", "Actual Budget"],
  ["adguard-home", "AdGuard Home"],
  ["affine", "AFFiNE"],
  ["anything-llm", "AnythingLLM"],
  ["ark-survival-evolved", "ARK: Survival Evolved"],
  ["audiobookshelf", "Audiobookshelf"],
  ["bazarr", "Bazarr"],
  ["bentopdf", "BentoPDF"],
  ["bindarr", "Bindarr"],
  ["blinko", "Blinko"],
  ["chaptarr", "Chaptarr"],
  ["code-server", "code-server"],
  ["collabora", "Collabora"],
  ["crafty-4", "Crafty 4"],
  ["deluge", "Deluge"],
  ["donetick", "Donetick"],
  ["dozzle", "Dozzle"],
  ["drawio", "Draw.io"],
  ["emby", "Emby"],
  ["eurooffice-document-server", "EuroOffice Document Server"],
  ["excalidraw", "Excalidraw"],
  ["factorio", "Factorio"],
  ["firefly-iii", "Firefly III"],
  ["fladder", "Fladder"],
  ["flaresolverr", "FlareSolverr"],
  ["forgejo", "Forgejo"],
  ["freshrss", "FreshRSS"],
  ["frigate", "Frigate"],
  ["handbrake", "Handbrake"],
  ["hermes-agent", "Hermes"],
  ["home-assistant", "Home Assistant"],
  ["immich", "Immich"],
  ["jellyfin", "Jellyfin"],
  ["jellystat", "Jellystat"],
  ["kavita", "Kavita"],
  ["kodi", "Kodi"],
  ["languagetool", "LanguageTool"],
  ["lidarr", "Lidarr"],
  ["linkwarden", "Linkwarden"],
  ["lubelogger", "LubeLogger"],
  ["maintainerr", "Maintainerr"],
  ["mealie", "Mealie"],
  ["memos", "Memos"],
  ["minecraft", "Minecraft"],
  ["minecraft-bedrock", "Minecraft Bedrock"],
  ["mkvtoolnix", "MKVToolNix"],
  ["n8n", "n8n"],
  ["navidrome", "Navidrome"],
  ["nevu", "Nevu"],
  ["nextcloud", "Nextcloud"],
  ["nginx-proxy-manager", "Nginx Proxy Manager"],
  ["nzbget", "NZBGet"],
  ["ollama", "Ollama"],
  ["onlyoffice-document-server", "ONLYOFFICE Document Server"],
  ["open-webui", "Open WebUI"],
  ["openclaw", "OpenClaw"],
  ["opencloud", "OpenCloud"],
  ["opencode", "opencode"],
  ["pairdrop", "PairDrop"],
  ["palworld", "Palworld Server"],
  ["paperless-ngx", "Paperless-ngx"],
  ["peanut", "Peanut"],
  ["pelican-panel", "Pelican Panel"],
  ["pelican-wings", "Pelican Wings"],
  ["photostructure", "PhotoStructure"],
  ["pihole", "Pi-hole"],
  ["planka", "Planka"],
  ["plex", "Plex"],
  ["portracker", "Portracker"],
  ["profilarr", "Profilarr"],
  ["project-zomboid", "Project Zomboid"],
  ["prowlarr", "Prowlarr"],
  ["pterodactyl-panel", "Pterodactyl Panel"],
  ["pterodactyl-wings", "Pterodactyl Wings"],
  ["qbittorrent", "qBittorrent"],
  ["qui", "qui"],
  ["rackula", "Rackula"],
  ["radarr", "Radarr"],
  ["ratelog", "Ratelog"],
  ["ripping-machine", "Automatic Ripping Machine"],
  ["romm", "RomM"],
  ["rust", "Rust"],
  ["rust-desk", "RustDesk"],
  ["rust-desk-relay", "RustDesk Relay"],
  ["sabnzbd", "SABnzbd"],
  ["satisfactory-server", "Satisfactory Server"],
  ["scrutiny", "Scrutiny"],
  ["scrypted", "Scrypted"],
  ["searxng", "SearXNG"],
  ["seerr", "Seerr"],
  ["snapotter", "SnapOtter"],
  ["sonarr", "Sonarr"],
  ["sparkyfitness", "SparkyFitness"],
  ["sportarr", "Sportarr"],
  ["stardew-valley", "Stardew Valley"],
  ["sure", "Sure"],
  ["swiparr", "Swiparr"],
  ["syncthing", "Syncthing"],
  ["tautulli", "Tautulli"],
  ["terraria", "Terraria"],
  ["terraria-tshock", "Terraria (TShock)"],
  ["the-lounge", "The Lounge"],
  ["tmodloader", "tModLoader"],
  ["trilium-notes", "Trilium Notes"],
  ["unifi-protect-backup", "UniFi Protect Backup"],
  ["uptime-kuma", "Uptime Kuma"],
  ["valheim", "Valheim"],
  ["vaultwarden", "Vaultwarden"],
  ["vikunja", "Vikunja"],
  ["warracker", "Warracker"],
  ["wiki-js", "Wiki.js"],
];

/**
 * These speak a raw protocol over their main port, not HTTP, so an HTTP request against
 * them would misreport a healthy server as down. Checked with a plain TCP connection instead.
 * Left out on purpose: ids whose main service is UDP-based (minecraft-bedrock, valheim,
 * palworld, factorio, rust, ark-survival-evolved, satisfactory-server, project-zomboid) --
 * a TCP connect to a UDP-only port fails even when the server is healthy, and Gatus's own
 * "[CONNECTED] == true" check on a udp:// endpoint only proves the local socket could send,
 * never that anything on the other end is listening, so neither check would be trustworthy.
 */
const TCP_CANDIDATES = new Set(["minecraft", "terraria", "terraria-tshock", "tmodloader", "rust-desk", "rust-desk-relay"]);

function dataMount(mounts: ContextMount[]): ContextMount | undefined {
  return mounts.find((m) => m.containerPath === "/app/data");
}

/** A YAML double-quoted scalar escapes the same way a JSON string does. */
function quote(value: string): string {
  return JSON.stringify(value);
}

/**
 * Written as its own file in Gatus's config.d/ rather than touching the owner's own config,
 * so it never clobbers anything they wrote by hand. Gatus reloads config.d/ live on file
 * change (no restart needed), so this takes effect as soon as it's written.
 */
export async function run(ctx: HookContext) {
  await ctx.registerCheckpoints([{ id: "scan", message: "Looking for other installed apps" }]);

  const data = dataMount(ctx.mounts);
  if (!data) ctx.fail("HexOS couldn't find Gatus's data folder");

  const found: { id: string; name: string; url: string }[] = [];
  for (const [id, name] of CANDIDATES) {
    const url = await ctx.getInstalledAppUrl(id).catch(() => null);
    if (url) found.push({ id, name, url });
  }

  if (found.length === 0) {
    await ctx.skipCheckpoint("scan", "No other apps found yet to monitor");
    return;
  }

  const endpoints = found
    .map((app) => {
      const tcp = TCP_CANDIDATES.has(app.id);
      const url = tcp ? `tcp://${new URL(app.url).host}` : app.url;
      const condition = tcp ? "[CONNECTED] == true" : "[RESPONSE_TIME] < 10000";
      return (
        `  - name: ${quote(app.name)}\n` +
        `    group: ${quote("Detected by HexOS")}\n` +
        `    url: ${quote(url)}\n` +
        `    conditions:\n` +
        `      - ${quote(condition)}\n`
      );
    })
    .join("");

  const yaml =
    '# Written by HexOS\'s "Detect installed apps" hook. Edit or delete this file freely --\n' +
    "# re-running the hook from this app's card overwrites it with what's currently found.\n" +
    "endpoints:\n" +
    endpoints;

  mkdirSync(`${data.localPath}/config.d`, { recursive: true, mode: 0o750 });
  writeFileSync(`${data.localPath}/config.d/hexos-detected.yaml`, yaml, { mode: 0o640 });

  const names = found.map((a) => a.name).join(", ");
  ctx.log(`Added ${found.length} detected app(s) to Gatus: ${names}`);
  await ctx.emitCheckpoint("scan", `Found and added ${found.length} app(s): ${names}`);
}
