// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";

import type { WidgetContext, WidgetQueryResult } from "../_lib/widget_context";

/** hbbs writes its key pair to its working directory, /root (src/common.rs, gen_sk). */
const PUBLIC_KEY_FILE = "id_ed25519.pub";
const SECRET_KEY_FILE = "id_ed25519";

function readPublicKey(ctx: WidgetContext): string | null {
  const data =
    ctx.mounts.find((m) => m.containerPath === "/root") ??
    ctx.mounts.find((m) => m.hostPath.endsWith("/rust-desk/data"));
  if (!data) return null;
  // hbbs uses only the secret key, so take the key from it first.
  // The public key is the second half of the 64-byte secret key.
  try {
    const secret = Buffer.from(readFileSync(`${data.localPath}/${SECRET_KEY_FILE}`, "utf-8").trim(), "base64");
    if (secret.length === 64) return secret.subarray(32).toString("base64");
  } catch {
    // Fall through to the public key file.
  }
  try {
    return readFileSync(`${data.localPath}/${PUBLIC_KEY_FILE}`, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

export async function run(ctx: WidgetContext): Promise<WidgetQueryResult> {
  const key = readPublicKey(ctx);
  if (!key) return { needsSetup: true, reason: "RustDesk has not created its key yet." };
  return {
    fields: {
      settings: {
        type: "list",
        entries: [
          { title: "ID server", subtitle: ctx.host },
          { title: "Key", subtitle: key },
        ],
      },
    },
  };
}
