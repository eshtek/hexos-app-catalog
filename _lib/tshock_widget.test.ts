import { describe, expect, test } from "bun:test";

import { configMount, players, setupCode, setupField } from "../terraria-tshock/widget_players";

const line = (text: string) => `2026-11-07 06:30:00 - TShock: INFO: ${text}`;

describe("TShock's players widget", () => {
  test("counts who joined and hasn't disconnected, with the limit from the join line", () => {
    const log = [
      line("TShock 6.2.1.0 (Profoundly Collaborative (3.11)) now running."),
      line("Alex (10.0.0.51) from 'guest' group joined. (1/16)"),
      line("Sam (10.0.0.52) from 'guest' group from 'United States' joined. (2/16)"),
      line("Alex disconnected."),
    ].join("\n");
    expect(players(log)).toEqual({ names: ["Sam"], max: 16 });
  });

  test("starts at TShock's default limit before anyone joins", () => {
    expect(players(line("Server started"))).toEqual({ names: [], max: 8 });
  });
});

describe("TShock's admin setup code on the Settings tab", () => {
  test("shows the code while setup-code.txt holds one", () => {
    expect(setupCode("4240417\n")).toBe("4240417");
    expect(setupField("4240417", false)).toEqual({ type: "stat", label: "Admin setup", value: "/setup 4240417" });
  });

  test("says done once TShock has an admin and left setup.lock", () => {
    expect(setupField(setupCode(null), true)).toEqual({ type: "stat", label: "Admin setup", value: "Done" });
  });

  test("shows the value as still to come before the first start writes either file", () => {
    expect(setupField(null, false)).toEqual({ type: "stat", label: "Admin setup", value: "" });
  });

  test("ignores a file that holds no code", () => {
    expect(setupCode("")).toBeNull();
    expect(setupCode("not a code")).toBeNull();
  });

  test("finds the config folder of a later copy by its host path", () => {
    const mount = { hostPath: "/mnt/SSDs/Applications/terraria-tshock-2/config", containerPath: null, localPath: "/host/x" };
    expect(configMount([mount])).toBe(mount);
    expect(configMount([{ ...mount, hostPath: "/mnt/SSDs/Applications/terraria/config" }])).toBeUndefined();
  });
});
