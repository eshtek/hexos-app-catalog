import { describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Giving a file to user 568 needs root, so the ownership is checked on a real install
mock.module("node:fs", () => ({ ...require("node:fs"), chownSync: () => {} }));
const { appRegistryYaml, seedSettings, webYaml } = await import("../opencloud/seed_settings");
const { configure } = await import("../opencloud/configure");

/** The extensions OpenCloud would offer, reading the file as its config loader does. */
const creatable = (env: Record<string, string> = {}) =>
  appRegistryYaml()
    .replace(/"\$\{(\w+)\|(\w)\}"/g, (_, name, fallback) => ((env[name] ?? fallback) === "T" ? "true" : "false"))
    .split("    - ")
    .slice(1)
    .filter((entry) => entry.includes("allow_creation: true"))
    .map((entry) => entry.match(/extension: '(\w+)'/)![1]);

function fakeBox() {
  const root = mkdtempSync(join(tmpdir(), "opencloud-"));
  const [config, data, files] = ["config", "data", "files"].map((name) => join(root, name));
  for (const path of [config, data, files]) mkdirSync(path);
  const events: string[] = [];
  const ctx = {
    mounts: [
      { hostPath: "/mnt/tank/Applications/opencloud/config", containerPath: null, localPath: config },
      { hostPath: "/mnt/tank/Applications/opencloud/data", containerPath: null, localPath: data },
      { hostPath: "/mnt/tank/Documents/opencloud", containerPath: "/var/lib/opencloud-files", localPath: files },
    ],
    registerCheckpoints: async () => {},
    emitCheckpoint: async (id: string) => void events.push(`done:${id}`),
    skipCheckpoint: async (id: string) => void events.push(`skip:${id}`),
    fail: (message: string) => {
      throw new Error(message);
    },
  };
  return { ctx: ctx as never, config, data, files, events };
}

describe("the New menu", () => {
  test("keeps upstream's order", () => {
    const order = [...appRegistryYaml().matchAll(/extension: '(\w+)'/g)].map((match) => match[1]);
    expect(order).toEqual(["pdf", "odt", "ods", "odp", "docx", "docxf", "xlsx", "pptx", "ipynb", "md", "zmd", "ggs"]);
  });
  test.each([
    ["microsoft", { HEXOS_NEW_MICROSOFT: "T", HEXOS_NEW_OPENDOCUMENT: "F" }, ["docx", "xlsx", "pptx", "md"]],
    ["open", { HEXOS_NEW_MICROSOFT: "F", HEXOS_NEW_OPENDOCUMENT: "T" }, ["odt", "ods", "odp", "md"]],
    ["both", { HEXOS_NEW_MICROSOFT: "T", HEXOS_NEW_OPENDOCUMENT: "T" }, ["odt", "ods", "odp", "docx", "xlsx", "pptx", "md"]],
  ])("%s", (_answer, env, expected) => expect(creatable(env)).toEqual(expected));
  test("with the variables missing it falls back to Microsoft", () => expect(creatable()).toEqual(["docx", "xlsx", "pptx", "md"]));
  test("the script's answers set those variables", () => {
    const script = JSON.parse(readFileSync(join(import.meta.dir, "..", "opencloud.json"), "utf8"));
    const value = (name: string) => script.app_values.opencloud.additional_envs.find((env: { name: string }) => env.name === name).value;
    expect(value("HEXOS_NEW_MICROSOFT")).toBe("$IF($QUESTION(new_formats) != open, T, F)");
    expect(value("HEXOS_NEW_OPENDOCUMENT")).toBe("$IF($QUESTION(new_formats) != microsoft, T, F)");
  });
  test("the Text Editor takes its entries from the variable a link sets", () => {
    expect(webYaml()).not.toMatch(/apps: \[[^\]]*"text-editor"/);
    expect(webYaml()).toContain('primaryExtensions: "${HEXOS_TEXT_EDITOR_NEW_FILES}"');
  });
});

describe("folder names", () => {
  const script = JSON.parse(readFileSync(join(import.meta.dir, "..", "opencloud.json"), "utf8"));
  const value = (name: string): string => script.app_values.opencloud.additional_envs.find((env: { name: string }) => env.name === name).value;
  test("the space template survives HexOS's handling of strings: no backslash, no comma", () => {
    expect(value("STORAGE_USERS_POSIX_GENERAL_SPACE_PATH_TEMPLATE")).not.toMatch(/[\\,]/);
  });
  test("the text to change is sprig's middle argument, not piped in last", () => {
    expect(value("STORAGE_USERS_POSIX_GENERAL_SPACE_PATH_TEMPLATE")).toContain('regexReplaceAll "[[:space:][:punct:][:cntrl:]]+" (lower .SpaceName) "-"');
  });
  test("OpenCloud's posixfs command looks in users and projects", () => {
    expect(value("STORAGE_USERS_POSIX_PERSONAL_SPACE_PATH_TEMPLATE")).toStartWith("users/");
    expect(value("STORAGE_USERS_POSIX_GENERAL_SPACE_PATH_TEMPLATE")).toStartWith("projects/");
  });
});

describe("before the first start", () => {
  test("a fresh install gets both files", async () => {
    const box = fakeBox();
    await seedSettings(box.ctx);
    expect(existsSync(join(box.config, "app-registry.yaml"))).toBe(true);
    expect(existsSync(join(box.config, "web.yaml"))).toBe(true);
    expect(box.events).toEqual(["done:settings"]);
  });
  test("an owner's edits stay", async () => {
    const box = fakeBox();
    writeFileSync(join(box.config, "web.yaml"), "mine");
    await seedSettings(box.ctx);
    expect(readFileSync(join(box.config, "web.yaml"), "utf8")).toBe("mine");
  });
});

/** An OpenCloud answering over a mocked fetch: passwords by account, and what was asked of its Graph API. */
function fakeOpenCloud(accounts: Record<string, string>, signIn?: { username: string; password: string }, answers?: Record<string, string>) {
  const calls: string[] = [];
  const events: string[] = [];
  const asked: string[] = [];
  let pending = "";
  globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    if (url.endsWith("/.well-known/openid-configuration")) return json({ issuer: "https://box:30134" });
    if (url.includes("/identifier/_/logon")) {
      const [user, password] = JSON.parse(String(init.body)).params;
      if (accounts[user] !== password) return new Response(null, { status: 204 });
      pending = user;
      return new Response(null, { status: 200, headers: { "set-cookie": "a=b" } });
    }
    if (url.includes("/identifier/_/authorize")) return new Response(null, { status: 302, headers: { location: "https://box/cb?code=x" } });
    if (url.includes("/konnect/v1/token")) return json({ access_token: pending });
    const path = url.split("/graph")[1];
    if (method !== "GET") calls.push(`${method} ${path}`);
    if (method === "POST" && path === "/v1.0/users") {
      const made = JSON.parse(String(init.body));
      accounts[made.onPremisesSamAccountName] = made.passwordProfile.password;
      return json({ id: made.onPremisesSamAccountName, onPremisesSamAccountName: made.onPremisesSamAccountName }, 201);
    }
    if (path.startsWith("/v1.0/users?")) {
      const name = decodeURIComponent(path).match(/"(.+)"/)![1];
      return json({ value: name in accounts ? [{ id: name, onPremisesSamAccountName: name }] : [] });
    }
    if (method === "DELETE") {
      delete accounts[path.split("/").pop()!];
      return new Response(null, { status: 204 });
    }
    if (path === "/v1.0/applications") return json({ value: [{ id: "app", appRoles: [{ id: "role", displayName: "Admin" }] }] });
    if (path.endsWith("/appRoleAssignments") && method === "GET") return json({ value: [] });
    return json({}, 201);
  }) as typeof fetch;
  const ctx = {
    host: "box",
    port: 30134,
    signIn,
    registerCheckpoints: async () => {},
    emitCheckpoint: async (id: string) => void events.push(`done:${id}`),
    skipCheckpoint: async (id: string) => void events.push(`skip:${id}`),
    sleep: async () => {},
    askForInputs: async (_inputs: unknown, prompt: { title: string }) => {
      asked.push(prompt.title);
      if (!answers) throw Object.assign(new Error("no answer"), { name: "HookInputsUnanswered" });
      return answers;
    },
    skip: (message: string) => {
      throw new Error(`skip: ${message}`);
    },
    fail: (message: string) => {
      throw new Error(`fail: ${message}`);
    },
  };
  return { ctx: ctx as never, accounts, calls, events, asked };
}

