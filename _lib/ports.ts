// The ports an install script publishes, and the rules that keep what it says about them true.
//
// A script states its ports twice: requirements.ports is what HexOS reads (the first one is where it
// reaches the app), and the pins in app_values are what TrueNAS applies. A pin anywhere else is never
// applied, so the chart's default is published in its place. TrueNAS refuses a port another app holds
// and compares the number alone, so 53/udp and 53/tcp clash: every comparison here ignores protocol.
//
// A pin is a number, which stays where it is, or "$PORT(n)", which prefers n and lets HexOS move it to
// a free port. Everything here is pure: validate.ts reads the files and reports what comes back.

export type Script = Record<string, unknown>;

export type Finding = { level: "error" | "warning"; message: string };

/** One thing a script publishes: a port, or a range of them that a chart publishes one by one. */
export type PublishedPort = {
  /** Where the pin sits in the script. */
  path: string;
  /** Only what the script itself says: a chart often publishes one pin as both tcp and udp. */
  protocol?: string;
  /** Written as $PORT, so HexOS may move it. A range moves only with both ends written that way. */
  movable: boolean;
} & ({ port: number } | { start: number; end: number });

type Pin = { path: string; protocol?: string } & ({ value: unknown } | { start: unknown; end: unknown });

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isPort = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535;

const error = (message: string): Finding => ({ level: "error", message });
const warning = (message: string): Finding => ({ level: "warning", message });

/** A value that is $PORT(n) and nothing else. */
const WHOLE_MACRO = /^\$PORT\((\d+)\)$/;

/** The number a $PORT(n) pin prefers. Any other value is handed back as it is. */
export const preferredPort = (value: unknown): unknown => {
  const macro = typeof value === "string" ? value.match(WHOLE_MACRO) : null;
  return macro ? Number(macro[1]) : value;
};

/** A question's default: all a pin that asks the owner can be checked against. */
function questionDefault(script: Script, key: string): unknown {
  const questions = Array.isArray(script.installation_questions) ? script.installation_questions.filter(isObject) : [];
  return questions.find((q) => q.key === key)?.default;
}

