import type { HookContext } from "../_lib/hook_context";

const JELLYFIN_AUTH_HEADER = 'MediaBrowser Client="HexOS", Device="HexOS", DeviceId="hexos-app-actions", Version="1.0"';
const API_KEY_APP_NAME = "Jellystat";

// ---- Keccak-512 (pre-standard, CryptoJS.SHA3-compatible) ----
// Jellystat's web UI hashes the password with CryptoJS.SHA3 before BOTH
// account creation and login, and the backend stores/compares the digest
// verbatim. Sending the raw password creates an account the UI can never
// sign into (the API accepts raw while the UI sends the digest) — so we
// must hash exactly like the UI. Bun/Node ship NIST SHA-3 (different
// padding byte), hence this small self-contained implementation.
const KECCAK_M64 = (1n << 64n) - 1n;
const KECCAK_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const KECCAK_ROT = [
  [0n, 36n, 3n, 41n, 18n],
  [1n, 44n, 10n, 45n, 2n],
  [62n, 6n, 43n, 15n, 61n],
  [28n, 55n, 25n, 21n, 56n],
  [27n, 20n, 39n, 8n, 14n],
];
const keccakRotl = (x: bigint, n: bigint) => (n === 0n ? x : (((x << n) | (x >> (64n - n))) & KECCAK_M64));

function keccakF(state: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    const c: bigint[] = [];
    for (let x = 0; x < 5; x++) {
      c[x] = state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!;
    }
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5]! ^ keccakRotl(c[(x + 1) % 5]!, 1n);
      for (let y = 0; y < 5; y++) state[x + 5 * y] = state[x + 5 * y]! ^ d;
    }
    const b: bigint[] = Array.from({ length: 25 }, () => 0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = keccakRotl(state[x + 5 * y]!, KECCAK_ROT[x]![y]!);
      }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        state[x + 5 * y] = b[x + 5 * y]! ^ (~b[((x + 1) % 5) + 5 * y]! & KECCAK_M64 & b[((x + 2) % 5) + 5 * y]!);
      }
    }
    state[0] = state[0]! ^ KECCAK_RC[round]!;
  }
}

function keccak512Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const rate = 72; // 576-bit rate for 512-bit output
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] = 0x01; // original Keccak domain byte (NIST SHA-3 uses 0x06)
  padded[padded.length - 1]! |= 0x80;

  const state: bigint[] = Array.from({ length: 25 }, () => 0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]!);
      state[i] = state[i]! ^ lane;
    }
    keccakF(state);
  }

  let out = "";
  for (let i = 0; i < 8; i++) {
    let lane = state[i]!;
    for (let j = 0; j < 8; j++) {
      out += Number(lane & 0xffn).toString(16).padStart(2, "0");
      lane >>= 8n;
    }
  }
  return out;
}

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
  // Match the web UI byte-for-byte: it sends keccak512(password), and the
  // backend stores/compares that digest verbatim. Raw passwords here would
  // create an account the login PAGE rejects even though the raw API accepts.
  const hashed = keccak512Hex(password);
  // Account create errors when a user already exists - fall through to login.
  const create = await fetch(`${baseUrl}/auth/createuser`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: hashed }),
  }).catch(() => null);
  if (create?.ok) {
    ctx.log("Created Jellystat admin account (same credentials as Jellyfin)");
    const created = tokenFrom(await create.json().catch(() => undefined));
    if (created) return created;
  }

  const login = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: hashed }),
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
