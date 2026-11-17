import { expect, test } from "bun:test";
import { configure, rewriteChanges, withAccount, withDnsAddress } from "../adguard-home/configure";
import type { HookContext } from "./hook_context";

// AdGuard Home answers the box's Anywhere names with the box's own address on the owner's network.
// HexOS only ever touches the rewrites it made itself.

const BOX = "192.168.1.20";

test("each name gets a rewrite to the box", () => {
  const changes = rewriteChanges([], [], ["photos.example.com", "films.example.com"], BOX);
  expect(changes.add).toEqual([
    { domain: "photos.example.com", answer: BOX },
    { domain: "films.example.com", answer: BOX },
  ]);
  expect(changes.remove).toEqual([]);
  expect(changes.ours).toEqual(changes.add);
});

test("a second run changes nothing", () => {
  const ours = [{ domain: "photos.example.com", answer: BOX }];
  const changes = rewriteChanges(ours, ours, ["photos.example.com"], BOX);
  expect(changes.add).toEqual([]);
  expect(changes.remove).toEqual([]);
  expect(changes.ours).toEqual(ours);
});

test("a name the box stopped answering loses its rewrite", () => {
  const ours = [{ domain: "photos.example.com", answer: BOX }];
  const changes = rewriteChanges(ours, ours, [], BOX);
  expect(changes.remove).toEqual(ours);
  expect(changes.ours).toEqual([]);
});

test("a new address for the box moves every rewrite", () => {
  const ours = [{ domain: "photos.example.com", answer: "192.168.1.9" }];
  const changes = rewriteChanges(ours, ours, ["photos.example.com"], BOX);
  expect(changes.remove).toEqual(ours);
  expect(changes.add).toEqual([{ domain: "photos.example.com", answer: BOX }]);
});

test("the owner's own rewrites stay, and theirs for one of our names wins", () => {
  const theirs = [
    { domain: "router.home", answer: "192.168.1.1" },
    { domain: "photos.example.com", answer: "192.168.1.50" },
  ];
  const changes = rewriteChanges(theirs, [], ["photos.example.com", "films.example.com"], BOX);
  expect(changes.remove).toEqual([]);
  expect(changes.add).toEqual([{ domain: "films.example.com", answer: BOX }]);
});

test("a rewrite the owner deleted is no longer counted as ours", () => {
  const changes = rewriteChanges([], [{ domain: "photos.example.com", answer: BOX }], [], BOX);
  expect(changes.remove).toEqual([]);
});

test("HexOS's account joins the accounts AdGuard Home has", () => {
  const yaml = ["http:", "  address: 0.0.0.0:30004", "users:", "  - name: owner", "    password: $2a$10$abc", "auth_attempts: 5", ""].join("\n");
  expect(withAccount(yaml, "hexos-anywhere", "$2b$10$xyz")).toBe(
    ["http:", "  address: 0.0.0.0:30004", "users:", "  - name: hexos-anywhere", "    password: $2b$10$xyz", "  - name: owner", "    password: $2a$10$abc", "auth_attempts: 5", ""].join("\n"),
  );
});

test("a second account of HexOS's replaces its first", () => {
  const yaml = ["users:", "  - name: hexos-anywhere", "    password: old", "  - name: owner", "    password: theirs", "dns:", ""].join("\n");
  expect(withAccount(yaml, "hexos-anywhere", "new")).toBe(["users:", "  - name: hexos-anywhere", "    password: new", "  - name: owner", "    password: theirs", "dns:", ""].join("\n"));
});

test("an empty account list takes it, and a file without one is left alone", () => {
  expect(withAccount("users: []\ndns:\n", "hexos-anywhere", "h")).toBe("users:\n  - name: hexos-anywhere\n    password: h\ndns:\n");
  expect(withAccount("dns:\n", "hexos-anywhere", "h")).toBeUndefined();
});

// On the server's own network AdGuard Home has to listen on the server's address: on every address
// it loses port 53 to the mesh client and never starts.

