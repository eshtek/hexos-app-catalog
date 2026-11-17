import { expect, test } from "bun:test";

import sparky from "../sparkyfitness.json";
import { withAnywhereOrigins } from "../sparkyfitness/anywhere";

// SparkyFitness answered a sign-in at its Anywhere address with 403 "Invalid origin"

const cors = { name: "ALLOW_PRIVATE_NETWORK_CORS", value: "true" };
const envs = (values: Record<string, unknown>) =>
  (values.sparkyfitness as { additional_envs: Array<{ name: string; value: string }> }).additional_envs;
const fresh = () => ({ sparkyfitness: { frontend_url: "http://192.168.1.20:30448", additional_envs: [{ ...cors }] } });

test("an Anywhere name is added as an https origin beside the script's own envs", () => {
  const values = fresh();
  withAnywhereOrigins(values, ["sparky.k7q2m9.example.com"]);
  expect(envs(values)).toEqual([
    cors,
    { name: "SPARKY_FITNESS_EXTRA_TRUSTED_ORIGINS", value: "https://sparky.k7q2m9.example.com" },
    { name: "HEXOS_ANYWHERE_ORIGINS", value: "https://sparky.k7q2m9.example.com" },
  ]);
  expect(values.sparkyfitness.frontend_url).toBe("http://192.168.1.20:30448");
});

test("running it again with the same names changes nothing", () => {
  const values = fresh();
  withAnywhereOrigins(values, ["sparky.k7q2m9.example.com"]);
  const once = structuredClone(values);
  withAnywhereOrigins(values, ["sparky.k7q2m9.example.com"]);
  expect(values).toEqual(once);
});

test("a renamed address replaces the old origin, and an origin the owner added stays", () => {
  const values = fresh();
  values.sparkyfitness.additional_envs.push({ name: "SPARKY_FITNESS_EXTRA_TRUSTED_ORIGINS", value: "https://fit.owner.example" });
  withAnywhereOrigins(values, ["sparky.k7q2m9.example.com"]);
  withAnywhereOrigins(values, ["fitness.k7q2m9.example.com", "fit.second.example"]);
  expect(envs(values).find((env) => env.name === "SPARKY_FITNESS_EXTRA_TRUSTED_ORIGINS")?.value).toBe(
    "https://fit.owner.example,https://fitness.k7q2m9.example.com,https://fit.second.example",
  );
});

test("with the address turned off, only what HexOS added comes back out", () => {
  const values = fresh();
  values.sparkyfitness.additional_envs.push({ name: "SPARKY_FITNESS_EXTRA_TRUSTED_ORIGINS", value: "https://fit.owner.example" });
  withAnywhereOrigins(values, ["sparky.k7q2m9.example.com"]);
  withAnywhereOrigins(values, []);
  expect(envs(values)).toEqual([cors, { name: "SPARKY_FITNESS_EXTRA_TRUSTED_ORIGINS", value: "https://fit.owner.example" }]);
  const plain = fresh();
  withAnywhereOrigins(plain, ["sparky.k7q2m9.example.com"]);
  withAnywhereOrigins(plain, []);
  expect(plain).toEqual(fresh());
});

test("a name that isn't a hostname is never written into an env", () => {
  const values = fresh();
  withAnywhereOrigins(values, ["sparky.example.com,https://evil.example", "ok.example.com"]);
  expect(envs(values).find((env) => env.name === "SPARKY_FITNESS_EXTRA_TRUSTED_ORIGINS")?.value).toBe("https://ok.example.com");
});

test("no http origin is ever listed, which would turn the app's secure cookies off", () => {
  const values = fresh();
  withAnywhereOrigins(values, ["sparky.k7q2m9.example.com"]);
  expect(JSON.stringify(envs(values))).not.toContain("http://");
});

test("the address step is a hook of its own that may run again", () => {
  const hooks = (sparky as { hooks?: Array<{ id: string; rerunsOn?: string[]; rerun?: string; events?: string[] }> }).hooks ?? [];
  expect(hooks).toHaveLength(1);
  expect(hooks[0]).toMatchObject({ id: "anywhere-address", rerun: "converge", rerunsOn: ["remote-address"], events: ["userAction"] });
});
