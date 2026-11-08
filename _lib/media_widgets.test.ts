import { Database } from "bun:sqlite";
import { afterEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { WidgetContext, WidgetQueryResult } from "./widget_context";

// On a box whose app config predates the pool mounts, the HexOS container can't see an app's own
// dataset, so these four widgets read their credential out of the app's container through Docker.

type Files = Record<string, Uint8Array | string>;
interface Seen {
  docker: string[];
  headers: Headers[];
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restore();
  setSystemTime();
});

const header = (name: string, size: number, type: string) => {
  const block = new Uint8Array(512);
  const put = (text: string, at: number) => block.set(new TextEncoder().encode(text), at);
  put(name, 0);
  put(`${size.toString(8).padStart(11, "0")}\0`, 124);
  put(type, 156);
  return block;
};
const padded = (bytes: Uint8Array) => {
  const body = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
  body.set(bytes);
  return body;
};
const tar = (...blocks: Uint8Array[]) => {
  const all = new Uint8Array(blocks.reduce((sum, block) => sum + block.length, 0) + 1024);
  let at = 0;
  for (const block of blocks) {
    all.set(block, at);
    at += block.length;
  }
  return all;
};
const bytesOf = (content: Uint8Array | string) =>
  typeof content === "string" ? new TextEncoder().encode(content) : content;
const tarOf = (name: string, content: Uint8Array | string) => {
  const bytes = bytesOf(content);
  return tar(header(name, bytes.length, "0"), padded(bytes));
};

/** Docker's archive endpoint holding `files` in the app's container, and the app answering everything else. */
function box(
  app: string,
  files: Files,
  appResponse: (url: URL, headers: Headers, signal?: AbortSignal | null) => Response | Promise<Response>,
): Seen {
  const seen: Seen = { docker: [], headers: [] };
  const archive = (requested: URL) => {
    expect(requested.pathname).toBe(`/containers/ix-${app}-${app}-1/archive`);
    const path = requested.searchParams.get("path") ?? "";
    seen.docker.push(path);
    const content = files[path];
    return content === undefined ? null : tarOf(path.split("/").pop() ?? "", content);
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit & { unix?: string }) => {
    const url = new URL(String(input));
    if (url.hostname !== "docker") {
      const headers = new Headers(init?.headers);
      seen.headers.push(headers);
      return appResponse(url, headers, init?.signal);
    }
    expect(init?.unix).toBe("/var/run/docker.sock");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = archive(url);
    return body ? new Response(body) : new Response("", { status: 404 });
  }) as typeof fetch;
  dockerOverHttp((options) => {
    expect(options.socketPath).toBe("/var/run/docker.sock");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const body = archive(new URL(String(options.path), "http://docker"));
    return body ? answer(200, Readable.from([Buffer.from(body)])) : answer(404, Readable.from([]));
  });
  return seen;
}

const answer = (statusCode: number, body: Readable) => Object.assign(body, { statusCode });

/** Docker's socket as node:http reaches it. `respond` throwing stands for a socket that isn't there. */
function dockerOverHttp(respond: (options: http.RequestOptions) => Readable) {
  const get = (options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
    const request = new EventEmitter();
    queueMicrotask(() => {
      try {
        callback(respond(options) as http.IncomingMessage);
      } catch (error) {
        request.emit("error", error);
      }
    });
    return request as http.ClientRequest;
  };
  spyOn(http, "get").mockImplementation(get as unknown as typeof http.get);
}

const scratch = () => mkdtempSync(join(tmpdir(), "media-widget-test-"));
const NOT_MOUNTED = () => join(tmpdir(), "media-widget-not-mounted");

function context(app: string, localPath: string | null, containerPath: string | null = "/config"): WidgetContext {
  const mounts = localPath === null ? [] : [{ hostPath: `/mnt/tank/${app}/config`, containerPath, localPath }];
  return { appId: app, host: "10.0.0.2", port: 8000, mounts, log: () => {} } as unknown as WidgetContext;
}

