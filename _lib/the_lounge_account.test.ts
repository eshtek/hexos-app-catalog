import { describe, expect, test } from "bun:test";
import { privateToApp } from "../the-lounge/create_account";

// The Lounge's setup step writes the account into a folder the app owns, as root. HexOS folders
// carry an inherited NFSv4 ACL, so what the app makes there reads as 0770 to apps and root, and the
// step must accept that while still refusing a folder or file a stranger can reach.

const DIR = 0o40000;
const FILE = 0o100000;

describe("The Lounge's account folder and file", () => {
  test("pass under HexOS's inherited ACL: apps, with root's group", () => {
    expect(privateToApp({ uid: 568, gid: 0, mode: DIR | 0o770 })).toBe(true);
    expect(privateToApp({ uid: 568, gid: 0, mode: FILE | 0o770 })).toBe(true);
    expect(privateToApp({ uid: 568, gid: 568, mode: FILE | 0o770 })).toBe(true);
  });

  test("pass when only apps can reach them, whatever the group", () => {
    expect(privateToApp({ uid: 568, gid: 568, mode: DIR | 0o700 })).toBe(true);
    expect(privateToApp({ uid: 568, gid: 1000, mode: FILE | 0o600 })).toBe(true);
  });

  test("fail when anyone at all can reach them", () => {
    expect(privateToApp({ uid: 568, gid: 0, mode: DIR | 0o775 })).toBe(false);
    expect(privateToApp({ uid: 568, gid: 568, mode: FILE | 0o604 })).toBe(false);
  });

  test("fail when a group other than root's and apps' can reach them", () => {
    expect(privateToApp({ uid: 568, gid: 1000, mode: DIR | 0o770 })).toBe(false);
    expect(privateToApp({ uid: 568, gid: 1000, mode: FILE | 0o640 })).toBe(false);
  });

  test("fail when apps doesn't own them", () => {
    expect(privateToApp({ uid: 0, gid: 0, mode: DIR | 0o700 })).toBe(false);
    expect(privateToApp({ uid: 1000, gid: 568, mode: FILE | 0o600 })).toBe(false);
  });
});