describe("the sign-in", () => {
  const owner = { username: "Anna", password: "a-long-password" };
  test("a fresh install: the owner's account replaces the built-in admin", async () => {
    const box = fakeOpenCloud({ admin: "admin" }, owner);
    await configure(box.ctx);
    expect(box.accounts).toEqual({ anna: "a-long-password" });
    expect(box.events).toEqual(["done:up", "done:admin"]);
    expect(box.asked).toEqual([]);
  });
  test("choosing admin as the name only changes its password", async () => {
    const box = fakeOpenCloud({ admin: "admin" }, { username: "admin", password: "a-long-password" });
    await configure(box.ctx);
    expect(box.calls).toEqual(["POST /v1.0/me/changePassword"]);
  });
  test("no sign-in on a fresh install: it asks, and says so when nobody answers", async () => {
    const box = fakeOpenCloud({ admin: "admin" });
    await expect(configure(box.ctx)).rejects.toThrow("skip: OpenCloud has no sign-in chosen yet");
    expect(box.asked).toEqual(["Choose your OpenCloud sign-in"]);
    expect(box.accounts.admin).toBe("admin");
  });
  test("a run from the card leaves a chosen administrator alone and asks nothing", async () => {
    const box = fakeOpenCloud({ anna: "secret-secret" });
    await configure(box.ctx);
    expect(box.events).toEqual(["done:up", "skip:admin"]);
    expect(box.asked).toEqual([]);
    expect(box.calls).toEqual([]);
  });
  test("an install with the sign-in it already knows changes nothing", async () => {
    const box = fakeOpenCloud({ anna: "a-long-password" }, owner);
    await configure(box.ctx);
    expect(box.calls).toEqual([]);
    expect(box.asked).toEqual([]);
  });
  test("accounts from before and a new sign-in: an administrator's answer adds it", async () => {
    const box = fakeOpenCloud({ sam: "old-password-1" }, owner, { username: "sam", password: "old-password-1" });
    await configure(box.ctx);
    expect(box.accounts).toEqual({ sam: "old-password-1", anna: "a-long-password" });
    expect(box.asked).toEqual(["Sign in to OpenCloud"]);
  });
  test("accounts from before and no answer: it steps aside and changes nothing", async () => {
    const box = fakeOpenCloud({ sam: "old-password-1" }, owner);
    await expect(configure(box.ctx)).rejects.toThrow("skip: OpenCloud already has accounts");
    expect(box.accounts).toEqual({ sam: "old-password-1" });
  });
});