describe.each([
  {
    app: "plex",
    file: "/config/Library/Application Support/Plex Media Server/Preferences.xml",
    content: '<?xml version="1.0"?><Preferences PlexOnlineToken="plex-token" />',
    reason: "Sign in to Plex to see your library here",
    token: (seen: Seen) => seen.headers[0]?.get("X-Plex-Token"),
    expected: "plex-token",
    answer: () => Response.json({ MediaContainer: {} }),
    load: () => import("../plex/widget_now_playing"),
  },
  {
    app: "tautulli",
    file: "/config/config.ini",
    content: '[General]\napi_key = "tautulli-key"\npms_identifier = abc\n',
    reason: "Tautulli is still starting up",
    token: (seen: Seen) => (seen.headers.length ? "tautulli-key" : null),
    expected: "tautulli-key",
    answer: () => Response.json({ response: { result: "success", data: {} } }),
    load: () => import("../tautulli/widget_overview"),
  },
])("$app, whose credential is in a text file", ({ app, file, content, reason, token, expected, answer, load }) => {
  const onTheDataset = (localFile: string) => {
    const dir = scratch();
    mkdirSync(join(dir, ...localFile.split("/").slice(2, -1)), { recursive: true });
    writeFileSync(join(dir, ...localFile.split("/").slice(2)), content);
    return dir;
  };

  test("with the path missing from the container, it comes through Docker", async () => {
    const { run } = await load();
    const seen = box(app, { [file]: content }, answer);
    const result = await run(context(app, NOT_MOUNTED()));
    expect(result.needsSetup).toBeUndefined();
    expect(seen.docker).toEqual([file]);
    expect(token(seen)).toBe(expected);
  });

  test("an empty folder in the dataset's place reads the same", async () => {
    const { run } = await load();
    const seen = box(app, { [file]: content }, answer);
    expect((await run(context(app, scratch()))).needsSetup).toBeUndefined();
    expect(seen.docker).toEqual([file]);
  });

  test("a chart's config mount, whose container path the catalog isn't told, is /config", async () => {
    const { run } = await load();
    box(app, { [file]: content }, answer);
    expect((await run(context(app, NOT_MOUNTED(), null))).needsSetup).toBeUndefined();
  });

  test("with no mounts known, Docker still has the app's /config", async () => {
    const { run } = await load();
    box(app, { [file]: content }, answer);
    expect((await run(context(app, null))).needsSetup).toBeUndefined();
  });

  test("a file the mount gives is never asked of Docker", async () => {
    const { run } = await load();
    const seen = box(app, { [file]: "the wrong file" }, answer);
    expect((await run(context(app, onTheDataset(file)))).needsSetup).toBeUndefined();
    expect(seen.docker).toEqual([]);
    expect(token(seen)).toBe(expected);
  });

  test("a file Docker doesn't have yet asks for setup, as before", async () => {
    const { run } = await load();
    box(app, {}, answer);
    expect(await run(context(app, NOT_MOUNTED()))).toEqual({ needsSetup: true, reason });
  });

  test("an error from Docker is never read as the file", async () => {
    const { run } = await load();
    globalThis.fetch = (async (_input: RequestInfo | URL) =>
      new Response(tarOf("file", content), { status: 500 })) as typeof fetch;
    expect(await run(context(app, NOT_MOUNTED()))).toEqual({ needsSetup: true, reason });
  });

  test("a box with no socket yet asks for setup, and doesn't fail the card", async () => {
    const { run } = await load();
    globalThis.fetch = (async (_input: RequestInfo | URL): Promise<Response> => {
      throw new Error("no such socket");
    }) as typeof fetch;
    expect(await run(context(app, NOT_MOUNTED()))).toEqual({ needsSetup: true, reason });
  });

  test("a pax header ahead of the file is skipped", async () => {
    const { untar } = await load();
    const pax = padded(new TextEncoder().encode("27 mtime=1761900000.000000\n"));
    const bytes = new TextEncoder().encode(content);
    expect(untar(tar(header("pax", 27, "x"), pax, header("file", bytes.length, "0"), padded(bytes)))).toBe(content);
  });
});

interface Widget {
  run(ctx: WidgetContext): Promise<WidgetQueryResult>;
  tarFile(head: Uint8Array): { start: number; size: number } | null;
}

let imports = 0;
/** A fresh copy of the script: each holds its own token between refreshes, as a box's does. */
const fresh = async (script: string): Promise<Widget> =>
  (await import(`${import.meta.dir}/../${script}?fresh=${++imports}`)) as Widget;

