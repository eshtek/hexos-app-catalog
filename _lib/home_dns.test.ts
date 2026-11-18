import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { homeDnsRules, hostIpsRules } from "./home_dns";
import type { Script } from "./ports";

const HOOK = { id: "home-addresses", rerun: "converge", rerunsOn: ["home-addresses"] };
const dnsApp = (requirements: Record<string, unknown> = {}, hooks: unknown[] = [HOOK]): Script => ({
  requirements: { ports: [30004, 53], home_dns: true, ...requirements },
  hooks,
});
const plain: Script = { requirements: { ports: [30100] } };
const messages = (id: string, script: Script, others: Record<string, Script> = {}) =>
  homeDnsRules(id, script, new Map(Object.entries({ [id]: script, ...others }))).map((finding) => finding.message);

describe("requirements.home_dns", () => {
  test("a script that says neither key is left alone", () => {
    expect(messages("a", plain)).toEqual([]);
  });

  test("an app that holds port 53 and keeps the Anywhere names answered passes", () => {
    expect(messages("a", dnsApp())).toEqual([]);
  });

  test("the key takes true and nothing else", () => {
    expect(messages("a", dnsApp({ home_dns: "yes" }))).toEqual(['requirements.home_dns: "yes" must be true']);
    expect(messages("a", dnsApp({ home_dns: false }))).toEqual(['requirements.home_dns: "false" must be true']);
  });

  test("it has to list port 53", () => {
    expect(messages("a", dnsApp({ ports: [30004, 5353] }))).toEqual([
      "requirements.home_dns needs 53 in requirements.ports, the port HexOS's own DNS service gives up",
    ]);
    expect(messages("a", dnsApp({ ports: undefined }))).toHaveLength(1);
  });

  test("it has to have a hook that reruns on home-addresses", () => {
    const expected = ['requirements.home_dns needs a hook that reruns on "home-addresses", which keeps the Anywhere names answered in the app'];
    expect(messages("a", dnsApp({}, []))).toEqual(expected);
    expect(messages("a", dnsApp({}, [{ id: "x", rerunsOn: ["remote-address"] }]))).toEqual(expected);
    expect(messages("a", dnsApp({}, [{ id: "x" }]))).toEqual(expected);
    expect(messages("a", { requirements: { ports: [53], home_dns: true } })).toEqual(expected);
  });
});

describe("requirements.exclusive_with", () => {
  const a: Script = { requirements: { ports: [1], exclusive_with: ["b"] } };
  const b: Script = { requirements: { ports: [2], exclusive_with: ["a"] } };

  test("two apps that name each other pass", () => {
    expect(messages("a", a, { b })).toEqual([]);
    expect(messages("b", b, { a })).toEqual([]);
  });

  test("it takes a list of app ids, with something in it", () => {
    const expected = ["requirements.exclusive_with must be a list of app ids"];
    expect(messages("a", { requirements: { exclusive_with: "b" } }, { b })).toEqual(expected);
    expect(messages("a", { requirements: { exclusive_with: [] } }, { b })).toEqual(expected);
    expect(messages("a", { requirements: { exclusive_with: ["b", 7] } }, { b })).toEqual(expected);
  });

  test("each id has to be a script in the catalog", () => {
    expect(messages("a", a)).toEqual(['requirements.exclusive_with: "b" is not an app in the catalog']);
  });

  test("the other app has to name this one back", () => {
    const expected = ['requirements.exclusive_with: "b" has to name "a" too'];
    expect(messages("a", a, { b: plain })).toEqual(expected);
    expect(messages("a", a, { b: { requirements: { exclusive_with: ["c"] } } })).toEqual(expected);
  });

  test("an app can't name itself", () => {
    expect(messages("a", { requirements: { exclusive_with: ["a"] } })).toEqual(['requirements.exclusive_with: "a" is this app']);
  });
});

