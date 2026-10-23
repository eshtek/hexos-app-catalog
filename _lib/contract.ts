// Hand-synced mirror of the install-script contract in hexos-platform
// (packages/shared/eshtek/apps.ts, packages/shared/eshtek/preferences.ts,
// packages/shared/eshtek/hooks.ts, packages/backend/src/lib/macros.ts).
//
// The catalog is public and the platform is private, so CI cannot import the
// real types. Everything the validator enforces is duplicated here instead, in
// one place, so a drift fix is a single edit rather than a hunt through checks.

/** LocationPreferenceId — the only names $LOCATION() can resolve. */
export const LOCATIONS = [
  "ApplicationsPerformance",
  "ApplicationsCapacity",
  "Downloads",
  "Documents",
  "Media",
  "Photos",
  "Music",
  "Movies",
  "Shows",
  "Videos",
  "VirtualizationPerformance",
  "VirtualizationCapacity",
  "InstallMedia",
  "VirtualDisks",
] as const;

/** APP_SPEC_REGEX. DISPLAY: the app draws on a TV or monitor plugged into the server. */
export const SPEC_REGEX = /^(\d+)(MBRAM|GBRAM|MB|GB|CORE)$|^GPU$|^DISPLAY$/;

/** AppPermission. */
export const PERMISSIONS = ["READ_WRITE_LOCATIONS"] as const;

/** InstallationQuestionType. */
export const QUESTION_TYPES = ["text", "number", "select", "boolean", "password"] as const;

/** HookEvent. */
export const HOOK_EVENTS = [
  "onBeforeInstall",
  "onAfterInstall",
  "onBeforeUpgrade",
  "onAfterUpgrade",
  "action",
] as const;

/** Install-script versions the backend still parses (appsInstallScriptSchema). */
export const SUPPORTED_VERSIONS = [4, 5, 6] as const;

/** Macros taking parenthesised arguments. */
export const CALL_MACROS = [
  "IF",
  "QUESTION",
  "MEMORY",
  "CPUS",
  "RANDOM_STRING",
  "HOST_PATH",
  "MOUNTED_HOST_PATH",
  "LOCATION",
  "APP_INSTALLED",
  "GPU_CONFIG",
  // A partner app's per-install credential, issued by the platform at install time. The argument
  // is the partner id; empty means the app being installed.
  "PARTNER_TOKEN",
  // A display app's devices (its card's DRM and HDMI audio nodes, plus input), its card's slot, its
  // TrueNAS GPU selection (an NVIDIA card by UUID), and the port it shows on ("HDMI-A:1").
  "DISPLAY_DEVICES",
  "DISPLAY_GPU_PCI",
  "DISPLAY_GPU_CONFIG",
  "DISPLAY_PORT",
] as const;

/** Macros substituted as bare tokens, with no argument list. */
export const BARE_MACROS = ["SERVER_LAN_IP", "SERVER_HOST_ID"] as const;

// --- v6 hook contract ---

/** HookKind — descriptive taxonomy (surfaces, icons, grouping). */
export const HOOK_KINDS = ["connect", "maintain", "custom"] as const;

/** HookEventSpec — what goes in v6 hooks' `events` array. */
export const HOOK_EVENT_SPECS = [
  "userAction",
  "onBeforeInstall",
  "onAfterInstall",
  "onBeforeUpgrade",
  "onAfterUpgrade",
] as const;

/** HookRerun — re-run semantics for user-triggerable hooks. */
export const HOOK_RERUNS = ["idempotent", "converge", "refuse"] as const;

/** HookSurface — where a hook can appear. */
export const HOOK_SURFACES = ["installPicker", "card", "fileBrowser", "widget"] as const;

/** Known hook condition types. Unknown types are accepted (fail closed at runtime). */
export const HOOK_CONDITION_TYPES = [
  "appInstalled",
  "appRunning",
  "appVersion",
  "capabilityPresent",
  "script",
] as const;

/** HookConditionRole. */
export const HOOK_CONDITION_ROLES = ["visibility", "availability"] as const;

/** Hook target types. */
export const HOOK_TARGET_TYPES = ["files"] as const;

// --- v6 widget contract ---

/**
 * Supported widgetsSchema version. In 3 a widget is the app's dashboard card,
 * so its `slots` and `background` sit on the declaration itself; the `sizes`
 * of 2 are gone.
 */
export const SUPPORTED_WIDGETS_SCHEMA = 3;

/** Widget slot types. An image is never a slot: the card's artwork is its background. */
export const WIDGET_SLOT_TYPES = ["text", "stat", "list", "progress", "chart"] as const;

/**
 * Most slides a widget adds after its own title and slots. A box from before
 * slides draws the first view alone, so that view must stand on its own.
 */
export const WIDGET_MAX_SLIDES = 3;

/** The shortest widget `refresh` the platform honours, in seconds: one deck poll (MIN_REFRESH_S). */
export const WIDGET_MIN_REFRESH_S = 5;

/** Most slots a widget declares. */
export const WIDGET_MAX_SLOTS = 3;