/** The live database's files as a running app holds them: its rows still in the write-ahead log. */
function liveDatabase(schema: string[]): { main: Uint8Array; wal: Uint8Array } {
  const path = join(scratch(), "live.db");
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA wal_autocheckpoint = 0");
  for (const statement of schema) db.run(statement);
  const files = { main: new Uint8Array(readFileSync(path)), wal: new Uint8Array(readFileSync(`${path}-wal`)) };
  db.close();
  return files;
}

/** The same database with everything written back, as an idle app leaves it. */
function checkpointedDatabase(schema: string[]): Uint8Array {
  const path = join(scratch(), "idle.db");
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  for (const statement of schema) db.run(statement);
  db.close();
  return new Uint8Array(readFileSync(path));
}

describe.each([
  {
    app: "jellyfin",
    script: "jellyfin/widget_now_playing.ts",
    file: "/config/data/jellyfin.db",
    localFile: "data/jellyfin.db",
    prefix: "hexos-jellyfin-",
    reason: "Sign in to Jellyfin to see what's playing here",
    token: (seen: Seen, at = 0) => seen.headers[at]?.get("Authorization")?.match(/Token="(.*)"/)?.[1],
    schema: (token: string) => [
      "CREATE TABLE ApiKeys (Name TEXT, AccessToken TEXT, DateCreated TEXT)",
      "CREATE TABLE Devices (AccessToken TEXT, UserId TEXT, DeviceId TEXT, IsActive INT, DateLastActivity TEXT)",
      "CREATE TABLE Permissions (UserId TEXT, Kind INT, Value INT)",
      `INSERT INTO ApiKeys VALUES ('HexOS', '${token}', '2026-01-01')`,
    ],
    empty: [
      "CREATE TABLE ApiKeys (Name TEXT, AccessToken TEXT, DateCreated TEXT)",
      "CREATE TABLE Devices (AccessToken TEXT, UserId TEXT, DeviceId TEXT, IsActive INT, DateLastActivity TEXT)",
      "CREATE TABLE Permissions (UserId TEXT, Kind INT, Value INT)",
    ],
  },
  {
    app: "emby",
    script: "emby/widget_now_playing.ts",
    file: "/config/data/authentication.db",
    localFile: "data/authentication.db",
    prefix: "hexos-emby-",
    reason: "Sign in to Emby as an administrator to see what's playing here",
    token: (seen: Seen, at = 0) => seen.headers[at]?.get("X-Emby-Token"),
    schema: (token: string) => [
      "CREATE TABLE Tokens_2 (AccessToken TEXT, DeviceId INT, UserId TEXT, IsActive INT, DateLastActivityInt INT)",
      "CREATE TABLE Devices2 (Id INT, ReportedDeviceId TEXT)",
      `INSERT INTO Tokens_2 VALUES ('${token}', 1, '', 1, 1)`,
    ],
    empty: [
      "CREATE TABLE Tokens_2 (AccessToken TEXT, DeviceId INT, UserId TEXT, IsActive INT, DateLastActivityInt INT)",
      "CREATE TABLE Devices2 (Id INT, ReportedDeviceId TEXT)",
    ],
  },
])("$app, whose credential is in a database", ({ app, script, file, localFile, prefix, reason, token, schema, empty }) => {
  const sessions = () => Response.json([]);
  const WAL = `${file}-wal`;
  const onTheDataset = (statements: string[]) => {
    const dir = scratch();
    mkdirSync(join(dir, "data"));
    const db = new Database(join(dir, localFile));
    for (const statement of statements) db.run(statement);
    db.close();
    return dir;
  };

  test("with the path missing from the container, it comes through Docker", async () => {
    const { run } = await fresh(script);
    const seen = box(app, { [file]: checkpointedDatabase(schema("idle-token")) }, sessions);
    expect((await run(context(app, NOT_MOUNTED()))).needsSetup).toBeUndefined();
    expect(token(seen)).toBe("idle-token");
  });

  test("an empty folder in the dataset's place reads the same", async () => {
    const { run } = await fresh(script);
    const seen = box(app, { [file]: checkpointedDatabase(schema("idle-token")) }, sessions);
    expect((await run(context(app, scratch()))).needsSetup).toBeUndefined();
    expect(token(seen)).toBe("idle-token");
  });

  test("a chart's config mount, whose container path the catalog isn't told, is /config", async () => {
    const { run } = await fresh(script);
    const seen = box(app, { [file]: checkpointedDatabase(schema("idle-token")) }, sessions);
    await run(context(app, NOT_MOUNTED(), null));
    expect(token(seen)).toBe("idle-token");
  });

  test("with no mounts known, Docker still has the app's /config", async () => {
    const { run } = await fresh(script);
    const seen = box(app, { [file]: checkpointedDatabase(schema("idle-token")) }, sessions);
    await run(context(app, null));
    expect(token(seen)).toBe("idle-token");
  });

  test("a row still in the write-ahead log is found, as a running app holds it", async () => {
    const { run } = await fresh(script);
    const { main, wal } = liveDatabase(schema("recent-token"));
    const seen = box(app, { [file]: main, [WAL]: wal }, sessions);
    expect((await run(context(app, NOT_MOUNTED()))).needsSetup).toBeUndefined();
    expect(token(seen)).toBe("recent-token");
  });

  test("an empty write-ahead log, as an idle app leaves one, changes nothing", async () => {
    const { run } = await fresh(script);
    const seen = box(app, { [file]: checkpointedDatabase(schema("idle-token")), [WAL]: new Uint8Array() }, sessions);
    expect((await run(context(app, NOT_MOUNTED()))).needsSetup).toBeUndefined();
    expect(token(seen)).toBe("idle-token");
  });

  test("a database the mount gives is never asked of Docker", async () => {
    const { run } = await fresh(script);
    const seen = box(app, {}, sessions);
    await run(context(app, onTheDataset(schema("mounted-token"))));
    expect(seen.docker).toEqual([]);
    expect(token(seen)).toBe("mounted-token");
  });

  test("the token is kept, so a refresh every five seconds copies the database once", async () => {
    const { run } = await fresh(script);
    const seen = box(app, { [file]: checkpointedDatabase(schema("idle-token")) }, sessions);
    await run(context(app, NOT_MOUNTED()));
    const copies = seen.docker.length;
    await run(context(app, NOT_MOUNTED()));
    await run(context(app, NOT_MOUNTED()));
    expect(seen.docker.length).toBe(copies);
    expect(token(seen, 2)).toBe("idle-token");
  });

  test("a database with no token yet asks for setup, and isn't copied again for a minute", async () => {
    const { run } = await fresh(script);
    setSystemTime(new Date("2026-10-31T12:00:00Z"));
    const seen = box(app, { [file]: checkpointedDatabase([...empty]) }, sessions);
    expect(await run(context(app, NOT_MOUNTED()))).toEqual({ needsSetup: true, reason });
    const copies = seen.docker.length;
    setSystemTime(new Date("2026-10-31T12:00:59Z"));
    await run(context(app, NOT_MOUNTED()));
    expect(seen.docker.length).toBe(copies);
    setSystemTime(new Date("2026-10-31T12:01:00Z"));
    await run(context(app, NOT_MOUNTED()));
    expect(seen.docker.length).toBeGreaterThan(copies);
  });

  test("a token the app refuses is dropped, and the next copy finds the new one", async () => {
    const { run } = await fresh(script);
    setSystemTime(new Date("2026-10-31T12:00:00Z"));
    box(app, { [file]: checkpointedDatabase(schema("idle-token")) }, sessions);
    await run(context(app, NOT_MOUNTED()));
    setSystemTime(new Date("2026-10-31T13:00:00Z"));
    box(app, { [file]: checkpointedDatabase(schema("idle-token")) }, () => new Response("", { status: 401 }));
    expect(await run(context(app, NOT_MOUNTED()))).toEqual({ needsSetup: true, reason });
    const seen = box(app, { [file]: checkpointedDatabase(schema("new-token")) }, sessions);
    expect((await run(context(app, NOT_MOUNTED()))).needsSetup).toBeUndefined();
    expect(token(seen)).toBe("new-token");
  });

  test("a token still refused after a new copy isn't copied again every five seconds", async () => {
    const { run } = await fresh(script);
    setSystemTime(new Date("2026-10-31T12:00:00Z"));
    const seen = box(app, { [file]: checkpointedDatabase(schema("idle-token")) }, () => new Response("", { status: 401 }));
    await run(context(app, NOT_MOUNTED()));
    const copies = seen.docker.length;
    setSystemTime(new Date("2026-10-31T12:00:05Z"));
    expect(await run(context(app, NOT_MOUNTED()))).toEqual({ needsSetup: true, reason });
    expect(seen.docker.length).toBe(copies);
  });

  test("an unreadable copy asks for setup, and doesn't fail the card", async () => {
    const { run } = await fresh(script);
    box(app, { [file]: "not a database" }, sessions);
    expect(await run(context(app, NOT_MOUNTED()))).toEqual({ needsSetup: true, reason });
  });

  test("a copy cut off part way asks for setup, and doesn't fail the card", async () => {
    const { run } = await fresh(script);
    dockerOverHttp(() => {
      async function* cutOff() {
        yield Buffer.alloc(1024);
        throw new Error("The operation timed out");
      }
      return answer(200, Readable.from(cutOff()));
    });
    expect(await run(context(app, NOT_MOUNTED()))).toEqual({ needsSetup: true, reason });
  });

  test("a copy that never finishes gives up inside the widget's 10 s, and reads as no token", async () => {
    const { run } = await fresh(script);
    const shortly = AbortSignal.timeout.bind(AbortSignal);
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => shortly(20));
    dockerOverHttp(() => answer(200, new Readable({ read() {} })));
    expect(await run(context(app, NOT_MOUNTED()))).toEqual({ needsSetup: true, reason });
    expect(timeout.mock.calls[0]?.[0]).toBeLessThan(10_000);
  });

  test("an error from Docker is never read as the database", async () => {
    const { run } = await fresh(script);
    const database = tarOf("file", checkpointedDatabase(schema("idle-token")));
    dockerOverHttp(() => answer(500, Readable.from([Buffer.from(database)])));
    expect(await run(context(app, NOT_MOUNTED()))).toEqual({ needsSetup: true, reason });
  });

  test("a box with no socket yet asks for setup, and doesn't fail the card", async () => {
    const { run } = await fresh(script);
    dockerOverHttp(() => {
      throw new Error("no such socket");
    });
    expect(await run(context(app, NOT_MOUNTED()))).toEqual({ needsSetup: true, reason });
  });

  test("no copy of the database is left behind, whichever way it ends", async () => {
    const left = () => readdirSync(tmpdir()).filter((name) => name.startsWith(prefix));
    const before = left();
    const found = await fresh(script);
    box(app, { [file]: checkpointedDatabase(schema("idle-token")) }, sessions);
    await found.run(context(app, NOT_MOUNTED()));
    const unreadable = await fresh(script);
    box(app, { [file]: "not a database" }, sessions);
    await unreadable.run(context(app, NOT_MOUNTED()));
    expect(left()).toEqual(before);
  });

  test("a pax header ahead of the file is skipped, and a tar with no file has none", async () => {
    const { tarFile } = await fresh(script);
    const pax = padded(new TextEncoder().encode("27 mtime=1761900000.000000\n"));
    const withPax = tar(header("pax", 27, "x"), pax, header("file", 9, "0"), padded(new TextEncoder().encode("the bytes")));
    expect(tarFile(withPax)).toEqual({ start: 1536, size: 9 });
    expect(tarFile(new Uint8Array(1024))).toBeNull();
  });
});

