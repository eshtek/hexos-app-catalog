// onAfterInstall: if a license code was entered at install, write it to
// /data/tmm.lic (where tinyMediaManager reads its license) and restart the app
// so it takes effect. Blank license -> do nothing (free version), and an
// existing tmm.lic is left alone.
import { writeFileSync } from "node:fs";

import type { ContextMount, HookContext } from "../_lib/hook_context";

/** tinyMediaManager's data folder is mounted at /data; the license lives at /data/tmm.lic. */
function dataMount(mounts: ContextMount[]): ContextMount | undefined {
  return (
    mounts.find((m) => m.containerPath === "/data") ??
    mounts.find((m) => m.hostPath.endsWith("/tiny-media-manager/data"))
  );
}

/** The license the owner typed, carried through app_values (additional_envs). */
function license(values: Record<string, unknown> | undefined): string | null {
  const tmm = (values?.tiny_media_manager ?? {}) as {
    additional_envs?: Array<{ name?: string; value?: string }>;
  };
  const entry = (tmm.additional_envs ?? []).find((e) => e?.name === "HEXOS_TMM_LICENSE");
  const code = typeof entry?.value === "string" ? entry.value.trim() : "";
  return code.length > 0 ? code : null;
}

export async function run(ctx: HookContext) {
  await ctx.registerCheckpoints([{ id: "license", message: "Applying your tinyMediaManager license" }]);

  const values = ctx.getAppValues ? await ctx.getAppValues().catch(() => undefined) : undefined;
  const code = license(values);

  if (!code) {
    const msg = "No license entered - running the free version";
    if (ctx.skipCheckpoint) await ctx.skipCheckpoint("license", msg);
    else await ctx.emitCheckpoint("license", msg);
    return;
  }

  const data = dataMount(ctx.mounts);
  if (!data) ctx.fail("HexOS couldn't find tinyMediaManager's data folder");

  // No trailing newline, per the tinyMediaManager docs.
  writeFileSync(`${data!.localPath}/tmm.lic`, code, { mode: 0o600 });
  ctx.log("Wrote tinyMediaManager license to /data/tmm.lic");

  if (ctx.restartApp) {
    await ctx.restartApp();
    await ctx.emitCheckpoint("license", "License applied; restarted tinyMediaManager");
  } else {
    await ctx.emitCheckpoint("license", "License applied; it takes effect on the next restart");
  }
}
