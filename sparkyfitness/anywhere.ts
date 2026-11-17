// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import type { HookContext } from "../_lib/hook_context";

/**
 * SparkyFitness refuses a sign-in from an address it wasn't told about: its sign-in answers 403
 * "Invalid origin" unless the page's origin is its own address, a private one, or listed in
 * SPARKY_FITNESS_EXTRA_TRUSTED_ORIGINS. This keeps the app's Anywhere addresses in that list.
 * HEXOS_ANYWHERE_ORIGINS holds the ones HexOS put there, so an origin the owner added stays.
 */

const TRUSTED = "SPARKY_FITNESS_EXTRA_TRUSTED_ORIGINS";
const OURS = "HEXOS_ANYWHERE_ORIGINS";
const HOSTNAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;

interface Env {
  name: string;
  value: string;
}

const split = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

/** Puts the names' origins into the app's values, in place of the ones put there before. */
export function withAnywhereOrigins(values: Record<string, unknown>, names: readonly string[]) {
  const app = (values.sparkyfitness ??= {}) as { additional_envs?: Env[] };
  const envs = Array.isArray(app.additional_envs) ? app.additional_envs : [];
  const valueOf = (name: string) => envs.find((env) => env.name === name)?.value;
  const before = split(valueOf(OURS));
  const origins = names.filter((name) => HOSTNAME.test(name)).map((name) => `https://${name}`);
  const trusted = [...split(valueOf(TRUSTED)).filter((origin) => !before.includes(origin) && !origins.includes(origin)), ...origins];
  const rest = envs.filter((env) => env.name !== TRUSTED && env.name !== OURS);
  app.additional_envs = [
    ...rest,
    ...(trusted.length > 0 ? [{ name: TRUSTED, value: trusted.join(",") }] : []),
    ...(origins.length > 0 ? [{ name: OURS, value: origins.join(",") }] : []),
  ];
}

export async function anywhere(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "names", message: "Reading this app's Anywhere addresses" },
    { id: "update", message: "Telling SparkyFitness to accept sign-ins from them" },
  ]);
  const read = await ctx.readRemoteAddresses?.();
  if (!read || typeof ctx.updateAppValues !== "function") {
    ctx.fail("This server's HexOS needs an update before SparkyFitness can open at an Anywhere address. Try again after it updates.");
  }
  await ctx.emitCheckpoint("names");
  const changed = await ctx.updateAppValues((values) => withAnywhereOrigins(values, read.names));
  if (changed) await ctx.emitCheckpoint("update");
  else await ctx.skipCheckpoint("update", "SparkyFitness already accepts these addresses");
}
