import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { START_FOLDER, START_SCRIPT } from "../nextcloud/startup";
import nextcloud from "../nextcloud.json";

// Nextcloud refused its Anywhere address as an untrusted domain. These run the real start-up script
// against a stand-in for occ that keeps each list setting as files, one a value, named by index.

let root: string;
let folder: string;
let state: string;
let config: string;
let script: string;

const OCC = `#!/bin/sh
# php -r '...' asks for the gateway; php /var/www/html/occ <command> ... is occ.
if [ "$1" = "-r" ]; then printf '%s' "$FAKE_GATEWAY"; exit 0; fi
shift
command=$1
key=$2
echo "$command $key" >>"$FAKE_CONFIG/../calls"
case "$command" in
  config:system:get)
    ls "$FAKE_CONFIG/$key".* >/dev/null 2>&1 || exit 1
    for file in $(ls "$FAKE_CONFIG" | grep "^$key\\\\." | sort -t. -k2 -n); do cat "$FAKE_CONFIG/$file"; echo; done
    ;;
  config:system:set)
    [ "$FAKE_FAIL_SET" = "all" ] && exit 1
    [ "$FAKE_FAIL_SET" = "$key" ] && exit 1
    # Another script rewrote the list after it was read: the write is taken and then gone
    [ "$FAKE_LOSE_SET" = "$key" ] && exit 0
    printf '%s' "\${4#--value=}" >"$FAKE_CONFIG/$key.$3"
    ;;
  config:system:delete) rm -f "$FAKE_CONFIG/$key.$3" ;;
  *) exit 1 ;;
esac
`;

function list(key: string): string[] {
  return readdirSync(config)
    .filter((file) => file.startsWith(`${key}.`))
    .sort((a, b) => Number(a.split(".")[1]) - Number(b.split(".")[1]))
    .map((file) => readFileSync(join(config, file), "utf-8"));
}

function seed(key: string, values: string[]) {
  values.forEach((value, index) => writeFileSync(join(config, `${key}.${index}`), value));
}

function start(names: string | null, env: Record<string, string> = {}) {
  if (names !== null) writeFileSync(join(state, "anywhere.wanted"), `names=${names}\n`);
  const run = Bun.spawnSync(["/bin/sh", script, "--work"], {
    // A folder with a file a wildcard entry would match, as a shell that expanded it would find
    cwd: folder,
    env: {
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      FAKE_CONFIG: config,
      FAKE_GATEWAY: "172.16.5.1",
      ...env,
    },
  });
  expect(run.exitCode).toBe(0);
}

