import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  applyChange,
  followVersion,
  laneTags,
  newestTag,
  notesSection,
  type Release,
  raisePatch,
  registryOf,
  releasesBetween,
  settingsChanges,
  settingsOf,
  splitPin,
  tagShape,
  updateFor,
  type WatchedApp,
  watchedApps,
} from "./image_watch";

// The tags GHCR listed for the Valheim image on 2026-10-29, the build tags among them
const VALHEIM_TAGS = ["sha-b824ca1", "1.0.0", "1.1.0", "sha-80a3d1f", "1.2.0", "1.3.0", "1.4.0", "sha-ee2bcf8", "1.4.1", "sha-0ab6cdc"];
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const watched: WatchedApp = {
  app: "valheim",
  file: "valheim.json",
  name: "Valheim",
  repository: "ghcr.io/community-valheim-tools/valheim-server",
  pin: `1.4.1@${DIGEST_A}`,
  scriptVersion: "1.0.0",
  metadataVersion: "1.4.1",
  sources: ["https://github.com/community-valheim-tools/valheim-server-docker"],
};

describe("tags", () => {
  test("a pin splits into its version and digest", () => {
    expect(splitPin("1.4.1")).toEqual({ version: "1.4.1" });
    expect(splitPin(`1.4.1@${DIGEST_A}`)).toEqual({ version: "1.4.1", digest: DIGEST_A });
  });

  test("a tag with no number in it names no version to follow", () => {
    expect(tagShape("latest")).toBeNull();
    expect(newestTag("latest", ["latest", "1.0.0"])).toBeNull();
  });

  test("the newest tag of the pin's shape wins, and build tags never match", () => {
    expect(newestTag("1.3.0", VALHEIM_TAGS)).toBe("1.4.1");
    expect(newestTag("1.4.1", VALHEIM_TAGS)).toBeNull();
  });

  test("numbers compare as numbers, not text", () => {
    expect(newestTag("1.9.0", ["1.10.0", "1.9.1"])).toBe("1.10.0");
  });

  test("Kodi's build number and version both move it, and a release candidate doesn't", () => {
    expect(newestTag("21.2-1", ["21.2-1", "21.2-2", "21.3-rc1", "21.2"])).toBe("21.2-2");
    expect(newestTag("21.2-1", ["21.2-2", "21.3-1"])).toBe("21.3-1");
  });

  test("the text around the numbers must match too", () => {
    expect(newestTag("v1.2.3", ["1.9.9", "v1.3.0"])).toBe("v1.3.0");
  });

  test("an older tag of the same shape is never an update", () => {
    expect(newestTag("1.4.1", ["1.4.0", "0.9.9"])).toBeNull();
  });
});

describe("laneTags", () => {
  test("the pin's own major version and the next one are offered apart", () => {
    expect(laneTags("1.3.0", [...VALHEIM_TAGS, "2.0.0", "2.1.0"])).toEqual({ current: "1.4.1", major: "2.1.0" });
  });

  test("a pin on its major version's newest tag still sees the next major version", () => {
    expect(laneTags("1.4.1", [...VALHEIM_TAGS, "2.0.0"])).toEqual({ current: null, major: "2.0.0" });
    expect(laneTags("1.4.1", VALHEIM_TAGS)).toEqual({ current: null, major: null });
    expect(laneTags("1.3.0", VALHEIM_TAGS)).toEqual({ current: "1.4.1", major: null });
  });

  test("Kodi's first number is Kodi's own version", () => {
    expect(laneTags("21.2-1", ["21.2-2", "22.0-1", "22.0-rc1"])).toEqual({ current: "21.2-2", major: "22.0-1" });
  });
});

describe("followVersion", () => {
  test("a metadata.version that is the tag becomes the new tag", () => {
    expect(followVersion("1.4.1", "1.4.1", "1.5.0")).toBe("1.5.0");
  });

  test("one that is the tag's leading numbers takes the new tag's", () => {
    expect(followVersion("21.2", "21.2-1", "21.3-1")).toBe("21.3");
    expect(followVersion("21.2", "21.2-1", "21.2-2")).toBe("21.2");
    expect(followVersion("21", "21.2-1", "22.0-1")).toBe("22");
  });

  test("one that says something else is left for a person", () => {
    expect(followVersion("21.2", "21.25-1", "21.26-1")).toBeNull();
    expect(followVersion("2026.1", "1.4.1", "1.5.0")).toBeNull();
    expect(followVersion("1.4.1", "v1.4.1", "v1.5.0")).toBeNull();
  });
});

