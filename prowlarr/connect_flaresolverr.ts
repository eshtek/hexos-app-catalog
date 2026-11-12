// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { readFileSync } from "node:fs";

import type { ContextMount, HookContext } from "../_lib/hook_context";

/**
 * Adds FlareSolverr to Prowlarr as an indexer proxy, for sites behind Cloudflare. Prowlarr only sends
 * a saved indexer through a proxy that shares a tag with it (IndexerHttpClient.GetProxy), so the
 * proxy gets a flaresolverr tag and the owner tags the indexers that need it. HexOS doesn't tag them
 * itself: most indexers don't need it, and FlareSolverr makes every search through it much slower.
 * Run again, it puts back how Prowlarr reaches FlareSolverr and leaves the rest as the owner set it.
 */

const TAG = "flaresolverr";

interface Proxy {
  id?: number;
  name?: string;
  implementation: string;
  tags: number[];
  fields: Array<{ name: string; value?: unknown }>;
  [key: string]: unknown;
}

function apiKey(mounts: ContextMount[]): string | undefined {
  const config = mounts.find((m) => m.containerPath === "/config") ?? mounts.find((m) => m.hostPath.endsWith("/prowlarr/config"));
  if (!config) return undefined;
  try {
    return readFileSync(`${config.localPath}/config.xml`, "utf-8").match(/<ApiKey>([^<]+)<\/ApiKey>/)?.[1];
  } catch {
    return undefined;
  }
}

async function prowlarr<T>(ctx: HookContext, key: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${ctx.baseUrl}/api/v1${path}`, {
    ...init,
    headers: { "X-Api-Key": key, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(90_000),
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

export async function run(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "locate", message: "Finding FlareSolverr" },
    { id: "configure", message: "Adding FlareSolverr to Prowlarr" },
  ]);

  const key = apiKey(ctx.mounts);
  if (!key) ctx.fail("HexOS couldn't read Prowlarr's API key yet. Try again once it has started.");
  const url = await ctx.getInstalledAppUrl("flaresolverr");
  if (!url) ctx.fail("FlareSolverr isn't installed, or HexOS can't find its port");
  await ctx.emitCheckpoint("locate");

  const tags = await prowlarr<Array<{ id: number; label: string }>>(ctx, key, "/tag");
  const tag = tags.find((entry) => entry.label === TAG) ?? (await prowlarr<{ id: number }>(ctx, key, "/tag", { method: "POST", body: JSON.stringify({ label: TAG }) }));

  const existing = (await prowlarr<Proxy[]>(ctx, key, "/indexerproxy")).find((proxy) => proxy.implementation === "FlareSolverr");
  const template = existing ?? (await prowlarr<Proxy[]>(ctx, key, "/indexerproxy/schema")).find((proxy) => proxy.implementation === "FlareSolverr");
  if (!template) ctx.fail("Prowlarr doesn't offer FlareSolverr as an indexer proxy");
  const proxy: Proxy = {
    ...template,
    name: existing?.name ?? "FlareSolverr",
    tags: existing?.tags.includes(tag.id) ? existing.tags : [...(existing?.tags ?? []), tag.id],
    fields: template.fields.map((field) => (field.name === "host" ? { ...field, value: `${url}/` } : field)),
  };
  try {
    if (existing?.id !== undefined) {
      await prowlarr(ctx, key, `/indexerproxy/${existing.id}`, { method: "PUT", body: JSON.stringify(proxy) });
    } else {
      await prowlarr(ctx, key, "/indexerproxy", { method: "POST", body: JSON.stringify(proxy) });
    }
  } catch (error) {
    ctx.fail("Prowlarr couldn't reach FlareSolverr", [{ label: "Reason", value: error instanceof Error ? error.message : String(error) }]);
  }
  await ctx.emitCheckpoint("configure", `FlareSolverr is ready. Give an indexer behind Cloudflare the ${TAG} tag in Prowlarr to use it.`);
}
