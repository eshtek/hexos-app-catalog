import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

import { composeScriptProblems } from "./compose";
import { composeDurationSeconds, healthGatedServices, healthGateProblems } from "./compose_health";

const root = new URL("../", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, root), "utf-8"));

const gated = (ripper: Record<string, unknown>) => ({
  services: {
    ripper: { image: "example/ripper:1", ...ripper },
    dashboard: { image: "example/ui:1", depends_on: { ripper: { condition: "service_healthy" } } },
  },
});

describe("compose durations", () => {
  test("reads the forms compose takes", () => {
    expect(composeDurationSeconds("20m")).toBe(1200);
    expect(composeDurationSeconds("90s")).toBe(90);
    expect(composeDurationSeconds("1h30m")).toBe(5400);
    expect(composeDurationSeconds("1.5m")).toBe(90);
    expect(composeDurationSeconds("500ms")).toBe(0.5);
    expect(composeDurationSeconds(".5m")).toBe(30);
  });

  test("anything else is not a duration", () => {
    for (const value of ["", "20", "20 minutes", "-5m", "5d", 1200, null, undefined, `${"9".repeat(400)}h`]) {
      expect(composeDurationSeconds(value)).toBeNull();
    }
  });
});

describe("a service another one waits on to be healthy", () => {
  test("is found from the waiting service's depends_on", () => {
    expect(healthGatedServices(gated({}))).toEqual(["ripper"]);
    const started = { services: { a: { depends_on: { b: { condition: "service_started" } } }, b: {} } };
    expect(healthGatedServices(started)).toEqual([]);
  });

  test("must name a start period", () => {
    expect(healthGateProblems(gated({}))).toEqual([expect.stringContaining("ripper: another service waits")]);
    expect(healthGateProblems(gated({ healthcheck: { interval: "30s" } }))).toHaveLength(1);
    expect(healthGateProblems(gated({ healthcheck: { start_period: "soon" } }))).toHaveLength(1);
    expect(healthGateProblems(gated({ healthcheck: { start_period: "0s" } }))).toHaveLength(1);
  });

  test("passes with a start period, keeping the image's own check", () => {
    expect(healthGateProblems(gated({ healthcheck: { start_period: "20m" } }))).toEqual([]);
  });

  test("can't have its check disabled, a start period or not", () => {
    for (const healthcheck of [
      { disable: true, start_period: "20m" },
      { test: ["NONE"], start_period: "20m" },
      { test: "NONE", start_period: "20m" },
    ]) {
      expect(healthGateProblems(gated({ healthcheck }))).toEqual([expect.stringContaining("can't be disabled")]);
    }
  });

  test("a service nobody waits on needs nothing", () => {
    const alone = { services: { game: { image: "example/game:1", healthcheck: { disable: true } } } };
    expect(healthGateProblems(alone)).toEqual([]);
  });
});

describe("the catalog's own version-7 scripts", () => {
  const scripts = readdirSync(root)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ name, script: read(name) }))
    .filter(({ script }) => script?.version === 7);

  test("there are some to check", () => {
    expect(scripts.length).toBeGreaterThan(0);
  });

  for (const { name, script } of scripts) {
    test(`${name} gives every health-gated service a start period`, () => {
      expect(healthGateProblems(script.app_values)).toEqual([]);
      expect(composeScriptProblems(script, { processed: false })).toEqual([]);
    });
  }

  test("Automatic Ripping Machine's ripper waits 20 minutes before its check counts", () => {
    const arm = read("ripping-machine.json");
    expect(arm.app_values.services.ripper.healthcheck).toEqual({ start_period: "20m" });
    expect(arm.app_values.services.dashboard.depends_on.ripper.condition).toBe("service_healthy");
  });
});
