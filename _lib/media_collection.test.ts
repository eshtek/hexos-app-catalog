import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Media library lets an owner tick no media manager: one who only wants a download client and a media
// server, or who keeps the managers they already have as they are (Aaron, 2026-11-08). A download
// client is still needed, since nothing else in the collection fetches anything.

interface Group {
  id: string;
  min?: number;
}

const groups = (JSON.parse(readFileSync(new URL("../_collections/media-management.json", import.meta.url), "utf-8")) as {
  groups: Group[];
}).groups;
const group = (id: string) => groups.find((each) => each.id === id);

test("the media managers step can be left empty", () => {
  expect(group("managers")).toBeDefined();
  expect(group("managers")?.min).toBeUndefined();
});

test("the download clients step still asks for one", () => {
  expect(group("download")?.min).toBe(1);
});
