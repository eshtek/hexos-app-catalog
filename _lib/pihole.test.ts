import { expect, test } from "bun:test";
import { lineChanges, linesFor, probeFor, tomlArray, withPassword } from "../pihole/configure";

// Pi-hole answers the box's Anywhere names with the box's own address on the owner's network, and
// every other record type for them with nothing. HexOS only ever touches the lines it made itself.

const BOX = "192.168.1.20";
const PHOTOS = linesFor("photos.example.com", BOX);
const FILMS = linesFor("films.example.com", BOX);

test("a name gets the three lines HexOS's own DNS service writes", () => {
  expect(PHOTOS).toEqual(["host-record=photos.example.com,192.168.1.20", "local=/photos.example.com/", "server=/*.photos.example.com/#"]);
});

test("each name gets its lines after the owner's own", () => {
  const theirs = ["address=/printer.home/192.168.1.7"];
  const changes = lineChanges(theirs, [], [], ["photos.example.com", "films.example.com"], BOX);
  expect(changes.lines).toEqual([...theirs, ...PHOTOS, ...FILMS]);
  expect(changes.ours).toEqual([...PHOTOS, ...FILMS]);
  expect(changes.changed).toBe(true);
});

test("a second run changes nothing", () => {
  const changes = lineChanges(PHOTOS, PHOTOS, [], ["photos.example.com"], BOX);
  expect(changes.changed).toBe(false);
  expect(changes.lines).toEqual(PHOTOS);
  expect(changes.ours).toEqual(PHOTOS);
});

test("a name the box stopped answering loses its lines, and the owner's stay where they were", () => {
  const theirs = ["address=/printer.home/192.168.1.7", "dns-forward-max=300"];
  const current = [theirs[0]!, ...PHOTOS, theirs[1]!, ...FILMS];
  const changes = lineChanges(current, [...PHOTOS, ...FILMS], [], ["films.example.com"], BOX);
  expect(changes.lines).toEqual([theirs[0]!, theirs[1]!, ...FILMS]);
  expect(changes.ours).toEqual(FILMS);
});

test("with the direct connection off, every line of HexOS's goes and nothing else", () => {
  const theirs = ["address=/printer.home/192.168.1.7"];
  for (const [names, address] of [[[], BOX], [["photos.example.com"], null]] as const) {
    const changes = lineChanges([...theirs, ...PHOTOS], PHOTOS, [], [...names], address);
    expect(changes.lines).toEqual(theirs);
    expect(changes.ours).toEqual([]);
    expect(changes.changed).toBe(true);
  }
});

test("a new address for the box moves every name", () => {
  const old = linesFor("photos.example.com", "192.168.1.9");
  const changes = lineChanges(old, old, [], ["photos.example.com"], BOX);
  // The two lines without an address stay where they were, and the order means nothing to dnsmasq
  expect(changes.lines).toEqual([PHOTOS[1]!, PHOTOS[2]!, PHOTOS[0]!]);
  expect(changes.ours).toEqual(PHOTOS);
});

test("a line the owner wrote for one of our names wins, whatever kind of line it is", () => {
  for (const theirs of ["host-record=photos.example.com,192.168.1.50", "address=/photos.example.com/192.168.1.50", "cname=photos.example.com,nas.home", "server=/photos.example.com/1.1.1.1"]) {
    const changes = lineChanges([theirs], [], [], ["photos.example.com", "films.example.com"], BOX);
    expect(changes.lines).toEqual([theirs, ...FILMS]);
    expect(changes.ours).toEqual(FILMS);
  }
});

test("a Local DNS record of the owner's for one of our names wins too", () => {
  const changes = lineChanges([], [], ["192.168.1.50 nas photos.example.com"], ["photos.example.com", "films.example.com"], BOX);
  expect(changes.lines).toEqual(FILMS);
});

test("a line about a name's subdomains doesn't count as the name", () => {
  const theirs = ["server=/*.photos.example.com/1.1.1.1", "address=/old.photos.example.com/192.168.1.2"];
  expect(lineChanges(theirs, [], [], ["photos.example.com"], BOX).lines).toEqual([...theirs, ...PHOTOS]);
});

test("a line of ours the owner deleted is no longer counted as ours, and one they kept still is", () => {
  const current = ["local=/photos.example.com/"];
  const changes = lineChanges(current, PHOTOS, [], [], BOX);
  expect(changes.lines).toEqual([]);
  expect(lineChanges([], PHOTOS, [], [], BOX).changed).toBe(false);
});

test("a line HexOS never recorded is never taken out, even one that looks like its own", () => {
  const changes = lineChanges(PHOTOS, [], [], [], BOX);
  expect(changes.lines).toEqual(PHOTOS);
  expect(changes.changed).toBe(false);
});

