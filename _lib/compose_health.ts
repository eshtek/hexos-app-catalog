// A catalog-only authoring rule for version-7 scripts, kept apart from compose.ts (the hand-synced
// mirror of the platform's compose subset): the box accepts a script without it.
//
// When a container waits for another to be healthy (`depends_on: <service>: condition:
// service_healthy`), compose fails the whole install if that service is still unhealthy when its
// health check runs out of start period and retries, and TrueNAS then removes the app. A first
// start can be far slower than later ones: when an image changes the owner of its own files at
// start, overlayfs copies each of them into the container's layer, and OpenZFS waits for a whole
// transaction group to reach the disks on every copy. On a server whose apps live on hard drives
// that is about a second per file. So, as a catalog authoring policy, every service another one
// waits on names its own start period and keeps a working check. The rule can't tell whether the
// period is long enough: that takes a first start on hard drives in the lab.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const DURATION_UNIT_SECONDS: Record<string, number> = {
  ns: 1e-9,
  us: 1e-6,
  "\u00b5s": 1e-6,
  ms: 1e-3,
  s: 1,
  m: 60,
  h: 3600,
};

/** The longest duration Go (and so compose) can hold, about 292 years: a longer one is refused there. */
const MAX_DURATION_SECONDS = 9_223_372_036.854775807;

/**
 * A compose duration such as `90s`, `1.5m`, `500ms` or `1h30m`, in seconds, or null when it isn't
 * one. Compose reads it with Go's time.ParseDuration: one or more decimal numbers, each with a unit.
 */
export function composeDurationSeconds(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "" || !/^(?:(?:\d+(?:\.\d*)?|\.\d+)(?:ns|us|\u00b5s|ms|s|m|h))+$/.test(text)) return null;
  let total = 0;
  for (const [, amount, unit] of text.matchAll(/(\d+(?:\.\d*)?|\.\d+)(ns|us|\u00b5s|ms|s|m|h)/g)) {
    total += Number(amount) * DURATION_UNIT_SECONDS[unit];
  }
  return Number.isFinite(total) && total <= MAX_DURATION_SECONDS ? total : null;
}

/**
 * The longest start period allowed. TrueNAS stops a compose `up` after 1200 s (middleware
 * `compose_utils.py`), and HexOS fails an install whose queued steps have waited about 15 minutes,
 * so the check must be able to call a broken start unhealthy well inside both.
 */
export const MAX_START_PERIOD_SECONDS = 12 * 60;

/** The services some other service waits on with `condition: service_healthy`. */
export function healthGatedServices(appValues: unknown): string[] {
  if (!isRecord(appValues) || !isRecord(appValues.services)) return [];
  const gated = new Set<string>();
  for (const definition of Object.values(appValues.services)) {
    const dependsOn = isRecord(definition) ? definition.depends_on : undefined;
    if (!isRecord(dependsOn)) continue;
    for (const [target, condition] of Object.entries(dependsOn)) {
      if (isRecord(condition) && condition.condition === "service_healthy") gated.add(target);
    }
  }
  return [...gated];
}

const checkDisabled = (healthcheck: Record<string, unknown>) => {
  if (healthcheck.disable === true) return true;
  const test = healthcheck.test;
  return (Array.isArray(test) && test[0] === "NONE") || test === "NONE";
};

/** Why a version-7 script's health-gated services would fail a slow first start, as sentences. */
export function healthGateProblems(appValues: unknown): string[] {
  if (!isRecord(appValues) || !isRecord(appValues.services)) return [];
  const problems: string[] = [];
  for (const service of healthGatedServices(appValues)) {
    const definition = appValues.services[service];
    const healthcheck = isRecord(definition) && isRecord(definition.healthcheck) ? definition.healthcheck : undefined;
    if (healthcheck && checkDisabled(healthcheck)) {
      problems.push(`${service}: another service waits for it to be healthy, so its health check can't be disabled`);
      continue;
    }
    const seconds = composeDurationSeconds(healthcheck?.start_period);
    if (seconds !== null && seconds > MAX_START_PERIOD_SECONDS) {
      problems.push(
        `${service}: healthcheck.start_period is longer than 12 minutes: TrueNAS gives up on a compose start after ` +
          "20 minutes and HexOS fails an install whose steps wait about 15, so a longer period never runs out " +
          "and a broken start would fail without saying why",
      );
      continue;
    }
    if (seconds === null || seconds <= 0) {
      problems.push(
        `${service}: another service waits for it to be healthy, so set healthcheck.start_period (for example "10m"): ` +
          "on hard drives a first start can take minutes longer than the image's own health check allows, " +
          "because each image file the container changes is copied up with a full ZFS sync",
      );
    }
  }
  return problems;
}
