import { afterEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextMount, HookContext } from "./hook_context";

// Giving a file to Nextcloud's user needs root, so the ownership is checked on a real install
mock.module("node:fs", () => ({ ...require("node:fs"), chownSync: () => {} }));
const { collabora, eurooffice, onlyoffice, START_FOLDER, writeStartScript } = await import("../nextcloud/startup");

// Nextcloud's links to Euro-Office and ONLYOFFICE, against the real start-up script with a stand-in
// for occ. Their Nextcloud apps are the same with another name, and both share the office's secret,
// which waits beside the wanted file only until occ has applied it.

const realFetch = globalThis.fetch;
const dirs: string[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function respond(answers: Record<string, () => Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = decodeURIComponent(String(input instanceof Request ? input.url : input));
    const match = Object.keys(answers).find((part) => url.includes(part));
    return match ? answers[match]() : new Response("", { status: 503 });
  }) as typeof fetch;
}

function nextcloud() {
  const base = mkdtempSync(join(tmpdir(), "nextcloud-")).replace(/\\/g, "/");
  dirs.push(base);
  const mount: ContextMount = { hostPath: "/mnt/tank/Applications/nextcloud/startup", containerPath: START_FOLDER, localPath: base };
  writeStartScript(mount);
  return { base, mount, state: `${base}/hexos` };
}

/** Runs the real start-up script as Nextcloud's image would, with a stand-in for occ that logs. */
async function start(base: string, occExit = 0): Promise<string[]> {
  const bin = `${base}/bin`;
  mkdirSync(bin, { recursive: true });
  // php -r is the script's wait for Nextcloud's web server, which is up here; sleep returns at once
  writeFileSync(`${bin}/php`, `#!/bin/sh\n[ "$1" = "-r" ] && exit 0\nshift\necho "$*" >> "${base}/occ.log"\nexit ${occExit}\n`);
  chmodSync(`${bin}/php`, 0o755);
  writeFileSync(`${bin}/sleep`, "#!/bin/sh\nexit 0\n");
  chmodSync(`${bin}/sleep`, 0o755);
  writeFileSync(`${base}/run.sh`, readFileSync(`${base}/hexos-start.sh`, "utf-8").replaceAll(START_FOLDER, base));
  const run = Bun.spawn(["sh", `${base}/run.sh`, "--work"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "ignore", stderr: "ignore" });
  await run.exited;
  return occ(base);
}

const occ = (base: string) => (existsSync(`${base}/occ.log`) ? readFileSync(`${base}/occ.log`, "utf-8").trim().split("\n") : []);

function context(mount: ContextMount, base: string, address: string) {
  return {
    baseUrl: "http://10.0.0.5:30027",
    mounts: [mount],
    getInstalledAppUrl: async () => address,
    registerCheckpoints: async () => {},
    emitCheckpoint: async () => {},
    skipCheckpoint: async () => {},
    sleep: async () => {},
    // Stands in for the restart that makes Nextcloud run its start-up script
    restartApp: async () => void (await start(base)),
    fail: (message: string) => {
      throw new Error(message);
    },
  } as unknown as HookContext;
}

const office = () =>
  respond({
    "containers/json": () => Response.json([{ Id: "office" }]),
    "containers/office/json": () => Response.json({ Config: { Env: ["JWT_SECRET=shared-secret"] } }),
    "status.php": () => Response.json({ installed: true, maintenance: false }),
    "/healthcheck": () => new Response("true"),
  });

