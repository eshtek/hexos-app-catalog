// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { readFileSync } from "node:fs";

import type { ContextMount, HookContext } from "../_lib/hook_context";

/**
 * Adds Radarr, Sonarr, Lidarr, Sportarr or Chaptarr to Prowlarr as an application with full sync, so every indexer added
 * to Prowlarr reaches the manager without being set up twice. Each manager is one hook
 * (connect-radarr, connect-sonarr, connect-lidarr, connect-sportarr, connect-chaptarr); the application is built from Prowlarr's own
 * schema and saved with Prowlarr's connection test.
 *
 * Run again, it puts back how Prowlarr and the manager reach each other and keeps the owner's sync
 * level. Prowlarr names each application once, so one under the manager's name at another address
 * (the box's address or the manager's port changed) is moved to this manager: with proof its saved API
 * key is this manager's, or with the owner's yes once nothing answers there. Prowlarr's own sync then
 * points the manager's indexers at Prowlarr's address again. One that may be another manager the
 * owner chose is left as it is, and the link says which.
 */

const MANAGERS: Record<string, { name: string; implementation: string; syncCategories?: number[] }> = {
  radarr: { name: "Radarr", implementation: "Radarr" },
  sonarr: { name: "Sonarr", implementation: "Sonarr" },
  lidarr: { name: "Lidarr", implementation: "Lidarr" },
  // Sportarr answers Prowlarr's Sonarr application API, so Prowlarr sees it as a Sonarr. Sports are
  // category 5060 (TV/Sport), which Prowlarr's Sonarr default leaves out (SonarrSettings.cs).
  sportarr: { name: "Sportarr", implementation: "Sonarr", syncCategories: [5000, 5010, 5020, 5030, 5040, 5045, 5050, 5060, 5090] },
  // Chaptarr answers Prowlarr's Readarr application API, whose default categories cover books and audiobooks.
  chaptarr: { name: "Chaptarr", implementation: "Readarr" },
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
  return mounts.find((m) => m.containerPath === "/config") ?? mounts.find((m) => new RegExp(`/${appId}(-\\d+)?/config$`).test(m.hostPath));
}

function apiKeyIn(mounts: ContextMount[], appId: string): string | undefined {
  try {
    const xml = readFileSync(`${configMount(mounts, appId)?.localPath}/config.xml`, "utf-8");
    return xml.match(/<ApiKey>([^<]+)<\/ApiKey>/)?.[1];
  } catch {
    return undefined;
  }
}

/** Whether anything answers at this address now. An app that's off, or an address nobody has any more, doesn't. */
async function answering(url: string, timeoutMs = 10_000): Promise<boolean> {
  // Any answer counts, so a certificate made for another name isn't taken for silence; nothing is sent
  const init = { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), tls: { rejectUnauthorized: false } };
  const response = await fetch(url, init as RequestInit).catch(() => undefined);
  await response?.body?.cancel().catch(() => undefined);
  return response !== undefined;
}

/** Waits up to about a minute for an app that has only just started, and fails plainly when it doesn't answer. */
async function waitFor(ctx: HookContext, name: string, url: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await answering(`${url}/ping`, 2_000)) return;
    await ctx.sleep(1_000);
  }
  ctx.fail(`${name} isn't answering yet. Try again once it has started.`);
}

/**
 * Whether the owner wants Prowlarr's application moved to this manager, once nothing answers at its
 * address. Nothing proves it was this one (it may be another computer that's switched off), so the
 * owner decides. False when they say no, skip the question, or this HexOS can't ask.
 */
