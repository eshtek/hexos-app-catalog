// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import type { HookContext } from "../_lib/hook_context";

/**
 * OpenCloud is https only, and a browser blocks an http editor inside an https page. So when OpenCloud
 * is on this server, Collabora serves https on the box's default certificate. Beside Nextcloud alone it
 * stays on http as before. This isn't a link: a link from Collabora to OpenCloud would point back at
 * OpenCloud's link to Collabora. OpenCloud installs first in the Office suite, so it's there by now.
 *
 * With a certificate the TrueNAS chart's nginx listens on the published port and always forwards to
 * 9980, while Collabora listens on the published port, so https only works on 9980. A script update
 * writes the script's own values back, so this also runs after an upgrade. Read at Collabora 26.04.
 *
 * The addresses Collabora allows (aliasgroup1) stay as they are. Collabora can't parse the script's
 * `http://<server>:[0-9]+` as an address and ignores it, so it allows any WOPI host, which lets both
 * Nextcloud and OpenCloud in. Real addresses there would turn that into a list, and a pattern for the
 * port matches nothing: with OpenCloud's address first, Collabora refused Nextcloud.
 */

const DOCKER_SOCKET = "/var/run/docker.sock";
const HTTPS_PORT = 9980;

const insecure = { tls: { rejectUnauthorized: false } } as RequestInit;

type Container = { Ports?: Array<{ PublicPort?: number }> };

/** An app's running containers, by the compose project TrueNAS names after it. */
async function containers(appId: string): Promise<Container[]> {
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=ix-${appId}`] }));
  const response = await fetch(`http://docker/containers/json?filters=${filters}`, { unix: DOCKER_SOCKET, signal: AbortSignal.timeout(10_000) } as RequestInit);
  return (await response.json()) as Container[];
}

/** OpenCloud's published port, or undefined when it isn't here. */
async function openCloudPort(): Promise<number | undefined> {
  return (await containers("opencloud")).flatMap((each) => each.Ports ?? []).find((entry) => entry.PublicPort)?.PublicPort;
}

const HTTPS_PARAMS = ["--o:ssl.termination=true", "--o:ssl.ssl_verification=false"];

/**
 * Collabora's values with https on, on the server's default certificate. Settings already right stay
 * where they are, so a run after LanguageTool's link (which adds its own at the end) changes nothing.
 */
export function withHttps(values: Record<string, unknown>): void {
  const collabora = values.collabora as { extra_params?: string[] };
  const params = (collabora.extra_params ?? []).filter(
    (param) => HTTPS_PARAMS.includes(param) || (!param.startsWith("--o:ssl.termination=") && !param.startsWith("--o:ssl.ssl_verification=")),
  );
  collabora.extra_params = [...params, ...HTTPS_PARAMS.filter((param) => !params.includes(param))];
  (values.network as { certificate_id?: number }).certificate_id = 1;
}

export async function run(ctx: HookContext): Promise<void> {
  await ctx.registerCheckpoints([
    { id: "locate", message: "Looking for OpenCloud" },
    { id: "update", message: "Updating Collabora to serve https" },
    { id: "confirm", message: "Checking Collabora came back" },
  ]);
  const port = await openCloudPort().catch(() => undefined);
  if (!port) {
    await ctx.skipCheckpoint("locate", "OpenCloud isn't on this server, so Collabora stays as it is");
    await ctx.skipCheckpoint("update");
    await ctx.skipCheckpoint("confirm");
    return;
  }
  if (ctx.port !== HTTPS_PORT) {
    const message = `Collabora can only serve https on port ${HTTPS_PORT}, and it's on ${ctx.port}. It stays on http, so OpenCloud can't use it.`;
    if (ctx.skip) ctx.skip(message);
    ctx.fail(message);
  }
  await ctx.emitCheckpoint("locate");

  if (typeof ctx.updateAppValues !== "function") ctx.fail("This server's HexOS needs an update first. Try again after it updates.");
  const changed = await ctx.updateAppValues((values) => withHttps(values));
  if (!changed) {
    await ctx.skipCheckpoint("update", "Collabora already serves https");
    await ctx.skipCheckpoint("confirm");
    return;
  }
  await ctx.emitCheckpoint("update");

  for (let attempt = 0; attempt < 40; attempt++) {
    const up = await fetch(`https://${ctx.host}:${HTTPS_PORT}/hosting/discovery`, { signal: AbortSignal.timeout(15_000), ...insecure }).then(
      (response) => response.ok,
      () => false,
    );
    if (up) {
      // A Nextcloud linked before this still asks over http
      const nextcloud = (await containers("nextcloud").catch(() => [])).length > 0;
      await ctx.emitCheckpoint("confirm", nextcloud ? "If Nextcloud uses Collabora, it needs connecting again. Run Connect to Collabora from Nextcloud's Connections tab." : undefined);
      return;
    }
    await ctx.sleep(5_000);
  }
  ctx.fail("Collabora didn't come back on https. Look at its logs on the app's card.");
}
