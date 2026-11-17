import { afterEach, expect, test } from "bun:test";

import { configure } from "../nextcloud/startup";
import type { HookContext } from "./hook_context";

// With a certificate set in TrueNAS, Nextcloud's port answers https only, and plain http gets a 400.
// Its setup steps asked over http alone, never saw it start, and gave up.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const up = () => Response.json({ installed: true, maintenance: false });
const refused = () => new Response("The plain HTTP request was sent to HTTPS port", { status: 400 });

function run(answer: (url: string) => Response | undefined) {
  const asked: string[] = [];
  const done: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push(url);
    const response = answer(url);
    if (!response) throw new Error("connection refused");
    return response;
  }) as typeof fetch;
  const ctx = {
    baseUrl: "http://10.0.0.5:30027",
    mounts: [],
    registerCheckpoints: async () => {},
    emitCheckpoint: async (id: string) => void done.push(id),
    sleep: async () => {},
    fail: (message: string) => {
      throw new Error(message);
    },
  } as unknown as HookContext;
  return { asked, done, finished: configure(ctx) };
}

test("a Nextcloud that answers its port over https only is seen as started", async () => {
  const { done, finished } = run((url) => (url === "https://10.0.0.5:30027/status.php" ? up() : refused()));
  await finished;
  expect(done).toEqual(["ready"]);
});

test("a Nextcloud on plain http is asked over http alone", async () => {
  const { asked, done, finished } = run(() => up());
  await finished;
  expect(done).toEqual(["ready"]);
  expect(asked).toEqual(["http://10.0.0.5:30027/status.php"]);
});

test("a Nextcloud in maintenance over http is not called started by asking over https", async () => {
  const { asked, finished } = run((url) => (url.startsWith("http://") ? Response.json({ installed: true, maintenance: true }) : up()));
  await expect(finished).rejects.toThrow("Nextcloud didn't finish starting");
  expect(asked.some((url) => url.startsWith("https://"))).toBe(false);
});

test("a Nextcloud that answers neither way is waited for and then reported", async () => {
  const { finished } = run(() => undefined);
  await expect(finished).rejects.toThrow("Nextcloud didn't finish starting");
});
