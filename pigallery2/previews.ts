import type {
  PreviewPictureContext,
  PreviewPictureResult,
  PreviewSignInContext,
  PreviewSignInResult,
} from "../_lib/previews_context";

// PiGallery2 for the file browser's previews: a sign-in with the admin account the install enforced,
// or the one the owner typed, and the address of a picture. The gallery serves the sizes in its own
// list (320, 540, 1080 and 2160 by default) and answers any other with the first, so the platform asks
// for sizes on that list.

const API = "/pgapi";

type EnforcedUser = { name?: unknown; password?: unknown; role?: unknown };
type Envelope = { error?: unknown; result?: unknown };

/** The admin the install enforced, from the JSON list the app's environment carries. */
function enforcedLogin(raw: string | undefined): { username: string; password: string } | null {
  if (!raw) return null;
  let users: unknown;
  try {
    users = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(users)) return null;
  const admin = (users as EnforcedUser[]).find((user) => user?.role === "Admin") ?? (users[0] as EnforcedUser | undefined);
  if (!admin || typeof admin.name !== "string" || typeof admin.password !== "string") return null;
  return { username: admin.name, password: admin.password };
}

export async function signIn(ctx: PreviewSignInContext): Promise<PreviewSignInResult> {
  const login = ctx.login ?? enforcedLogin(ctx.credentials.enforcedUsers);
  if (!login) return { refused: true };
  const res = await ctx.fetch(`${API}/user/login`, {
    method: "POST",
    body: { loginCredential: { ...login, rememberMe: true } },
  });
  if (!res.ok) throw new Error(`PiGallery2 answered ${res.status} to the sign-in`);
  // A refused login answers 200 with an error envelope; a session is two cookies, both sent back on every call
  const body = (await res.json().catch(() => null)) as Envelope | null;
  if (!body || body.error || !body.result || res.cookies.length === 0) return { refused: true };
  return { headers: { cookie: res.cookies.join("; ") } };
}

export async function picture(ctx: PreviewPictureContext): Promise<PreviewPictureResult> {
  const encoded = ctx.path.split("/").map(encodeURIComponent).join("/");
  return { path: `${API}/gallery/content/${encoded}/${Math.round(ctx.size)}` };
}
