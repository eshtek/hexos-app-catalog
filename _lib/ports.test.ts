import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  catalogFixedPortClashes,
  catalogPreferredPortClashes,
  collectionPortClashes,
  declaredPortsMatchPins,
  networkInsideAppValues,
  portMacrosWellFormed,
  preferredPort,
  publishedPorts,
  usesHostNetwork,
  type Script,
} from "./ports";

const pin = (port_number: unknown, extra: Record<string, unknown> = {}) => ({ bind_mode: "published", port_number, ...extra });

/** A chart app: its declared ports and what sits in app_values.network. */
const app = (ports: number[], network: Record<string, unknown>, extra: Script = {}): Script => ({
  requirements: { ports },
  app_values: { network },
  ...extra,
});
const webApp = (port: unknown, declared: number[] = [preferredPort(port) as number]) => app(declared, { web_port: pin(port) });

const hostApp = (ports: number[], portalPort: number): Script => ({
  custom: true,
  requirements: { ports },
  app_values: { host_network: true, portals: [{ name: "Web UI", port: portalPort }] },
});

// Crafty 4 as it ships: its Java range is listed member by member
const javaPorts = Array.from({ length: 11 }, (_, i) => 25565 + i);
const crafty = (start: unknown = 25565, end: unknown = 25575) =>
  app([30146, ...javaPorts, 19132], {
    host_network: false,
    web_port: pin(30146, { host_ips: [] }),
    additional_ports: [pin(19132, { host_ips: [], container_port: 19132, protocol: "udp" })],
    additional_port_ranges: [{ bind_mode: "published", host_ips: [], protocol: "tcp", start, end }],
  });

const messages = (findings: { message: string }[]) => findings.map((finding) => finding.message);
const levels = (findings: { level: string }[]) => [...new Set(findings.map((finding) => finding.level))];

describe("publishedPorts", () => {
  test("reads a named pin with its path", () => {
    expect(publishedPorts(webApp(30025))).toEqual([{ path: "app_values.network.web_port.port_number", port: 30025, movable: false }]);
  });

  test("reads every named key, with or without a bind_mode", () => {
    const script = app([], {
      api_port: pin(30443),
      rcon_port: pin(38212),
      vnc_port: { port_number: 30044 },
      influxdb_port: pin(31055),
      networks: [],
      host_network: false,
      certificate_id: 1,
    });
    expect(publishedPorts(script).map((p) => ("port" in p ? p.port : null))).toEqual([30443, 38212, 30044, 31055]);
  });

  test("leaves out a port the chart doesn't publish on the box", () => {
    expect(publishedPorts(app([], { daemon_port: pin(58846, { bind_mode: "" }), web_port: pin(1, { bind_mode: "exposed" }) }))).toEqual([]);
    expect(publishedPorts(app([], { additional_ports: [pin(1, { bind_mode: "exposed" })] }))).toEqual([]);
  });

  test("reads additional_ports with their protocol", () => {
    expect(publishedPorts(app([], { additional_ports: [pin(19132, { protocol: "udp" })] }))).toEqual([
      { path: "app_values.network.additional_ports[0].port_number", protocol: "udp", port: 19132, movable: false },
    ]);
  });

  test("reads additional_port_ranges as a range", () => {
    const ranges = publishedPorts(crafty()).filter((p) => "start" in p);
    expect(ranges).toEqual([{ path: "app_values.network.additional_port_ranges[0]", protocol: "tcp", start: 25565, end: 25575, movable: false }]);
  });

  test("a range is movable only with both ends movable", () => {
    const range = (start: unknown, end: unknown) => publishedPorts(crafty(start, end)).find((p) => "start" in p);
    expect(range("$PORT(25565)", "$PORT(25575)")).toMatchObject({ start: 25565, end: 25575, movable: true });
    expect(range("$PORT(25565)", 25575)).toMatchObject({ start: 25565, end: 25575, movable: false });
  });

  test("reads a custom app's ports from app_values, as Valheim writes them", () => {
    const script = {
      custom: true,
      app_values: { host_network: false, ports: [pin(2456, { container_port: 2456, protocol: "udp", host_ips: [] })] },
    };
    expect(publishedPorts(script)).toEqual([{ path: "app_values.ports[0].port_number", protocol: "udp", port: 2456, movable: false }]);
  });

  test("reads portals under host networking, and only there", () => {
    expect(publishedPorts(hostApp([8080], 8080))).toEqual([{ path: "app_values.portals[0].port", port: 8080, movable: false }]);
    const linkOnly = { custom: true, app_values: { host_network: false, portals: [{ port: 8080 }] } };
    expect(publishedPorts(linkOnly)).toEqual([]);
  });

  test("marks $PORT movable and reads its number", () => {
    expect(publishedPorts(webApp("$PORT(30146)"))).toEqual([{ path: "app_values.network.web_port.port_number", port: 30146, movable: true }]);
  });

  test("reads a number written as a string, as Vaultwarden does", () => {
    expect(publishedPorts(webApp("30032", [30032]))).toMatchObject([{ port: 30032, movable: false }]);
  });

  test("reads a pin that asks the owner at its default, as Uptime Kuma does", () => {
    const script = webApp("$QUESTION(web_port)", [31050]);
    script.installation_questions = [{ key: "web_port", type: "number", default: 31050 }];
    expect(publishedPorts(script)).toMatchObject([{ port: 31050, movable: false }]);
  });

  test("leaves out what it can't read, and survives a script with no app_values", () => {
    expect(publishedPorts(webApp("$QUESTION(nothing)", []))).toEqual([]);
    expect(publishedPorts(webApp("$PORT(99999)", []))).toEqual([]);
    expect(publishedPorts(webApp("not a port", []))).toEqual([]);
    expect(publishedPorts(crafty(25575, 25565)).filter((p) => "start" in p)).toEqual([]);
    expect(publishedPorts({})).toEqual([]);
    expect(publishedPorts({ app_values: "nope" })).toEqual([]);
  });

  test("doesn't read a misplaced network: nothing applies it", () => {
    expect(publishedPorts({ network: { web_port: pin(1) }, app_values: {} })).toEqual([]);
  });
});

