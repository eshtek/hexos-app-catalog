import { HookContext } from "../../hexos-app-catalog/_lib/hook_context";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown[];
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

/**
 * See /api/docs/current/api_methods_user.get_instance.html
 */
export type TruenasUserObject = {
  id: number;
  uid: number;

  username: string;
  unixhash: string;
  smbhash: string;
  home: string;
  shell: string;
  full_name: string;
  builtin: boolean;
  smb: boolean;
  userns_idmap: number | null;
  group: {
    id: number;
    bsdgrp_gid: number;
    bsdgrp_group: string;
    bsdgrp_builtin: boolean;
    bsdgrp_sudo_commands: string[];
    bsdgrp_sudo_commands_nopasswd: string[];
    bsdgrp_smb: boolean;
    bsdgrp_userns_idmap: number;
  };
  groups: number[];
  password_disabled: boolean;
  ssh_password_enabled: boolean;
  sshpubkey: string | null;
  locked: boolean;
  sudo_commands: string[];
  sudo_commands_nopasswd: string[];
  email: string | null;
  local: boolean;
  immutable: boolean;
  twofactor_auth_configured: boolean;
  sid: string;
  last_password_change: { $date: number };
  password_age: number;
  password_history: string[];
  password_change_required: boolean;
  roles: string[];
  api_keys: number[];

};

export type JobID = number;

export type TrueNasRpc = (method: string, params?: unknown[]) => Promise<any>;

export interface TrueNasApiClient extends Disposable {
  rpc: TrueNasRpc;
  uploadFile: (path: string, content: string | ArrayBuffer | Blob, options?: { append?: boolean; mode?: string | null }) => Promise<JobID>;
  close: () => void;
};

export function createWsUrl(ctx?: HookContext): string {

  const host = process.env.LOCAL_LAN_IP || ctx?.host;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const protocol = "wss";
  const port = String(process.env.LOCAL_TN_PORT || 443);
  const path = process.env.LOCAL_WS_PATH || "/api/current";

  if (!host) {
    throw new Error("Unable to resolve TrueNAS host. Set LOCAL_LAN_IP or ensure ctx.host is available.");
  }

  if (protocol !== "wss") {
    throw new Error(`Refusing to use insecure WebSocket protocol '${protocol}'. Use wss only.`);
  }

  if (port === "80") {
    throw new Error("Refusing to use port 80 for TrueNAS WebSocket connections. Use 443 with wss.");
  }

  return `${protocol}://${host}:${port}${path}`;
}

async function openRpcClient( ctx: HookContext, wsUrl: string,): Promise<TrueNasApiClient> {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const WebSocketCtor = (globalThis as any).WebSocket;
  if (!WebSocketCtor) {
    throw new Error("WebSocket runtime is unavailable.");
  }

  const socket = new WebSocketCtor(wsUrl);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error(`Failed to open WebSocket connection to ${wsUrl}.`));
  });

  let requestId = 0;
  const rpc: TrueNasRpc = (method, params = []) =>
    new Promise<any>((resolve, reject) => {
      const id = ++requestId;
      const payload: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params
      };

      const onMessage = (event: any) => {
        let parsed: JsonRpcResponse;
        try {
          parsed = JSON.parse(String(event.data));
        } catch {
          return;
        }

        if (!parsed || parsed.id !== id) {
          return;
        }

        socket.removeEventListener("message", onMessage);
        if (parsed.error) {
          reject(new Error(`${parsed.error.code}: ${parsed.error.message}`));
          return;
        }

        resolve(parsed.result);
      };

      socket.addEventListener("message", onMessage);
      socket.send(JSON.stringify(payload));
    });

  return {
    rpc,
    uploadFile: async (path: string, content: string | ArrayBuffer | Blob, options?: { append?: boolean; mode?: string | null }) => {
      return uploadFile(ctx , path, content, options);
    },
    close: () => socket.close(),
    [Symbol.dispose]() {
      socket.close();
    }

  };
}

export async function createTrueNasApi(ctx: HookContext): Promise<TrueNasApiClient> {
  const resolvedApiKey = process.env.LOCAL_API_KEY;
  if (!resolvedApiKey) {
    throw new Error("LOCAL_API_KEY is missing.");
  }

  const wsUrl = createWsUrl(ctx);
  const client = await openRpcClient(ctx, wsUrl);

  try {
    const authResult = await client.rpc("auth.login_with_api_key", [resolvedApiKey]);
    if (authResult !== true) {
      throw new Error(`Authentication failed: ${String(authResult)}`);
    }

    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

export async function queryUsers(client: Pick<TrueNasApiClient, "rpc">): Promise<any[]> {
  const users = await client.rpc("user.query", [[], {}]);
  return Array.isArray(users) ? users : [];
}



export async function getBuiltinUsers(client: Pick<TrueNasApiClient, "rpc">): Promise<TruenasUserObject[]> {
  const groups = await client.rpc("group.query", [[[
    "name",
    "=",
    "builtin_users"
  ]], {}]);

  if (!Array.isArray(groups) || groups.length === 0) {
    throw new Error("builtin_users group was not found");
  }

  const builtinUserIds = Array.isArray(groups[0]?.users) ? groups[0].users : [];
  if (builtinUserIds.length === 0) {
    throw new Error("builtin_users group has no users");
  }

  const users: TruenasUserObject[] = await client.rpc("user.query", [[[
    "id",
    "in",
    builtinUserIds
  ]], {}]);

  const normalizedUsers = Array.isArray(users) ? users : [];
  if (normalizedUsers.length !== builtinUserIds.length) {
    throw new Error(`Only ${normalizedUsers.length} users in builtin_users group were found, expected ${builtinUserIds.length}`);
  }

  return normalizedUsers;
}

export async function uploadFile(
  ctx: HookContext,
  path: string,
  content: string | ArrayBuffer | Blob,
  options?: { append?: boolean; mode?: string | null }
): Promise<JobID> {
  const host = process.env.LOCAL_LAN_IP || ctx?.host;
  const port = String(process.env.LOCAL_TN_PORT || 443);
  const uploadPath = process.env.LOCAL_UPLOAD_PATH || "/_upload/";

  if (!host) {
    throw new Error("Unable to resolve TrueNAS host. Set LOCAL_LAN_IP or ensure ctx.host is available.");
  }

  // Equivalent to curl -k for self-signed certs
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  const url = `https://${host}:${port}${uploadPath}`;
  const form = new FormData();
  form.append("data", JSON.stringify({ method: "filesystem.put", params: [path, options || {}] }));

  const blob =
    content instanceof Blob
      ? content
      : typeof content === "string"
        ? new Blob([content])
        : new Blob([content]);
  form.append("file", blob, ".ignore");
 
  const auth = process.env.LOCAL_API_KEY;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth}`
    },
    body: form
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Upload failed (${res.status} ${res.statusText}): ${text}`);
  }

  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "number") return parsed;
    if (typeof parsed?.job_id === "number") return parsed.job_id;
    if (typeof parsed?.result === "number") return parsed.result;
  } catch {
    // non-JSON responsea
  }

  throw new Error(`Upload succeeded but could not parse job id from response: ${text}`);
}