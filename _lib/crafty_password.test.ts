import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../crafty-4/change_password";
import type { HookContext } from "./hook_context";

// Crafty's password lives in its database; default-creds.txt is what HexOS shows the owner. A change
// has to reach both, in that order, and a refusal has to leave the file saying what still works.

let folder: string;
let file: string;
let accepted: string;
let patches: string[];
let patchStatus: number;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "crafty-"));
  file = join(folder, "default-creds.txt");
  writeFileSync(file, JSON.stringify({ username: "admin", password: "made-by-crafty", info: "keep" }));
  accepted = "made-by-crafty";
  patches = [];
  patchStatus = 200;
  spyOn(globalThis, "fetch").mockImplementation((async (url: string, init: RequestInit) => {
    expect(url.startsWith("https://")).toBe(true);
    const body = JSON.parse(String(init.body));
    if (url.endsWith("/api/v2/auth/login")) {
      if (body.password !== accepted) return new Response("{}", { status: 401 });
      return Response.json({ data: { token: "token" } });
    }
    patches.push(body.password);
    if (patchStatus !== 200) return Response.json({ error_data: "too short" }, { status: patchStatus });
    accepted = body.password;
    return Response.json({ status: "ok" });
  }) as never);
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

function context(answers: Record<string, string> = {}) {
  const asked: unknown[] = [];
  const ctx = {
    baseUrl: "http://10.0.0.49:30147",
    mounts: [
      { hostPath: "/mnt/SSDs/Applications/crafty-4-2/logs", containerPath: null, localPath: "/nowhere" },
      { hostPath: "/mnt/SSDs/Applications/crafty-4-2/config", containerPath: null, localPath: folder },
    ],
    inputs: { password: "chosen-by-the-owner" },
    registerCheckpoints: async () => {},
    emitCheckpoint: async () => {},
    askForInputs: async (inputs: unknown[]) => {
      asked.push(...inputs);
      return answers;
    },
    fail: (message: string) => {
      throw new Error(message);
    },
  } as unknown as HookContext;
  return { ctx, asked };
}

const held = () => JSON.parse(readFileSync(file, "utf8"));

describe("Crafty's change-password hook", () => {
  test("sets the new password in Crafty, then in the file, keeping the file's other keys", async () => {
    await run(context().ctx);
    expect(accepted).toBe("chosen-by-the-owner");
    expect(held()).toEqual({ username: "admin", password: "chosen-by-the-owner", info: "keep" });
  });

  test("asks for the current password when the file has gone stale", async () => {
    accepted = "set-inside-crafty";
    const { ctx, asked } = context({ current_password: "set-inside-crafty" });
    await run(ctx);
    expect(asked).toHaveLength(1);
    expect(accepted).toBe("chosen-by-the-owner");
    expect(held().password).toBe("chosen-by-the-owner");
  });

  test("changes nothing when Crafty refuses the current password too", async () => {
    accepted = "set-inside-crafty";
    await expect(run(context({ current_password: "a-wrong-guess" }).ctx)).rejects.toThrow("nothing changed");
    expect(patches).toEqual([]);
    expect(held().password).toBe("made-by-crafty");
  });

  test("leaves the file alone when Crafty refuses the new password, and says why", async () => {
    patchStatus = 400;
    await expect(run(context().ctx)).rejects.toThrow("too short");
    expect(held().password).toBe("made-by-crafty");
  });
});