describe("raisePatch", () => {
  test("raises the last number", () => {
    expect(raisePatch("1.0.9")).toBe("1.0.10");
  });

  test("refuses a version the platform's semver can't read", () => {
    expect(() => raisePatch("1.0")).toThrow();
  });
});

describe("registryOf", () => {
  test("a bare name is on Docker Hub, an official image under library/", () => {
    expect(registryOf("eshtek/kodi")).toEqual({ host: "registry-1.docker.io", repository: "eshtek/kodi" });
    expect(registryOf("nginx")).toEqual({ host: "registry-1.docker.io", repository: "library/nginx" });
    expect(registryOf("docker.io/nginx")).toEqual({ host: "registry-1.docker.io", repository: "library/nginx" });
  });

  test("a host in the first part is the registry", () => {
    expect(registryOf("ghcr.io/community-valheim-tools/valheim-server")).toEqual({
      host: "ghcr.io",
      repository: "community-valheim-tools/valheim-server",
    });
    expect(registryOf("localhost:5000/kodi")).toEqual({ host: "localhost:5000", repository: "kodi" });
  });
});

describe("applyChange", () => {
  // Kodi's layout, by hand: the image on one line
  const kodi = `{
  "version": 6,
  "custom": true,
  "metadata": {
    "name": "Kodi",
    "version": "21.2"
  },
  "script": {
    "version": "1.0.0",
    "changeLog": "Kodi on the TV."
  },
  "app_values": {
    "image": { "repository": "eshtek/kodi", "tag": "21.2-1", "pull_policy": "missing" },
    "envs": [{ "name": "KODI_WEB_PORT", "value": "21.2-1" }]
  }
}
`;

  test("writes the tag, versions and change log in place, and nothing else", () => {
    const next = applyChange(kodi, { tag: "21.3-1", scriptVersion: "1.0.1", changeLog: "Runs eshtek/kodi 21.3-1.", metadataVersion: "21.3" });
    expect(next).toBe(
      kodi
        .replace('"tag": "21.2-1"', '"tag": "21.3-1"')
        .replace('"version": "1.0.0"', '"version": "1.0.1"')
        .replace('"Kodi on the TV."', '"Runs eshtek/kodi 21.3-1."')
        .replace('"version": "21.2"', '"version": "21.3"'),
    );
    // The same text elsewhere in the script stays as it was
    expect(next).toContain('"value": "21.2-1"');
  });

  test("adds a change log the script lacks at the file's own indent", () => {
    const fourSpaces = `{
    "script": {
        "version": "1.0.0"
    },
    "app_values": {
        "image": {
            "repository": "eshtek/kodi",
            "tag": "21.2-1"
        }
    }
}
`;
    const next = applyChange(fourSpaces, { tag: "21.2-2", scriptVersion: "1.0.1", changeLog: "Runs eshtek/kodi 21.2-2." });
    expect(next).toContain('        "version": "1.0.1",\n        "changeLog": "Runs eshtek/kodi 21.2-2."\n    },');
    expect(JSON.parse(next).app_values.image.tag).toBe("21.2-2");
  });
});

