import type { HookContext, HookInputDeclaration } from "../_lib/hook_context";

const JELLYFIN_AUTH_HEADER = 'MediaBrowser Client="HexOS", Device="HexOS", DeviceId="hexos-app-actions", Version="1.0"';
const API_KEY_APP_NAME = "Jellystat";

// ---- Keccak-512 (pre-standard, CryptoJS.SHA3-compatible) ----
// Jellystat's web UI hashes the password with CryptoJS.SHA3 before BOTH
// account creation and login, and the backend stores/compares the digest
// verbatim. Sending the raw password creates an account the UI can never
// sign into (the API accepts raw while the UI sends the digest); so we
// must hash exactly like the UI. Bun/Node ship NIST SHA-3 (different
// padding byte), hence this small self-contained implementation.
const KECCAK_M64 = (1n << 64n) - 1n;
const KECCAK_RC = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];
const KECCAK_ROT = [
  [0n, 36n, 3n, 41n, 18n],
  [1n, 44n, 10n, 45n, 2n],
  [62n, 6n, 43n, 15n, 61n],
  [28n, 55n, 25n, 21n, 56n],
  [27n, 20n, 39n, 8n, 14n],
];
const keccakRotl = (x: bigint, n: bigint) => (n === 0n ? x : ((x << n) | (x >> (64n - n))) & KECCAK_M64);

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
      out += Number(lane & 0xffn)
        .toString(16)
        .padStart(2, "0");
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
    throw new Error(`Jellyfin sign-in failed (${response.status})`);
  }
  const result = (await response.json()) as {
    AccessToken?: string;
    User?: { Policy?: { IsAdministrator?: boolean } };
  };
  if (!result.AccessToken) throw new Error("Jellyfin sign-in returned no access token");
  if (!result.User?.Policy?.IsAdministrator) {
    throw new Error("That Jellyfin account is not an administrator; an admin account is required to create an API key");
  }
  return result.AccessToken;
}

async function ensureApiKey(baseUrl: string, accessToken: string): Promise<string> {
  // Jellyfin 12 has EnableLegacyAuthorization off, which turns away a token in X-Emby-Token (401)
  const headers = { Authorization: `MediaBrowser Token="${accessToken}"` };
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
    throw new Error(`Could not create a Jellyfin API key (${create.status})`);
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

async function jellystatSignIn(
  baseUrl: string,
  username: string,
  password: string,
  ctx: HookContext,
): Promise<{ token: string; state: number }> {
  const configured = await fetch(`${baseUrl}/auth/isConfigured`);
  if (!configured.ok) throw new Error(`Could not read Jellystat's setup state (${configured.status})`);
  const { state } = (await configured.json()) as { state?: number };
  if (state !== 0 && state !== 1 && state !== 2) throw new Error("Could not confirm Jellystat's setup state");
  const hashed = keccak512Hex(password);
  if (state === 0) {
    const create = await fetch(`${baseUrl}/auth/createuser`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: hashed }),
    });
    if (create.ok) {
      ctx.log("Created Jellystat admin account (same credentials as Jellyfin)");
      const token = tokenFrom(await create.json().catch(() => undefined));
      if (token) return { token, state };
    } else if (create.status !== 403) {
      throw new Error(`Could not create Jellystat's account (${create.status})`);
    }
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
  return { token, state };
}

/**
 * The Jellyfin administrator Jellystat's account and API key come from: the sign-in the owner chose
 * for the install or collection (`ctx.signIn`, which Pre-configure Jellyfin made an administrator),
 * else the answers an older Pre-configure Jellyfin was given, else asked for.
 */
