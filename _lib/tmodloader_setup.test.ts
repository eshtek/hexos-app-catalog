import { describe, expect, test } from "bun:test";

import { latestSetupCode } from "../tmodloader/setup";

describe("tModLoader's dashboard setup code", () => {
  test("reads the code from the container log, past Docker's frame headers", () => {
    const log = "\u0001\u0000\u0000\u0000\u0000\u0000\u0000@[ADMIN] One-time setup code: Ab_c-9xYz\n";
    expect(latestSetupCode(log)).toBe("Ab_c-9xYz");
  });

  test("takes the last code, since a restart prints a new one", () => {
    expect(latestSetupCode("[ADMIN] One-time setup code: first\n[ADMIN] One-time setup code: second\n")).toBe("second");
  });

  test("finds nothing before the dashboard has printed one", () => {
    expect(latestSetupCode("[ADMIN] Game startup paused.\n")).toBeNull();
  });
});
