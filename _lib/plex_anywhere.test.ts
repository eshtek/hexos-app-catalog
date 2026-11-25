import { expect, test } from "bun:test";

import plex from "../plex.json";
import { setSwitch, switchPlan, withAnywhereUrls } from "../plex/anywhere";

// Plex's TV and phone apps showed the server as unavailable away from home, while its Anywhere
// address opened in a browser: the server never told plex.tv about that address (2026-11-18)

const lan = { name: "ADVERTISE_IP", value: "http://192.168.1.20:32400" };
const envs = (values: Record<string, unknown>) => (values.plex as { additional_envs: Array<{ name: string; value: string }> }).additional_envs;
const fresh = () => ({ plex: { image_selector: "image", additional_envs: [{ ...lan }] } });

test("an Anywhere name joins the LAN address Plex already gives out, as https on 443", () => {
  const values = fresh();
  withAnywhereUrls(values, ["plex.k7q2m9.example.com"]);
  expect(envs(values)).toEqual([
    { name: "ADVERTISE_IP", value: "http://192.168.1.20:32400,https://plex.k7q2m9.example.com:443" },
    { name: "HEXOS_ANYWHERE_URLS", value: "https://plex.k7q2m9.example.com:443" },
  ]);
  expect(values.plex.image_selector).toBe("image");
});

test("running it again with the same names changes nothing", () => {
  const values = fresh();
  withAnywhereUrls(values, ["plex.k7q2m9.example.com"]);
  const once = structuredClone(values);
  withAnywhereUrls(values, ["plex.k7q2m9.example.com"]);
  expect(values).toEqual(once);
});

test("a renamed address replaces the old URL, and a URL the owner added stays", () => {
  const values = fresh();
  values.plex.additional_envs[0].value += ",https://plex.owner.example:32400";
  withAnywhereUrls(values, ["plex.k7q2m9.example.com"]);
  withAnywhereUrls(values, ["movies.k7q2m9.example.com"]);
  expect(envs(values)[0].value).toBe("http://192.168.1.20:32400,https://plex.owner.example:32400,https://movies.k7q2m9.example.com:443");
});

test("with no address left, the values are as the script wrote them", () => {
  const values = fresh();
  withAnywhereUrls(values, ["plex.k7q2m9.example.com"]);
  withAnywhereUrls(values, []);
  expect(values).toEqual(fresh());
});

test("a name that isn't a hostname is left out", () => {
  const values = fresh();
  withAnywhereUrls(values, ["plex.example.com,http://evil.example", "ok.example.com"]);
  expect(envs(values)[0].value).toBe("http://192.168.1.20:32400,https://ok.example.com:443");
});

test("with an address, Remote Access and Relay go off, and what they were is kept once", () => {
  const on = { PublishServerOnPlexOnlineKey: true, RelayEnabled: true };
  expect(switchPlan(true, on, undefined)).toEqual({ set: { PublishServerOnPlexOnlineKey: false, RelayEnabled: false }, keep: on });
  // A second run reads them off: what the owner had is still what is kept
  const off = { PublishServerOnPlexOnlineKey: false, RelayEnabled: false };
  expect(switchPlan(true, off, on)).toEqual({ set: {}, keep: on });
});

test("once the address goes, each switch returns to what the owner had, and nothing is kept", () => {
  const off = { PublishServerOnPlexOnlineKey: false, RelayEnabled: false };
  expect(switchPlan(false, off, { PublishServerOnPlexOnlineKey: true, RelayEnabled: false })).toEqual({ set: { PublishServerOnPlexOnlineKey: true }, keep: undefined });
});

test("a Plex that never had an Anywhere address is left alone", () => {
  expect(switchPlan(false, { PublishServerOnPlexOnlineKey: true, RelayEnabled: true }, undefined)).toEqual({ set: {}, keep: undefined });
});

test("the hook runs again when the address changes, in a hook of its own", () => {
  const hook = plex.hooks.find((entry) => entry.id === "anywhere-address") as Record<string, unknown>;
  expect(hook).toMatchObject({ kind: "maintain", events: ["userAction"], rerun: "converge", rerunsOn: ["remote-address"], script: "plex/anywhere.ts", entrypoint: "anywhere" });
  expect(plex.app_values.plex.additional_envs).toContainEqual({ name: "ADVERTISE_IP", value: "http://$SERVER_LAN_IP:$PORT(32400)" });
});

// A signed-in Plex took more than 10 seconds to answer the Remote Access change just after it
// restarted, applied it anyway, and the run failed while the switch was already off (2026-11-24)
function fakePlex(opts: { putStatus?: number; putHangsMs?: number; applies: boolean }) {
  const prefs = { PublishServerOnPlexOnlineKey: true, RelayEnabled: true } as Record<string, boolean>;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "PUT") {
        if (opts.applies) for (const name of Object.keys(prefs)) if (url.searchParams.has(name)) prefs[name] = url.searchParams.get(name) === "1";
        if (opts.putHangsMs) await Bun.sleep(opts.putHangsMs);
        return new Response(null, { status: opts.putStatus ?? 200 });
      }
      return Response.json({ MediaContainer: { Setting: Object.entries(prefs).map(([id, value]) => ({ id, value })) } });
    },
  });
  const ctx = { baseUrl: `http://localhost:${server.port}`, sleep: (ms: number) => Bun.sleep(Math.min(ms, 5)) };
  return { server, ctx, prefs };
}
const quick = { attempts: 2, waitMs: 1, timeoutMs: 50 };

test("a switch Plex took without answering in time counts as set", async () => {
  const { server, ctx, prefs } = fakePlex({ putHangsMs: 500, applies: true });
  try {
    expect(await setSwitch(ctx as never, "token", "PublishServerOnPlexOnlineKey", false, quick)).toBe(true);
    expect(prefs.PublishServerOnPlexOnlineKey).toBe(false);
  } finally {
    server.stop(true);
  }
});

test("a switch Plex answered for is set", async () => {
  const { server, ctx } = fakePlex({ applies: true });
  try {
    expect(await setSwitch(ctx as never, "token", "RelayEnabled", false, quick)).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("a switch Plex refused and never took still fails the run", async () => {
  const { server, ctx, prefs } = fakePlex({ putStatus: 500, applies: false });
  try {
    expect(await setSwitch(ctx as never, "token", "RelayEnabled", false, quick)).toBe(false);
    expect(prefs.RelayEnabled).toBe(true);
  } finally {
    server.stop(true);
  }
});
