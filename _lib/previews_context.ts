/**
 * MIRROR of the platform's previews script contract (hexos-platform/packages/shared/eshtek/
 * filePreviews.ts, the "What the script sees" section). Keep in sync: this file exists so a catalog
 * previews script typechecks; the platform constructs the real objects when it runs the script.
 *
 * A previews script is protocol only: it signs the platform in to the app and names the address of
 * a picture; the platform confines paths, mints tickets and streams the picture. Two rules bind the
 * author, since the loader runs the script in-process and enforces neither: read no files, and open
 * no connection of your own (the scoped fetch is the way to the app).
 */

export type PreviewInputKind = "image" | "video";

export interface PreviewScriptApp {
  id: string;
  /** The app's own address on the server's LAN, the only origin the scoped client reaches. */
  baseUrl: string;
}

export interface PreviewScriptFetchInit {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
}

/** The app's answer, without the stream: a script reads JSON or text, never a picture. */
export interface PreviewScriptResponse {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  /** Each Set-Cookie the app sent, as its name=value pair. */
  cookies: string[];
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

export type PreviewScriptFetch = (path: string, init?: PreviewScriptFetchInit) => Promise<PreviewScriptResponse>;

/** A sign-in the owner typed into the file browser settings after the app's own stopped working. */
export interface PreviewLogin {
  username: string;
  password: string;
}

export interface PreviewSignInContext {
  app: PreviewScriptApp;
  /** The declared credentials' values, by credential id; one the app's configuration lacks is absent. */
  credentials: Record<string, string>;
  /** The owner's own sign-in, when they typed one; it takes precedence over the credentials. */
  login?: PreviewLogin;
  fetch: PreviewScriptFetch;
  signal: AbortSignal;
}

/** What every picture request carries once signed in; the platform attaches it to the app's origin only. */
export interface PreviewSession {
  headers: Record<string, string>;
}

/** A sign-in the app refused: wrong credentials, as distinct from an app that did not answer (throw for that). */
export interface PreviewSignInRefused {
  refused: true;
}

export type PreviewSignInResult = PreviewSession | PreviewSignInRefused;

export interface PreviewPictureContext {
  app: PreviewScriptApp;
  /** The file inside the served root as the app addresses it, such as "Trips/2024/IMG_0001.heic". */
  path: string;
  kind: PreviewInputKind;
  extension: string;
  /** The shorter side in pixels the deck asked for; the app rounds to a size it keeps. */
  size: number;
  session: PreviewSession;
  fetch: PreviewScriptFetch;
  signal: AbortSignal;
}

/** The address of a picture, relative to the app, carrying the session; never an origin or a file path. */
export interface PreviewFetchSpec {
  path: string;
}

export type PreviewDeclineReason = "unsupported" | "needs-login" | "unavailable";

export interface PreviewDecline {
  decline: PreviewDeclineReason;
  retryable?: boolean;
}

export type PreviewPictureResult = PreviewFetchSpec | PreviewDecline;
