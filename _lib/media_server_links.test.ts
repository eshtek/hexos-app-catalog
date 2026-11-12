import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// What Jellyfin, Emby and Plex declare for Lidarr and Sportarr, and when Media library plans each
// link. A collection has no list of links: HexOS runs every pairing hook whose apps are all in the
// run (README, Collections), so a link is planned by its conditions. Aaron asked for links to
// Lidarr and Sportarr and none to Chaptarr (2026-11-12).

interface Condition {
  role: string;
  type: string;
  app: string;
}

interface Hook {
  id: string;
  title?: string;
  description?: string;
  kind?: string;
  conditions?: Condition[];
  [field: string]: unknown;
}

const read = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf-8"));
const SERVERS = ["jellyfin", "emby", "plex"];
const NAMES: Record<string, string> = { jellyfin: "Jellyfin", emby: "Emby", plex: "Plex" };
const hooks = (app: string) => read(`${app}.json`).hooks as Hook[];
const hook = (app: string, id: string) => hooks(app).find((each) => each.id === id);
const collection = read("_collections/media-management.json") as { groups: Array<{ options: Array<{ app: string }> }> };
const offered = collection.groups.flatMap((group) => group.options.map((option) => option.app));

/** The links of an app that a run with these apps plans: the ones whose every app takes part. */
const planned = (app: string, picks: string[]) =>
  hooks(app)
    .filter((each) => each.kind === "connect" && picks.includes(app) && (each.conditions ?? []).every((condition) => picks.includes(condition.app)))
    .map((each) => each.id);

/** A link's conditions: shown when the other app is installed, and ready when both are running. */
const pairing = (server: string, other: string) => [
  { role: "visibility", type: "appInstalled", app: other },
  { role: "availability", type: "appRunning", app: other },
  { role: "availability", type: "appRunning", app: server },
];

describe("Connect to Lidarr", () => {
  test("Plex declares it exactly as it declares Connect to Radarr", () => {
    const radarr = JSON.stringify(hook("plex", "connect-radarr"));
    expect(hook("plex", "connect-lidarr")).toEqual(JSON.parse(radarr.replaceAll("Radarr", "Lidarr").replaceAll("radarr", "lidarr")));
    expect(hook("plex", "connect-lidarr")).toMatchObject({
      title: "Connect to Lidarr",
      description: "Shows what Lidarr adds, renames or removes in Plex right away.",
      kind: "connect",
      conditions: pairing("plex", "lidarr"),
      requiresHooks: ["configure-plex"],
      rerun: "converge",
      copies: "each",
      script: "servarr/connect_media_server.ts",
      entrypoint: "lidarr",
    });
  });

  // Lidarr 3.2.1.5196 names no real folder to Jellyfin or Emby, so a connection there would update nothing
  test.each(["jellyfin", "emby"])("%s declares none", (server) => {
    expect(hook(server, "connect-lidarr")).toBeUndefined();
  });

  test("Media library plans it when Plex and Lidarr both take part, and only then", () => {
    expect(offered).toEqual(expect.arrayContaining(["plex", "lidarr"]));
    expect(planned("plex", ["plex", "lidarr"])).toEqual(["connect-lidarr"]);
    expect(planned("plex", ["plex", "radarr"])).not.toContain("connect-lidarr");
    expect(planned("plex", ["lidarr"])).toEqual([]);
    for (const server of ["jellyfin", "emby"]) expect(planned(server, [server, "lidarr"])).toEqual([]);
  });
});

describe.each(SERVERS)("%s's Connect to Sportarr", (server) => {
  const link = hook(server, "connect-sportarr");
  const name = NAMES[server];

  test("is one row, which adds the library and then the connection", () => {
    expect(hooks(server).filter((each) => (each.conditions ?? []).some((condition) => condition.app === "sportarr"))).toHaveLength(1);
    expect(link).toMatchObject({
      title: "Connect to Sportarr",
      description: `Adds a Sports library to ${name} for what Sportarr fetches. What Sportarr adds or renames shows in it right away.`,
      kind: "connect",
      conditions: pairing(server, "sportarr"),
      rerun: "converge",
      script: `${server}/add_library.ts`,
      entrypoint: "sportarr",
      retries: 0,
    });
    // Sportarr runs as one copy, so the link names no copies
    expect(read("sportarr.json").requirements.instances).toBeUndefined();
    expect(link?.copies).toBeUndefined();
  });

  test("Media library plans it when the server and Sportarr both take part, and only then", () => {
    expect(offered).toEqual(expect.arrayContaining([server, "sportarr"]));
    expect(planned(server, [server, "sportarr"])).toEqual(["connect-sportarr"]);
    expect(planned(server, [server, "radarr"])).not.toContain("connect-sportarr");
    expect(planned(server, ["sportarr"])).toEqual([]);
  });
});

test("every link to Lidarr or Sportarr is described in one or two short sentences, with no dash", () => {
  for (const server of SERVERS) {
    for (const id of ["connect-lidarr", "connect-sportarr"]) {
      const description = hook(server, id)?.description;
      if (description === undefined) continue;
      expect(description).not.toMatch(/[–—]/);
      const sentences = description.split(". ");
      expect(sentences.length).toBeLessThanOrEqual(2);
      for (const sentence of sentences) expect(sentence.length).toBeLessThanOrEqual(70);
    }
  }
});

test("Chaptarr gets no link that tells a media server what it changes", () => {
  for (const server of SERVERS) {
    for (const each of hooks(server)) {
      if ((each.conditions ?? []).some((condition) => condition.app === "chaptarr")) expect(each.script).toBe(`${server}/add_library.ts`);
    }
  }
});