async function jellyfinAdmin(ctx: HookContext): Promise<{ username: string; password: string }> {
  if (ctx.signIn) return { username: ctx.signIn.username, password: ctx.signIn.password };
  // Read without getInput, which throws for an answer that isn't there: a run from the card has none.
  // Jellyfin takes an empty password, so an inherited one counts once the username is there.
  const inherited = { username: ctx.inputs?.admin_username, password: ctx.inputs?.admin_password };
  if (typeof inherited.username === "string" && inherited.username && typeof inherited.password === "string") {
    return { username: inherited.username, password: inherited.password };
  }
  const inputs: HookInputDeclaration[] = [
    { type: "question", id: "username", question: { question: "Jellyfin username", type: "text", key: "username", required: true } },
    { type: "question", id: "password", question: { question: "Jellyfin password", type: "password", key: "password", required: true } },
  ];
  const answered =
    typeof ctx.askForInputs === "function"
      ? await ctx
          .askForInputs(inputs, {
            title: "Sign in to Jellyfin",
            description: "Enter a Jellyfin administrator's sign-in, so HexOS can connect Jellystat to Jellyfin.",
          })
          .catch((error: unknown) => {
            if (error instanceof Error && error.name === "HookInputsUnanswered") return undefined;
            throw error;
          })
      : undefined;
  const username = answered?.username as string | undefined;
  const password = answered?.password as string | undefined;
  if (!username || !password) {
    const message = "Jellystat needs a Jellyfin administrator's sign-in. Run Connect to Jellystat from Jellyfin to give it.";
    if (ctx.skip) ctx.skip(message);
    ctx.fail(message);
  }
  return { username, password };
}

function sameServer(left: string, right: string): boolean {
  return new URL(left).href.replace(/\/+$/, "") === new URL(right).href.replace(/\/+$/, "");
}

/**
 * The Jellyfin server that answers at an address now, by its id and name, or undefined when nothing
 * does. Jellyfin answers `/System/Info/Public` without a sign-in.
 */
async function serverAt(url: string): Promise<{ id: string; name?: string } | undefined> {
  // Only the server's public id is read, so a certificate made for another name (a Jellyfin reached
  // by its IP over TLS) doesn't count as no answer; nothing is sent
  const init = { signal: AbortSignal.timeout(10_000), tls: { rejectUnauthorized: false } };
  const response = await fetch(`${url.replace(/\/+$/, "")}/System/Info/Public`, init as RequestInit).catch(() => undefined);
  if (!response?.ok) return undefined;
  const info = (await response.json().catch(() => undefined)) as { Id?: string; ServerName?: string } | undefined;
  return info?.Id ? { id: info.Id, name: info.ServerName || undefined } : undefined;
}

interface JellystatConfig {
  JF_HOST?: string | null;
  settings?: { ServerID?: string | null } | null;
}

/**
 * The Jellyfin servers Jellystat's own records name: the id it saved at its last setup, and the server
 * each library it hasn't archived was synced from. Undefined when the libraries can't be read, which
 * proves nothing.
 */
async function recordedServers(jellystatUrl: string, token: string, config: JellystatConfig): Promise<string[] | undefined> {
  const response = await fetch(`${jellystatUrl}/api/getLibraries`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
  if (!response?.ok) return undefined;
  const libraries = (await response.json().catch(() => undefined)) as Array<{ ServerId?: string; archived?: boolean }> | undefined;
  if (!Array.isArray(libraries)) return undefined;
  const ids = [config.settings?.ServerID, ...libraries.filter((library) => !library.archived).map((library) => library.ServerId)];
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id !== ""))];
}

/**
 * Whether the owner wants Jellystat moved off a server that no longer answers. Nothing proves that
 * server is gone for good (it may be another computer that's switched off), so the owner decides.
 * False when they say no, skip the question, or the box can't ask.
 */
async function ownerSwitches(ctx: HookContext, address: string): Promise<boolean> {
  if (typeof ctx.askForInputs !== "function") return false;
  const answers = await ctx
    .askForInputs(
      [
        {
          type: "question",
          id: "switch",
          question: {
            question: "Switch Jellystat to this Jellyfin server",
            description: "Jellystat keeps the history it has, and adds this server's plays to it.",
            type: "boolean",
            key: "switch",
            required: true,
          },
        },
      ],
      { title: "Switch Jellystat's Jellyfin server", description: `Jellystat uses ${address}, which isn't answering.` },
    )
    .catch((error: unknown) => {
      if (error instanceof Error && error.name === "HookInputsUnanswered") return undefined;
      throw error;
    });
  return answers?.switch === true;
}

/**
 * The address Jellystat should keep for this server, when the one it has isn't this server's. Jellystat
 * keeps one Jellyfin server, and its history belongs to that server. It moves to this one when its
 * address now answers as this server (Jellyfin was reinstalled, or the owner wrote another name for
 * it), when its address answers nothing and its own records name this server and no other (the box's
 * address or Jellyfin's port changed), or when the owner says so. It's left alone while its address
 * answers as another server.
 */
