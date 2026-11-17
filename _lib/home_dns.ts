// `requirements.home_dns: true` says the app answers DNS for the home on port 53 of the server's own
// address. HexOS's own DNS service gives the port up to it, and the app's hook keeps the Anywhere
// names answered inside the app, so the script has to hold port 53 and have that hook.
//
// `requirements.exclusive_with` lists the apps this one can't be installed beside. Two DNS apps
// would both want port 53, and the box refuses the second. Each app names the other, so the refusal
// reads the same whichever one the owner installs first.
//
// Both are read from the catalog's current script, and a box from before them ignores them.

import type { Finding, Script } from "./ports";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const DNS_PORT = 53;

const requirementsOf = (script: Script | undefined) => (script && isObject(script.requirements) ? script.requirements : {});

/** The apps a script says it can't be installed beside. */
const exclusiveWith = (script: Script | undefined): string[] => {
  const listed = requirementsOf(script).exclusive_with;
  return Array.isArray(listed) ? listed.filter((other): other is string => typeof other === "string") : [];
};

/** The rules for a script that answers the home's DNS, and for one that can't share a server with another app. */
export function homeDnsRules(id: string, script: Script, scripts: ReadonlyMap<string, Script>): Finding[] {
  const error = (message: string): Finding => ({ level: "error", message });
  const requirements = requirementsOf(script);
  const findings: Finding[] = [];

  const homeDns = requirements.home_dns;
  if (homeDns !== undefined && homeDns !== true) {
    findings.push(error(`requirements.home_dns: "${String(homeDns)}" must be true`));
  }
  if (homeDns === true) {
    if (!(Array.isArray(requirements.ports) && requirements.ports.includes(DNS_PORT))) {
      findings.push(error(`requirements.home_dns needs ${DNS_PORT} in requirements.ports, the port HexOS's own DNS service gives up`));
    }
    const hooks = Array.isArray(script.hooks) ? script.hooks.filter(isObject) : [];
    if (!hooks.some((hook) => Array.isArray(hook.rerunsOn) && hook.rerunsOn.includes("home-addresses"))) {
      findings.push(error('requirements.home_dns needs a hook that reruns on "home-addresses", which keeps the Anywhere names answered in the app'));
    }
  }

  const listed = requirements.exclusive_with;
  if (listed === undefined) return findings;
  if (!Array.isArray(listed) || listed.length === 0 || !listed.every((other) => typeof other === "string")) {
    findings.push(error("requirements.exclusive_with must be a list of app ids"));
    return findings;
  }
  for (const other of exclusiveWith(script)) {
    if (other === id) {
      findings.push(error(`requirements.exclusive_with: "${other}" is this app`));
    } else if (!scripts.has(other)) {
      findings.push(error(`requirements.exclusive_with: "${other}" is not an app in the catalog`));
    } else if (!exclusiveWith(scripts.get(other)).includes(id)) {
      // The box reads the list of the app being installed, so one side alone lets the other order through
      findings.push(error(`requirements.exclusive_with: "${other}" has to name "${id}" too`));
    }
  }
  return findings;
}
