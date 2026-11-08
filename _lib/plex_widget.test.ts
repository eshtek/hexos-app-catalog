import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { WidgetContext, WidgetQueryResult } from "./widget_context";

// Plex's card says how each stream is served and at what bitrate. Session.bandwidth is what Plex
// reserves for the stream, and a direct play on the home network can come with none, so the card
// falls back to the bitrate of the version that plays.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

let imports = 0;
/** A fresh copy of the script: each keeps its own count of the last run's streams, as a box's does. */
const fresh = async () =>
  (await import(`${import.meta.dir}/../plex/widget_now_playing.ts?fresh=${++imports}`)) as {
    run(ctx: WidgetContext): Promise<WidgetQueryResult>;
  };

/** The card's run against a Plex playing `session`, with the owner's token on the dataset. */
async function card(session: Record<string, unknown>): Promise<WidgetQueryResult> {
  const dir = mkdtempSync(join(tmpdir(), "hexos-plex-widget-"));
  const prefs = join(dir, "Library/Application Support/Plex Media Server/Preferences.xml");
  mkdirSync(dirname(prefs), { recursive: true });
  writeFileSync(prefs, '<Preferences PlexOnlineToken="token"/>');
  globalThis.fetch = (async (input: string | URL) => {
    if (new URL(String(input)).pathname === "/status/sessions") {
      return Response.json({ MediaContainer: { Metadata: [{ title: "Coco", User: { title: "sam" }, Player: { product: "Plex for LG" }, ...session }] } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const { run } = await fresh();
  return run({
    appId: "plex",
    host: "10.0.0.2",
    port: 32400,
    mounts: [{ hostPath: "/mnt/tank/plex/config", containerPath: "/config", localPath: dir }],
    log: () => {},
  } as never);
}

/** The line that says how the stream is served. */
const how = (result: WidgetQueryResult) => {
  const sessions = result.fields?.sessions;
  return sessions?.type === "list" ? sessions.entries[0]?.subtitles?.[1] : undefined;
};

describe("plex, how a stream is served", () => {
  test("a direct play on the home network with no reserved bandwidth shows the version's bitrate", async () => {
    const result = await card({ Session: { location: "lan" }, Media: [{ bitrate: 8200 }] });
    expect(how(result)).toBe("DirectPlay · 8.2 Mbps");
  });

  test("a reserved bandwidth of 0 reads as none, so the version's bitrate shows", async () => {
    const result = await card({ Session: { location: "lan", bandwidth: 0 }, Media: [{ bitrate: 8200 }] });
    expect(how(result)).toBe("DirectPlay · 8.2 Mbps");
  });

  test("with no Session at all, the version's bitrate shows", async () => {
    expect(how(await card({ Media: [{ bitrate: 8200 }] }))).toBe("DirectPlay · 8.2 Mbps");
  });

  test("the reserved bandwidth wins when Plex gives one", async () => {
    const result = await card({
      Session: { location: "wan", bandwidth: 4000 },
      Media: [{ bitrate: 8200 }],
      TranscodeSession: { videoDecision: "transcode" },
    });
    expect(how(result)).toBe("Transcode · 4.0 Mbps");
  });

  test("an item with several versions shows the bitrate of the one that plays", async () => {
    const result = await card({ Media: [{ bitrate: 20000 }, { bitrate: 8200, selected: true }] });
    expect(how(result)).toBe("DirectPlay · 8.2 Mbps");
  });

  test("a single version not marked as playing shows its bitrate", async () => {
    expect(how(await card({ Media: [{ bitrate: 8200 }] }))).toBe("DirectPlay · 8.2 Mbps");
  });

  test("several versions with none marked as playing show no figure, since any could be the one", async () => {
    expect(how(await card({ Media: [{ bitrate: 8200 }, { bitrate: 20000 }] }))).toBe("DirectPlay");
  });

  test("a transcode with no reserved bandwidth shows no figure, not the file's bitrate", async () => {
    const result = await card({ Media: [{ bitrate: 8200 }], TranscodeSession: { videoDecision: "transcode", audioDecision: "copy" } });
    expect(how(result)).toBe("Transcode");
  });

  test("re-encoded audio alone shows no figure either, as what's sent isn't the file", async () => {
    const result = await card({ Media: [{ bitrate: 8200 }], TranscodeSession: { videoDecision: "copy", audioDecision: "transcode" } });
    expect(how(result)).toBe("DirectPlay");
  });

  test("a part Plex says it transcodes shows no figure, with no transcoder details", async () => {
    expect(how(await card({ Media: [{ bitrate: 8200, Part: [{ decision: "transcode" }] }] }))).toBe("DirectPlay");
  });

  test("a remux, which sends the file's own streams, shows the file's bitrate", async () => {
    const result = await card({
      Media: [{ bitrate: 8200, Part: [{ decision: "copy" }] }],
      TranscodeSession: { videoDecision: "copy", audioDecision: "copy" },
    });
    expect(how(result)).toBe("DirectPlay · 8.2 Mbps");
  });

  test("with no bitrate anywhere, the line shows no figure", async () => {
    expect(how(await card({ Session: { location: "lan" }, Media: [{}] }))).toBe("DirectPlay");
    expect(how(await card({}))).toBe("DirectPlay");
  });
});
