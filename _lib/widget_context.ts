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
  /** The longest data URI this box accepts. A box on an older image doesn't send it, and holds to 60,000. */
  readonly imageLimit?: number;
  log(message: string): void;
}

export interface WidgetListEntry {
  title: string;
  subtitle?: string;
  /**
   * Lines that take turns under the entry (up to 4, each at most 80 chars).
   * The featured form steps through them at twice the pace of its entries,
   * starting over with each entry. `subtitle` stays the floor for renderers
   * that ignore this, so repeat the first line there.
   */
  subtitles?: string[];
  meta?: string;
  /**
   * A short line of small text under the entry where a list draws rows (at
   * most 120 chars): why it failed, or that it is being tried again. It takes
   * the place of a row, so a list with notes shows fewer entries. The featured
   * form does not draw it; its line under the entry is `subtitles`.
   */
  note?: string;
  /**
   * A duration in steady motion — capable renderers advance it in real
   * time between polls; the text floor (meta) must still carry a static
   * representation. state "paused" = not accruing.
   */
  elapsed?: { ms: number; ofMs?: number; state?: "running" | "paused" };
  /**
   * How far along this entry is, 0 to 100, for a quantity that is not time
   * in motion (a download, a conversion). Capable renderers draw a bar; the
   * text floor (meta) must still carry the figure.
   */
  progress?: number;
  /**
   * The entry's artwork as a data URI within `ctx.imageLimit`. When the widget's
   * background names this list, the card draws the image of the entry it has
   * on screen, so fetch a wide crop near the card's shape (about 660x260).
   * Data URIs ONLY: fetch and inline server-side; never emit app URLs (key
   * leak, mixed-content, off-LAN breakage).
   */
  image?: string;
}

/** One bar of a chart: a short label under it ("Mon", "sda", at most 12 chars) and its value (0 or more). */
export interface WidgetChartPoint {
  label: string;
  value: number;
}

/**
 * One named field of the result document (widgetsSchema 3). The
 * declaration's `slots` reference these fields by name; the card's background
 * names a standalone image field, or a list whose entries carry images (the
 * card then draws the image of the entry on screen). An image is never a slot.
 * Max 16 fields; images are
 * data URIs within `ctx.imageLimit`, text is capped at 500 chars.
 */
export type WidgetFieldValue =
  | { type: "text"; text: string }
  | { type: "stat"; label: string; value: string }
  | { type: "list"; entries: WidgetListEntry[] }
  | { type: "image"; image: string; alt?: string }
  /** A bounded quantity: `value` is 0 to 100, `text` the caption beside the label ("3.2 GB of 5 GB", max 60 chars). */
  | { type: "progress"; label: string; value: number; text?: string }
  /**
   * A few values side by side, 2 to 7 points, the highest labelled. `axis` says what the points
   * are: moments in order (`time`, plays by weekday) are drawn as a line, separate things
   * (`category`, the default: a temperature per disk) as columns. `unit` follows a value where one
   * is spelled out ("plays", "°C", max 20 chars). `tone` colours columns by value: green at `good`
   * and beyond, red at `bad` and beyond, amber halfway (either may be the larger). A chart of all
   * zeros says nothing, so leave the field out.
   */
  | {
      type: "chart";
      points: WidgetChartPoint[];
      unit?: string;
      axis?: "time" | "category";
      tone?: { good: number; bad: number };
    };

/**
 * What a widget script returns: named fields the card's slots project
 * from. One widget is ONE query. Return `needsSetup` (with a human reason)
 * when the data source isn't usable yet. Harvest credentials first:
 * needs-setup is the fallback, not the default. Field names must be STABLE
 * (slots reference them); dynamic collections (users, library sections)
 * ride as `list` entries.
 */
export interface WidgetQueryResult {
  needsSetup?: boolean;
  reason?: string;
  fields?: Record<string, WidgetFieldValue>;
}