const LOCAL = ["127.0.0.1", "::1", BOX, "100.67.242.239"];
const settings = (hosts: string[]) =>
  ["http:", "  address: 0.0.0.0:30004", "users: []", "dns:", ...(hosts.length ? ["  bind_hosts:", ...hosts.map((host) => `    - ${host}`)] : ["  bind_hosts: []"]), "  port: 53", "  upstream_dns:", "    - 9.9.9.9", "filtering:", "  rewrites: []", ""].join("\n");

test("DNS on every address moves to the server's address", () => {
  expect(withDnsAddress(settings(["0.0.0.0"]), BOX, LOCAL)).toBe(settings([BOX]));
  expect(withDnsAddress(settings(["0.0.0.0", "::"]), BOX, LOCAL)).toBe(settings([BOX]));
});

test("DNS on an address the server no longer has moves to the one it has now", () => {
  expect(withDnsAddress(settings(["192.168.1.9"]), BOX, LOCAL)).toBe(settings([BOX]));
});

test("DNS already on the server's address is left alone", () => {
  expect(withDnsAddress(settings([BOX]), BOX, LOCAL)).toBeUndefined();
});

test("an address of the server's that the owner chose is left alone, and so are several", () => {
  expect(withDnsAddress(settings(["127.0.0.1"]), BOX, LOCAL)).toBeUndefined();
  expect(withDnsAddress(settings([BOX, "127.0.0.1"]), BOX, LOCAL)).toBeUndefined();
  expect(withDnsAddress(settings(["192.168.1.9", "127.0.0.1"]), BOX, LOCAL)).toBeUndefined();
});

test("when the server's addresses can't be read, only every address is put right", () => {
  expect(withDnsAddress(settings(["192.168.1.9"]), BOX, [])).toBeUndefined();
  expect(withDnsAddress(settings(["0.0.0.0"]), BOX, [])).toBe(settings([BOX]));
});

test("only the DNS section's own list is read, and a file without one is left alone", () => {
  const other = ["dns:", "  port: 53", "tls:", "  bind_hosts:", "    - 0.0.0.0", ""].join("\n");
  expect(withDnsAddress(other, BOX, LOCAL)).toBeUndefined();
  expect(withDnsAddress(settings([]), BOX, LOCAL)).toBeUndefined();
  expect(withDnsAddress("http:\n", BOX, LOCAL)).toBeUndefined();
});

/** Runs Pre-configure AdGuard Home against a setup page that takes anything, and gives back what it was sent and told. */
async function setUp(context: Partial<HookContext>) {
  const said: string[] = [];
  let sent: { web?: unknown; dns?: unknown } | undefined;
  const ctx = {
    host: BOX,
    port: 30004,
    baseUrl: `http://${BOX}:30004`,
    signIn: { username: "owner", password: "a-password" },
    getAppValues: async () => ({ network: { host_network: true } }),
    registerCheckpoints: async () => {},
    emitCheckpoint: async (_id: string, message?: string) => void said.push(message ?? ""),
    skipCheckpoint: async (_id: string, message?: string) => void said.push(message ?? ""),
    fail: (message: string) => {
      throw new Error(message);
    },
    ...context,
  } as unknown as HookContext;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/control/install/configure")) sent = JSON.parse(String(init?.body));
    return new Response("OK", { status: 200 });
  }) as unknown as typeof fetch;
  try {
    await configure(ctx);
  } finally {
    globalThis.fetch = realFetch;
  }
  return { sent, said };
}

test("the setup page is answered with the server's address for DNS, never every address", async () => {
  const { sent } = await setUp({});
  expect(sent?.dns).toEqual({ ip: BOX, port: 53 });
  expect(sent?.web).toEqual({ ip: "0.0.0.0", port: 30004 });
});

test("an AdGuard Home still in its own network keeps DNS on every address, which is all it has there", async () => {
  const { sent } = await setUp({ getAppValues: async () => ({ network: { host_network: false } }) });
  expect(sent?.dns).toEqual({ ip: "0.0.0.0", port: 53 });
});

test("with no sign-in chosen, the owner is told which address to pick on the setup page", async () => {
  const { sent, said } = await setUp({ signIn: undefined });
  expect(sent).toBeUndefined();
  expect(said.at(-1)).toBe(`Open AdGuard Home to finish its setup page. For its DNS server, pick this server's address, ${BOX}.`);
});
