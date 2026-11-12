// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { chmodSync, chownSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import type { ContextMount, HookContext } from "../_lib/hook_context";

/**
 * Links OpenCloud to a web office on this server. OpenCloud takes the link only from its chart's
 * values, so the link puts it there and updates the app, as Collabora's link to LanguageTool does. A
 * script update writes the script's own values back, which running this again puts right.
 *
 * The office and OpenCloud must share the office's secret, and a hook can only read its own app's
 * values, so this reads it from the office's container over the Docker socket HexOS already has
 * (as jellyfin/hardware_transcoding.ts does). The secret is never written to a file of its own.
 *
 * Collabora has no secret: it allows the addresses in its aliasgroup1 instead, which its own
 * use-https hook sets when it sees OpenCloud (collabora/use_https.ts). Its certificate is served by
 * the chart's nginx container rather than Collabora's own.
 *
 * Both apps serve https, since a browser won't show an http editor inside an https page. OpenCloud
 * makes a certificate of its own and the office serves the box's, and the editor opens in a frame,
 * where a browser offers no warning to accept. So the link gives OpenCloud the office's certificate:
 * the one warning the owner accepts for OpenCloud then covers the editor (Chrome, Edge, Brave and
 * Safari remember it for the address, Firefox for each port). OpenCloud reads its certificate from
 * proxy/server.crt and server.key in its data folder at its start, and its own stay beside them as
 * .hexos-bak. An OpenCloud at an outside address has a certificate of its owner's, which is left.
 * Read at OpenCloud 9.0, Euro-Office 9.3, ONLYOFFICE 10.0 and Collabora 26.04 (TrueNAS chart 1.5.44).
 */

const DOCKER_SOCKET = "/var/run/docker.sock";
const NOTE_ENV = "HEXOS_TEXT_EDITOR_NEW_FILES";

const insecure = { tls: { rejectUnauthorized: false } } as RequestInit;
const docker = (path: string) => fetch(`http://docker${path}`, { unix: DOCKER_SOCKET, signal: AbortSignal.timeout(10_000) } as RequestInit);

type Env = { name: string; value: string };
type OpenCloudValues = { collaboration?: Record<string, unknown>; additional_envs?: Env[] };

const APPS_UID = 568;

/** An office OpenCloud can use. `service` is the chart's container that serves its certificate. */
interface Office {
  appId: string;
  service: string;
  type: string;
  name: string;
  /** Whether OpenCloud and the office share the office's JWT_SECRET. */
  secret: boolean;
  /** Where that container keeps the certificate, when its settings don't say. */
  cert: string;
  key: string;
}

