// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import { chownSync, existsSync, writeFileSync } from "node:fs";

import type { HookContext } from "../_lib/hook_context";

/**
 * Two settings OpenCloud reads only from files in its config folder, written before its first start.
 *
 * app-registry.yaml sets what the New menu creates. Upstream's list, in its order, except that the
 * office formats read two variables the install question fills in, so a change on the Settings tab
 * applies at the next start. OpenCloud's config loader expands "${VAR|default}" and reads T or F as
 * a boolean. The script passes T and F because HexOS would turn true and false into JSON booleans.
 *
 * web.yaml loads the Text Editor as an external app, the only way a core web app takes a config, so
 * its New menu entries can follow HEXOS_TEXT_EDITOR_NEW_FILES. A link to a web office sets that to
 * "md", which hides Note (.ocnote, a format only OpenCloud opens). Unset, the Text Editor keeps its
 * default. A core web app added by a later OpenCloud needs adding to CORE_APPS.
 *
 * Both are written once, so an owner's edits stay. Read at OpenCloud 9.0.
 */

/** The user the TrueNAS chart runs OpenCloud as. */
const APPS_UID = 568;

type Family = "open" | "microsoft" | boolean;
type MimeType = [mime: string, extension: string, name: string, description: string, create: Family];

const MIME_TYPES: MimeType[] = [
  ["application/pdf", "pdf", "PDF", "PDF document", false],
  ["application/vnd.oasis.opendocument.text", "odt", "Document", "OpenDocument text document", "open"],
  ["application/vnd.oasis.opendocument.spreadsheet", "ods", "Spreadsheet", "OpenDocument spreadsheet document", "open"],
  ["application/vnd.oasis.opendocument.presentation", "odp", "Presentation", "OpenDocument presentation document", "open"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx", "Microsoft Word", "Microsoft Word document", "microsoft"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.form", "docxf", "Form Document", "Form Document", false],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx", "Microsoft Excel", "Microsoft Excel document", "microsoft"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx", "Microsoft PowerPoint", "Microsoft PowerPoint document", "microsoft"],
  ["application/vnd.jupyter", "ipynb", "Jupyter Notebook", "Jupyter Notebook", false],
  ["text/markdown", "md", "Markdown file", "Markdown file", true],
  ["application/compressed-markdown", "zmd", "Compressed markdown file", "Compressed markdown file", false],
  ["application/vnd.geogebra.slides", "ggs", "GeoGebra Slides", "GeoGebra Slides", false],
];

/** OpenCloud's default core web apps, without the Text Editor. */
const CORE_APPS = ["files", "search", "pdf-viewer", "external", "admin-settings", "epub-reader", "preview", "app-store", "rclone-crypt"];

export function appRegistryYaml(): string {
  const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
  const allowCreation = (create: Family) => {
    if (create === "open") return '"${HEXOS_NEW_OPENDOCUMENT|F}"';
    if (create === "microsoft") return '"${HEXOS_NEW_MICROSOFT|T}"';
    return String(create);
  };
  const types = MIME_TYPES.map(([mime, extension, name, description, create]) =>
    [
      `    - mime_type: ${quote(mime)}`,
      `      extension: ${quote(extension)}`,
      `      name: ${quote(name)}`,
      `      description: ${quote(description)}`,
      `      icon: ''`,
      `      default_app: ''`,
      `      allow_creation: ${allowCreation(create)}`,
    ].join("\n"),
  ).join("\n");
  return `app_registry:\n  mimetypes:\n${types}\n`;
}

export function webYaml(): string {
  return [
    "web:",
    "  config:",
    `    apps: [${CORE_APPS.map((app) => `"${app}"`).join(", ")}]`,
    "    external_apps:",
    "      - id: web-app-text-editor",
    "        path: web-app-text-editor",
    "        config:",
    '          primaryExtensions: "${HEXOS_TEXT_EDITOR_NEW_FILES}"',
    "",
  ].join("\n");
}

function writeOnce(path: string, text: string): boolean {
  if (existsSync(path)) return false;
  writeFileSync(path, text, { mode: 0o640 });
  chownSync(path, APPS_UID, APPS_UID);
  return true;
}

export async function seedSettings(ctx: HookContext): Promise<void> {
  await ctx.registerCheckpoints([{ id: "settings", message: "Setting up the New menu" }]);
  const config = ctx.mounts.find((mount) => mount.hostPath.endsWith("/opencloud/config"));
  if (!config) ctx.fail("HexOS couldn't find OpenCloud's config folder");
  const registry = writeOnce(`${config.localPath}/app-registry.yaml`, appRegistryYaml());
  const web = writeOnce(`${config.localPath}/web.yaml`, webYaml());
  if (registry || web) await ctx.emitCheckpoint("settings");
  else await ctx.skipCheckpoint("settings", "Kept the New menu settings from before");
}