describe("usesHostNetwork", () => {
  test("is read from either place a script sets it", () => {
    expect(usesHostNetwork(hostApp([8080], 8080))).toBe(true);
    expect(usesHostNetwork(app([], { host_network: true }))).toBe(true);
    expect(usesHostNetwork(app([], { host_network: false }))).toBe(false);
    expect(usesHostNetwork({})).toBe(false);
  });
});

describe("preferredPort", () => {
  test("reads $PORT(n) and hands everything else back", () => {
    expect(preferredPort("$PORT(30025)")).toBe(30025);
    expect(preferredPort(30025)).toBe(30025);
    expect(preferredPort("30032")).toBe("30032");
    expect(preferredPort("http://x:$PORT(30025)")).toBe("http://x:$PORT(30025)");
    expect(preferredPort(undefined)).toBeUndefined();
  });
});

describe("declaredPortsMatchPins", () => {
  test("declared and pinned agree", () => {
    expect(declaredPortsMatchPins(webApp(30025))).toEqual([]);
    expect(declaredPortsMatchPins(app([30024, 51413], { web_port: pin(30024), bt_port: pin(51413) }))).toEqual([]);
  });

  test("a $PORT pin matches the number it prefers", () => {
    expect(declaredPortsMatchPins(webApp("$PORT(30146)"))).toEqual([]);
  });

  test("a pin nobody declared is refused", () => {
    const findings = declaredPortsMatchPins(app([30024], { web_port: pin(30024), bt_port: pin(51413) }));
    expect(levels(findings)).toEqual(["error"]);
    expect(messages(findings)).toEqual(["app_values.network.bt_port.port_number publishes 51413, which requirements.ports doesn't declare"]);
  });

  test("a declared port nothing pins is refused", () => {
    const findings = declaredPortsMatchPins(app([30024, 51413], { web_port: pin(30024) }));
    expect(levels(findings)).toEqual(["error"]);
    expect(messages(findings)[0]).toContain("declares 51413, which nothing pins");
  });

  test("a port the chart doesn't publish isn't pinned, whatever it says", () => {
    expect(messages(declaredPortsMatchPins(app([58846], { daemon_port: pin(58846, { bind_mode: "exposed" }) })))[0]).toContain("declares 58846");
  });

  test("a script whose network is misplaced publishes nothing", () => {
    const misplaced = { requirements: { ports: [30224] }, app_values: {}, network: { web_port: pin(30224) } };
    expect(messages(declaredPortsMatchPins(misplaced))[0]).toContain("declares 30224, which nothing pins");
  });

  test("a range's members are listed one by one, as Crafty 4 lists them", () => {
    expect(declaredPortsMatchPins(crafty())).toEqual([]);
    expect(declaredPortsMatchPins(crafty("$PORT(25565)", "$PORT(25575)"))).toEqual([]);
  });

  test("a range with members left out of the list is refused, naming them", () => {
    const short = crafty();
    (short.requirements as { ports: number[] }).ports = [30146, 19132, 25565, 25566];
    expect(messages(declaredPortsMatchPins(short))).toEqual([
      "app_values.network.additional_port_ranges[0] publishes 25567-25575, which requirements.ports doesn't declare",
    ]);
  });

  test("a port past a range's end is declared but unpinned", () => {
    expect(messages(declaredPortsMatchPins(crafty(25565, 25574)))[0]).toContain("declares 25575, which nothing pins");
  });

  test("a host-network app may declare more than it pins", () => {
    expect(declaredPortsMatchPins(hostApp([8080, 9090, 9777], 8080))).toEqual([]);
  });

  test("a host-network app must still declare its portal", () => {
    expect(messages(declaredPortsMatchPins(hostApp([9090], 8080)))[0]).toContain("app_values.portals[0].port publishes 8080");
  });

  test("a host-network app must declare something", () => {
    const findings = declaredPortsMatchPins({ requirements: { ports: [] }, app_values: { host_network: true } });
    expect(levels(findings)).toEqual(["error"]);
    expect(messages(findings)[0]).toContain("must list all of them");
  });

  test("a chart app on host networking is held to the same rule", () => {
    expect(declaredPortsMatchPins(app([8080, 9090], { host_network: true, web_port: pin(8080) }))).toEqual([]);
    expect(declaredPortsMatchPins(app([9090], { host_network: true, web_port: pin(8080) }))).toHaveLength(1);
  });

  test("a custom app's ports match too", () => {
    const valheim = (ports: number[]) => ({ custom: true, requirements: { ports }, app_values: { ports: [pin(2456, { protocol: "udp" })] } });
    expect(declaredPortsMatchPins(valheim([2456]))).toEqual([]);
    expect(declaredPortsMatchPins(valheim([2456, 2457]))).toHaveLength(1);
  });

  test("a pin that asks the owner matches its default, and only that", () => {
    const script = (fallback: unknown) => ({ ...webApp("$QUESTION(web_port)", [31050]), installation_questions: [{ key: "web_port", default: fallback }] });
    expect(declaredPortsMatchPins(script(31050))).toEqual([]);
    expect(declaredPortsMatchPins(script("31050"))).toEqual([]);
    expect(messages(declaredPortsMatchPins(script(31051)))[0]).toContain("publishes 31051");
  });

  test("a pin that can't be read is refused, not skipped", () => {
    for (const unreadable of ["$QUESTION(nothing)", "soon", "$PORT(99999)", 0, 70000, 1.5, true]) {
      const findings = declaredPortsMatchPins(webApp(unreadable, []));
      expect(levels(findings)).toEqual(["error"]);
      expect(messages(findings)[0]).toContain("can't tell what this publishes");
    }
  });

  test("a range that runs backwards is refused", () => {
    expect(messages(declaredPortsMatchPins(crafty(25575, 25565))).join()).toContain("can't tell what this publishes");
  });

  test("a script with no ports list is left to the validator", () => {
    expect(declaredPortsMatchPins({ app_values: { network: { web_port: pin(1) } } })).toEqual([]);
  });
});

