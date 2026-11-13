import { describe, expect, test } from "bun:test";
import { longEdgeFor, picture, signIn } from "../photostructure/previews";
import type { PreviewPictureContext, PreviewScriptFetch, PreviewSignInContext } from "./previews_context";

// The PhotoStructure adapter is protocol only: a bearer header from the install's token, and the
// preview route's address for a file's path on the server at a long edge the deck's ask maps to.

const app = { id: "photostructure", baseUrl: "http://box:30509" };
const signal = new AbortController().signal;
const neverFetch: PreviewScriptFetch = async () => {
  throw new Error("the adapter asks PhotoStructure for nothing of its own");
};
const session = { headers: {} };

const signInContext = (credentials: Record<string, string>): PreviewSignInContext => ({
  app,
  credentials,
  fetch: neverFetch,
  signal,
});

const pictureContext = (size: number): PreviewPictureContext => ({
  app,
  path: "2024/a b/IMG_0001.heic",
  hostPath: "/mnt/HDDs/Photos/2024/a b/IMG_0001.heic",
  kind: "image",
  extension: "heic",
  size,
  session,
  fetch: neverFetch,
  signal,
});

describe("the PhotoStructure previews adapter", () => {
  test("signs in with the install's token as a bearer header, and bare when the install wrote none", async () => {
    expect(await signIn(signInContext({ token: "abc123" }))).toEqual({ headers: { Authorization: "Bearer abc123" } });
    expect(await signIn(signInContext({}))).toEqual({ headers: {} });
    expect(await signIn(signInContext({ token: "  " }))).toEqual({ headers: {} });
  });

  test("names the preview route with the file's path on the server, encoded whole, at the long edge for the ask", async () => {
    expect(await picture(pictureContext(320))).toEqual({
      path: "/api/preview?path=%2Fmnt%2FHDDs%2FPhotos%2F2024%2Fa%20b%2FIMG_0001.heic&size=480",
    });
    expect(await picture(pictureContext(1080))).toEqual({
      path: "/api/preview?path=%2Fmnt%2FHDDs%2FPhotos%2F2024%2Fa%20b%2FIMG_0001.heic&size=1620",
    });
  });

  test("the long edge is 1.5 times the shorter side asked, rounded up to the tile step or the viewer step", () => {
    expect(longEdgeFor(240)).toBe(480);
    expect(longEdgeFor(320)).toBe(480);
    expect(longEdgeFor(321)).toBe(1620);
    expect(longEdgeFor(1080)).toBe(1620);
    expect(longEdgeFor(5000)).toBe(1620);
  });
});
