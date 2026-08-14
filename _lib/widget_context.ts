/**
 * MIRROR of the platform's WidgetContext (packages/backend/src/interface/
 * widgets.ts). Keep in sync — this file exists so catalog widget scripts
 * typecheck; the platform constructs the real object at query time.
 *
 * Widgets are read-only glances: the script runs in-process on the local
 * node, must return within its declared timeout, and its result is cached
 * by the platform for the widget's refresh interval. No tasks, no
 * checkpoints, no inputs — return data or { needsSetup }.
 */

export interface WidgetMount {
  /** Host path (/mnt/...). */
  hostPath: string;
  /**
   * The same directory as the app sees it inside its container — null for
   * chart-style primary storage (config/data/logs) whose container path
   * the chart fixes internally. Match those by hostPath instead.
   */
  containerPath: string | null;
  /**
   * The same directory as THIS script can read it (the local node's host
   * bind-mount). Use for harvesting app config files, e.g. Plex's
   * Preferences.xml.
   */
  localPath: string;
}

export interface WidgetContext {
  readonly appId: string;
  /** Box LAN IP — app APIs live at http://host:port. */
  readonly host: string;
  /** The app's first declared catalog port, when it declares one. */
  readonly port?: number;
  /** The app's live mounts. */
  readonly mounts: WidgetMount[];
  log(message: string): void;
}

/**
 * What a widget script returns. Provide `stats` for the stat layout or
 * `items` for the list layout; return `needsSetup` (with a human reason)
 * when the data source isn't usable yet. Harvest credentials first —
 * needs-setup is the fallback, not the default.
 */
export interface WidgetQueryResult {
  needsSetup?: boolean;
  reason?: string;
  stats?: Array<{ label: string; value: string }>;
  items?: Array<{
    title: string;
    subtitle?: string;
    meta?: string;
    /**
     * A duration in steady motion — capable renderers advance it in real
     * time between polls; the text floor (meta) must still carry a static
     * representation. state "paused" = not accruing.
     */
    elapsed?: { ms: number; ofMs?: number; state?: "running" | "paused" };
    /**
     * Optional thumbnail as a size-capped (60KB) data URI. Data URIs ONLY —
     * fetch and inline server-side; never emit app URLs (key leak,
     * mixed-content, off-LAN breakage).
     */
    image?: string;
  }>;
}