describe("networkInsideAppValues", () => {
  test("app_values.network is where it goes", () => {
    expect(networkInsideAppValues(webApp(30025))).toEqual([]);
  });

  test("a network beside app_values is refused", () => {
    const findings = networkInsideAppValues({ app_values: {}, network: { web_port: pin(30224) } });
    expect(levels(findings)).toEqual(["error"]);
    expect(messages(findings)[0]).toContain("network sits outside app_values");
  });

  test("a network nested in the app's own group is refused, as SnapOtter had it", () => {
    const findings = networkInsideAppValues({ app_values: { snapotter: { network: { web_port: pin(30428) } } } });
    expect(levels(findings)).toEqual(["error"]);
    expect(messages(findings)[0]).toContain("app_values.snapotter.network");
  });

  test("nesting is found at any depth, and for every kind of pin", () => {
    expect(networkInsideAppValues({ app_values: { a: { b: { network: { web_port: pin(1) } } } } })).toHaveLength(1);
    expect(networkInsideAppValues({ app_values: { a: { network: { additional_ports: [] } } } })).toHaveLength(1);
    expect(networkInsideAppValues({ app_values: { a: { network: { additional_port_ranges: [] } } } })).toHaveLength(1);
    expect(networkInsideAppValues({ app_values: { a: { network: { host_network: true } } } })).toHaveLength(1);
  });

  test("a chart's own setting that happens to be called network is left alone", () => {
    expect(networkInsideAppValues({ app_values: { vpn: { network: "10.0.0.0/8" } } })).toEqual([]);
    expect(networkInsideAppValues({ app_values: { vpn: { network: { name: "wg0" } } } })).toEqual([]);
  });

  test("a script with no app_values is left to the validator", () => {
    expect(networkInsideAppValues({})).toEqual([]);
  });
});