describe("OpenCloud's install questions", () => {
  const script = JSON.parse(readFileSync(join(import.meta.dir, "..", "opencloud.json"), "utf8"));
  const questions = script.installation_questions as Array<{ key: string; default?: unknown; type: string; group?: string }>;
  const asked = (key: string) => questions.find((question) => question.key === key)!;

  test("calendars start on, search and every web app start off", () => {
    expect(asked("calendars").default).toBe(true);
    expect(asked("search").default).toBe(false);
    for (const question of questions.filter((question) => question.key.startsWith("app_"))) {
      expect(question.type).toBe("boolean");
      expect(question.default).toBe(false);
      expect(question.group).toBe("Web apps");
    }
  });

  test("every web app follows its own question", () => {
    const apps = Object.entries(script.app_values.opencloud.apps);
    expect(apps.length).toBeGreaterThan(0);
    for (const [app, value] of apps) {
      expect(value).toBe(`$QUESTION(app_${app})`);
      expect(asked(`app_${app}`)).toBeDefined();
    }
  });

  test("the choices reach the chart", () => {
    expect(script.app_values.opencloud.radicale.enabled).toBe("$QUESTION(calendars)");
    expect(script.app_values.opencloud.full_text_search.enabled).toBe("$QUESTION(search)");
  });
});
