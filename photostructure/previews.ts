import type {
  PreviewPictureContext,
  PreviewPictureResult,
  PreviewSignInContext,
  PreviewSignInResult,
} from "../_lib/previews_context";

// PhotoStructure for the file browser's previews. Its preview route takes the file's path on the
// server and the long edge wanted, and answers with a JPEG whether or not the file is in its library;
// the token the install generated guards the route. There is no sign-in: the token is the session.

const PREVIEW_ROUTE = "/api/preview";

/**
 * The two long edges asked for. The deck asks for a shorter side (320 for a tile, 1080 for the
 * viewer) and PhotoStructure sizes the long edge, so a 3:2 picture needs 1.5 times the ask; two
 * steps keep PhotoStructure's cache at two renders per file instead of one per size the deck names.
 */
const TILE_LONG_EDGE = 480;
const VIEWER_LONG_EDGE = 1620;

/** The long edge for the shorter side the deck asked for: the tile step when it fits, else the viewer step. */
export function longEdgeFor(shorterSide: number): number {
  return Math.round(shorterSide * 1.5) <= TILE_LONG_EDGE ? TILE_LONG_EDGE : VIEWER_LONG_EDGE;
}

export async function signIn(ctx: PreviewSignInContext): Promise<PreviewSignInResult> {
  const token = ctx.credentials.token?.trim();
  // An install that wrote no token leaves the route open, so the pictures are asked for bare, not refused
  return { headers: token ? { Authorization: `Bearer ${token}` } : {} };
}

export async function picture(ctx: PreviewPictureContext): Promise<PreviewPictureResult> {
  return { path: `${PREVIEW_ROUTE}?path=${encodeURIComponent(ctx.hostPath)}&size=${longEdgeFor(ctx.size)}` };
}