/** A pin's number, or null when it can't be told. Vaultwarden writes its pin as a string, "30032". */
function readPort(value: unknown, script: Script): { port: number; movable: boolean } | null {
  const preferred = preferredPort(value);
  if (preferred !== value) return isPort(preferred) ? { port: preferred, movable: true } : null;
  const question = typeof value === "string" ? value.match(/^\$QUESTION\(\s*["']?([^"',)\s]+)/) : null;
  const written = question ? questionDefault(script, question[1]) : value;
  const port = typeof written === "string" && /^\d+$/.test(written) ? Number(written) : written;
  return isPort(port) ? { port, movable: false } : null;
}

const appValuesOf = (script: Script) => (isObject(script.app_values) ? script.app_values : {});
const networkOf = (script: Script) => {
  const values = appValuesOf(script);
  return isObject(values.network) ? values.network : {};
};

/** The app listens on the box directly, so what it binds isn't limited to what the script pins. */
export const usesHostNetwork = (script: Script): boolean =>
  appValuesOf(script).host_network === true || networkOf(script).host_network === true;

/** A chart publishes a port by default, so only a bind_mode that says otherwise (exposed) opts out. */
const isPublished = (entry: Record<string, unknown>) => entry.bind_mode === undefined || entry.bind_mode === "published";

const withProtocol = (entry: Record<string, unknown>) =>
  typeof entry.protocol === "string" ? { protocol: entry.protocol } : {};

/** Every pin the script makes, read or not. */
function* pins(script: Script): Generator<Pin> {
  const network = networkOf(script);
  const values = appValuesOf(script);
  const entries = function* (list: unknown): Generator<[number, Record<string, unknown>]> {
    for (const [i, entry] of (Array.isArray(list) ? list : []).entries()) {
      if (isObject(entry) && isPublished(entry)) yield [i, entry];
    }
  };

  // Named by the chart: web_port, http_port, api_port and so on
  for (const [key, entry] of Object.entries(network)) {
    if (isObject(entry) && entry.port_number !== undefined && isPublished(entry)) {
      yield { path: `app_values.network.${key}.port_number`, ...withProtocol(entry), value: entry.port_number };
    }
  }
  for (const [i, entry] of entries(network.additional_ports)) {
    yield { path: `app_values.network.additional_ports[${i}].port_number`, ...withProtocol(entry), value: entry.port_number };
  }
  for (const [i, entry] of entries(network.additional_port_ranges)) {
    yield { path: `app_values.network.additional_port_ranges[${i}]`, ...withProtocol(entry), start: entry.start, end: entry.end };
  }
  // A custom app runs on the ix-app chart, whose pins sit directly in app_values
  for (const [i, entry] of entries(values.ports)) {
    yield { path: `app_values.ports[${i}].port_number`, ...withProtocol(entry), value: entry.port_number };
  }
  // A portal is only a link, but with host networking it's the one place the app's port is written
  if (usesHostNetwork(script)) {
    for (const [i, entry] of entries(values.portals)) {
      yield { path: `app_values.portals[${i}].port`, value: entry.port };
    }
  }
}

function readPin(pin: Pin, script: Script): PublishedPort | null {
  const { path } = pin;
  const protocol = pin.protocol === undefined ? {} : { protocol: pin.protocol };
  if ("value" in pin) {
    const read = readPort(pin.value, script);
    return read && { path, ...protocol, port: read.port, movable: read.movable };
  }
  const [start, end] = [readPort(pin.start, script), readPort(pin.end, script)];
  if (!start || !end || start.port > end.port) return null;
  return { path, ...protocol, start: start.port, end: end.port, movable: start.movable && end.movable };
}

/** Everything the script publishes that can be read. A pin that can't be is refused by declaredPortsMatchPins. */
export function publishedPorts(script: Script): PublishedPort[] {
  return [...pins(script)].flatMap((pin) => readPin(pin, script) ?? []);
}

const members = (published: PublishedPort): number[] =>
  "port" in published
    ? [published.port]
    : Array.from({ length: published.end - published.start + 1 }, (_, i) => published.start + i);

function declaredPorts(script: Script): Set<number> {
  const requirements = isObject(script.requirements) ? script.requirements : {};
  return new Set(Array.isArray(requirements.ports) ? requirements.ports.filter(isPort) : []);
}

/** The ports a script holds on a box: fixed, or preferred and free to move. */
function footprint(script: Script) {
  const fixed = new Set<number>();
  const preferred = new Set<number>();
  for (const published of publishedPorts(script)) {
    for (const port of members(published)) (published.movable ? preferred : fixed).add(port);
  }
  // What a host-network app declares beyond its pins, it binds all the same
  if (usesHostNetwork(script)) {
    for (const port of declaredPorts(script)) if (!preferred.has(port)) fixed.add(port);
  }
  return { fixed, preferred };
}

/** 25565, 25566, 25567 and 19132 read as "19132, 25565-25567". */
function listPorts(ports: Iterable<number>): string {
  const spans: [number, number][] = [];
  for (const port of [...new Set(ports)].sort((a, b) => a - b)) {
    const last = spans[spans.length - 1];
    if (last && last[1] === port - 1) last[1] = port;
    else spans.push([port, port]);
  }
  return spans.map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`)).join(", ");
}

const shared = (a: Set<number>, b: Set<number>) => [...a].filter((port) => b.has(port));

function pairs<T>(items: T[]): [T, T][] {
  return items.flatMap((a, i) => items.slice(i + 1).map((b): [T, T] => [a, b]));
}

/** Each script in the catalog with its footprint, by app id. */
const footprints = (scripts: ReadonlyMap<string, Script>) =>
  [...scripts.keys()].sort().map((app) => ({ app, ...footprint(scripts.get(app)!) }));

/**
 * Rule (a): requirements.ports and the pins say the same thing, both ways. A range counts member by
 * member, as Crafty 4 lists its Java range one port at a time. A host-network app's other direction
 * can't be checked, because it binds ports without pinning them, so its list is the only record of
 * them: it must exist and hold every pin, and nothing is asked of the rest.
 */
export function declaredPortsMatchPins(script: Script): Finding[] {
  const requirements = isObject(script.requirements) ? script.requirements : {};
  if (!Array.isArray(requirements.ports)) return []; // the validator refuses this already
  const declared = declaredPorts(script);
  const published = new Set<number>();
  const findings: Finding[] = [];
  for (const pin of pins(script)) {
    const read = readPin(pin, script);
    if (!read) {
      findings.push(error(`${pin.path}: can't tell what this publishes; pin a port, $PORT(n), a question with a port for its default, or a range from low to high`));
      continue;
    }
    const ports = members(read);
    for (const port of ports) published.add(port);
    const undeclared = ports.filter((port) => !declared.has(port));
    if (undeclared.length > 0) {
      findings.push(error(`${pin.path} publishes ${listPorts(undeclared)}, which requirements.ports doesn't declare`));
    }
  }
  if (usesHostNetwork(script)) {
    if (declared.size === 0) findings.push(error("a host-network app binds ports it doesn't pin, so requirements.ports must list all of them"));
    return findings;
  }
  const unpublished = [...declared].filter((port) => !published.has(port));
  if (unpublished.length > 0) {
    findings.push(error(`requirements.ports declares ${listPorts(unpublished)}, which nothing pins; pin it in app_values under the chart's own key`));
  }
  return findings;
}

/** A network block's mark: a pin, or one of the keys only a network block has. */
const holdsPins = (value: unknown) =>
  isObject(value) &&
  ("additional_ports" in value ||
    "additional_port_ranges" in value ||
    "host_network" in value ||
    Object.values(value).some((entry) => isObject(entry) && "port_number" in entry));

/** Rule (b): network sits in app_values, the only part of a script that reaches the chart. */
export function networkInsideAppValues(script: Script): Finding[] {
  const findings: Finding[] = [];
  if (script.network !== undefined) {
    findings.push(error("network sits outside app_values, so none of its pins are applied; move it to app_values.network"));
  }
  const search = (value: unknown, path: string) => {
    if (!isObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (path === "app_values" && key === "network") continue;
      if (key === "network" && holdsPins(child)) {
        findings.push(error(`${path}.network is not app_values.network, so none of its pins are applied; move it there`));
      } else {
        search(child, `${path}.${key}`);
      }
    }
  };
  search(script.app_values, "app_values");
  return findings;
}

/**
 * Rule (c): a collection installs its apps in one walk, so a port that can't move must have only one
 * app after it, or the walk stops at the refused install. Another app's $PORT counts: when that app
 * goes first it takes the port. Two options of a `single` group are never picked together.
 */
export function collectionPortClashes(collection: Script, scripts: ReadonlyMap<string, Script>): Finding[] {
  const groups = Array.isArray(collection.groups) ? collection.groups.filter(isObject) : [];
  const picks = groups.flatMap((group) =>
    (Array.isArray(group.options) ? group.options.filter(isObject) : []).flatMap((option) => {
      const script = typeof option.app === "string" ? scripts.get(option.app) : undefined;
      return script ? [{ app: option.app as string, group, ...footprint(script) }] : [];
    }),
  );
  const findings: Finding[] = [];
  for (const [a, b] of pairs(picks)) {
    if (a.app === b.app || (a.group === b.group && a.group.type === "single")) continue;
    const clash = [...shared(a.fixed, b.fixed), ...shared(a.fixed, b.preferred), ...shared(a.preferred, b.fixed)];
    if (clash.length > 0) {
      findings.push(error(`${a.app} and ${b.app} both want ${listPorts(clash)} and at least one of them can't move, so TrueNAS would refuse the second install`));
    }
  }
  return findings;
}

/** Rule (d): two scripts that fix the same port can't share a box, and the box says so at install. */
export function catalogFixedPortClashes(scripts: ReadonlyMap<string, Script>): Finding[] {
  return pairs(footprints(scripts)).flatMap(([a, b]) => {
    const clash = shared(a.fixed, b.fixed);
    return clash.length > 0 ? [warning(`${a.app} and ${b.app} both fix ${listPorts(clash)}: the box refuses whichever is installed second`)] : [];
  });
}

/** Rule (e): a preferred port another script also wants. The box moves it, unless the other can't move. */
export function catalogPreferredPortClashes(scripts: ReadonlyMap<string, Script>): Finding[] {
  return pairs(footprints(scripts)).flatMap(([a, b]) => {
    const findings: Finding[] = [];
    const bothPrefer = shared(a.preferred, b.preferred);
    if (bothPrefer.length > 0) {
      findings.push(warning(`${a.app} and ${b.app} both prefer ${listPorts(bothPrefer)}: the box moves whichever is installed second`));
    }
    for (const [prefers, fixes] of [[a, b], [b, a]] as const) {
      const clash = shared(prefers.preferred, fixes.fixed);
      if (clash.length > 0) {
        findings.push(warning(`${prefers.app} prefers ${listPorts(clash)}, which ${fixes.app} fixes: the box moves ${prefers.app} when ${fixes.app} got there first, and refuses ${fixes.app} when it didn't`));
      }
    }
    return findings;
  });
}

function* stringLeaves(value: unknown, path = ""): Generator<{ path: string; value: string }> {
  if (typeof value === "string") {
    yield { path, value };
  } else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) yield* stringLeaves(v, `${path}[${i}]`);
  } else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) yield* stringLeaves(v, path ? `${path}.${k}` : k);
  }
}

