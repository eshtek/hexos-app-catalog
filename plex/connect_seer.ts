import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { HookContext } from "../_lib/hook_context";

const MOUNT_ROOT = "/host/mnt";
const PREFS_RELATIVE = "Applications/plex/config/Library/Application Support/Plex Media Server/Preferences.xml";

async function findPlexToken(): Promise<{ token: string; machineId?: string }> {
  const pools = readdirSync(MOUNT_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const pool of pools) {
    const prefsPath = `${MOUNT_ROOT}/${pool}/${PREFS_RELATIVE}`;
    let xml: string;
    try {
      xml = await readFile(prefsPath, "utf-8");
    } catch {
      continue;
    }
    const token = xml.match(/PlexOnlineToken="([^"]+)"/)?.[1];
    const machineId = xml.match(/ProcessedMachineIdentifier="([^"]+)"/)?.[1];
    if (token) return { token, machineId };
  }
  throw new Error(
    "Could not read the Plex server token from Preferences.xml — is Plex set up and claimed on this server?",
  );
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0] ?? "";
}

export async function run(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "locate", message: "Locating Seer" },
    { id: "token", message: "Reading Plex credentials" },
    { id: "auth", message: "Signing in to Seer with Plex" },
    { id: "configure", message: "Connecting the Plex server" },
    { id: "verify", message: "Verifying the connection" },
  ]);

  const seerUrl = await ctx.getInstalledAppUrl("seerr");
  if (!seerUrl) throw new Error("Seer is not installed or has no reachable port");
  await ctx.emitCheckpoint("locate");

  const { token } = await findPlexToken();
  await ctx.emitCheckpoint("token");

  const authResponse = await fetch(`${seerUrl}/api/v1/auth/plex`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authToken: token }),
  });
  if (!authResponse.ok) {
    throw new Error(`Seer rejected the Plex sign-in (${authResponse.status}): ${await authResponse.text()}`);
  }
  const cookie = cookieFrom(authResponse);
  await ctx.emitCheckpoint("auth");

  if (!ctx.host || !ctx.port) throw new Error("Missing Plex host/port in action context");
  const configureResponse = await fetch(`${seerUrl}/api/v1/settings/plex`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ ip: ctx.host, port: ctx.port, useSsl: false }),
  });
  if (!configureResponse.ok) {
    throw new Error(`Failed to configure Plex in Seer (${configureResponse.status}): ${await configureResponse.text()}`);
  }
  await ctx.emitCheckpoint("configure");

  await fetch(`${seerUrl}/api/v1/settings/initialize`, {
    method: "POST",
    headers: { Cookie: cookie },
  }).catch(() => {});

  const verifyResponse = await fetch(`${seerUrl}/api/v1/settings/plex`, { headers: { Cookie: cookie } });
  if (!verifyResponse.ok) throw new Error(`Could not verify Seer's Plex settings (${verifyResponse.status})`);
  const settings = (await verifyResponse.json()) as { ip?: string; machineId?: string };
  if (settings.ip !== ctx.host) {
    throw new Error(`Seer reports Plex at "${settings.ip}", expected "${ctx.host}"`);
  }
  await ctx.emitCheckpoint("verify");
}
