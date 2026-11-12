import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Each download client keeps its downloads in a folder of the Downloads location, and HexOS makes a
// missing folder a dataset of its own. A manager mounts the whole location, and a dataset mounted
// after the manager started never shows inside it (rprivate), so a client installed later would be
// an empty folder to the manager. Every manager makes each client's folder itself, before it starts,
// as it does qBittorrent's.

const ROOT = join(import.meta.dir, "..");
const scripts = readdirSync(ROOT)
  .filter((file) => file.endsWith(".json"))
  .map((file) => ({ id: file.slice(0, -".json".length), script: JSON.parse(readFileSync(join(ROOT, file), "utf-8")) }));

const DOWNLOAD_LINKS = ["servarr/connect_download_client.ts", "sportarr/connect_download_client.ts"];
const WHOLE = /\$(?:MOUNTED_)?HOST_PATH\(\$LOCATION\(Downloads\)\s*(?:,|\))/;

const ensured = (script: { ensure_directories_exists?: Array<string | { path: string }> }) =>
  (script.ensure_directories_exists ?? []).map((entry) => (typeof entry === "string" ? entry : entry.path));

/** The download clients a manager links, by the app each link names. */
const linkedClients = (script: { hooks?: Array<{ script?: string; conditions?: Array<{ app?: string }> }> }) =>
  (script.hooks ?? [])
    .filter((hook) => hook.script && DOWNLOAD_LINKS.includes(hook.script))
    .flatMap((hook) => (hook.conditions ?? []).map((condition) => condition.app))
    .filter((app): app is string => !!app && scripts.some((each) => each.id === app && ensured(each.script).includes(`$LOCATION(Downloads)/${app}`)));

const managers = scripts.filter(({ script }) => WHOLE.test(JSON.stringify(script.app_values ?? {})) && linkedClients(script).length > 0);

test("the managers that mount the whole Downloads location are found", () => {
  expect(managers.map(({ id }) => id).sort()).toEqual(["chaptarr", "lidarr", "radarr", "sonarr", "sportarr"]);
});

for (const { id, script } of managers) {
  test(`${id} makes the folder of every download client it links before it starts`, () => {
    const clients = [...new Set(linkedClients(script))].sort();
    expect(clients).toEqual(["deluge", "nzbget", "qbittorrent", "sabnzbd"]);
    for (const client of clients) expect(ensured(script)).toContain(`$LOCATION(Downloads)/${client}`);
  });
}
