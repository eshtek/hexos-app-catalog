/**
 * HookContext — the runtime context passed to every hook entrypoint.
 *
 * MIRROR: this interface is a hand-maintained copy of the public surface of
 * hexos-platform/packages/backend/src/interface/hooks.ts (class HookContext).
 * Update BOTH files when the contract grows — nothing checks this for you.
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
/**
 * One mount entry from the app's live config — the same shape every script
 * surface receives (hooks, actions, widgets).
 */
export interface ContextMount {
  /** Host path (/mnt/...). */
  hostPath: string;
  /**
   * The same directory as the app sees it inside its container — null for
   * chart-style primary storage (config/data/logs) whose container path the
   * chart fixes internally. Match those by hostPath instead.
   */
  containerPath: string | null;
  /**
   * The same directory as THIS script can read it (the local node's host
   * bind-mount). Use for harvesting app config files, e.g. Plex's
   * Preferences.xml — no more hand-walking /host/mnt.
   */
  localPath: string;
}

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
   * File-targeted actions only: the files the user selected. `containerPath`
   * is the same file as THIS app sees it (pre-resolved from its mounts), or
   * null when the file isn't under any of the app's mounts — scripts for
   * requiresTargetMount:false actions must handle null (e.g. deliver the
   * file themselves via the platform mounts).
   */
  readonly target?: {
    type: "files";
    files: Array<{
      path: string;
      containerPath: string | null;
      name: string;
      extension: string;
      size?: number;
    }>;
  };

  /**
   * The app's live mounts, pre-resolved (empty when the app doesn't exist
   * yet, e.g. onBeforeInstall, or mount discovery failed — scripts must
   * tolerate an empty list).
   */
  readonly mounts: ContextMount[];

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
  /**
   * Base URL of another installed app (e.g. "http://192.168.1.50:5055"),
   * or null when it isn't installed or has no known port. Available to app
   * actions; lifecycle hooks may receive null depending on platform version.
   */
  getInstalledAppUrl(appId: string): Promise<string | null>;

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

  /**
   * Update a checkpoint's message without marking it completed.
   * Useful for showing real-time progress within a long-running step.
   *
   * @param id - Checkpoint identifier (must match a registered ID)
   * @param message - New message to display
   *
   * @example
   * ```ts
   * await ctx.updateCheckpointMessage("librariesCreated", "Creating library 3 of 5: Music");
   * ```
   */
  updateCheckpointMessage(id: string, message: string): Promise<void>;

  /**
   * Drive the task's progress bar directly (clamped 0-99) without touching
   * checkpoints. For long-running work whose real progress the script can
   * measure — e.g. frames encoded out of a known total. A later
   * emitCheckpoint WITHOUT an explicit progress reverts the bar to
   * checkpoint-fraction math, so pass explicit progress on the final
   * checkpoint when using this.
   *
   * @example
   * ```ts
   * await ctx.setProgress(42);
   * ```
   */
  setProgress(percent: number): Promise<void>;

  /**
   * Fail the hook with a structured error. The message is shown as the primary error,
   * and context items are rendered as labeled key-value pairs in the UI.
   *
   * @param message - Human-readable error message
   * @param context - Diagnostic details: endpoint, status, response body, suggestions, etc.
   *
   * @example
   * ```ts
   * ctx.fail("Library creation rejected by Plex", [
   *   { label: "Endpoint", value: "POST /library/sections" },
   *   { label: "Status", value: "400 Bad Request" },
   *   { label: "Response", value: "Couldn't create section: 'language' is invalid" },
   * ]);
   * ```
   */
  fail(message: string, context?: Array<{ label: string; value: string }>): never;

  /**
   * Pause the hook at a failed checkpoint and wait for the user to retry or skip.
   * The error and context are surfaced in the UI exactly like `fail()`, but the hook
   * stays alive — it resumes when the user acts.
   *
   * @returns "retry" if the user chose to retry, "skip" if they chose to skip
   */
  awaitCheckpointRetry(
    checkpointId: string,
    error: string,
    context?: Array<{ label: string; value: string }>,
  ): Promise<"retry" | "skip">;

  /**
   * Mark a checkpoint as skipped (distinct from completed).
   * The UI renders a skip icon instead of a check mark.
   */
  skipCheckpoint(id: string, message?: string): Promise<void>;

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
