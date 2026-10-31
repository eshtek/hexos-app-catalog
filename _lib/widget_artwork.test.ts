import { afterEach, describe, expect, test } from "bun:test";
import { fetchArtwork as embyArtwork } from "../emby/widget_now_playing";
import { fetchArtwork as jellyfinArtwork } from "../jellyfin/widget_now_playing";
import { fetchArtwork as plexArtwork } from "../plex/widget_now_playing";

// Each media card sends its artwork as a data URI inside the platform's limit. A detailed backdrop
// is over it at the old two crops, and then the card had no picture at all.

const LIMIT = 60_000;
const SHARP = { width: 660, height: 260, quality: 80 };
const SOFTER = { width: 660, height: 260, quality: 60 };
const SMALLER = { width: 560, height: 220, quality: 60 };
const SMALL = { width: 480, height: 190, quality: 60 };
const SMALLEST = { width: 330, height: 130, quality: 60 };
const EVERY_CROP = [SHARP, SOFTER, SMALLER, SMALL, SMALLEST];

interface Ask {
  width: number;
  height: number;
  quality: number;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The bytes whose data URI, with this content type, is `length` long. */
function bytesFor(length: number, type: string): ArrayBuffer {
  const body = length - `data:${type};base64,`.length;
  if (body % 4) throw new Error(`no data URI of ${length} characters with ${type}`);
  return new ArrayBuffer((body / 4) * 3);
}

/** An app answering each crop with a picture of the given data URI length, or with `answer`'s own Response. */
function app(answer: (ask: Ask) => number | Response, type = "image/jpeg"): Ask[] {
  const asked: Ask[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    const ask = {
      width: Number(url.searchParams.get("width") ?? url.searchParams.get("fillWidth")),
      height: Number(url.searchParams.get("height") ?? url.searchParams.get("fillHeight")),
      quality: Number(url.searchParams.get("quality")),
    };
    asked.push(ask);
    const result = answer(ask);
    if (result instanceof Response) return result;
    return new Response(bytesFor(result, type), { headers: { "content-type": type } });
  }) as typeof fetch;
  return asked;
}

let items = 0;
const JSON_HEADERS = { Accept: "application/json" };
const cards = [
  {
    name: "Jellyfin",
    artwork: (id: string) =>
      jellyfinArtwork("http://app", JSON_HEADERS, { Id: id, BackdropImageTags: ["tag"] } as never),
    format: "format=Jpg",
    path: (id: string) => `/Items/${id}/Images/Backdrop/0`,
  },
  {
    name: "Emby",
    artwork: (id: string) => embyArtwork("http://app", JSON_HEADERS, { Id: id, BackdropImageTags: ["tag"] } as never),
    format: "format=jpg",
    path: (id: string) => `/emby/Items/${id}/Images/Backdrop/0`,
  },
  {
    name: "Plex",
    artwork: (id: string) => plexArtwork("http://app", "token", { title: "Coco", art: `/art/${id}` }),
    format: "format=jpeg",
    path: () => "/photo/:/transcode",
  },
];

describe.each(cards)("$name artwork", ({ artwork, format, path }) => {
  const item = () => `item-${++items}`;

  test("a picture that fits is asked for once, at full size and quality", async () => {
    const asked = app(() => 40_003);
    expect(await artwork(item())).toStartWith("data:image/jpeg;base64,");
    expect(asked).toEqual([SHARP]);
  });

  test("a picture over the limit comes down a step at a time, to the first that fits", async () => {
    // Coco's backdrop as Jellyfin gives it: 111,251 and 71,559 characters, then 51,079
    const asked = app(({ width, quality }) => {
      if (width === SHARP.width) return quality === SHARP.quality ? 111_251 : 71_559;
      return 51_079;
    });
    const image = await artwork(item());
    expect(asked).toEqual([SHARP, SOFTER, SMALLER]);
    expect(image?.length).toBe(51_079);
  });

  test("the smallest crop is the last one tried, and it is enough", async () => {
    const asked = app((ask) => (ask.width === SMALLEST.width ? 29_839 : 62_435));
    expect((await artwork(item()))?.length).toBe(29_839);
    expect(asked).toEqual(EVERY_CROP);
  });

  test("a picture over the limit at every crop leaves the card without one, and is asked for again", async () => {
    const asked = app(() => 80_003);
    const id = item();
    expect(await artwork(id)).toBeUndefined();
    expect(asked).toEqual(EVERY_CROP);
    asked.length = 0;
    await artwork(id);
    expect(asked).toEqual(EVERY_CROP);
  });

  test("a picture exactly at the limit fits", async () => {
    // A content type of this length is what lets a data URI land on the limit exactly
    const asked = app(() => LIMIT, "image/x-foo");
    expect((await artwork(item()))?.length).toBe(LIMIT);
    expect(asked).toEqual([SHARP]);
  });

  test("the smallest step past the limit doesn't", async () => {
    const asked = app(() => LIMIT + 4, "image/x-foo");
    expect(await artwork(item())).toBeUndefined();
    expect(asked).toEqual(EVERY_CROP);
  });

  test("a failed answer ends it, since a smaller crop of it would fail too", async () => {
    const asked = app(() => new Response("no", { status: 500 }));
    expect(await artwork(item())).toBeUndefined();
    expect(asked).toEqual([SHARP]);
  });

  test("an answer that isn't an image ends it", async () => {
    const asked = app(() => new Response("<html>", { headers: { "content-type": "text/html" } }));
    expect(await artwork(item())).toBeUndefined();
    expect(asked).toEqual([SHARP]);
  });

  test("an app that can't be reached leaves the card without a picture, and doesn't fail it", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    expect(await artwork(item())).toBeUndefined();
  });

  test("a picture that fit is kept, so a refresh doesn't ask again", async () => {
    const asked = app((ask) => (ask.quality === 80 ? 71_559 : 51_079));
    const id = item();
    const image = await artwork(id);
    asked.length = 0;
    expect(await artwork(id)).toBe(image);
    expect(asked).toEqual([]);
  });

  test("the app is asked for a JPEG of that picture", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL) => {
      urls.push(String(input));
      return new Response(new Uint8Array(3), { headers: { "content-type": "image/jpeg" } });
    }) as typeof fetch;
    const id = item();
    await artwork(id);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(format);
    expect(urls[0]).toContain(path(id));
  });
});
