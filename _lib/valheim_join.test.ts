import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { WidgetContext } from "./widget_context";
import { joinCode, run } from "../valheim/widget_join";

// The lines a crossplay server installed by HexOS logged on demeter (TrueNAS 25.10.3, image 1.4.1)
// on 2026-10-29, the code replaced two seconds after it registered
const REGISTERED = '10/29/2026 11:48:06: Session "HexOS Valheim" registered with join code 144343';
const REPLACED = '10/29/2026 11:48:06: Created new join code 282677 for session "HexOS Valheim"';
const ACTIVE =
  '10/29/2026 11:48:08: Session "HexOS Valheim" with join code 282677 and IP 47.227.151.114:2456 is active with 0 player(s)';
const NO_CODE_YET = '10/29/2026 11:48:04: New session server "HexOS Valheim" that has join code , now 0 player(s)';

const context = (configDir: string | null): WidgetContext => ({
  appId: "valheim",
  host: "10.0.0.49",
  port: 2456,
  mounts: configDir
    ? [
        { hostPath: "/mnt/SSDs/Applications/valheim/server", containerPath: "/opt/valheim", localPath: "/tmp/unused" },
        { hostPath: "/mnt/SSDs/Applications/valheim/config", containerPath: "/config", localPath: configDir },
      ]
    : [],
  log: () => {},
});

describe("joinCode", () => {
  test("each line the server logs a code in gives it", () => {
    expect(joinCode(REGISTERED)).toBe("144343");
    expect(joinCode(REPLACED)).toBe("282677");
    expect(joinCode(ACTIVE)).toBe("282677");
  });

  test("the newest line wins, so a replaced code never shows", () => {
    expect(joinCode(`${REGISTERED}\n${REPLACED}\n`)).toBe("282677");
  });

  test("the line before a code exists names none", () => {
    expect(joinCode(NO_CODE_YET)).toBeNull();
    expect(joinCode("")).toBeNull();
  });

  test("a server name with a join code in it is never taken for the code", () => {
    expect(joinCode('10/29/2026 11:48:06: Session "with join code 99" registered with join code 123456')).toBe("123456");
    expect(joinCode('10/29/2026 11:48:06: Created new join code 123456 for session "join code 99"')).toBe("123456");
    expect(
      joinCode('10/29/2026 11:48:08: Session "join code 99" with join code 123456 and IP 203.0.113.7:2456 is active with 2 player(s)'),
    ).toBe("123456");
  });

  test("a file written on Windows line endings still reads", () => {
    expect(joinCode(`${REGISTERED}\r\n`)).toBe("144343");
  });
});

describe("run", () => {
  test("shows the code from the session file", async () => {
    const dir = mkdtempSync(`${tmpdir()}/valheim-`);
    writeFileSync(`${dir}/hexos-session.txt`, `${ACTIVE}\n`);
    expect(await run(context(dir))).toEqual({ fields: { code: { type: "stat", label: "Join code", value: "282677" } } });
  });

  test("with no session file yet, the server is starting", async () => {
    const result = await run(context(mkdtempSync(`${tmpdir()}/valheim-`)));
    expect(result.needsSetup).toBe(true);
    expect(result.reason).toContain("starting");
  });

  test("with no mounts known, the server is starting too", async () => {
    expect((await run(context(null))).needsSetup).toBe(true);
  });
});
