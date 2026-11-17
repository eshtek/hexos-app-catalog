// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import type { HookContext } from "../_lib/hook_context";

/**
 * The gateway serves an app's Anywhere address over https and reaches the app over http, with the
 * visitor's scheme in X-Forwarded-Proto. Each app here has one setting that makes it believe that header.
 */

/** Names the setting HexOS added, so one the owner made themselves is never changed or taken out. */
const OURS = "HEXOS_ANYWHERE_ENVS";

interface Env {
  container?: string;
  name: string;
  value: string;
}

export interface ProxySetting {
  /** The key of the app's values that holds its `additional_envs`. */
  group: string;
  /** The container the env is for, in an app whose envs each name one. */
  container?: string;
  name: string;
  value: string;
}

/** Paperless-ngx read an https sign-in as http, so the page's origin never matched and it answered 403. */
export const PAPERLESS: ProxySetting = {
  group: "paperless",
  container: "paperless",
  name: "PAPERLESS_PROXY_SSL_HEADER",
  value: '["HTTP_X_FORWARDED_PROTO","https"]',
};

/** Firefly III wrote http addresses for its assets and redirects into a page opened over https. */
export const FIREFLY: ProxySetting = { group: "firefly_iii", name: "TRUSTED_PROXIES", value: "**" };

export type Outcome = "added" | "removed" | "owners" | "unchanged";

/**
 * Adds the setting while the app has an Anywhere name, and takes HexOS's own back out once it has none.
 * Both upstreams warn against it on an app with no proxy in front, so it is never in the install script.
 */
export function withProxySetting(values: Record<string, unknown>, names: readonly string[], setting: ProxySetting): Outcome {
  const app = values[setting.group] as { additional_envs?: Env[] } | undefined;
  const envs = Array.isArray(app?.additional_envs) ? app.additional_envs : [];
  // TrueNAS refuses a name twice in one container, and the same name in another container is another env
  const is = (env: Env, name: string) => env.name === name && env.container === setting.container;
  const current = envs.find((env) => is(env, setting.name));
  const marked = envs.some((env) => is(env, OURS));
  // A value the owner changed after HexOS added it is the owner's from then on
  const ours = marked && current?.value === setting.value;
  const wanted = names.length > 0;

  const write = (next: Env[]) => {
    if (app) app.additional_envs = next;
    else values[setting.group] = { additional_envs: next };
  };
  const unmarked = envs.filter((env) => !is(env, OURS));
  const own = (name: string, value: string): Env => ({ ...(setting.container ? { container: setting.container } : {}), name, value });

  if (current && !ours) {
    if (marked) write(unmarked);
    return "owners";
  }
  if (wanted && !current) {
    write([...unmarked, own(setting.name, setting.value), own(OURS, setting.name)]);
    return "added";
  }
  if (!wanted && current) {
    write(unmarked.filter((env) => env !== current));
    return "removed";
  }
  if (marked && !current) write(unmarked);
  return "unchanged";
}

async function run(ctx: HookContext, app: string, setting: ProxySetting) {
  await ctx.registerCheckpoints([
    { id: "names", message: "Reading this app's Anywhere addresses" },
    { id: "update", message: `Setting ${app} up for its Anywhere address` },
  ]);
  const read = await ctx.readRemoteAddresses?.();
  if (!read || typeof ctx.updateAppValues !== "function") {
    ctx.fail(`This server's HexOS needs an update before ${app} can open at an Anywhere address. Try again after it updates.`);
  }
  await ctx.emitCheckpoint("names");
  const result: { outcome: Outcome } = { outcome: "unchanged" };
  const changed = await ctx.updateAppValues((values) => {
    result.outcome = withProxySetting(values, read.names, setting);
  });
  if (result.outcome === "owners") {
    await ctx.skipCheckpoint("update", `Left the ${setting.name} setting you made yourself as it is`);
  } else if (!changed) {
    await ctx.skipCheckpoint("update", read.names.length > 0 ? `${app} is already set up for its Anywhere address` : `${app} has no Anywhere address`);
  } else if (result.outcome === "removed") {
    await ctx.emitCheckpoint("update", `Took ${app}'s Anywhere setting back out`);
  } else {
    await ctx.emitCheckpoint("update");
  }
}

export async function paperless(ctx: HookContext) {
  await run(ctx, "Paperless-ngx", PAPERLESS);
}

export async function firefly(ctx: HookContext) {
  await run(ctx, "Firefly III", FIREFLY);
}