describe("collectionPortClashes", () => {
  const collection = (...groups: { type: string; apps: string[] }[]): Script => ({
    groups: groups.map(({ type, apps }) => ({ type, options: apps.map((name) => ({ app: name })) })),
  });
  const scripts = (entries: Record<string, Script>) => new Map(Object.entries(entries));

  test("apps with their own ports are fine", () => {
    expect(collectionPortClashes(collection({ type: "multiple", apps: ["a", "b"] }), scripts({ a: webApp(1), b: webApp(2) }))).toEqual([]);
  });

  test("two apps fixing one port are refused", () => {
    const findings = collectionPortClashes(collection({ type: "multiple", apps: ["a", "b"] }), scripts({ a: webApp(8080), b: webApp(8080) }));
    expect(levels(findings)).toEqual(["error"]);
    expect(messages(findings)[0]).toContain("a and b both want 8080");
  });

  test("across groups too", () => {
    const groups = collection({ type: "fixed", apps: ["a"] }, { type: "single", apps: ["b"] });
    expect(collectionPortClashes(groups, scripts({ a: webApp(8080), b: webApp(8080) }))).toHaveLength(1);
  });

  test("a port inside another app's range counts", () => {
    const findings = collectionPortClashes(collection({ type: "multiple", apps: ["crafty", "minecraft"] }), scripts({ crafty: crafty(), minecraft: webApp(25570) }));
    expect(messages(findings)[0]).toContain("crafty and minecraft both want 25570");
  });

  test("protocol doesn't save a clash: TrueNAS compares the number alone", () => {
    const udp = app([53], { additional_ports: [pin(53, { protocol: "udp" })] });
    const tcp = app([53], { additional_ports: [pin(53, { protocol: "tcp" })] });
    expect(collectionPortClashes(collection({ type: "multiple", apps: ["a", "b"] }), scripts({ a: udp, b: tcp }))).toHaveLength(1);
  });

  test("a host-network app's undeclared-by-pin ports count", () => {
    const groups = collection({ type: "multiple", apps: ["kodi", "b"] });
    expect(collectionPortClashes(groups, scripts({ kodi: hostApp([8080, 9090], 8080), b: webApp(9090) }))).toHaveLength(1);
  });

  test("the options of one single group are never picked together", () => {
    expect(collectionPortClashes(collection({ type: "single", apps: ["a", "b"] }), scripts({ a: webApp(8080), b: webApp(8080) }))).toEqual([]);
  });

  test("two $PORT apps can share a preference: the box moves one", () => {
    const groups = collection({ type: "multiple", apps: ["a", "b"] });
    expect(collectionPortClashes(groups, scripts({ a: webApp("$PORT(8080)"), b: webApp("$PORT(8080)") }))).toEqual([]);
  });

  test("a fixed port and another app's $PORT clash, either way round: the $PORT app may get there first", () => {
    const groups = collection({ type: "multiple", apps: ["a", "b"] });
    expect(collectionPortClashes(groups, scripts({ a: webApp(8080), b: webApp("$PORT(8080)") }))).toHaveLength(1);
    expect(collectionPortClashes(groups, scripts({ a: webApp("$PORT(8080)"), b: webApp(8080) }))).toHaveLength(1);
  });

  test("one app's own ports don't clash with each other", () => {
    expect(collectionPortClashes(collection({ type: "multiple", apps: ["a"] }), scripts({ a: app([53], { dns: pin(53), dns_udp: pin(53, { protocol: "udp" }) }) }))).toEqual([]);
  });

  test("an app listed twice is the validator's to report, not its own clash", () => {
    const twice = collection({ type: "multiple", apps: ["a"] }, { type: "multiple", apps: ["a"] });
    expect(collectionPortClashes(twice, scripts({ a: webApp(8080) }))).toEqual([]);
  });

  test("an app with no script is the validator's to report", () => {
    expect(collectionPortClashes(collection({ type: "multiple", apps: ["a", "gone"] }), scripts({ a: webApp(1) }))).toEqual([]);
    expect(collectionPortClashes({}, scripts({ a: webApp(1) }))).toEqual([]);
  });
});