const applied = () => (existsSync(join(state, "anywhere.applied")) ? readFileSync(join(state, "anywhere.applied"), "utf-8") : undefined);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nextcloud-anywhere-"));
  folder = join(root, "before-starting");
  state = join(folder, "hexos");
  config = join(root, "config");
  for (const dir of [state, config, join(root, "bin")]) mkdirSync(dir, { recursive: true });
  script = join(folder, "hexos-start.sh");
  writeFileSync(script, START_SCRIPT.replaceAll(START_FOLDER, folder));
  writeFileSync(join(root, "bin", "php"), OCC);
  writeFileSync(join(root, "bin", "timeout"), '#!/bin/sh\nshift\nexec "$@"\n');
  // The web server: refuses FAKE_STARTING times, then answers
  writeFileSync(
    join(root, "bin", "curl"),
    '#!/bin/sh\necho curl >>"$FAKE_CONFIG/../calls"\nn=$(grep -c curl "$FAKE_CONFIG/../calls")\n[ "$n" -gt "${FAKE_STARTING:-0}" ]\n',
  );
  writeFileSync(join(root, "bin", "sleep"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(root, "bin", "curl"), 0o755);
  chmodSync(join(root, "bin", "sleep"), 0o755);
  chmodSync(join(root, "bin", "php"), 0o755);
  chmodSync(join(root, "bin", "timeout"), 0o755);
  seed("trusted_domains", ["127.0.0.1", "localhost", "nextcloud", "192.168.1.20"]);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("an Anywhere name is trusted beside the addresses Nextcloud already had, and the server's own proxy is believed", () => {
  start("nextcloud.k7q2m9.example.com");
  expect(list("trusted_domains")).toEqual(["127.0.0.1", "localhost", "nextcloud", "192.168.1.20", "nextcloud.k7q2m9.example.com"]);
  expect(list("trusted_proxies")).toEqual(["172.16.5.1"]);
  expect(applied()).toBe("names=nextcloud.k7q2m9.example.com\n");
});

test("a second start with the same names changes nothing", () => {
  start("nextcloud.k7q2m9.example.com");
  writeFileSync(join(config, "marker"), "");
  start(null, { FAKE_FAIL_SET: "all" });
  expect(list("trusted_domains")).toHaveLength(5);
  expect(applied()).toBe("names=nextcloud.k7q2m9.example.com\n");
});

test("a renamed address replaces the old name, and an owner's own entries stay", () => {
  seed("trusted_proxies", ["10.0.0.9"]);
  start("nextcloud.k7q2m9.example.com cloud.owner.example");
  start("files.k7q2m9.example.com");
  expect(list("trusted_domains")).toEqual(["127.0.0.1", "localhost", "nextcloud", "192.168.1.20", "files.k7q2m9.example.com"]);
  expect(list("trusted_proxies")).toEqual(["10.0.0.9", "172.16.5.1"]);
});

test("with the address turned off, its name and the proxy HexOS added come back out", () => {
  seed("trusted_proxies", ["10.0.0.9"]);
  start("nextcloud.k7q2m9.example.com");
  start("");
  expect(list("trusted_domains")).toEqual(["127.0.0.1", "localhost", "nextcloud", "192.168.1.20"]);
  expect(list("trusted_proxies")).toEqual(["10.0.0.9"]);
  expect(existsSync(join(state, "anywhere.proxy"))).toBe(false);
});

test("a proxy the owner already trusted is never taken out as if HexOS had added it", () => {
  seed("trusted_proxies", ["172.16.5.1"]);
  start("nextcloud.k7q2m9.example.com");
  start("");
  expect(list("trusted_proxies")).toEqual(["172.16.5.1"]);
});

test("a wildcard the owner trusts is kept as written", () => {
  writeFileSync(join(folder, "nas.home.example"), "");
  seed("trusted_domains", ["localhost", "*.home.example"]);
  rmSync(join(config, "trusted_domains.2"));
  rmSync(join(config, "trusted_domains.3"));
  start("nextcloud.k7q2m9.example.com");
  expect(list("trusted_domains")).toEqual(["localhost", "*.home.example", "nextcloud.k7q2m9.example.com"]);
});

test("a change occ refuses is not recorded as applied, so the next start tries again", () => {
  // The proxy list still writes, so only the refused domains keep this from counting as applied
  start("nextcloud.k7q2m9.example.com", { FAKE_FAIL_SET: "trusted_domains" });
  expect(applied()).toBeUndefined();
  start(null);
  expect(applied()).toBe("names=nextcloud.k7q2m9.example.com\n");
  expect(list("trusted_domains")).toContain("nextcloud.k7q2m9.example.com");
});

// On a real install the name was applied and then gone: TrueNAS's start-up script rewrote the list
test("nothing is changed until Nextcloud's web server answers, when its other start-up scripts are done", () => {
  start("nextcloud.k7q2m9.example.com", { FAKE_STARTING: "3" });
  const calls = readFileSync(join(root, "calls"), "utf-8").trim().split("\n");
  const firstChange = calls.findIndex((call) => call.startsWith("config:system:"));
  expect(calls.slice(0, firstChange)).toEqual(["curl", "curl", "curl", "curl"]);
  expect(list("trusted_domains")).toContain("nextcloud.k7q2m9.example.com");
});

test("a Nextcloud that never finishes starting is left as it was, for the next start", () => {
  start("nextcloud.k7q2m9.example.com", { FAKE_STARTING: "100000" });
  expect(list("trusted_domains")).toEqual(["127.0.0.1", "localhost", "nextcloud", "192.168.1.20"]);
  expect(applied()).toBeUndefined();
});

test("a name that didn't stay in the list is not recorded as applied", () => {
  start("nextcloud.k7q2m9.example.com", { FAKE_LOSE_SET: "trusted_domains" });
  expect(applied()).toBeUndefined();
});

test("a Nextcloud whose trusted domains can't be read is left alone", () => {
  for (const file of readdirSync(config)) rmSync(join(config, file));
  start("nextcloud.k7q2m9.example.com");
  expect(list("trusted_domains")).toEqual([]);
  expect(applied()).toBeUndefined();
});

test("the address step is a hook of its own, so a server from before the trigger keeps Nextcloud's other steps", () => {
  const hooks = nextcloud.hooks as Array<{ id: string; rerunsOn?: string[]; rerun?: string; entrypoint: string }>;
  const following = hooks.filter((hook) => hook.rerunsOn?.includes("remote-address"));
  expect(following.map((hook) => hook.id)).toEqual(["anywhere-address"]);
  expect(following[0]).toMatchObject({ rerun: "converge", entrypoint: "anywhere" });
});
