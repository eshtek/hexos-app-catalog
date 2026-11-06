import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { configure, namesOf } from "../n8n/configure";
import type { HookContext } from "./hook_context";

// n8n's owner is made from the sign-in the owner chose, so n8n opens on its sign-in page. n8n's own
// rules refuse a password without a number and a capital letter, and any second owner.

afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
});

function ctxWith(signIn?: { username: string; password: string; email?: string }) {
  const done: string[] = [];
  const ctx = {
    baseUrl: "http://box:30109",
    signIn,
    registerCheckpoints: async () => {},
    waitForApp: async () => new Response("ok"),
    emitCheckpoint: async (id: string) => void done.push(`done ${id}`),
    skipCheckpoint: async (id: string, message?: string) => void done.push(`skip ${id}: ${message}`),
    skip: (message: string) => {
      throw new Error(`skip: ${message}`);
    },
    fail: (message: string) => {
      throw new Error(`fail: ${message}`);
    },
  } as unknown as HookContext;
  return { ctx, done };
}

function n8nAnswering(showSetup: boolean, setupStatus = 200) {
  const sent: unknown[] = [];
  spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    if (url.endsWith("/rest/settings")) return Response.json({ data: { userManagement: { showSetupOnFirstLoad: showSetup } } });
    sent.push(JSON.parse(String(init?.body)));
    return new Response(setupStatus === 200 ? "{}" : "Instance owner already setup", { status: setupStatus });
  }) as never);
  return sent;
}

describe("n8n's names from a username", () => {
  test("split at a dot, a dash or a space, else the username and Owner", () => {
    expect(namesOf("aaron.roach")).toEqual({ firstName: "Aaron", lastName: "Roach" });
    expect(namesOf("mary-jane watson")).toEqual({ firstName: "Mary", lastName: "Jane Watson" });
    expect(namesOf("admin")).toEqual({ firstName: "Admin", lastName: "Owner" });
  });
});

describe("n8n's account", () => {
  test("is made from the run's sign-in", async () => {
    const sent = n8nAnswering(true);
    const { ctx, done } = ctxWith({ username: "aaron", password: "Correct1horse", email: "owner@example.com" });
    await configure(ctx);
    expect(sent).toEqual([{ email: "owner@example.com", firstName: "Aaron", lastName: "Owner", password: "Correct1horse" }]);
    expect(done).toEqual(["done start", "done account"]);
  });

  test("is left to n8n when it already has an owner", async () => {
    const sent = n8nAnswering(false);
    const { ctx, done } = ctxWith({ username: "aaron", password: "Correct1horse", email: "owner@example.com" });
    await configure(ctx);
    expect(sent).toEqual([]);
    expect(done).toEqual(["done start", "skip account: n8n keeps the account it has"]);
  });

  test("is left to the owner when the password won't meet n8n's rules", async () => {
    const sent = n8nAnswering(true);
    const { ctx } = ctxWith({ username: "aaron", password: "correct horse", email: "owner@example.com" });
    await expect(configure(ctx)).rejects.toThrow("skip: n8n needs a password with a number and a capital letter");
    expect(sent).toEqual([]);
  });

  test("is left to n8n's own setup page without a sign-in", async () => {
    const sent = n8nAnswering(true);
    const { ctx, done } = ctxWith();
    await configure(ctx);
    expect(sent).toEqual([]);
    expect(done[1]).toContain("skip account");
  });
});