describe("catalogFixedPortClashes", () => {
  const catalog = (entries: Record<string, Script>) => new Map(Object.entries(entries));

  test("scripts with their own ports are fine", () => {
    expect(catalogFixedPortClashes(catalog({ a: webApp(1), b: webApp(2) }))).toEqual([]);
  });

  test("two scripts fixing one port is a warning", () => {
    const findings = catalogFixedPortClashes(catalog({ b: webApp(8080), a: webApp(8080), c: webApp(9000) }));
    expect(levels(findings)).toEqual(["warning"]);
    expect(messages(findings)).toEqual(["a and b both fix 8080: the box refuses whichever is installed second"]);
  });

  test("a port inside a range counts, and an overlap is named as a span", () => {
    const short = app([25570, 25571, 25572], { additional_port_ranges: [{ start: 25570, end: 25572 }] });
    expect(messages(catalogFixedPortClashes(catalog({ crafty: crafty(), other: short })))[0]).toContain("both fix 25570-25572");
  });

  test("protocol doesn't save a clash", () => {
    const udp = app([53], { additional_ports: [pin(53, { protocol: "udp" })] });
    expect(catalogFixedPortClashes(catalog({ a: webApp(53), b: udp }))).toHaveLength(1);
  });

  test("a host-network app counts, with what it declares beyond its portal", () => {
    expect(catalogFixedPortClashes(catalog({ kodi: hostApp([8080, 9090], 8080), a: webApp(8080), b: webApp(9090) }))).toHaveLength(2);
  });

  test("$PORT isn't fixed, so it's no business of this rule", () => {
    expect(catalogFixedPortClashes(catalog({ a: webApp("$PORT(8080)"), b: webApp(8080) }))).toEqual([]);
  });

  test("one script's own pins are no clash", () => {
    expect(catalogFixedPortClashes(catalog({ a: app([53], { dns: pin(53), dns_udp: pin(53, { protocol: "udp" }) }) }))).toEqual([]);
  });
});