async function ownerSwitches(ctx: HookContext, managerName: string, application: Application, at: string): Promise<boolean> {
  if (typeof ctx.askForInputs !== "function") return false;
  const answers = await ctx
    .askForInputs(
      [
        {
          type: "question",
          id: "switch",
          question: {
            question: `Switch Prowlarr to this ${managerName}`,
            description: "Prowlarr keeps its indexers and syncs them to it.",
            type: "boolean",
            key: "switch",
            required: true,
          },
        },
      ],
      { title: `Switch Prowlarr's ${managerName}`, description: `Prowlarr syncs indexers to ${application.name} at ${at}, which isn't answering.` },
    )
    .catch((error: unknown) => {
      if (error instanceof Error && error.name === "HookInputsUnanswered") return undefined;
      throw error;
    });
  return answers?.switch === true;
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
  // A copy goes by the name its owner gave it, which also keeps two in Prowlarr apart
  const manager = { ...MANAGERS[managerId], name: ctx.linkedApp?.(managerId)?.displayName ?? MANAGERS[managerId].name };
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
  // Either app may have only just started
  await waitFor(ctx, "Prowlarr", ctx.baseUrl);
  await waitFor(ctx, manager.name, managerUrl);
  await ctx.emitCheckpoint("locate");

  const values: Record<string, unknown> = { prowlarrUrl: ctx.baseUrl, baseUrl: managerUrl, apiKey: managerKey };
  // An application under the manager's name at another address: the box's address or the manager's
  // port changed, or it's another manager the owner chose. It moves here with proof it was this
  // manager, or with the owner's yes once nothing answers there, and is left as it is otherwise.
  const repair = async (application: Application): Promise<Application> => {
    const at = String(application.fields.find((field) => field.name === "baseUrl")?.value ?? "");
    if (application.implementation === manager.implementation) {
      // Prowlarr shows the key it holds as ******** (SchemaBuilder) and tests an application sent by
      // id with the one it holds, so a pass at this manager's address says the saved key is its own:
      // each install makes its key at random
      const moved = {
        ...application,
        fields: application.fields.map((field) => (field.name === "baseUrl" || field.name === "prowlarrUrl" ? { ...field, value: values[field.name] } : field)),
      };
      const proven = await prowlarrApi(ctx, prowlarrKey, "/applications/test", { method: "POST", body: JSON.stringify(moved) }).then(
        () => true,
        () => false,
      );
      if (proven || (!(await answering(`${at}/ping`)) && (await ownerSwitches(ctx, manager.name, application, at)))) return application;
    }
    // It may be another manager the owner chose, so it's theirs to change: trying again can't help
    const message = `Prowlarr already has an app named ${application.name}, at ${at}. Rename that one in Prowlarr's Settings, under Apps, then run Connect to ${manager.name} again.`;
    const context = [
      { label: `Prowlarr's ${application.name}`, value: at },
      { label: `This ${manager.name}`, value: managerUrl },
    ];
    if (ctx.skip) ctx.skip(message, context);
    ctx.fail(message, context);
  };
  const applications = await prowlarrApi<Application[]>(ctx, prowlarrKey, "/applications");
  const atThisAddress = applications.find(
    (application) =>
      application.implementation === manager.implementation &&
      application.fields.some((field) => field.name === "baseUrl" && field.value === managerUrl),
  );
  // Prowlarr refuses a second application under a name it has, whatever its case (ProviderControllerBase)
  const named = atThisAddress ? undefined : applications.find((application) => application.name.toLowerCase() === manager.name.toLowerCase());
  const existing = atThisAddress ?? (named ? await repair(named) : undefined);
  const template =
    existing ??
    (await prowlarrApi<Application[]>(ctx, prowlarrKey, "/applications/schema")).find(
      (application) => application.implementation === manager.implementation,
    );
  if (!template) ctx.fail(`Prowlarr doesn't offer ${manager.name} as an application`);
  // Only a new application gets HexOS's categories. A run again keeps the ones the owner chose.
  if (manager.syncCategories && !existing) values.syncCategories = manager.syncCategories;

  const application: Application = {
    ...template,
    name: existing?.name ?? manager.name,
    // A run again keeps the sync level the owner chose
    syncLevel: existing?.syncLevel ?? "fullSync",
    fields: template.fields.map((field) => (field.name in values ? { ...field, value: values[field.name] } : field)),
  };
  try {
    if (existing?.id !== undefined) {
      await prowlarrApi(ctx, prowlarrKey, `/applications/${existing.id}`, { method: "PUT", body: JSON.stringify(application) });
    } else {
      await prowlarrApi(ctx, prowlarrKey, "/applications", { method: "POST", body: JSON.stringify(application) });
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // One added since the list was read: a run again finds it under the name
    if (/should be unique/i.test(reason)) ctx.fail(`Prowlarr already has an app named ${manager.name}. Run Connect to ${manager.name} again to check it.`);
    ctx.fail(`Prowlarr couldn't reach ${manager.name}`, [{ label: "Reason", value: reason }]);
  }
  await ctx.emitCheckpoint("configure", existing && !atThisAddress ? `Prowlarr reaches ${manager.name} at its new address` : undefined);
}

export const radarr = (ctx: HookContext) => connect(ctx, "radarr");
export const sonarr = (ctx: HookContext) => connect(ctx, "sonarr");
export const lidarr = (ctx: HookContext) => connect(ctx, "lidarr");
export const sportarr = (ctx: HookContext) => connect(ctx, "sportarr");
export const chaptarr = (ctx: HookContext) => connect(ctx, "chaptarr");