// Emby shows a token every stream only when it's an administrator's: anyone else's sees just their
// own. Emby's API reference lists the server's devices to an administrator alone (an API key acts
// as one), while its configuration is open to any signed-in user, so the card reads sessions only
// with a token that just listed the devices.
describe("emby, whose card reads sessions as an administrator", () => {
  const script = "emby/widget_now_playing.ts";
  const FILE = "/config/data/authentication.db";
  const REASON = "Sign in to Emby as an administrator to see what's playing here";
  const STREAM = [{ UserName: "sam", DeviceName: "Living room", NowPlayingItem: { Id: "1", Name: "Coco" } }];
  const DEVICES = "/emby/Devices";
  const SESSIONS = "/emby/Sessions";

  /** Sign-ins of other users, each a token and when it was last used. */
  const signIns = (...rows: Array<[token: string, lastUsed: number]>) => [
    "CREATE TABLE Tokens_2 (AccessToken TEXT, DeviceId INT, UserId TEXT, IsActive INT, DateLastActivityInt INT)",
    "CREATE TABLE Devices2 (Id INT, ReportedDeviceId TEXT)",
    ...rows.map(([token, lastUsed], i) => `INSERT INTO Tokens_2 VALUES ('${token}', ${i + 1}, 'user-${token}', 1, ${lastUsed})`),
  ];

  interface Emby {
    admins: Set<string>;
    /** False while Emby can't answer, as while it starts. */
    answering: boolean;
    asked: Array<{ path: string; token: string | null }>;
    /** Awaited before each answer about the devices, to hold one back. */
    gate?: (signal?: AbortSignal | null) => Promise<void>;
    answer: (url: URL, headers: Headers, signal?: AbortSignal | null) => Promise<Response>;
  }

  /** An Emby whose `admins` list its devices and see the one stream; anyone else reads its configuration, and sees none of theirs. */
  function emby(...admins: string[]): Emby {
    const app: Emby = {
      admins: new Set(admins),
      answering: true,
      asked: [],
      answer: async (url, headers, signal) => {
        const token = headers.get("X-Emby-Token");
        app.asked.push({ path: url.pathname, token });
        if (url.pathname === DEVICES) await app.gate?.(signal);
        if (!app.answering) return new Response("", { status: 503 });
        const admin = app.admins.has(token ?? "");
        if (url.pathname === DEVICES) return admin ? Response.json({ Items: [] }) : new Response("", { status: 403 });
        if (url.pathname === "/emby/System/Configuration") return Response.json({ ServerName: "emby" });
        if (url.pathname === SESSIONS) return Response.json(admin ? STREAM : []);
        return new Response("", { status: 404 });
      },
    };
    return app;
  }

  const asked = (app: Emby, path: string) => app.asked.filter((request) => request.path === path).map((request) => request.token);
  const streams = (result: WidgetQueryResult) => {
    const field = result.fields?.streams;
    return field?.type === "stat" ? field.value : undefined;
  };

  const START = new Date("2026-10-31T12:00:00Z").getTime();
  const at = (ms: number) => setSystemTime(new Date(START + ms));
  const aborted = (signal?: AbortSignal | null) =>
    new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));

  const datasetWith = (statements: string[]) => {
    const dir = scratch();
    mkdirSync(join(dir, "data"));
    const db = new Database(join(dir, "data/authentication.db"));
    for (const statement of statements) db.run(statement);
    db.close();
    return dir;
  };

  describe.each([
    {
      place: "copied through Docker",
      open: (statements: string[], app: Emby) => {
        const seen = box("emby", { [FILE]: checkpointedDatabase(statements) }, app.answer);
        return { seen, ctx: context("emby", NOT_MOUNTED()) };
      },
    },
    {
      place: "on the dataset",
      open: (statements: string[], app: Emby) => {
        const seen = box("emby", {}, app.answer);
        return { seen, ctx: context("emby", datasetWith(statements)) };
      },
    },
  ])("with the database $place", ({ open }) => {
    test("a newer sign-in that isn't an administrator's is passed over for an older one that is", async () => {
      const { run } = await fresh(script);
      const app = emby("owner");
      const { ctx } = open(signIns(["member", 200], ["owner", 100]), app);
      const result = await run(ctx);
      expect(streams(result)).toBe("1");
      expect(asked(app, DEVICES)).toEqual(["member", "owner"]);
      expect(asked(app, SESSIONS)).toEqual(["owner"]);
    });

    test("with no administrator's sign-in, the card asks for one and reads no sessions", async () => {
      const { run } = await fresh(script);
      const app = emby();
      const { ctx } = open(signIns(["member", 200], ["guest", 100]), app);
      expect(await run(ctx)).toEqual({ needsSetup: true, reason: REASON });
      expect(asked(app, SESSIONS)).toEqual([]);
    });

    test("only the five sign-ins used last are tried, so a refresh stays inside the widget's time", async () => {
      const { run } = await fresh(script);
      const app = emby("owner");
      const members = [1, 2, 3, 4, 5].map((n): [string, number] => [`member-${n}`, 200 - n]);
      const { ctx } = open(signIns(...members, ["owner", 100]), app);
      expect(await run(ctx)).toEqual({ needsSetup: true, reason: REASON });
      expect(asked(app, DEVICES)).toHaveLength(5);
    });

    test("every sign-in is asked about at once, so slow answers cost one wait, not five", async () => {
      const { run } = await fresh(script);
      const app = emby("owner");
      const members = [1, 2, 3, 4].map((n): [string, number] => [`member-${n}`, 200 - n]);
      const { ctx } = open(signIns(...members, ["owner", 100]), app);
      // Emby answers none until all five are asked: one at a time, the first would wait out its time
      let arrived = 0;
      let allAsked!: () => void;
      const everyone = new Promise<void>((resolve) => (allAsked = resolve));
      app.gate = async (signal) => {
        if (++arrived === 5) allAsked();
        await Promise.race([everyone, aborted(signal)]);
      };
      expect(streams(await run(ctx))).toBe("1");
    });

    test("a refresh between checks asks Emby nothing about the sign-in, for five minutes", async () => {
      const { run } = await fresh(script);
      at(0);
      const app = emby("owner");
      const { ctx } = open(signIns(["member", 200], ["owner", 100]), app);
      await run(ctx);
      app.asked.length = 0;
      for (const later of [5_000, 60_000, 299_000]) {
        at(later);
        expect(streams(await run(ctx))).toBe("1");
      }
      expect(asked(app, DEVICES)).toEqual([]);
      at(300_000);
      expect(streams(await run(ctx))).toBe("1");
      expect(asked(app, DEVICES)).toEqual(["owner"]);
    });

    test("an Emby that doesn't answer is never read as having no administrator", async () => {
      const { run } = await fresh(script);
      setSystemTime(new Date("2026-10-31T12:00:00Z"));
      const app = emby("owner");
      app.answering = false;
      const { ctx } = open(signIns(["member", 200], ["owner", 100]), app);
      await expect(run(ctx)).rejects.toThrow();
      // Five seconds on, inside the minute before another copy, Emby is up
      setSystemTime(new Date("2026-10-31T12:00:05Z"));
      app.answering = true;
      expect(streams(await run(ctx))).toBe("1");
    });
  });

  test("a kept sign-in that stops being an administrator's is replaced, and never read for the card", async () => {
    const { run } = await fresh(script);
    setSystemTime(new Date("2026-10-31T12:00:00Z"));
    const app = emby("owner");
    box("emby", { [FILE]: checkpointedDatabase(signIns(["member", 200], ["owner", 100])) }, app.answer);
    expect(streams(await run(context("emby", NOT_MOUNTED())))).toBe("1");

    // The owner hands the server to a partner, and is no longer an administrator
    setSystemTime(new Date("2026-10-31T13:00:00Z"));
    app.admins = new Set(["partner"]);
    app.asked.length = 0;
    const seen = box("emby", { [FILE]: checkpointedDatabase(signIns(["member", 300], ["partner", 250], ["owner", 100])) }, app.answer);
    expect(await run(context("emby", NOT_MOUNTED()))).toEqual({ needsSetup: true, reason: REASON });
    // Only the administrator's token was kept from the first copy, so only it is asked about
    expect(asked(app, DEVICES)).toEqual(["owner"]);
    expect(seen.docker).toEqual([]);
    expect(streams(await run(context("emby", NOT_MOUNTED())))).toBe("1");
    expect(seen.docker).toContain(FILE);
    expect(asked(app, SESSIONS)).toEqual(["partner"]);
  });

  test("on the dataset, a sign-in that stops being an administrator's is passed over at the next check", async () => {
    const { run } = await fresh(script);
    at(0);
    const app = emby("owner");
    const ctx = context("emby", datasetWith(signIns(["member", 300], ["partner", 250], ["owner", 100])));
    box("emby", {}, app.answer);
    expect(streams(await run(ctx))).toBe("1");
    app.admins = new Set(["partner"]);
    app.asked.length = 0;
    at(300_000);
    expect(streams(await run(ctx))).toBe("1");
    expect(asked(app, SESSIONS)).toEqual(["partner"]);
  });

  test("the checks share what's left of the refresh after a slow copy, so it ends inside the widget's 10 s", async () => {
    const { run } = await fresh(script);
    at(0);
    const app = emby("owner");
    const database = checkpointedDatabase(signIns(["member", 200], ["owner", 100]));
    box("emby", { [FILE]: database }, app.answer);
    // The copy takes eight and a half seconds
    dockerOverHttp((options) => {
      at(8_500);
      return String(options.path).endsWith(encodeURIComponent(FILE))
        ? answer(200, Readable.from([Buffer.from(tarOf("authentication.db", database))]))
        : answer(404, Readable.from([]));
    });
    const timeouts: number[] = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      timeouts.push(ms);
      return timeout(ms);
    });
    expect(streams(await run(context("emby", NOT_MOUNTED())))).toBe("1");
    // The copy's own, then one the checks share, ending nine seconds into the refresh
    expect(timeouts).toHaveLength(2);
    expect(timeouts[1]).toBeLessThanOrEqual(500);
  });

  test("a sign-in Emby refuses between checks is dropped at once, and the next copy finds another", async () => {
    const { run } = await fresh(script);
    at(0);
    const owner = emby("owner");
    box("emby", { [FILE]: checkpointedDatabase(signIns(["owner", 100])) }, owner.answer);
    expect(streams(await run(context("emby", NOT_MOUNTED())))).toBe("1");
    // The owner signs out on that device, and Emby refuses its token
    at(5_000);
    box("emby", { [FILE]: checkpointedDatabase(signIns(["owner", 100])) }, () => new Response("", { status: 401 }));
    expect(await run(context("emby", NOT_MOUNTED()))).toEqual({ needsSetup: true, reason: REASON });
    at(65_000);
    const partner = emby("partner");
    box("emby", { [FILE]: checkpointedDatabase(signIns(["partner", 300])) }, partner.answer);
    expect(streams(await run(context("emby", NOT_MOUNTED())))).toBe("1");
    expect(asked(partner, SESSIONS)).toEqual(["partner"]);
  });

  test("on the dataset, sign-ins with no administrator among them aren't asked about again for a minute", async () => {
    const { run } = await fresh(script);
    at(0);
    const app = emby();
    const ctx = context("emby", datasetWith(signIns(["member", 200], ["guest", 100])));
    box("emby", {}, app.answer);
    expect(await run(ctx)).toEqual({ needsSetup: true, reason: REASON });
    expect(asked(app, DEVICES)).toHaveLength(2);
    at(59_000);
    expect(await run(ctx)).toEqual({ needsSetup: true, reason: REASON });
    expect(asked(app, DEVICES)).toHaveLength(2);
    at(60_000);
    await run(ctx);
    expect(asked(app, DEVICES)).toHaveLength(4);
  });

  test("on the dataset, the administrator's sign-in is kept when five newer ones push it out of those asked about", async () => {
    const { run } = await fresh(script);
    at(0);
    const app = emby("owner");
    const dir = datasetWith(signIns(["member", 200], ["owner", 100]));
    box("emby", {}, app.answer);
    expect(streams(await run(context("emby", dir)))).toBe("1");
    const db = new Database(join(dir, "data/authentication.db"));
    for (const n of [1, 2, 3, 4, 5]) db.run(`INSERT INTO Tokens_2 VALUES ('guest-${n}', ${10 + n}, 'user-guest-${n}', 1, ${300 + n})`);
    db.close();
    app.asked.length = 0;
    at(5_000);
    expect(streams(await run(context("emby", dir)))).toBe("1");
    expect(asked(app, DEVICES)).toEqual([]);
    at(300_000);
    expect(streams(await run(context("emby", dir)))).toBe("1");
    expect(asked(app, DEVICES)).toEqual(["owner"]);
  });

  test("on the dataset, a kept sign-in that's signed out is dropped at once", async () => {
    const { run } = await fresh(script);
    at(0);
    const app = emby("owner", "partner");
    const dir = datasetWith(signIns(["owner", 200], ["partner", 100]));
    box("emby", {}, app.answer);
    expect(streams(await run(context("emby", dir)))).toBe("1");
    const db = new Database(join(dir, "data/authentication.db"));
    db.run("UPDATE Tokens_2 SET IsActive = 0 WHERE AccessToken = 'owner'");
    db.close();
    app.admins.delete("owner");
    app.asked.length = 0;
    at(5_000);
    expect(streams(await run(context("emby", dir)))).toBe("1");
    expect(asked(app, SESSIONS)).toEqual(["partner"]);
  });

  test("on the dataset, a new sign-in is asked about at once, so signing in shows the streams", async () => {
    const { run } = await fresh(script);
    at(0);
    const app = emby("owner");
    const dir = datasetWith(signIns(["member", 200]));
    box("emby", {}, app.answer);
    expect(await run(context("emby", dir))).toEqual({ needsSetup: true, reason: REASON });
    const db = new Database(join(dir, "data/authentication.db"));
    db.run("INSERT INTO Tokens_2 VALUES ('owner', 9, 'user-owner', 1, 300)");
    db.close();
    at(5_000);
    expect(streams(await run(context("emby", dir)))).toBe("1");
  });
});
