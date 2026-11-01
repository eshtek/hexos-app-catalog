// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { readFileSync, writeFileSync } from "node:fs";

import type { HookContext } from "../_lib/hook_context";

/**
 * Turns on spelling and grammar checks in Collabora through LanguageTool. Collabora reads its
 * settings at its start, from coolwsd.xml and then every file in /etc/coolwsd/conf.d, which is a
 * folder of HexOS's. So the link writes one file there and restarts Collabora, and running it again
 * changes nothing unless LanguageTool has moved. Read at Collabora 26.04.
 */

const FOLDER = "/etc/coolwsd/conf.d";
const FILE = "hexos-languagetool.xml";

const settings = (url: string) => `<config>
  <languagetool>
    <enabled type="bool">true</enabled>
    <base_url type="string">${url}/v2</base_url>
    <ssl_verification type="bool">false</ssl_verification>
    <rest_protocol type="string"></rest_protocol>
  </languagetool>
</config>
`;

export async function run(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "locate", message: "Finding LanguageTool" },
    { id: "restart", message: "Restarting Collabora to connect it" },
    { id: "confirm", message: "Checking Collabora came back" },
  ]);

  const mount = ctx.mounts.find((m) => m.containerPath === FOLDER);
  if (!mount) ctx.fail("This Collabora can't connect to LanguageTool yet. Update its setup from the app's page, then try again.");
  const url = await ctx.getInstalledAppUrl("languagetool");
  if (!url) ctx.fail("LanguageTool isn't installed, or HexOS can't find its port");
  await ctx.emitCheckpoint("locate");

  const path = `${mount.localPath}/${FILE}`;
  let current: string | undefined;
  try {
    current = readFileSync(path, "utf-8");
  } catch {}
  const wanted = settings(url);
  if (current === wanted) {
    await ctx.skipCheckpoint("restart", "Collabora already uses this LanguageTool");
    await ctx.skipCheckpoint("confirm");
    return;
  }
  if (typeof ctx.restartApp !== "function") ctx.fail("This server's HexOS needs an update before it can connect Collabora. Try again after it updates.");
  writeFileSync(path, wanted, { mode: 0o644 });
  await ctx.restartApp();
  await ctx.emitCheckpoint("restart");
  await ctx.waitForApp("/hosting/discovery", { maxAttempts: 40 });
  await ctx.emitCheckpoint("confirm");
}