describe("catalogPreferredPortClashes", () => {
  const catalog = (entries: Record<string, Script>) => new Map(Object.entries(entries));

  test("distinct preferences are fine", () => {
    expect(catalogPreferredPortClashes(catalog({ a: webApp("$PORT(1)"), b: webApp("$PORT(2)") }))).toEqual([]);
  });

  test("two scripts preferring one port is a warning", () => {
    const findings = catalogPreferredPortClashes(catalog({ a: webApp("$PORT(8080)"), b: webApp("$PORT(8080)") }));
    expect(levels(findings)).toEqual(["warning"]);
    expect(messages(findings)).toEqual(["a and b both prefer 8080: the box moves whichever is installed second"]);
  });

  test("a preference another script fixes is a warning too, naming who moves", () => {
    const findings = catalogPreferredPortClashes(catalog({ a: webApp(8080), b: webApp("$PORT(8080)") }));
    expect(levels(findings)).toEqual(["warning"]);
    expect(messages(findings)[0]).toContain("b prefers 8080, which a fixes");
  });

  test("a movable range's members count", () => {
    const findings = catalogPreferredPortClashes(catalog({ crafty: crafty("$PORT(25565)", "$PORT(25575)"), a: webApp("$PORT(25570)") }));
    expect(messages(findings)[0]).toContain("both prefer 25570");
  });

  test("two fixed ports are no business of this rule", () => {
    expect(catalogPreferredPortClashes(catalog({ a: webApp(8080), b: webApp(8080) }))).toEqual([]);
  });

  test("one script's own $PORT repeated is no clash", () => {
    expect(catalogPreferredPortClashes(catalog({ a: app([1], { web_port: pin("$PORT(1)"), https_port: pin("$PORT(1)") }) }))).toEqual([]);
  });
});

describe("portMacrosWellFormed", () => {
  test("a declared $PORT passes, whole or inside a longer string", () => {
    expect(portMacrosWellFormed(webApp("$PORT(30146)"))).toEqual([]);
    const script = webApp("$PORT(30111)");
    (script.app_values as Record<string, unknown>).mealie = { base_url: "http://$SERVER_LAN_IP:$PORT(30111)/" };
    expect(portMacrosWellFormed(script)).toEqual([]);
  });

  test("a script with no $PORT has nothing to check", () => {
    expect(portMacrosWellFormed(webApp(30025))).toEqual([]);
    expect(portMacrosWellFormed({})).toEqual([]);
  });

  test("a $PORT that isn't declared is refused, whole or inside a longer string", () => {
    const whole = portMacrosWellFormed(webApp("$PORT(30146)", [30147]));
    expect(levels(whole)).toEqual(["error"]);
    expect(messages(whole)).toEqual(["app_values.network.web_port.port_number: $PORT(30146) names a port requirements.ports doesn't declare"]);
    const script = webApp("$PORT(30111)");
    (script.app_values as Record<string, unknown>).mealie = { base_url: "http://$SERVER_LAN_IP:$PORT(30112)/" };
    expect(messages(portMacrosWellFormed(script))[0]).toContain("app_values.mealie.base_url");
  });

  test("a $PORT in a question's default is checked too", () => {
    const script = { ...webApp("$PORT(30032)"), installation_questions: [{ key: "domain", default: "https://$SERVER_LAN_IP:$PORT(1)" }] };
    expect(messages(portMacrosWellFormed(script))[0]).toContain("installation_questions[0].default");
  });

  test("a malformed $PORT is refused", () => {
    for (const bad of ["$PORT", "$PORT()", "$PORT(abc)", "$PORT(0)", "$PORT(70000)", "$PORT(030146)", "$PORT( 30146 )", "$PORT(30146", "$PORT(1,2)", "$PORT(-1)", "$PORT(1.5)", "http://x:$PORT"]) {
      const findings = portMacrosWellFormed(webApp(bad, [30146]));
      expect(levels(findings)).toEqual(["error"]);
      expect(messages(findings).join()).toContain("malformed");
    }
  });

  test("another macro that starts the same way is the validator's to report", () => {
    expect(portMacrosWellFormed(webApp("$PORTS", []))).toEqual([]);
  });

  test("a range with one movable end is refused, whichever end", () => {
    const expected = ["app_values.network.additional_port_ranges[0]: a range moves as one block, so start and end are both $PORT(n) or both fixed"];
    expect(messages(portMacrosWellFormed(crafty("$PORT(25565)", 25575)))).toEqual(expected);
    expect(messages(portMacrosWellFormed(crafty(25565, "$PORT(25575)")))).toEqual(expected);
  });

  test("a range with both ends fixed or both movable passes", () => {
    expect(portMacrosWellFormed(crafty())).toEqual([]);
    expect(portMacrosWellFormed(crafty("$PORT(25565)", "$PORT(25575)"))).toEqual([]);
  });
});

