import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runPart } from "./script_bumps";
import { videoCardProblems } from "./video_card";

// A media server given an NVIDIA card beside an Intel one loses Intel's HDR tone mapping, so these
// three ask HexOS for one card. These hold that they keep asking, and what the validator refuses.

const read = (app: string) => JSON.parse(readFileSync(join(import.meta.dir, "..", `${app}.json`), "utf8")) as Record<string, any>;

const script = (requirements: object, hooks: object[] = [], appValues: object = { resources: { gpus: "$GPU_CONFIG()" } }) => ({
  requirements,
  hooks,
  app_values: appValues,
});
const hook = (over: object = {}) => ({ id: "hardware-transcoding", events: ["onAfterInstall", "userAction"], rerun: "converge", ...over });

describe("the media servers", () => {
  test.each(["jellyfin", "plex", "emby"])("%s asks for one graphics card, and passes the validator's rules", (app) => {
    const parsed = read(app);
    expect(parsed.requirements.gpu).toBe("one");
    expect(videoCardProblems(parsed)).toEqual([]);
  });

  test("Jellyfin names the hook that sets its transcoding for the card", () => {
    expect(read("jellyfin").requirements.gpu_hook).toBe("hardware-transcoding");
  });

  test("Plex and Emby name none, since they pick their own device", () => {
    expect(read("plex").requirements.gpu_hook).toBeUndefined();
    expect(read("emby").requirements.gpu_hook).toBeUndefined();
  });

  test.each(["immich", "ollama", "snapotter"])("%s, which is no media server, still gets every card", (app) => {
    expect(read(app).requirements.gpu).toBeUndefined();
  });
});

describe("what the validator refuses", () => {
  test("nothing, for a script with neither key", () => expect(videoCardProblems(script({}))).toEqual([]));
  test("nothing, for one card and a hook that may run again from the card", () =>
    expect(videoCardProblems(script({ gpu: "one", gpu_hook: "hardware-transcoding" }, [hook()]))).toEqual([]));

  test.each<[string, Record<string, unknown>, string]>([
    ["a value other than one", script({ gpu: "all" }), 'is not "one"'],
    ["one card with no card macro", script({ gpu: "one" }, [], {}), "needs $GPU_CONFIG()"],
    ["a hook without the one-card key", script({ gpu_hook: "hardware-transcoding" }, [hook()]), 'needs requirements.gpu: "one"'],
    ["a hook the script doesn't have", script({ gpu: "one", gpu_hook: "missing" }, [hook()]), "is not one of the script's hooks"],
    ["a hook the box can't start", script({ gpu: "one", gpu_hook: "hardware-transcoding" }, [hook({ events: ["onAfterInstall"] })]), 'needs the "userAction" event'],
    ["a hook that refuses a second run", script({ gpu: "one", gpu_hook: "hardware-transcoding" }, [hook({ rerun: "refuse" })]), "may run again"],
  ])("%s", (_name, bad, message) => expect(videoCardProblems(bad).join("\n")).toContain(message));
});

describe("a new script version", () => {
  test("isn't needed for the one-card keys, which change nothing a server already runs", () => {
    const before = script({ ports: [1] }, [hook()]);
    const after = script({ ports: [1], gpu: "one", gpu_hook: "hardware-transcoding" }, [hook()]);
    expect(runPart(after)).toBe(runPart(before));
  });
});
