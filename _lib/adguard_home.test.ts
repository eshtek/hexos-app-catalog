import { expect, test } from "bun:test";
import { rewriteChanges, withAccount } from "../adguard-home/configure";

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
