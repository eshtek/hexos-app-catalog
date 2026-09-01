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

import type { ContextMount } from "./hook_context";

/** One mount shape across every script surface — defined once in hook_context. */
export type WidgetMount = ContextMount;

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

export interface WidgetListEntry {
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
}

/**
 * One named field of the result document (widgetsSchema 2). The
 * declaration's `sizes` slots reference these fields by name; a standalone
 * image field is the media slot's source. Max 16 fields; images are
 * size-capped (60KB) data URIs, text is capped at 500 chars.
 */
export type WidgetFieldValue =
  | { type: "text"; text: string }
  | { type: "stat"; label: string; value: string }
  | { type: "list"; entries: WidgetListEntry[] }
  | { type: "image"; image: string; alt?: string };

/**
 * What a widget script returns: named fields the platform's size templates
 * project from — one widget, ONE query; sizes never add polls. Return
 * `needsSetup` (with a human reason) when the data source isn't usable
 * yet. Harvest credentials first — needs-setup is the fallback, not the
 * default. Field names must be STABLE (sizes reference them); dynamic
 * collections (users, library sections) ride as `list` entries.
 */
export interface WidgetQueryResult {
  needsSetup?: boolean;
  reason?: string;
  fields?: Record<string, WidgetFieldValue>;
}