describe("the two DNS apps", () => {
  const read = (id: string) => JSON.parse(readFileSync(`${import.meta.dir}/../${id}.json`, "utf-8")) as Script & {
    requirements: Record<string, unknown>;
    app_values: { network: { dns_port: unknown; host_network: unknown }; pihole?: { additional_envs: Array<{ name: string; value: string }> } };
  };
  const scripts = new Map<string, Script>(["adguard-home", "pihole"].map((id) => [id, read(id)]));

  test("each answers the home's DNS and can't be installed beside the other", () => {
    expect(read("adguard-home").requirements).toMatchObject({ home_dns: true, exclusive_with: ["pihole"] });
    expect(read("pihole").requirements).toMatchObject({ home_dns: true, exclusive_with: ["adguard-home"] });
    for (const [id, script] of scripts) expect(homeDnsRules(id, script, scripts)).toEqual([]);
  });

  test("each runs on the server's own network and publishes nothing on one address", () => {
    for (const id of scripts.keys()) {
      const script = read(id);
      expect(script.app_values.network.host_network).toBe(true);
      expect(JSON.stringify(script)).not.toContain("host_ips");
      expect(JSON.stringify(script)).not.toContain("$SERVER_LAN_IP");
      expect(hostIpsRules(script)).toEqual([]);
      // The platform reads port 53 from here, since an app on the host network publishes none
      expect(script.requirements.ports).toContain(53);
    }
    expect(read("adguard-home").app_values.network.dns_port).toEqual({ bind_mode: "" });
    expect(read("pihole").app_values.network.dns_port).toBeUndefined();
  });

  test("Pi-hole runs as the apps user and can't set the server's clock", () => {
    const envs = Object.fromEntries(read("pihole").app_values.pihole!.additional_envs.map((env) => [env.name, env.value]));
    expect(envs).toMatchObject({ PIHOLE_UID: "568", PIHOLE_GID: "568", FTLCONF_ntp_sync_active: "false" });
  });

  test("Pi-hole reads the file that keeps it off every address, written before its first start", () => {
    const script = read("pihole") as ReturnType<typeof read> & { hooks: Array<{ id: string; events: string[]; optional?: boolean }> };
    const envs = Object.fromEntries(script.app_values.pihole!.additional_envs.map((env) => [env.name, env.value]));
    expect(envs.FTLCONF_misc_etc_dnsmasq_d).toBe("true");
    // TrueNAS's app sets these two itself, and refuses the install when a script sets them again
    expect(envs.FTLCONF_dns_listeningMode).toBeUndefined();
    expect(envs.FTLCONF_webserver_api_password).toBeUndefined();
    // A forced setting is one the owner can't change in Pi-hole, and the Anywhere hook writes this one
    expect(envs.FTLCONF_misc_dnsmasq_lines).toBeUndefined();
    const seed = script.hooks.find((hook) => hook.id === "seed-listen");
    expect(seed?.events).toEqual(["onBeforeInstall"]);
    // Without the file Pi-hole answers nowhere, so the install doesn't go on without it
    expect(seed?.optional).toBeUndefined();
  });
});

describe("host_ips", () => {
  const publishing = (hostIps: unknown) => ({ app_values: { network: { dns_port: { bind_mode: "published", port_number: 53, host_ips: hostIps } } } });

  test("the server's own address is refused, however it is written", () => {
    for (const address of ["$SERVER_LAN_IP", "192.168.1.20", "fd00::20", "$QUESTION(address)"]) {
      const [finding, ...rest] = hostIpsRules(publishing([address]));
      expect(rest).toEqual([]);
      expect(finding?.level).toBe("error");
      expect(finding?.message).toStartWith(`app_values.network.dns_port.host_ips: "${address}" is one address`);
      expect(finding?.message).toContain("gets its address from the router");
    }
  });

  test("every address, an empty list and no list at all pass", () => {
    expect(hostIpsRules(publishing(["0.0.0.0", "::"]))).toEqual([]);
    expect(hostIpsRules(publishing([]))).toEqual([]);
    expect(hostIpsRules({ app_values: { network: { web_port: { bind_mode: "published", port_number: 80 } } } })).toEqual([]);
    expect(hostIpsRules({})).toEqual([]);
  });

  test("one address beside every address is still refused", () => {
    expect(hostIpsRules(publishing(["0.0.0.0", "10.0.0.5"]))).toHaveLength(1);
  });

  test("a list anywhere in app_values is found", () => {
    const script = { app_values: { network: { additional_ports: [{ port_number: 1 }, { port_number: 2, host_ips: ["10.0.0.5"] }] }, ports: [{ host_ips: ["10.0.0.6"] }] } };
    expect(hostIpsRules(script).map((finding) => finding.message.split(":")[0])).toEqual(["app_values.network.additional_ports[1].host_ips", "app_values.ports[0].host_ips"]);
  });
});
