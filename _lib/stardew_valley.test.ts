import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consoleState, hasSession } from "../stardew-valley/sign_in_steam";
import { farmDate, farmFields, onlineNames, playersLine, usableCode } from "../stardew-valley/widget_farm";
import { composeScriptProblems } from "./compose";

const script = JSON.parse(readFileSync(join(import.meta.dir, "..", "stardew-valley.json"), "utf8"));

describe("the Stardew Valley script", () => {
  test("its compose document is one the platform installs", () => {
    expect(composeScriptProblems(script, { processed: false })).toEqual([]);
  });

  test("every folder the server image keeps as a volume is bound, at exactly that path", () => {
    // sdvd/server:1.5.0-preview.140's VOLUME lines, read from its image config on Docker Hub
    const volumes = ["/config", "/config/xdg/config/StardewValley", "/data/game"];
    const targets = (script.app_values.services.server.volumes as string[]).map((bind) => bind.split(":")[1]);
    for (const path of volumes) expect(targets).toContain(path);
  });

  test("the Steam container keeps its session in a folder of the app's", () => {
    const binds = script.app_values.services["steam-auth"].volumes as string[];
    expect(binds.some((bind) => bind.endsWith(":/data/steam-session"))).toBe(true);
  });

  test("the Steam password is never in the app's settings", () => {
    expect(JSON.stringify(script.app_values)).not.toContain("STEAM_PASSWORD");
  });

  test("the Steam container publishes no port: its token endpoint has no password", () => {
    expect(script.app_values.services["steam-auth"].ports).toBeUndefined();
  });
});

// What sdvd/steam-service's `login` writes on its console (tools/steam-service, ConsoleAuthenticator.cs
// and SteamAuthService.cs), as its TTY shows it
const BANNER = "*****************************************************************\r\n*              Steam Authentication Setup                       *\r\n";
const PASSWORD = `${BANNER}Steam account: farmer (from STEAM_USERNAME)\r\nSteam Password: `;
const CHOICE =
  "\r\n[Steam] Connecting...\r\n╔═══╗\r\n║  [1] Approve in Steam Mobile App (recommended)                ║\r\n║  [2] Enter code from Steam Mobile App or Email                ║\r\n╚═══╝\r\n\r\nChoice [1]: ";

describe("reading the Steam console", () => {
  test("it asks for the password, then for Steam Guard", () => {
    expect(consoleState(PASSWORD)).toEqual({ kind: "password" });
    expect(consoleState(CHOICE)).toEqual({ kind: "choice" });
  });

  test("a code prompt, and the same prompt after a wrong code", () => {
    expect(consoleState("\r\nEnter Steam Guard code sent to f***@example.com: ")).toEqual({ kind: "code", retry: false });
    expect(consoleState("[Steam] Incorrect code, try again.\r\nEnter Steam Guard code from mobile app: ")).toEqual({
      kind: "code",
      retry: true,
    });
  });

  test("an answered prompt no longer counts", () => {
    expect(consoleState(`${PASSWORD}********\r\n[Steam] Connecting...\r\n`)).toEqual({ kind: "waiting" });
  });

  test("signed in, or refused with Steam's reason", () => {
    expect(consoleState("[Steam] Logged in as 76561198000000000\r\n")).toEqual({ kind: "signedIn" });
    expect(consoleState("[Steam] Authentication failed: InvalidPassword\r\n")).toEqual({
      kind: "refused",
      reason: "InvalidPassword",
    });
  });

  test("a retry notice is not a refusal", () => {
    expect(consoleState("[Steam] Login failed, retrying in 5 seconds...\r\n")).toEqual({ kind: "waiting" });
  });

  test("a saved session is found at the folder's top or under the account's name", () => {
    const top = mkdtempSync(join(tmpdir(), "steam-"));
    expect(hasSession(top)).toBe(false);
    mkdirSync(join(top, "farmer"));
    writeFileSync(join(top, "farmer", "session.json"), "{}");
    expect(hasSession(top)).toBe(true);
    expect(hasSession(join(top, "missing"))).toBe(false);
  });
});

describe("the farm card", () => {
  const status = {
    isOnline: true,
    playerCount: 2,
    maxPlayers: 8,
    inviteCode: "S123456789",
    connectionStatusCode: "ready",
    farmName: "Junimo",
    season: "summer",
    day: 12,
    year: 2,
  };

  test("the date reads as the game writes it", () => {
    expect(farmDate(status)).toBe("Summer 12, Year 2");
    expect(farmDate({ ...status, season: undefined })).toBeNull();
  });

  test("one entry while anyone's on: the farm, who's there and the day", () => {
    const fields = farmFields(status, ["Abigail", "Sam"]);
    expect(fields.online).toEqual({
      type: "list",
      entries: [{ title: "Junimo Farm", subtitle: "Abigail and Sam", subtitles: ["Summer 12, Year 2"] }],
    });
    expect(fields.count).toEqual({ type: "stat", label: "Players", value: "2/8" });
  });

  test("nobody on: no entry, so the card folds back", () => {
    const fields = farmFields({ ...status, playerCount: 0 }, []);
    expect(fields.online).toEqual({ type: "list", entries: [] });
  });

  test("the invite code shows only while players can use it", () => {
    expect(usableCode(status)).toBe("S123456789");
    expect(usableCode({ ...status, connectionStatusCode: "steamSessionDown" })).toBeNull();
    expect(farmFields({ ...status, connectionStatusCode: "starting" }, []).code).toEqual({
      type: "stat",
      label: "Invite code",
      value: "",
    });
  });

  test("only farmhands online, by name", () => {
    expect(onlineNames({ players: [{ name: "Abigail", isOnline: true }, { name: "Sam", isOnline: false }, { name: " ", isOnline: true }] })).toEqual([
      "Abigail",
    ]);
    expect(playersLine(["A", "B", "C", "D", "E"])).toBe("A, B, and 3 more");
  });
});