// The rules above are only as good as the validator calling them: run it on a small catalog.
describe("validate.ts", () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-ports-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const script = (ports: number[], appValues: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      version: 6,
      script: { version: "1.0.0" },
      requirements: { permissions: [], specifications: [], locations: [], ports },
      app_values: appValues,
      ...extra,
    });
  const hook = { id: "go", title: "Go", script: "go.ts", entrypoint: "run", rerun: "idempotent" };
  const web = (port: unknown) => ({ network: { web_port: pin(port) } });

  const run = (scripts: Record<string, string>, collection?: unknown) => {
    const catalog = mkdtempSync(join(dir, "run-"));
    writeFileSync(join(catalog, "go.ts"), "export const run = () => {};\n");
    for (const [name, content] of Object.entries(scripts)) writeFileSync(join(catalog, `${name}.json`), content);
    if (collection) {
      mkdirSync(join(catalog, "_collections"));
      writeFileSync(join(catalog, "_collections", "set.json"), JSON.stringify(collection));
    }
    const result = Bun.spawnSync(["bun", join(import.meta.dir, "validate.ts")], { cwd: catalog });
    return { code: result.exitCode, output: result.stdout.toString() };
  };

  /** One file's block of the validator's output. */
  const section = (output: string, file: string) => output.split("\n\n").find((block) => block.includes(` ${file}\n`));

  test("a clean catalog passes, with a hook-linked app pinning ports[0] as $PORT", () => {
    const { code, output } = run({ a: script([30025], web("$PORT(30025)"), { hooks: [hook] }) });
    expect(output).toContain("0 error(s), 0 warning(s)");
    expect(code).toBe(0);
  });

  test("a hook-linked app whose ports[0] isn't its $PORT pin is still refused", () => {
    const { code, output } = run({ a: script([30025, 30026], web("$PORT(30026)"), { hooks: [hook] }) });
    expect(output).toContain("requirements.ports[0] (30025) must be a port it pins");
    expect(code).toBe(1);
  });

  test("a hook-linked app with a string pin is still refused: the rule is unchanged", () => {
    const { output } = run({ a: script([30032], web("30032"), { hooks: [hook] }) });
    expect(output).toContain("requirements.ports[0] (30032) must be a port it pins");
  });

  test("each per-script rule is reported against its file", () => {
    const { code, output } = run({
      undeclared: script([1], { network: { web_port: pin(1), other: pin(2) } }),
      outside: script([3], {}, { network: { web_port: pin(3) } }),
      unknown: script([4], web("$PORT(5)")),
    });
    expect(code).toBe(1);
    expect(section(output, "undeclared.json")).toContain("publishes 2");
    expect(section(output, "outside.json")).toContain("network sits outside app_values");
    expect(section(output, "unknown.json")).toContain("$PORT(5) names a port");
  });

  test("$PORT is a macro the validator knows", () => {
    expect(run({ a: script([1], web("$PORT(1)")) }).output).not.toContain("unknown macro");
  });

  test("a catalog-wide overlap warns and doesn't fail", () => {
    const { code, output } = run({
      a: script([1, 2], { network: { web_port: pin(1), other: pin("$PORT(2)") } }),
      b: script([1, 2], { network: { web_port: pin(1), other: pin("$PORT(2)") } }),
    });
    expect(output).toContain("a and b both fix 1");
    expect(output).toContain("a and b both prefer 2");
    expect(output).toContain("0 error(s), 2 warning(s)");
    expect(code).toBe(0);
  });

  test("the same overlap inside a collection fails", () => {
    const collection = {
      type: "collection",
      version: 1,
      name: "Set",
      description: "A set.",
      groups: [{ id: "all", type: "multiple", title: "All", options: [{ app: "a" }, { app: "b" }] }],
    };
    const { code, output } = run({ a: script([1], web(1)), b: script([1], web(1)) }, collection);
    expect(section(output, "_collections/set.json")).toContain("a and b both want 1");
    expect(code).toBe(1);
  });
});
