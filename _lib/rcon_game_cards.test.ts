import { describe, expect, test } from "bun:test";

import { envOf, listedPlayers, playersLine } from "../ark-survival-evolved/widget_players";
import { connectedPlayers } from "../project-zomboid/widget_players";

describe("ARK's listplayers", () => {
  test("names each player, past the number and the Steam id", () => {
    expect(listedPlayers("\n0. Alex, 76561198000000001\n1. Sam Smith, 76561198000000002\n ")).toEqual(["Alex", "Sam Smith"]);
  });

  test("an empty server answers with no names", () => {
    expect(listedPlayers("No Players Connected \n")).toEqual([]);
  });
});

describe("Project Zomboid's players", () => {
  test("names each player on its own dashed line", () => {
    expect(connectedPlayers("Players connected (2): \n-alex\n-sam smith\n")).toEqual(["alex", "sam smith"]);
    expect(connectedPlayers("Players connected (0): \n")).toEqual([]);
  });
});

describe("the shared pieces", () => {
  test("reads the container's environment, values with = in them included", () => {
    expect(envOf({ Config: { Env: ["ADMIN_PASSWORD=a=b", "MAX_PLAYERS=10"] } }).get("ADMIN_PASSWORD")).toBe("a=b");
  });

  test("names players as every other card does", () => {
    expect(playersLine(["Alex", "Sam", "Kim", "Lee"])).toBe("Alex, Sam, and 2 more");
  });
});