/** The office's running container and its settings. The service name is the chart's. */
async function officeContainer(appId: string, service: string): Promise<{ id: string; env: Map<string, string> } | undefined> {
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=ix-${appId}`, `com.docker.compose.service=${service}`] }));
  const found = (await (await docker(`/containers/json?filters=${filters}`)).json()) as Array<{ Id: string }>;
  if (!found[0]) return undefined;
  const { Config } = (await (await docker(`/containers/${found[0].Id}/json`)).json()) as { Config?: { Env?: string[] } };
  const env = new Map((Config?.Env ?? []).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const));
  return { id: found[0].Id, env };
}

/** The file in a tar from Docker's archive endpoint: a 512-byte header, then its bytes. */
export function untar(tar: Uint8Array): string {
  const text = new TextDecoder();
  for (let at = 0; tar[at]; ) {
    const size = Number.parseInt(text.decode(tar.subarray(at + 124, at + 136)), 8);
    const type = tar[at + 156];
    if (type === 0 || type === 48) return text.decode(tar.subarray(at + 512, at + 512 + size)); // a regular file
    at += 512 + Math.ceil(size / 512) * 512; // a pax header ahead of the file
  }
  return "";
}

async function readFromContainer(id: string, path: string): Promise<string> {
  const response = await docker(`/containers/${id}/archive?path=${encodeURIComponent(path)}`);
  return response.ok ? untar(new Uint8Array(await response.arrayBuffer())) : "";
}

/** The certificate and key the office serves, or undefined when they can't be read as PEM. */
async function officeCertificate(office: { id: string; env: Map<string, string> }, paths: Office): Promise<{ cert: string; key: string } | undefined> {
  const [cert, key] = await Promise.all([
    readFromContainer(office.id, office.env.get("SSL_CERTIFICATE_PATH") || paths.cert),
    readFromContainer(office.id, office.env.get("SSL_KEY_PATH") || paths.key),
  ]).catch(() => ["", ""]);
  return cert.includes("BEGIN CERTIFICATE") && /BEGIN [A-Z ]*PRIVATE KEY/.test(key) ? { cert, key } : undefined;
}

const read = (path: string) => {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
};

/**
 * Puts the certificate where OpenCloud reads its own, and says whether anything changed. OpenCloud's
 * first pair is copied beside it once, and each file is replaced in one step.
 */
export function shareCertificate(data: ContextMount, shared: { cert: string; key: string }): boolean {
  const folder = `${data.localPath}/proxy`;
  const files = [
    { path: `${folder}/server.crt`, text: shared.cert, mode: 0o644 },
    { path: `${folder}/server.key`, text: shared.key, mode: 0o600 },
  ];
  if (files.every((file) => read(file.path) === file.text)) return false;
  mkdirSync(folder, { recursive: true });
  chownSync(folder, APPS_UID, APPS_UID);
  for (const file of files) {
    if (existsSync(file.path) && !existsSync(`${file.path}.hexos-bak`)) copyFileSync(file.path, `${file.path}.hexos-bak`);
    const temporary = `${file.path}.hexos-tmp`;
    writeFileSync(temporary, file.text, { mode: file.mode });
    chmodSync(temporary, file.mode);
    chownSync(temporary, APPS_UID, APPS_UID);
    renameSync(temporary, file.path);
  }
  return true;
}

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(15_000), ...insecure })).ok;
  } catch {
    return false;
  }
}

/** True for an address with a name, set up for use outside the home, which the link must not replace. */
export function isOutsideAddress(address: unknown): boolean {
  if (typeof address !== "string" || !URL.canParse(address)) return false;
  return !/^[\d.]+$/.test(new URL(address).hostname);
}

async function connect(ctx: HookContext, link: Office): Promise<void> {
  const { appId, service, type, name } = link;
  await ctx.registerCheckpoints([
    { id: "locate", message: `Finding ${name}` },
    { id: "certificate", message: `Giving OpenCloud ${name}'s certificate` },
    { id: "update", message: "Updating OpenCloud to connect it" },
    { id: "confirm", message: "Checking OpenCloud came back" },
  ]);
  const stop = (message: string): never => {
    if (ctx.skip) ctx.skip(message);
    return ctx.fail(message);
  };

  const address = await ctx.getInstalledAppUrl(appId);
  if (!address) stop(`${name} isn't installed, or HexOS can't find its port`);
  const url = address!.replace(/^http:/, "https:").replace(/\/+$/, "");
  if (!(await answers(`${url}/hosting/discovery`))) {
    // Collabora serves https only once it has seen OpenCloud, which a Collabora from before OpenCloud hasn't
    if (!link.secret) stop(`${name} isn't answering on https. Run Serve over https from ${name}'s card, then connect again.`);
    ctx.fail(`${name} isn't answering at ${url} yet. Try again when it has finished starting.`);
  }
  const office = await officeContainer(appId, service).catch(() => undefined);
  const secret = link.secret ? office?.env.get("JWT_SECRET") : undefined;
  if (link.secret && (!office || !secret)) stop(`HexOS couldn't read ${name}'s secret from its container`);
  await ctx.emitCheckpoint("locate");

  if (typeof ctx.updateAppValues !== "function") ctx.fail("This server's HexOS needs an update before it can connect OpenCloud. Try again after it updates.");
  const current = ((await ctx.getAppValues?.())?.opencloud ?? {}) as OpenCloudValues & { app_url?: unknown };
  const data = ctx.mounts.find((m) => m.containerPath === "/var/lib/opencloud") ?? ctx.mounts.find((m) => m.hostPath.replace(/\/+$/, "").endsWith("/opencloud/data"));
  let shared = false;
  if (isOutsideAddress(current.app_url) || isOutsideAddress(current.collaboration?.url)) {
    await ctx.skipCheckpoint("certificate", "OpenCloud has an outside address, so it keeps its own certificate");
  } else {
    const certificate = office ? await officeCertificate(office, link) : undefined;
    if (!certificate || !data) {
      // The link still works. The owner opens the office's address once to accept its certificate
      await ctx.skipCheckpoint("certificate", `HexOS couldn't read ${name}'s certificate. Open ${url} once and accept its warning.`);
    } else {
      try {
        shared = shareCertificate(data, certificate);
      } catch (error) {
        ctx.fail("HexOS couldn't save the certificate in OpenCloud's folder. Run this again.", [
          { label: "Reason", value: error instanceof Error ? error.message : String(error) },
        ]);
      }
      if (shared) await ctx.emitCheckpoint("certificate");
      else await ctx.skipCheckpoint("certificate", `OpenCloud already has ${name}'s certificate`);
    }
  }
  const changed = await ctx.updateAppValues((values) => {
    const opencloud = values.opencloud as OpenCloudValues;
    const stored = opencloud.collaboration?.url;
    const outside = isOutsideAddress(stored);
    // The chart stores the address with a trailing slash. The same address isn't a change, or every run would restart OpenCloud
    const address = typeof stored === "string" && stored.replace(/\/+$/, "") === url ? stored : url;
    opencloud.collaboration = { ...opencloud.collaboration, enabled: true, proof_disable: true, type, ...(secret ? { jwt_secret: secret } : {}), ...(outside ? {} : { url: address, insecure: true }) };
    // With an office linked, documents belong there: this hides the Text Editor's Note (see seed_settings.ts)
    opencloud.additional_envs = [...(opencloud.additional_envs ?? []).filter((env) => env.name !== NOTE_ENV), { name: NOTE_ENV, value: "md" }];
  });
  if (!changed && !shared) {
    await ctx.skipCheckpoint("update", `OpenCloud already uses this ${name}`);
    await ctx.skipCheckpoint("confirm");
    return;
  }
  if (changed) {
    await ctx.emitCheckpoint("update");
  } else {
    // The settings were right already, so nothing restarted OpenCloud to read its new certificate
    if (typeof ctx.restartApp !== "function") ctx.fail("This server's HexOS needs an update before OpenCloud can take the certificate. Try again after it updates.");
    await ctx.restartApp();
    await ctx.skipCheckpoint("update", `OpenCloud already uses this ${name}`);
  }

  const openCloud = `https://${ctx.host}:${ctx.port}`;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await answers(`${openCloud}/.well-known/openid-configuration`)) {
      await ctx.emitCheckpoint("confirm");
      return;
    }
    await ctx.sleep(5_000);
  }
  ctx.fail("OpenCloud didn't come back after connecting. Look at its logs on the app's card.");
}

const OFFICE_CERT = { cert: "/certs/tls.crt", key: "/certs/tls.key" };
export const collabora = (ctx: HookContext) =>
  connect(ctx, { appId: "collabora", service: "nginx", type: "collabora", name: "Collabora", secret: false, cert: "/etc/certs/server.crt", key: "/etc/certs/server.key" });
export const eurooffice = (ctx: HookContext) =>
  connect(ctx, { appId: "eurooffice-document-server", service: "eurooffice", type: "eurooffice", name: "Euro-Office", secret: true, ...OFFICE_CERT });
export const onlyoffice = (ctx: HookContext) =>
  connect(ctx, { appId: "onlyoffice-document-server", service: "onlyoffice", type: "onlyoffice", name: "ONLYOFFICE", secret: true, ...OFFICE_CERT });
