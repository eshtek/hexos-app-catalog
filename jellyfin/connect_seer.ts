import type { HookContext } from "../_lib/hook_context";

// Seer's media server binding, from /api/v1/settings/public
const MEDIA_SERVER_PLEX = 1;
const MEDIA_SERVER_JELLYFIN = 2;
const MEDIA_SERVER_EMBY = 3;

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0] ?? "";
}

export async function run(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "locate", message: "Locating Seer" },
    { id: "precheck", message: "Checking Seer's media server" },
    { id: "auth", message: "Signing in to Seer with Jellyfin" },
    { id: "verify", message: "Verifying the connection" },
  ]);

  const seerUrl = await ctx.getInstalledAppUrl("seerr");
  if (!seerUrl) throw new Error("Seer is not installed or has no reachable port");
  if (!ctx.host || !ctx.port) throw new Error("Missing Jellyfin host/port in action context");
  await ctx.emitCheckpoint("locate");

  const publicResponse = await fetch(`${seerUrl}/api/v1/settings/public`);
  if (!publicResponse.ok) throw new Error(`Could not read Seer's settings (${publicResponse.status})`);
  const publicSettings = (await publicResponse.json()) as { initialized?: boolean; mediaServerType?: number };
  if (publicSettings.initialized && publicSettings.mediaServerType === MEDIA_SERVER_PLEX) {
    ctx.fail("Seer is already connected to a Plex server", [
      { label: "Why", value: "Seer supports one media server at a time" },
      { label: "Fix", value: "Reinstall Seer (or reset its settings) to connect it to Jellyfin instead" },
    ]);
  }
  if (publicSettings.initialized && publicSettings.mediaServerType === MEDIA_SERVER_EMBY) {
    ctx.fail("Seer is already connected to an Emby server", [
      { label: "Why", value: "Seer supports one media server at a time" },
      { label: "Fix", value: "Reinstall Seer (or reset its settings) to connect it to Jellyfin instead" },
    ]);
  }
  await ctx.emitCheckpoint("precheck");

  const username = ctx.getInput<string>("jf_username");
  const password = ctx.getInput<string>("jf_password");
  const authResponse = await fetch(`${seerUrl}/api/v1/auth/jellyfin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      password,
      // Seerr wants the bare host here; a scheme-full URL is rejected with 404 INVALID_URL.
      hostname: ctx.host,
      port: ctx.port,
      useSsl: false,
      urlBase: "",
      serverType: MEDIA_SERVER_JELLYFIN,
    }),
  });
  if (authResponse.status === 401) {
    throw new Error("Seer rejected the Jellyfin username or password");
  }
  if (!authResponse.ok) {
    throw new Error(`Seer's Jellyfin sign-in failed (${authResponse.status}): ${await authResponse.text()}`);
  }
  const cookie = cookieFrom(authResponse);
  await ctx.emitCheckpoint("auth");

  await fetch(`${seerUrl}/api/v1/settings/initialize`, {
    method: "POST",
    headers: { Cookie: cookie },
  }).catch(() => {});

  const verifyResponse = await fetch(`${seerUrl}/api/v1/settings/public`);
  if (!verifyResponse.ok) throw new Error(`Could not verify Seer's settings (${verifyResponse.status})`);
  const verified = (await verifyResponse.json()) as { mediaServerType?: number };
  if (verified.mediaServerType !== MEDIA_SERVER_JELLYFIN) {
    throw new Error(`Seer reports media server type ${verified.mediaServerType}, expected Jellyfin`);
  }
  await ctx.emitCheckpoint("verify");
}
