import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterInstall } from "../jellyfin/jellyfin_hook";
import type { HookContext } from "./hook_context";

// Pre-configure Jellyfin on a Jellyfin set up before, with a new sign-in chosen: HexOS adds that
// account through an administrator's token from Jellyfin's own database, so the owner isn't asked.
// Jellyfin never sets Devices.IsActive (a real sign-in carries 0) and deletes the row at sign-out.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const CHOSEN = { username: "admin", password: "a-new-password" };

function jellyfin(rows: string[]) {
  const config = mkdtempSync(join(tmpdir(), "jellyfin-stored-admin-"));
  mkdirSync(join(config, "data"));
  const db = new Database(join(config, "data/jellyfin.db"));
  db.run("CREATE TABLE ApiKeys (Name TEXT, AccessToken TEXT, DateCreated TEXT)");
  db.run("CREATE TABLE Devices (UserId TEXT, AccessToken TEXT, DeviceId TEXT, IsActive INT, DateLastActivity TEXT)");
  db.run("CREATE TABLE Permissions (UserId TEXT, Kind INT, Value INT)");
  for (const row of rows) db.run(row);
  db.close();

  const seen = { asked: 0, actedWith: [] as string[], sent: [] as string[] };
  let made = false;
  let madeAdmin = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const token = new Headers(init?.headers).get("Authorization")?.match(/Token="([^"]*)"/)?.[1];
    if (url.pathname === "/Startup/User") return new Response(null, { status: 401 });
    if (url.pathname === "/System/Info/Public") return Response.json({ StartupWizardCompleted: true });
    if (url.pathname === "/Users/AuthenticateByName") {
      const { Username, Pw } = JSON.parse(String(init?.body)) as { Username: string; Pw: string };
      if (!made || Username !== CHOSEN.username || Pw !== CHOSEN.password) return new Response(null, { status: 401 });
      return Response.json({ AccessToken: "chosen-session", User: { Id: "u2", Policy: { IsAdministrator: madeAdmin } } });
    }
    if (token) seen.sent.push(token);
    if (url.pathname.startsWith("/Users") && token !== "chosen-session") {
      // Only a live, enabled administrator's token may act on users
      if (token !== "owner-web") return new Response(null, { status: 401 });
      seen.actedWith.push(`${method} ${url.pathname}`);
      if (url.pathname === "/Users" && method === "GET") return Response.json([]);
      if (url.pathname === "/Users/New") {
        made = true;
        return Response.json({ Id: "u2", Name: CHOSEN.username, Policy: { IsAdministrator: false } });
      }
      if (url.pathname === "/Users/u2/Policy") {
        madeAdmin = true;
        return new Response(null, { status: 204 });
      }
    }
    if (url.pathname.startsWith("/Library/VirtualFolders") && method === "GET") return Response.json([]);
    if (url.pathname.startsWith("/Auth/Keys")) return Response.json({ Items: [{ AppName: "HexOS" }] });
    if (url.pathname.startsWith("/System/Configuration")) return Response.json({});
    return Response.json({});
  }) as typeof fetch;

  const ctx = {
    resourceId: "jellyfin",
    catalogAppId: "jellyfin",
    baseUrl: "http://jellyfin.test",
    event: "action",
    inputs: {},
    signIn: CHOSEN,
    mounts: [{ hostPath: "/mnt/a/jellyfin/config", containerPath: "/config", localPath: config }],
    registerCheckpoints: async () => {},
    emitCheckpoint: async () => {},
    updateCheckpointMessage: async () => {},
    skipCheckpoint: async () => {},
    awaitCheckpointRetry: async () => "skip",
    askForInputs: async () => {
      seen.asked++;
      throw Object.assign(new Error("skipped"), { name: "HookInputsUnanswered" });
    },
    getInstalledAppUrl: async () => null,
    log: () => {},
    sleep: async () => {},
    skip: (message: string) => {
      throw new Error(message);
    },
    fail: (message: string) => {
      throw new Error(message);
    },
  } as unknown as HookContext;
  return { ctx, seen };
}

test("an administrator's sign-in in Jellyfin's database adds the chosen account without asking, and a disabled one's is passed over", async () => {
  const { ctx, seen } = jellyfin([
    "INSERT INTO Permissions VALUES ('owner', 0, 1), ('gone', 0, 1), ('gone', 2, 1)",
    "INSERT INTO Devices VALUES ('owner', 'owner-web', 'web', 0, '2026-11-01'), ('gone', 'disabled-token', 'tv', 0, '2026-11-12')",
  ]);
  await afterInstall(ctx);
  expect(seen.asked).toBe(0);
  expect(seen.sent).not.toContain("disabled-token");
  // The token is checked, then the users are listed
  expect(seen.actedWith).toEqual(["GET /Users", "GET /Users", "POST /Users/New", "POST /Users/u2/Policy"]);
});

test("with only a member's sign-in, it asks for an administrator's", async () => {
  const { ctx, seen } = jellyfin([
    "INSERT INTO Permissions VALUES ('kid', 0, 0)",
    "INSERT INTO Devices VALUES ('kid', 'kid-tv', 'tv', 0, '2026-11-12')",
  ]);
  await expect(afterInstall(ctx)).rejects.toThrow("HexOS needs a Jellyfin administrator's sign-in to add the account you chose");
  expect(seen.asked).toBe(1);
  expect(seen.actedWith).toEqual([]);
  // A member's token is never sent to Jellyfin, not even to be refused
  expect(seen.sent).not.toContain("kid-tv");
});