describe("Nextcloud's links to Euro-Office and ONLYOFFICE", () => {
  test.each([
    ["Euro-Office", eurooffice, "eurooffice", "http://10.0.0.5:30461", "https://10.0.0.5:30461/"],
    ["ONLYOFFICE", onlyoffice, "onlyoffice", "http://10.0.0.5:30136/", "https://10.0.0.5:30136/"],
  ])("%s is set up with occ over https, and its secret doesn't stay on disk", async (_name, link, app, known, documentServer) => {
    const { base, mount, state } = nextcloud();
    office();
    await link(context(mount, base, known));
    const log = occ(base);
    expect(log[0]).toBe(`app:enable ${app}`);
    expect(log).toContain(`config:app:set ${app} verify_peer_off --value=true`);
    expect(log).toContain(`config:app:set ${app} DocumentServerUrl --value=${documentServer}`);
    expect(log).toContain(`config:app:set ${app} StorageUrl --value=http://10.0.0.5:30027/`);
    expect(log).toContain(`config:app:set ${app} jwt_secret --value=shared-secret`);
    expect(log.at(-1)).toBe(`${app}:documentserver --check`);
    expect(existsSync(`${state}/${app}.secret`)).toBe(false);
    expect(readFileSync(`${state}/${app}.applied`, "utf-8")).not.toContain("shared-secret");
  });

  test("the check is tried again while the office can't fetch from Nextcloud yet", async () => {
    const { base, state } = nextcloud();
    writeFileSync(`${state}/eurooffice.wanted`, "url=https://10.0.0.5:30461\nstorage=http://10.0.0.5:30027\nsecret=abc\n");
    writeFileSync(`${state}/eurooffice.secret`, "shared-secret");
    const bin = `${base}/bin`;
    mkdirSync(bin, { recursive: true });
    // The first two checks fail, as when Nextcloud's web server isn't serving yet
    const php = [
      "#!/bin/sh",
      '[ "$1" = "-r" ] && exit 0',
      "shift",
      `echo "$*" >> "${base}/occ.log"`,
      `case "$*" in *--check) n=$(cat "${base}/n" 2>/dev/null || echo 0); echo $((n + 1)) > "${base}/n"; [ "$n" -ge 2 ] ;; esac`,
      "",
    ].join("\n");
    writeFileSync(`${bin}/php`, php);
    chmodSync(`${bin}/php`, 0o755);
    writeFileSync(`${bin}/sleep`, "#!/bin/sh\nexit 0\n");
    chmodSync(`${bin}/sleep`, 0o755);
    writeFileSync(`${base}/run.sh`, readFileSync(`${base}/hexos-start.sh`, "utf-8").replaceAll(START_FOLDER, base));
    await Bun.spawn(["sh", `${base}/run.sh`, "--work"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "ignore", stderr: "ignore" }).exited;
    expect(occ(base).filter((line) => line.endsWith("--check"))).toHaveLength(3);
    expect(existsSync(`${state}/eurooffice.applied`)).toBe(true);
    expect(existsSync(`${state}/eurooffice.secret`)).toBe(false);
  });

  test("when occ fails, the secret waits for the next start and nothing counts as applied", async () => {
    const { base, state } = nextcloud();
    writeFileSync(`${state}/onlyoffice.wanted`, "url=https://10.0.0.5:30136\nstorage=http://10.0.0.5:30027\nsecret=abc\n");
    writeFileSync(`${state}/onlyoffice.secret`, "shared-secret");
    await start(base, 1);
    expect(existsSync(`${state}/onlyoffice.applied`)).toBe(false);
    expect(existsSync(`${state}/onlyoffice.secret`)).toBe(true);
  });

  test("a second start with nothing new runs no occ", async () => {
    const { base, mount } = nextcloud();
    office();
    await eurooffice(context(mount, base, "http://10.0.0.5:30461"));
    const before = occ(base);
    await start(base);
    expect(occ(base)).toEqual(before);
  });

  test("a new secret counts as a new wish, so it's applied again", async () => {
    const { base, mount } = nextcloud();
    office();
    await eurooffice(context(mount, base, "http://10.0.0.5:30461"));
    respond({
      "containers/json": () => Response.json([{ Id: "office" }]),
      "containers/office/json": () => Response.json({ Config: { Env: ["JWT_SECRET=another-secret"] } }),
      "status.php": () => Response.json({ installed: true, maintenance: false }),
      "/healthcheck": () => new Response("true"),
    });
    await eurooffice(context(mount, base, "http://10.0.0.5:30461"));
    expect(occ(base)).toContain("config:app:set eurooffice jwt_secret --value=another-secret");
  });

  test("an office still starting is waited for, and one that never answers stops the link before Nextcloud restarts", async () => {
    const { base, mount } = nextcloud();
    let checks = 0;
    respond({
      "containers/json": () => Response.json([{ Id: "office" }]),
      "containers/office/json": () => Response.json({ Config: { Env: ["JWT_SECRET=shared-secret"] } }),
      "status.php": () => Response.json({ installed: true, maintenance: false }),
      "/healthcheck": () => (++checks < 3 ? new Response("", { status: 502 }) : new Response("true")),
    });
    await eurooffice(context(mount, base, "http://10.0.0.5:30461"));
    expect(checks).toBe(3);
    expect(occ(base).at(-1)).toBe("eurooffice:documentserver --check");

    const other = nextcloud();
    respond({
      "containers/json": () => Response.json([{ Id: "office" }]),
      "containers/office/json": () => Response.json({ Config: { Env: ["JWT_SECRET=shared-secret"] } }),
      "/healthcheck": () => new Response("", { status: 502 }),
    });
    await expect(onlyoffice(context(other.mount, other.base, "http://10.0.0.5:30136"))).rejects.toThrow("ONLYOFFICE hasn't finished starting");
    expect(existsSync(`${other.state}/onlyoffice.wanted`)).toBe(false);
    expect(occ(other.base)).toEqual([]);
  });

  test("with no secret to read, nothing is written and the link says why", async () => {
    const { base, mount, state } = nextcloud();
    respond({ "containers/json": () => Response.json([]) });
    await expect(onlyoffice(context(mount, base, "http://10.0.0.5:30136"))).rejects.toThrow("couldn't read ONLYOFFICE's secret");
    expect(existsSync(`${state}/onlyoffice.wanted`)).toBe(false);
  });
});