/**
 * Rule (f): every $PORT names a port from requirements.ports, the script's list of preferred numbers,
 * and is written exactly as $PORT(n). A range moves as one block, so one movable end would stretch or
 * shrink it.
 */
export function portMacrosWellFormed(script: Script): Finding[] {
  const findings: Finding[] = [];
  const declared = declaredPorts(script);
  for (const { path, value } of stringLeaves(script)) {
    for (const [macro, argument] of value.matchAll(/\$PORT(?![A-Z_])(?:\(([^()]*)\))?/g)) {
      if (argument === undefined || !/^[1-9]\d*$/.test(argument) || !isPort(Number(argument))) {
        findings.push(error(`${path}: "${macro}" is malformed; write $PORT(n), with n a port from 1 to 65535`));
      } else if (!declared.has(Number(argument))) {
        findings.push(error(`${path}: ${macro} names a port requirements.ports doesn't declare`));
      }
    }
  }
  for (const pin of pins(script)) {
    if ("value" in pin) continue;
    const movableEnds = [pin.start, pin.end].filter((end) => preferredPort(end) !== end).length;
    if (movableEnds === 1) {
      findings.push(error(`${pin.path}: a range moves as one block, so start and end are both $PORT(n) or both fixed`));
    }
  }
  return findings;
}
