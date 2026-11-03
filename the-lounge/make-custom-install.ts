// Build a self-contained JSON script for testing through HexOS Custom Install.
// The catalog version keeps the hook in its own file for normal installs.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const script = JSON.parse(readFileSync(join(root, "the-lounge.json"), "utf8"));
const hook = script.hooks.find((item: { id: string }) => item.id === "create-account");
if (!hook) throw new Error("The Lounge account hook is missing");

const source = readFileSync(join(import.meta.dir, "create_account.ts"), "utf8")
  .replace(/^import type \{ HookContext \} from "\.\.\/_lib\/hook_context";\r?\n/m, "")
  .replace("ctx: HookContext", "ctx: any");
if (source.includes("HookContext")) throw new Error("The hook still depends on the catalog's type declarations");

delete hook.script;
hook.scriptContent = source;
process.stdout.write(`${JSON.stringify(script, null, 2)}\n`);