describe("the catalog", () => {
  const app: WatchedApp = {
    app: "valheim",
    file: "valheim.json",
    name: "Valheim",
    repository: "ghcr.io/community-valheim-tools/valheim-server",
    pin: `1.4.1@${DIGEST_A}`,
    scriptVersion: "1.0.0",
    metadataVersion: "1.4.1",
    sources: ["https://github.com/community-valheim-tools/valheim-server-docker"],
  };

  test("only custom apps whose pin names a version are watched", () => {
    const dir = mkdtempSync(`${tmpdir()}/image-watch-`);
    const image = (tag: string) => ({ image: { repository: "example/app", tag } });
    writeFileSync(`${dir}/valheim.json`, JSON.stringify({ custom: true, script: { version: "1.0.0" }, app_values: image("1.4.1") }));
    writeFileSync(`${dir}/hexos-test.json`, JSON.stringify({ custom: true, script: { version: "1.0.0" }, app_values: image("latest") }));
    writeFileSync(`${dir}/plex.json`, JSON.stringify({ script: { version: "1.0.0" }, app_values: { network: {} } }));
    expect(watchedApps(dir).map((a) => a.app)).toEqual(["valheim"]);
  });

  test("an update keeps the digest pinned, and its pull request names it", () => {
    const update = updateFor(app, "1.5.0", DIGEST_B);
    expect(update.to).toBe(`1.5.0@${DIGEST_B}`);
    expect(update.change).toEqual({
      tag: `1.5.0@${DIGEST_B}`,
      scriptVersion: "1.0.1",
      changeLog: "Runs ghcr.io/community-valheim-tools/valheim-server 1.5.0.",
      metadataVersion: "1.5.0",
    });
    expect(update.title).toBe("Valheim's image moves to 1.5.0");
    expect(update.body).toContain(DIGEST_B);
    expect(update.body).toContain("https://github.com/community-valheim-tools/valheim-server-docker/releases");
    expect(update.body).not.toContain("first number moved");
  });

  test("a pin with no digest gets none", () => {
    expect(updateFor({ ...app, pin: "1.4.1" }, "1.5.0").to).toBe("1.5.0");
  });

  test("a major step and a metadata.version it can't follow are named for the reviewer", () => {
    const update = updateFor({ ...app, metadataVersion: "Ashlands" }, "2.0.0", DIGEST_B);
    expect(update.body).toContain("The first number moved (1.4.1 to 2.0.0)");
    expect(update.body).toContain("`metadata.version` (Ashlands) doesn't read as the tag");
    expect(update.change.metadataVersion).toBeUndefined();
  });
});

describe("the next major version", () => {
  const app: WatchedApp = {
    app: "valheim",
    file: "valheim.json",
    name: "Valheim",
    repository: "ghcr.io/community-valheim-tools/valheim-server",
    pin: `1.4.1@${DIGEST_A}`,
    scriptVersion: "1.0.0",
    metadataVersion: "1.4.1",
    sources: [],
  };

  test("opens as a draft on its own branch, so the current major version's updates keep theirs", () => {
    const major = updateFor(app, "2.0.0", DIGEST_B);
    expect(major).toMatchObject({ id: "valheim-major", lane: "major", branch: "image-watch/valheim-major", draft: true });
    expect(major.body).toContain("Updates within 1.x keep coming in their own pull request");
    expect(updateFor(app, "1.5.0", DIGEST_B)).toMatchObject({ id: "valheim", lane: "current", branch: "image-watch/valheim", draft: false });
  });
});

