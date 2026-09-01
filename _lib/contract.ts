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

/** APP_SPEC_REGEX. */
export const SPEC_REGEX = /^(\d+)(MBRAM|GBRAM|MB|GB|CORE)$|^GPU$/;

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
  "RANDOM_STRING",
  "HOST_PATH",
  "MOUNTED_HOST_PATH",
  "LOCATION",
  "APP_INSTALLED",
  "GPU_CONFIG",
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

/** Supported widgetsSchema version. */
export const SUPPORTED_WIDGETS_SCHEMA = 2;

/** Widget slot types. */
export const WIDGET_SLOT_TYPES = ["text", "stat", "list", "image"] as const;