describe("Nextcloud's link to Collabora", () => {
  test.each([
    ["on https, as beside OpenCloud, Nextcloud skips the check of the server's own certificate", "https://10.0.0.5:9980", () => new Response(""), "yes"],
    ["on http, as beside Nextcloud alone, the check stays on", "http://10.0.0.5:9980", () => new Response("", { status: 503 }), "no"],
  ])("%s", async (_name, address, discovery, verify) => {
    const { base, mount } = nextcloud();
    respond({ "/hosting/discovery": discovery, "status.php": () => Response.json({ installed: true, maintenance: false }) });
    await collabora(context(mount, base, "http://10.0.0.5:9980"));
    const log = occ(base);
    expect(log).toContain(`config:app:set richdocuments disable_certificate_verification --value=${verify}`);
    expect(log).toContain(`config:app:set richdocuments wopi_url --value=${address}`);
  });
});

describe("the Office suite", () => {
  test("offers all three editors beside either files app, each with a link from it, and starts on Collabora", () => {
    const json = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "..", name), "utf-8"));
    const editors = (json("_collections/office.json").groups as Array<{ id: string; options: Array<{ app: string; requires?: string[]; default?: boolean }> }>).find(
      (group) => group.id === "editor",
    )!.options;
    expect(editors.map((editor) => [editor.app, editor.requires, editor.default ?? false])).toEqual([
      ["collabora", undefined, true],
      ["onlyoffice-document-server", undefined, false],
      ["eurooffice-document-server", undefined, false],
    ]);
    for (const files of ["nextcloud", "opencloud"])
      for (const { app } of editors)
        expect((json(`${files}.json`).hooks as Array<{ kind?: string; conditions?: Array<{ app?: string }> }>).some((hook) => hook.kind === "connect" && hook.conditions?.some((c) => c.app === app))).toBe(true);
  });
});