async function addressToKeep(
  ctx: HookContext,
  jellystatUrl: string,
  token: string,
  config: JellystatConfig & { JF_HOST: string },
): Promise<string> {
  const thisServer = await serverAt(ctx.baseUrl);
  if (!thisServer) ctx.fail("Jellyfin didn't answer. Try again once it has started.");
  const stored = await serverAt(config.JF_HOST);
  // An address that answers as this server stays as the owner wrote it
  if (stored?.id === thisServer.id) return config.JF_HOST;
  // Switching servers is the owner's to do in Jellystat, so trying again can't help
  const message =
    "Jellystat is already connected to another Jellyfin server. Change it in Jellystat's own settings, then run Connect to Jellystat from Jellyfin.";
  const context = [{ label: "Jellystat uses", value: stored?.name ? `${stored.name} at ${config.JF_HOST}` : config.JF_HOST }];
  // What answers is checked before the records, since Jellystat saves the id of the server its old
  // settings reach: one moved to another server in its own settings can still name this one
  if (!stored) {
    const records = await recordedServers(jellystatUrl, token, config);
    if (records?.length && records.every((id) => id === thisServer.id)) return ctx.baseUrl;
    if (await ownerSwitches(ctx, config.JF_HOST)) return ctx.baseUrl;
  }
  if (ctx.skip) ctx.skip(message, context);
  ctx.fail(message, context);
}

/**
 * Connects Jellystat to this Jellyfin server with an API key of its own, signing in to Jellystat with
 * the owner's Jellyfin administrator (and making that account in a fresh Jellystat). Run again, it
 * moves Jellystat to this server when Jellystat's own is gone: Jellyfin reinstalled at the address
 * Jellystat has, or this server at an address that no longer reaches it. Read at Jellystat 1.1.12,
 * the version TrueNAS pins.
 */
export async function run(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "locate", message: "Locating Jellystat" },
    { id: "auth", message: "Signing in to Jellyfin" },
    { id: "apikey", message: "Preparing a Jellyfin API key for Jellystat" },
    { id: "configure", message: "Connecting Jellystat to Jellyfin" },
    { id: "verify", message: "Verifying the connection" },
  ]);

  const jellystatUrl = await ctx.getInstalledAppUrl("jellystat");
  if (!jellystatUrl) throw new Error("Jellystat is not installed or has no reachable port");
  if (!ctx.baseUrl) throw new Error("Missing Jellyfin host/port in action context");
  await ctx.emitCheckpoint("locate");

  const { username, password } = await jellyfinAdmin(ctx);
  const accessToken = await jellyfinSignIn(ctx.baseUrl, username, password);
  await ctx.emitCheckpoint("auth");

  const { token: jellystatToken, state } = await jellystatSignIn(jellystatUrl, username, password, ctx);
  const current = await fetch(`${jellystatUrl}/api/getconfig`, {
    headers: { Authorization: `Bearer ${jellystatToken}` },
  });
  if (!current.ok) throw new Error(`Could not read Jellystat's existing connection (${current.status})`);
  const existing = (await current.json()) as JellystatConfig;
  if (state === 2 && !existing.JF_HOST) throw new Error("Could not confirm Jellystat's existing Jellyfin server");
  const host = existing.JF_HOST;
  const address =
    host && !sameServer(host, ctx.baseUrl) ? await addressToKeep(ctx, jellystatUrl, jellystatToken, { ...existing, JF_HOST: host }) : ctx.baseUrl;
  // A Jellyfin that was reinstalled doesn't know the key Jellystat has, so it gets one of its own
  const apiKey = await ensureApiKey(ctx.baseUrl, accessToken);
  await ctx.emitCheckpoint("apikey");

  const configure = await fetch(`${jellystatUrl}/api/setconfig`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jellystatToken}` },
    body: JSON.stringify({ JF_HOST: address, JF_API_KEY: apiKey }),
  });
  if (!configure.ok) {
    throw new Error(`Jellystat rejected the configuration (${configure.status})`);
  }
  await ctx.emitCheckpoint("configure");

  const verify = await fetch(`${jellystatUrl}/api/getconfig`, {
    headers: { Authorization: `Bearer ${jellystatToken}` },
  });
  if (!verify.ok) throw new Error(`Could not verify Jellystat's configuration (${verify.status})`);
  const config = (await verify.json()) as { JF_HOST?: string };
  if (!config.JF_HOST || !sameServer(config.JF_HOST, address)) {
    throw new Error(`Jellystat reports Jellyfin at "${config.JF_HOST}", expected "${address}"`);
  }
  await ctx.emitCheckpoint("verify");
}
