import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { run } from "../nevu/connect_plex";
import type { HookContext } from "./hook_context";

// Nevu's link to Plex against a fake of Plex's /identity. Nevu's one setting is the Plex address in
// its own TrueNAS values, and its sign-in only works on a Plex server a Plex account owns.

const PLEX = "http://10.0.0.5:32401";

let values: Record<string, unknown>;
let updates: number;
let skipped: string[];
let plex: { url: string | null; body?: string };

class Skipped extends Error {}

function ctx(overrides: Partial<HookContext> = {}): HookContext {
  return {
    getInstalledAppUrl: async (app: string) => (app === "plex" ? plex.url : null),
    registerCheckpoints: async () => {},
    emitCheckpoint: async () => {},
    skipCheckpoint: async (_id: string, message?: string) => {
      skipped.push(message ?? "");
    },
    getAppValues: async () => structuredClone(values),
    updateAppValues: async (change: (next: Record<string, unknown>) => void) => {
      const next = structuredClone(values);
      change(next);
      const changed = JSON.stringify(next) !== JSON.stringify(values);
      if (changed) updates++;
      values = next;
      return changed;
    },
    skip: (message: string) => {
      throw new Skipped(message);
    },
    fail: (message: string) => {
      throw new Error(message);
    },
    ...overrides,
  } as unknown as HookContext;
}

beforeEach(() => {
  values = { nevu: { plex_server: "http://10.0.0.5:32400", disable_nevu_sync: false }, network: { web_port: { port_number: 30267 } } };
  updates = 0;
  skipped = [];
  plex = { url: PLEX, body: '{"MediaContainer":{"claimed":true,"machineIdentifier":"abc"}}' };
  spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
    if (plex.body === undefined || !String(url).startsWith(`${PLEX}/identity`)) throw new Error("connection refused");
    return new Response(plex.body);
  }) as typeof fetch);
});
afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore: () => void }).mockRestore();
});

describe("Nevu's link to Plex", () => {
  test("moves Nevu to where Plex answers now and keeps its other settings", async () => {
    await run(ctx());
    expect(values.nevu).toEqual({ plex_server: PLEX, disable_nevu_sync: false });
    expect(values.network).toEqual({ web_port: { port_number: 30267 } });
    expect(updates).toBe(1);
  });

  test("leaves Nevu alone when it already uses this Plex server", async () => {
    values = { nevu: { plex_server: `${PLEX}/` } };
    await run(ctx());
    expect(updates).toBe(0);
    expect(skipped).toEqual(["Nevu already uses this Plex server"]);
  });

  test("points Nevu at a Plex nobody signed in to, then says to sign in to Plex", async () => {
    plex.body = '<MediaContainer size="0" claimed="0" machineIdentifier="abc"></MediaContainer>';
    await expect(run(ctx())).rejects.toBeInstanceOf(Skipped);
    await expect(run(ctx())).rejects.toThrow("nobody has signed in to Plex yet");
    expect((values.nevu as { plex_server: string }).plex_server).toBe(PLEX);
    expect(updates).toBe(1);
  });

  test("fails with that message on a box from before skip", async () => {
    plex.body = '{"MediaContainer":{"claimed":false}}';
    await expect(run(ctx({ skip: undefined }))).rejects.toThrow("nobody has signed in to Plex yet");
  });

  test("changes nothing when Plex isn't installed", async () => {
    plex.url = null;
    await expect(run(ctx())).rejects.toThrow("Plex isn't installed");
    expect(updates).toBe(0);
  });

  test("changes nothing when Plex doesn't answer", async () => {
    plex.body = undefined;
    await expect(run(ctx())).rejects.toThrow("Plex didn't answer");
    expect(updates).toBe(0);
  });

  test("changes nothing on a box that can't update an app's values", async () => {
    await expect(run(ctx({ updateAppValues: undefined }))).rejects.toThrow("needs an update first");
    expect(updates).toBe(0);
  });
});