describe("what the image declares", () => {
  const blob = (config: Record<string, unknown>) => ({ architecture: "amd64", config });
  const pinned = settingsOf(
    blob({
      Env: ["PATH=/usr/bin", "CROSSPLAY=false", "OLD_NAME=1"],
      ExposedPorts: { "2456/udp": {} },
      Volumes: { "/config": {} },
      Entrypoint: ["/usr/local/sbin/bootstrap"],
      Cmd: null,
    }),
  );

  test("an image config's settings are read, the command as entrypoint then cmd", () => {
    expect(pinned).toEqual({
      env: { PATH: "/usr/bin", CROSSPLAY: "false", OLD_NAME: "1" },
      ports: ["2456/udp"],
      volumes: ["/config"],
      user: "",
      command: ["/usr/local/sbin/bootstrap"],
    });
    expect(settingsOf({})).toEqual({ env: {}, ports: [], volumes: [], user: "", command: [] });
  });

  test("only what moved is listed, a renamed variable as one gone and one new", () => {
    const newest = settingsOf(
      blob({
        Env: ["PATH=/usr/bin", "CROSSPLAY=true", "NEW_NAME=1"],
        ExposedPorts: { "2456/udp": {}, "2459/udp": {} },
        Volumes: { "/data": {} },
        User: "1000",
        Entrypoint: ["/usr/local/sbin/bootstrap"],
      }),
    );
    expect(settingsChanges(pinned, newest)).toEqual([
      ["Variable CROSSPLAY", "false", "true"],
      ["Variable NEW_NAME", "", "1"],
      ["Variable OLD_NAME", "1", ""],
      ["Ports", "2456/udp", "2456/udp 2459/udp"],
      ["Folders", "/config", "/data"],
      ["User", "", "1000"],
    ]);
    expect(settingsChanges(pinned, pinned)).toEqual([]);
  });

  test("the pull request shows the changes as a table, its cells safe for one", () => {
    const newest = { ...pinned, env: { ...pinned.env, ARGS: "-a | -b `x`" } };
    const update = updateFor({ ...watched, sources: [] }, "1.5.0", DIGEST_B, { settings: { before: pinned, after: newest } });
    expect(update.body).toContain("### What the image declares (linux/amd64)");
    expect(update.body).toContain("| Variable ARGS | not declared | `` -a \\| -b `x` `` |");
  });

  test("the same settings, or ones that couldn't be read, say so", () => {
    expect(updateFor(watched, "1.5.0", DIGEST_B, { settings: { before: pinned, after: pinned } }).body).toContain(
      "The same variables, ports, folders, start command and user as the pinned image.",
    );
    expect(updateFor(watched, "1.5.0", DIGEST_B, { settings: { error: "1.5.0 has no linux/amd64 image" } }).body).toContain(
      "⚠️ The two images couldn't be compared: 1.5.0 has no linux/amd64 image",
    );
  });
});

describe("release notes", () => {
  const release = (tag: string, body = `Notes for ${tag}`): Release => ({ tag, body, url: `https://github.com/o/r/releases/tag/${tag}` });

  test("the releases after the pin up to the newest, newest first, in the pin's shape", () => {
    const releases = ["v1.3.0", "v1.4.0", "1.4.1", "v1.4.1-rc1", "v1.5.0", "v1.6.0", "nightly"].map((t) => release(t));
    expect(releasesBetween(releases, "1.3.0", "1.5.0").map((r) => r.tag)).toEqual(["v1.5.0", "1.4.1", "v1.4.0"]);
    expect(releasesBetween([release("21.3-Omega"), release("21.3-1")], "21.2-1", "21.3-1").map((r) => r.tag)).toEqual(["21.3-1"]);
  });

  test("each sits in a code block longer than any backtick run in it, so nothing in it links or notifies", () => {
    const lines = notesSection([release("1.5.0", "Thanks @someone for #12\n```sh\nrun\n```")]);
    expect(lines).toContain("````text");
    const open = lines.indexOf("````text");
    const close = lines.indexOf("````", open + 1);
    const mention = lines.findIndex((line) => line.includes("@someone"));
    expect(open).toBeLessThan(mention);
    expect(mention).toBeLessThan(close);
  });

  test("a long note is cut with a link to the rest, and past ten releases the older ones are counted", () => {
    const long = notesSection([release("1.5.0", "x".repeat(5000))]);
    expect(long).toContain("The rest: https://github.com/o/r/releases/tag/1.5.0");
    const many = notesSection(Array.from({ length: 12 }, (_, i) => release(`1.${20 - i}.0`)));
    expect(many.filter((line) => line.startsWith("<details>"))).toHaveLength(10);
    expect(many).toContain("2 older releases are left out.");
  });

  test("the pull request quotes them, says when none match or they couldn't be read, and links them otherwise", () => {
    expect(updateFor(watched, "1.5.0", DIGEST_B, { releases: [release("v1.5.0")] }).body).toContain("<summary>v1.5.0</summary>");
    expect(updateFor(watched, "1.5.0", DIGEST_B, { releases: [] }).body).toContain("No release on GitHub has a tag shaped like the image's");
    expect(updateFor(watched, "1.5.0", DIGEST_B, { releases: { error: "403" } }).body).toContain("⚠️ They couldn't be read (403)");
    expect(updateFor({ ...watched, sources: [] }, "1.5.0", DIGEST_B, { releases: [] }).body).not.toContain("Release notes");
  });
});
