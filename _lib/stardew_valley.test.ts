import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asksForPassword, consoleState, hasSession, openConsole, run } from "../stardew-valley/sign_in_steam";
import { farmDate, farmFields, onlineNames, playersLine, usableCode } from "../stardew-valley/widget_farm";
import { composeScriptProblems } from "./compose";
import type { HookContext } from "./hook_context";

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
// and SteamAuthService.cs), as an attached console shows it. Docker's log shows less: see `logged`
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

  test("the card's background is the list its picture rides on, so an empty farm leaves the card small", () => {
    // The deck opens a card with a background only while that list has entries, and draws the
    // entry's picture behind it (hexos-platform, widgetHasContent). Without it, "0/10" opens the card
    const widget = script.widgets.find((entry: { id: string }) => entry.id === "farm");
    expect(widget.background).toEqual({ field: "online" });
    expect(widget.slots).toContainEqual({ type: "list", field: "online", rows: 1 });
    expect((farmFields({ ...status, playerCount: 0 }, []).online as { entries: unknown[] }).entries).toEqual([]);
  });

  test("one entry while anyone's on: the farm, who's there and the day", () => {
    const fields = farmFields(status, ["Abigail", "Sam"]);
    const entry = (fields.online as { entries: { image?: string }[] }).entries[0];
    expect(fields.online).toEqual({
      type: "list",
      entries: [{ title: "Junimo Farm", subtitle: "Abigail and Sam", subtitles: ["Summer 12, Year 2"], image: entry.image }],
    });
    // The farm picture, within the platform's cap on an image field
    expect(entry.image).toStartWith("data:image/webp;base64,");
    expect(entry.image!.length).toBeLessThanOrEqual(60_000);
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

// What Docker's log holds of something the console wrote: its copier logs a line when the line
// ends (moby daemon/logger/copier.go), so the prompt the console is waiting at is never in it.
const logged = (written: string) => written.slice(0, written.lastIndexOf("\n") + 1);

describe("the password prompt, which Docker's log never shows", () => {
  test("it is read from the account line before it, the last line logged", () => {
    expect(logged(PASSWORD).endsWith("Steam Password: ")).toBe(false);
    expect(consoleState(logged(PASSWORD))).toEqual({ kind: "waiting" });
    expect(asksForPassword(logged(PASSWORD))).toBe(true);
  });

  test("an answered prompt, a run that ended and an empty log are not it", () => {
    expect(asksForPassword(logged(`${PASSWORD}********\r\n[SteamAuth:A0] Connecting... +0.0s\r\n`))).toBe(false);
    expect(asksForPassword(logged(`${PASSWORD}********\r\n[SteamService] Account 0: Login failed +0.1s\r\n`))).toBe(false);
    expect(asksForPassword("")).toBe(false);
  });
});

/**
 * A Docker socket with one container behind it, the Steam one: its log answers with finished lines
 * only, and an attach is sent each thing the console writes from then on, as Docker does.
 */
function fakeDocker(guard: "app" | "email" | "none") {
  const socketPath = join(mkdtempSync(join(tmpdir(), "sdv-")), "d.sock");
  const attached = new Set<{ write(data: string): number }>();
  let written = PASSWORD;
  let at: "password" | "choice" | "code" | "done" = "password";
  const write = (text: string) => {
    written += text;
    for (const socket of attached) socket.write(text);
  };
  const signedIn = () => {
    write("[SteamAuth:A0] Logged in as 76561198000000000 +1.2s\r\n");
    at = "done";
  };
  const listener = Bun.listen<{ head: string }>({
    unix: socketPath,
    socket: {
      open(socket) {
        socket.data = { head: "" };
      },
      data(socket, chunk) {
        socket.data.head += chunk.toString();
        if (!socket.data.head.includes("\r\n\r\n")) return;
        const [method, path] = socket.data.head.split(" ");
        if (method === "GET" && path?.includes("/logs")) {
          const body = logged(written);
          socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
          socket.end();
        } else if (method === "POST" && path?.includes("/containers/steam1/attach")) {
          socket.write("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
          attached.add(socket);
        } else {
          socket.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
          socket.end();
        }
      },
      close(socket) {
        attached.delete(socket);
      },
    },
  });
  return {
    socketPath,
    stop: () => listener.stop(true),
    /** What `login` does with a line typed at its console. */
    type(text: string) {
      const line = text.replace(/\r$/, "");
      if (at === "password") {
        write(`${"*".repeat(line.length)}\r\n[SteamAuth:A0] Connecting... +0.0s\r\n`);
        if (guard === "none") return signedIn();
        write(guard === "app" ? CHOICE : "Enter Steam Guard code sent to f***@example.com: ");
        at = guard === "app" ? "choice" : "code";
      } else if (at === "choice") {
        write(`${line}\r\n`);
        if (line !== "2") return signedIn();
        write("Enter Steam Guard code: ");
        at = "code";
      } else if (at === "code") {
        write(`${line}\r\n`);
        if (line === "R2D2C") return signedIn();
        write("[Steam] Incorrect code, try again. +0.3s\r\nEnter Steam Guard code from mobile app: ");
      }
    },
  };
}

function signInWith(docker: ReturnType<typeof fakeDocker>, codes: string[]) {
  const typed: string[] = [];
  const asked: Array<string | undefined> = [];
  let restarts = 0;
  const ctx = {
    mounts: [{ hostPath: "/mnt/tank/steam-session", containerPath: "/data/steam-session", localPath: mkdtempSync(join(tmpdir(), "steam-")) }],
    inputs: { steam_password: "not-a-real-password" },
    appContainers: async () => [{ id: "steam1", name: "ix-stardew-valley-steam-auth-1", service: "steam-auth", state: "running", addresses: [] }],
    writeAppStdin: async (text: string) => {
      typed.push(text);
      docker.type(text);
    },
    askForInputs: async (_inputs: unknown, prompt?: { title?: string }) => {
      asked.push(prompt?.title);
      return { code: codes.shift() ?? "" };
    },
    restartApp: async () => {
      restarts++;
    },
    log: () => {},
    sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
    fail: (message: string) => {
      throw new Error(message);
    },
  } as unknown as HookContext;
  return { typed, asked, restarts: () => restarts, done: run(ctx, docker.socketPath).finally(docker.stop) };
}

describe("signing in at the Steam container's console", () => {
  test("the console is read as written, a prompt with no line end included", async () => {
    const docker = fakeDocker("app");
    const live = await openConsole("steam1", docker.socketPath);
    docker.type("not-a-real-password\r");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(consoleState(live.text())).toEqual({ kind: "choice" });
    live.close();
    await expect(openConsole("another", docker.socketPath)).rejects.toThrow("refused");
    docker.stop();
  });

  test("Steam Guard in the app: the password is typed, the owner is asked, approval is waited for", async () => {
    const run = signInWith(fakeDocker("app"), [""]);
    await run.done;
    expect(run.typed).toEqual(["not-a-real-password\r", "1\r"]);
    expect(run.asked).toEqual(["Approve the sign-in in Steam"]);
    expect(run.restarts()).toBe(0);
  });

  test("Steam Guard in the app, with the code typed instead", async () => {
    const run = signInWith(fakeDocker("app"), ["R2D2C"]);
    await run.done;
    expect(run.typed).toEqual(["not-a-real-password\r", "2\r", "R2D2C\r"]);
  });

  test("Steam Guard by email: the owner is asked for the code, and again after a wrong one", async () => {
    const run = signInWith(fakeDocker("email"), ["WRONG", "R2D2C"]);
    await run.done;
    expect(run.typed).toEqual(["not-a-real-password\r", "WRONG\r", "R2D2C\r"]);
    expect(run.asked).toEqual(["Enter your Steam Guard code", "Enter your Steam Guard code"]);
  });

  test("no Steam Guard: nothing is asked", async () => {
    const run = signInWith(fakeDocker("none"), []);
    await run.done;
    expect(run.typed).toEqual(["not-a-real-password\r"]);
    expect(run.asked).toEqual([]);
  });
});
