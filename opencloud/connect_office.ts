// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import type { HookContext } from "../_lib/hook_context";

/**
 * Links OpenCloud to a web office on this server. OpenCloud takes the link only from its chart's
 * values, so the link puts it there and updates the app, as Collabora's link to LanguageTool does. A
 * script update writes the script's own values back, which running this again puts right.
 *
 * The office and OpenCloud must share the office's secret, and a hook can only read its own app's
 * values, so this reads it from the office's container over the Docker socket HexOS already has
 * (as jellyfin/hardware_transcoding.ts does). The secret is never written to a file of its own.
 *
 * Both apps serve https on the box's default certificate. A browser won't show an http editor inside
 * an https page. Read at OpenCloud 9.0 and Euro-Office 9.3.
 */

const DOCKER_SOCKET = "/var/run/docker.sock";
const NOTE_ENV = "HEXOS_TEXT_EDITOR_NEW_FILES";

const insecure = { tls: { rejectUnauthorized: false } } as RequestInit;
const docker = (path: string) => fetch(`http://docker${path}`, { unix: DOCKER_SOCKET, signal: AbortSignal.timeout(10_000) } as RequestInit);

type Env = { name: string; value: string };
type OpenCloudValues = { collaboration?: Record<string, unknown>; additional_envs?: Env[] };

/** The office's JWT_SECRET, from its running container. The service name is the chart's. */
async function officeSecret(appId: string, service: string): Promise<string | undefined> {
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=ix-${appId}`, `com.docker.compose.service=${service}`] }));
  const found = (await (await docker(`/containers/json?filters=${filters}`)).json()) as Array<{ Id: string }>;
  if (!found[0]) return undefined;
  const { Config } = (await (await docker(`/containers/${found[0].Id}/json`)).json()) as { Config?: { Env?: string[] } };
  return Config?.Env?.find((line) => line.startsWith("JWT_SECRET="))?.slice("JWT_SECRET=".length);
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

async function connect(ctx: HookContext, appId: string, service: string, type: string, name: string): Promise<void> {
  await ctx.registerCheckpoints([
    { id: "locate", message: `Finding ${name}` },
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
  if (!(await answers(`${url}/hosting/discovery`))) ctx.fail(`${name} isn't answering at ${url} yet. Try again when it has finished starting.`);
  const secret = await officeSecret(appId, service).catch(() => undefined);
  if (!secret) stop(`HexOS couldn't read ${name}'s secret from its container`);
  await ctx.emitCheckpoint("locate");

  if (typeof ctx.updateAppValues !== "function") ctx.fail("This server's HexOS needs an update before it can connect OpenCloud. Try again after it updates.");
  const changed = await ctx.updateAppValues((values) => {
    const opencloud = values.opencloud as OpenCloudValues;
    const outside = isOutsideAddress(opencloud.collaboration?.url);
    opencloud.collaboration = { ...opencloud.collaboration, enabled: true, proof_disable: true, type, jwt_secret: secret, ...(outside ? {} : { url, insecure: true }) };
    // With an office linked, documents belong there: this hides the Text Editor's Note (see seed_settings.ts)
    opencloud.additional_envs = [...(opencloud.additional_envs ?? []).filter((env) => env.name !== NOTE_ENV), { name: NOTE_ENV, value: "md" }];
  });
  if (!changed) {
    await ctx.skipCheckpoint("update", `OpenCloud already uses this ${name}`);
    await ctx.skipCheckpoint("confirm");
    return;
  }
  await ctx.emitCheckpoint("update");

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

export const eurooffice = (ctx: HookContext) => connect(ctx, "eurooffice-document-server", "eurooffice", "eurooffice", "Euro-Office");
