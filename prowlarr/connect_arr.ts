// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { readFileSync } from "node:fs";

import type { ContextMount, HookContext } from "../_lib/hook_context";

/**
 * Adds Radarr, Sonarr or Lidarr to Prowlarr as an application with full sync, so every indexer added
 * to Prowlarr reaches the manager without being set up twice. Each manager is one hook
 * (connect-radarr, connect-sonarr, connect-lidarr); the application is built from Prowlarr's own
 * schema and saved with Prowlarr's connection test.
 */

const MANAGERS: Record<string, { name: string; implementation: string }> = {
  radarr: { name: "Radarr", implementation: "Radarr" },
  sonarr: { name: "Sonarr", implementation: "Sonarr" },
  lidarr: { name: "Lidarr", implementation: "Lidarr" },
};

interface Field {
  name: string;
  value?: unknown;
}

interface Application {
  id?: number;
  name: string;
  implementation: string;
  syncLevel?: string;
  fields: Field[];
  [key: string]: unknown;
}

function configMount(mounts: ContextMount[], appId: string): ContextMount | undefined {
  return mounts.find((m) => m.containerPath === "/config") ?? mounts.find((m) => m.hostPath.endsWith(`/${appId}/config`));
}

function apiKeyIn(mounts: ContextMount[], appId: string): string | undefined {
  try {
    const xml = readFileSync(`${configMount(mounts, appId)?.localPath}/config.xml`, "utf-8");
    return xml.match(/<ApiKey>([^<]+)<\/ApiKey>/)?.[1];
  } catch {
    return undefined;
  }
}

async function prowlarrApi<T>(ctx: HookContext, apiKey: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${ctx.baseUrl}/api/v1${path}`, {
    ...init,
    headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    let reason = text.slice(0, 300);
    try {
      const body = JSON.parse(text) as Array<{ errorMessage?: string }> | { message?: string };
      reason = Array.isArray(body) ? body.map((entry) => entry.errorMessage).filter(Boolean).join("; ") : (body.message ?? reason);
    } catch {}
    throw new Error(reason || `${response.status} ${response.statusText}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

async function connect(ctx: HookContext, managerId: string) {
  const manager = MANAGERS[managerId];
  await ctx.registerCheckpoints([
    { id: "locate", message: `Finding ${manager.name}` },
    { id: "configure", message: `Adding ${manager.name} to Prowlarr` },
  ]);

  const prowlarrKey = apiKeyIn(ctx.mounts, "prowlarr");
  if (!prowlarrKey) ctx.fail("HexOS couldn't read Prowlarr's API key yet. Try again once it has started.");
  const managerUrl = await ctx.getInstalledAppUrl(managerId);
  if (!managerUrl) ctx.fail(`${manager.name} isn't installed, or HexOS can't find its port`);
  const managerKey = apiKeyIn(await ctx.getInstalledAppMounts(managerId), managerId);
  if (!managerKey) ctx.fail(`HexOS couldn't read ${manager.name}'s API key yet. Try again once it has started.`);
  await ctx.emitCheckpoint("locate");

  const values: Record<string, unknown> = { prowlarrUrl: ctx.baseUrl, baseUrl: managerUrl, apiKey: managerKey };
  const existing = (await prowlarrApi<Application[]>(ctx, prowlarrKey, "/applications")).find(
    (application) =>
      application.implementation === manager.implementation &&
      application.fields.some((field) => field.name === "baseUrl" && field.value === managerUrl),
  );
  const template =
    existing ??
    (await prowlarrApi<Application[]>(ctx, prowlarrKey, "/applications/schema")).find(
      (application) => application.implementation === manager.implementation,
    );
  if (!template) ctx.fail(`Prowlarr doesn't offer ${manager.name} as an application`);

  const application: Application = {
    ...template,
    name: existing?.name ?? manager.name,
    syncLevel: "fullSync",
    fields: template.fields.map((field) => (field.name in values ? { ...field, value: values[field.name] } : field)),
  };
  try {
    if (existing?.id !== undefined) {
      await prowlarrApi(ctx, prowlarrKey, `/applications/${existing.id}`, { method: "PUT", body: JSON.stringify(application) });
    } else {
      await prowlarrApi(ctx, prowlarrKey, "/applications", { method: "POST", body: JSON.stringify(application) });
    }
  } catch (error) {
    ctx.fail(`Prowlarr couldn't reach ${manager.name}`, [
      { label: "Reason", value: error instanceof Error ? error.message : String(error) },
    ]);
  }
  await ctx.emitCheckpoint("configure");
}

export const radarr = (ctx: HookContext) => connect(ctx, "radarr");
export const sonarr = (ctx: HookContext) => connect(ctx, "sonarr");
export const lidarr = (ctx: HookContext) => connect(ctx, "lidarr");