test("a name that could end its line early is never written", () => {
  const bad = ["photos.example.com\naddn-hosts=/etc/passwd", "films.example.com,10.0.0.1", "a b.example.com", "nodots", "-x.example.com", ""];
  const changes = lineChanges([], [], [], bad, BOX);
  expect(changes.lines).toEqual([]);
  expect(changes.changed).toBe(false);
});

test("an address that isn't one writes nothing", () => {
  expect(lineChanges([], [], [], ["photos.example.com"], "192.168.1.20\nserver=1.2.3.4").lines).toEqual([]);
  expect(lineChanges([], [], [], ["photos.example.com"], "fd00::20").lines).toEqual(linesFor("photos.example.com", "fd00::20"));
});

test("names are written once, in small letters", () => {
  expect(lineChanges([], [], [], ["Photos.Example.com", "photos.example.com"], BOX).lines).toEqual(PHOTOS);
  expect(lineChanges([], [], [], ["Photos.Example.com"], BOX).lines).toEqual(PHOTOS);
});

test("the answer to wait for is an added name's, or else a removed one's", () => {
  expect(probeFor([], PHOTOS)).toEqual({ name: "photos.example.com", address: BOX, answered: true });
  expect(probeFor([...PHOTOS, ...FILMS], FILMS)).toEqual({ name: "photos.example.com", address: BOX, answered: false });
  expect(probeFor(linesFor("photos.example.com", "192.168.1.9"), PHOTOS)).toEqual({ name: "photos.example.com", address: BOX, answered: true });
  expect(probeFor(["dns-forward-max=300"], [])).toBeUndefined();
});

// Pi-hole's settings file as FTL 6.9 writes it: sub-tables indented, a changed list one entry a line.
const TOML = [
  "# Pi-hole configuration file (v6.9)",
  "[dns]",
  "  upstreams = [",
  '    "8.8.8.8",',
  '    "8.8.4.4"',
  "  ] ### CHANGED, default = []",
  "",
  '  # Example: [ "127.0.0.1 mylocal", "192.168.0.1 therouter" ]',
  "  hosts = [",
  '    "192.168.1.1 router"',
  "  ] ### CHANGED, default = []",
  "",
  "  [dns.cache]",
  "    size = 10000",
  "",
  "[dhcp]",
  "  hosts = []",
  "",
  "[misc]",
  "  etc_dnsmasq_d = false",
  "",
  '  # Example: [ "address=/example.com/192.168.0.1" ]',
  "  dnsmasq_lines = [",
  '    "host-record=photos.example.com,192.168.1.20",',
  '    "local=/photos.example.com/",',
  '    "server=/*.photos.example.com/#",',
  '    "txt-record=note,\\"a ] quoted, value\\""',
  "  ] ### CHANGED, default = []",
  "",
  "  [misc.check]",
  "    load = true",
  "",
].join("\n");

test("Pi-hole's dnsmasq lines are read from its settings file as it writes them", () => {
  expect(tomlArray(TOML, "misc", "dnsmasq_lines")).toEqual([...PHOTOS, 'txt-record=note,"a ] quoted, value"']);
});

test("a list is read from its own table, not from another table's key of the same name", () => {
  expect(tomlArray(TOML, "dns", "hosts")).toEqual(["192.168.1.1 router"]);
  expect(tomlArray(TOML, "dhcp", "hosts")).toEqual([]);
});

test("a list on one line reads the same, with a comment after it", () => {
  expect(tomlArray('[misc]\n  dnsmasq_lines = [ "a=1", "b=2" ] # mine\n', "misc", "dnsmasq_lines")).toEqual(["a=1", "b=2"]);
});

test("a file without the list, or with one this can't read, gives nothing to build on", () => {
  expect(tomlArray("", "misc", "dnsmasq_lines")).toBeUndefined();
  expect(tomlArray("[misc]\n  etc_dnsmasq_d = false\n", "misc", "dnsmasq_lines")).toBeUndefined();
  expect(tomlArray("[misc]\n  dnsmasq_lines = [ 'a=1' ]\n", "misc", "dnsmasq_lines")).toBeUndefined();
  expect(tomlArray('[misc]\n  dnsmasq_lines = [\n    "a=1",\n', "misc", "dnsmasq_lines")).toBeUndefined();
});

test("the password goes into the app's values and leaves the rest alone", () => {
  const values: Record<string, unknown> = { pihole: { web_password: "old", additional_envs: [{ name: "PIHOLE_UID", value: "568" }] }, network: { host_network: false } };
  withPassword(values, "chosen-by-owner");
  expect(values).toEqual({ pihole: { web_password: "chosen-by-owner", additional_envs: [{ name: "PIHOLE_UID", value: "568" }] }, network: { host_network: false } });
});
