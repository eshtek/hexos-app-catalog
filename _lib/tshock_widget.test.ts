import { describe, expect, test } from "bun:test";

import { configMount, setupCode, setupField } from "../terraria-tshock/widget_setup";

describe("TShock's admin setup widget", () => {
  test("shows the code while setup-code.txt holds one", () => {
    expect(setupCode("4240417\n")).toBe("4240417");
    expect(setupField("4240417", false)).toEqual({ type: "stat", label: "Admin setup code", value: "/setup 4240417" });
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
