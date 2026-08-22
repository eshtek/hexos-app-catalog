import type { HookContext } from "../_lib/hook_context";

const JELLYFIN_AUTH_HEADER = 'MediaBrowser Client="HexOS", Device="HexOS", DeviceId="hexos-app-actions", Version="1.0"';
const API_KEY_APP_NAME = "Jellystat";

async function jellyfinSignIn(baseUrl: string, username: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/Users/AuthenticateByName`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Jellyfin 10.8+ reads Authorization; older builds read X-Emby-Authorization
      Authorization: JELLYFIN_AUTH_HEADER,
      "X-Emby-Authorization": JELLYFIN_AUTH_HEADER,
    },
    body: JSON.stringify({ Username: username, Pw: password }),
  });
  if (response.status === 401) {
    throw new Error("Jellyfin rejected the username or password");
  }
  if (!response.ok) {
    throw new Error(`Jellyfin sign-in failed (${response.status}): ${await response.text()}`);
  }
  const result = (await response.json()) as {
    AccessToken?: string;
    User?: { Policy?: { IsAdministrator?: boolean } };
  };
  if (!result.AccessToken) throw new Error("Jellyfin sign-in returned no access token");
  if (!result.User?.Policy?.IsAdministrator) {
    throw new Error("That Jellyfin account is not an administrator — an admin account is required to create an API key");
  }
  return result.AccessToken;
}

async function ensureApiKey(baseUrl: string, accessToken: string): Promise<string> {
  const headers = { "X-Emby-Token": accessToken };
  const findKey = async (): Promise<string | undefined> => {
    const response = await fetch(`${baseUrl}/Auth/Keys`, { headers });
    if (!response.ok) throw new Error(`Could not list Jellyfin API keys (${response.status})`);
    const keys = (await response.json()) as { Items?: Array<{ AppName?: string; AccessToken?: string }> };
    return keys.Items?.find((item) => item.AppName === API_KEY_APP_NAME)?.AccessToken;
  };

  const existing = await findKey();
  if (existing) return existing;

  const create = await fetch(`${baseUrl}/Auth/Keys?App=${API_KEY_APP_NAME}`, { method: "POST", headers });
  if (!create.ok) {
    throw new Error(`Could not create a Jellyfin API key (${create.status}): ${await create.text()}`);
  }
  const minted = await findKey();
  if (!minted) throw new Error("Jellyfin accepted the API key request but the key did not appear");
  return minted;
}

/** Jellystat has returned its JWT under different fields across versions. */
function tokenFrom(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  for (const field of ["token", "accessToken", "jwt"]) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  const user = record.user;
  if (typeof user === "object" && user !== null && typeof (user as Record<string, unknown>).token === "string") {
    return (user as Record<string, unknown>).token as string;
  }
  return undefined;
}

async function jellystatSignIn(baseUrl: string, username: string, password: string, ctx: HookContext): Promise<string> {
    // Account create errors when a user already exists - fall through to login.
  const create = await fetch(`${baseUrl}/auth/createuser`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  }).catch(() => null);
  if (create?.ok) {
    ctx.log("Created Jellystat admin account (same credentials as Jellyfin)");
    const created = tokenFrom(await create.json().catch(() => undefined));
    if (created) return created;
  }

  const login = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!login.ok) {
    throw new Error(
      `Could not sign in to Jellystat (${login.status}). If Jellystat was set up with different credentials, sign in there and connect Jellyfin manually.`,
    );
  }
  const token = tokenFrom(await login.json().catch(() => undefined));
  if (!token) throw new Error("Jellystat sign-in succeeded but returned no token");
  return token;
}

export async function run(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "locate", message: "Locating Jellystat" },
    { id: "auth", message: "Signing in to Jellyfin" },
    { id: "apikey", message: "Creating a Jellyfin API key for Jellystat" },
    { id: "configure", message: "Connecting Jellystat to Jellyfin" },
    { id: "verify", message: "Verifying the connection" },
  ]);

  const jellystatUrl = await ctx.getInstalledAppUrl("jellystat");
  if (!jellystatUrl) throw new Error("Jellystat is not installed or has no reachable port");
  if (!ctx.baseUrl) throw new Error("Missing Jellyfin host/port in action context");
  await ctx.emitCheckpoint("locate");

  const username = ctx.getInput<string>("admin_username");
  const password = ctx.getInput<string>("admin_password");
  const accessToken = await jellyfinSignIn(ctx.baseUrl, username, password);
  await ctx.emitCheckpoint("auth");

  const apiKey = await ensureApiKey(ctx.baseUrl, accessToken);
  await ctx.emitCheckpoint("apikey");

  const jellystatToken = await jellystatSignIn(jellystatUrl, username, password, ctx);
  const configure = await fetch(`${jellystatUrl}/api/setconfig`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jellystatToken}` },
    body: JSON.stringify({ JF_HOST: ctx.baseUrl, JF_API_KEY: apiKey }),
  });
  if (!configure.ok) {
    throw new Error(`Jellystat rejected the configuration (${configure.status}): ${await configure.text()}`);
  }
  await ctx.emitCheckpoint("configure");

  const verify = await fetch(`${jellystatUrl}/api/getconfig`, {
    headers: { Authorization: `Bearer ${jellystatToken}` },
  });
  if (!verify.ok) throw new Error(`Could not verify Jellystat's configuration (${verify.status})`);
  const config = (await verify.json()) as { JF_HOST?: string };
  if (config.JF_HOST !== ctx.baseUrl) {
    throw new Error(`Jellystat reports Jellyfin at "${config.JF_HOST}", expected "${ctx.baseUrl}"`);
  }
  await ctx.emitCheckpoint("verify");
}
