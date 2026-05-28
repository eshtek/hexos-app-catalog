/**
 * HookContext — the runtime context passed to every hook entrypoint.
 *
 * The actual class is provided by hexos-platform at execution time.
 * Hook scripts import this interface for autocompletion and type safety.
 *
 * @example
 * ```ts
 * import type { HookContext } from "../_lib/hook_context";
 *
 * export async function afterInstall(ctx: HookContext) {
 *   const token = ctx.getInput<PlexOAuthResult>("plex_login").authToken;
 *   await ctx.waitForApp("/identity");
 *   await ctx.emitCheckpoint("ready", "App is ready", 50);
 * }
 * ```
 */
export interface HookContext {
  /** "app" or "vm" */
  readonly resourceType: string;
  /** The app/vm ID this hook is running for (e.g., "plex", "nextcloud") */
  readonly resourceId: string;
  /** The lifecycle event that triggered this hook */
  readonly event: "onBeforeInstall" | "onAfterInstall" | "onBeforeUpgrade" | "onAfterUpgrade" | string;
  /** Previous version (upgrade hooks only) */
  readonly fromVersion?: string;
  /** Target version (upgrade hooks only) */
  readonly toVersion?: string;
  /** TrueNAS app config path (e.g., /mnt/.ix-apps/app_configs/plex) */
  readonly configPath?: string;
  /** TrueNAS LAN IP */
  readonly host?: string;
  /** The app's primary port */
  readonly port?: number;
  /** Convenience: http://{host}:{port} — empty string if host/port unavailable */
  readonly baseUrl: string;
  /**
   * User-collected inputs, keyed by input declaration ID.
   * - OAuth inputs: `{ authToken: string, ... }` (shape depends on provider)
   * - Question inputs: the raw answer value (string | number | boolean)
   */
  readonly inputs: Record<string, unknown>;

  /**
   * Type-safe input accessor. Throws if the input is missing.
   *
   * @example
   * ```ts
   * const { authToken } = ctx.getInput<{ authToken: string }>("plex_login");
   * const password = ctx.getInput<string>("admin_password");
   * ```
   */
  getInput<T = unknown>(inputId: string): T;

  /** Log a message (visible in backend logs, not shown to user) */
  log(message: string): void;

  /**
   * Register all checkpoints upfront so the UI shows them as pending from the start.
   * Call this before any async work begins.
   *
   * @example
   * ```ts
   * ctx.registerCheckpoints([
   *   { id: "serverReady", message: "Server started" },
   *   { id: "configured", message: "Preferences configured" },
   * ]);
   * ```
   */
  registerCheckpoints(checkpoints: Array<{ id: string; message: string }>): Promise<void>;

  /**
   * Mark a registered checkpoint as completed.
   * If the checkpoint wasn't registered, it's added as completed.
   * Progress auto-calculates from completed/total ratio unless explicitly provided.
   *
   * @param id - Checkpoint identifier (must match a registered ID)
   * @param message - Optional override message
   * @param progress - Optional explicit 0-99 progress percentage
   */
  emitCheckpoint(id: string, message?: string, progress?: number): Promise<void>;

  /** Async sleep helper */
  sleep(ms: number): Promise<void>;

  /**
   * Poll an app endpoint until it responds with the expected status.
   * Useful for waiting for an app to start after container creation.
   *
   * @param path - URL path relative to baseUrl (e.g., "/identity")
   * @param opts - Polling options
   * @returns The successful Response object
   * @throws After maxAttempts if the app never responds
   */
  waitForApp(path: string, opts?: WaitForAppOptions): Promise<Response>;
}

export interface WaitForAppOptions {
  /** Expected HTTP status code (default: 200) */
  expectedStatus?: number;
  /** Maximum number of poll attempts (default: 40) */
  maxAttempts?: number;
  /** Initial delay between attempts in ms (default: 5000) */
  initialDelayMs?: number;
  /** Maximum delay between attempts in ms (default: 15000) */
  maxDelayMs?: number;
  /** Request timeout in ms (default: 5000) */
  timeoutMs?: number;
  /** Additional fetch headers */
  headers?: Record<string, string>;
}

/**
 * Common OAuth result shapes for type-safe input access.
 */
export interface PlexOAuthResult {
  authToken: string;
}

export interface GenericOAuthResult {
  authToken: string;
  refreshToken?: string;
  idToken?: string;
}
