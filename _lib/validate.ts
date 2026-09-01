// Catalog validator. Every check here corresponds to a way an install script
// can be accepted by GitHub and still fail on a user's box: unparseable JSON,
// a version the backend no longer understands, a $LOCATION the resolver will
// throw on, a $QUESTION with no question behind it, an icon path that 404s.
//
// Run: bun run validate

import { readdirSync, existsSync, statSync } from "node:fs";
import {
  BARE_MACROS,
  CALL_MACROS,
  HOOK_CONDITION_ROLES,
  HOOK_CONDITION_TYPES,
  HOOK_EVENT_SPECS,
  HOOK_EVENTS,
  HOOK_KINDS,
  HOOK_RERUNS,
  HOOK_SURFACES,
  HOOK_TARGET_TYPES,
  LOCATIONS,
  PERMISSIONS,
  QUESTION_TYPES,
  SPEC_REGEX,
  SUPPORTED_VERSIONS,
  SUPPORTED_WIDGETS_SCHEMA,
  WIDGET_SLOT_TYPES,
} from "./contract";

type Problem = { file: string; message: string };

const errors: Problem[] = [];
const warnings: Problem[] = [];

const err = (file: string, message: string) => errors.push({ file, message });
const warn = (file: string, message: string) => warnings.push({ file, message });

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Every string leaf in the document, with a dotted path for error messages. */
function* strings(value: unknown, path = ""): Generator<{ path: string; value: string }> {
  if (typeof value === "string") {
    yield { path, value };
  } else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) yield* strings(v, `${path}[${i}]`);
  } else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) yield* strings(v, path ? `${path}.${k}` : k);
  }
}

/**
 * A referenced file must exist and must sit inside the repo. Catalog assets are
 * fetched by relative path from the raw GitHub URL, so a leading slash or a
 * `../` escape resolves somewhere that is not the catalog.
 */
function checkAssetPath(file: string, field: string, value: string) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return; // absolute URL, not our asset
  if (value.startsWith("/")) {
    err(file, `${field}: "${value}" is an absolute path; asset paths are relative to the repo root`);
    return;
  }
  if (value.split("/").includes("..")) {
    err(file, `${field}: "${value}" escapes the repository`);
    return;
  }
  if (!existsSync(value) || !statSync(value).isFile()) {
    err(file, `${field}: "${value}" does not exist in the repository`);
  }
}

function checkCondition(file: string, where: string, cond: unknown) {
  if (!isObject(cond)) {
    err(file, `${where}: must be an object`);
    return;
  }
  if (typeof cond.role !== "string" || !(HOOK_CONDITION_ROLES as readonly string[]).includes(cond.role)) {
    err(file, `${where}: role must be "visibility" or "availability"`);
  }
  if (typeof cond.type !== "string" || !cond.type.trim()) {
    err(file, `${where}: type is missing`);
    return;
  }
  if ((HOOK_CONDITION_TYPES as readonly string[]).includes(cond.type)) {
    if (cond.type === "appInstalled" || cond.type === "appRunning") {
      if (typeof cond.app !== "string" || !cond.app.trim()) {
        err(file, `${where}: ${cond.type} condition requires an app name`);
      }
    }
    if (cond.type === "appVersion") {
      if (typeof cond.app !== "string" || !cond.app.trim()) {
        err(file, `${where}: appVersion condition requires an app name`);
      }
      if (typeof cond.range !== "string" || !cond.range.trim()) {
        err(file, `${where}: appVersion condition requires a range`);
      }
    }
    if (cond.type === "capabilityPresent") {
      if (typeof cond.capability !== "string" || !cond.capability.trim()) {
        err(file, `${where}: capabilityPresent condition requires a capability name`);
      }
    }
    if (cond.type === "script") {
      if (typeof cond.script !== "string" || !cond.script.trim()) {
        err(file, `${where}: script condition requires a script path`);
      } else {
        checkAssetPath(file, `${where}.script`, cond.script);
      }
    }
  }
}

function checkMacros(file: string, script: unknown, questionKeys: Set<string>) {
  const raw = JSON.stringify(script);

  // A macro name we do not know is almost always a typo. It survives install
  // untouched and lands in the container as a literal "$LOCATIN(...)".
  for (const match of raw.matchAll(/\$([A-Z_]{3,})/g)) {
    const name = match[1];
    const followedByParen = raw[match.index! + match[0].length] === "(";
    if (followedByParen) {
      if (!(CALL_MACROS as readonly string[]).includes(name)) {
        err(file, `unknown macro $${name}()`);
      }
    } else if (!(BARE_MACROS as readonly string[]).includes(name)) {
      // $LOCATION with no argument list is the same typo class.
      if ((CALL_MACROS as readonly string[]).includes(name)) {
        err(file, `$${name} is used without an argument list`);
      } else {
        err(file, `unknown macro $${name}`);
      }
    }
  }

  // replaceLocation() throws PROCESS_INSTALL_SCRIPT_UNKNOWN_LOCATION on any
  // name outside LocationPreferenceId, which aborts the whole install.
  for (const match of raw.matchAll(/\$LOCATION\(([^)]+)\)/g)) {
    const name = match[1].trim();
    if (!(LOCATIONS as readonly string[]).includes(name)) {
      err(file, `$LOCATION(${name}) is not a known location`);
    }
  }

  // A $QUESTION with no declaration behind it resolves to nothing.
  for (const match of raw.matchAll(/\$QUESTION\(([^)]+)\)/g)) {
    const key = match[1].trim().replace(/^["']|["']$/g, "").split(",")[0].trim();
    if (!questionKeys.has(key)) {
      err(file, `$QUESTION(${key}) has no matching question key`);
    }
  }

  // Unbalanced parentheses make the tokenizer consume to end-of-input.
  for (const name of CALL_MACROS) {
    for (const match of raw.matchAll(new RegExp(`\\$${name}\\(`, "g"))) {
      let depth = 0;
      let closed = false;
      for (let i = match.index! + match[0].length - 1; i < raw.length; i++) {
        if (raw[i] === "(") depth++;
        else if (raw[i] === ")" && --depth === 0) { closed = true; break; }
      }
      if (!closed) err(file, `$${name}( is never closed`);
    }
  }
}

function validate(file: string, script: Record<string, unknown>) {
  const version = script.version;
  if (typeof version !== "number") {
    err(file, "version is missing or not a number");
    return;
  }
  if (!(SUPPORTED_VERSIONS as readonly number[]).includes(version)) {
    err(
      file,
      `version ${version} is not parsed by the backend (supported: ${SUPPORTED_VERSIONS.join(", ")})`,
    );
    return;
  }

  // --- script block (required from v4 on) ---
  const scriptMeta = script.script;
  if (!isObject(scriptMeta)) {
    err(file, "script block is missing");
  } else if (typeof scriptMeta.version !== "string") {
    err(file, "script.version is missing");
  }

  // --- requirements (required from v4 on) ---
  const req = script.requirements;
  const declaredLocations = new Set<string>();
  if (!isObject(req)) {
    err(file, "requirements block is missing");
  } else {
    for (const key of ["permissions", "specifications", "locations", "ports"]) {
      if (!Array.isArray(req[key])) err(file, `requirements.${key} must be an array`);
    }
    for (const spec of (req.specifications as unknown[]) ?? []) {
      if (typeof spec !== "string" || !SPEC_REGEX.test(spec)) {
        err(file, `requirements.specifications: "${String(spec)}" is not a valid spec`);
      }
    }
    for (const perm of (req.permissions as unknown[]) ?? []) {
      if (typeof perm !== "string" || !(PERMISSIONS as readonly string[]).includes(perm)) {
        err(file, `requirements.permissions: "${String(perm)}" is not a known permission`);
      }
    }
    for (const loc of (req.locations as unknown[]) ?? []) {
      if (typeof loc !== "string" || !(LOCATIONS as readonly string[]).includes(loc)) {
        err(file, `requirements.locations: "${String(loc)}" is not a known location`);
      } else {
        declaredLocations.add(loc);
      }
    }
    for (const port of (req.ports as unknown[]) ?? []) {
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
        err(file, `requirements.ports: "${String(port)}" is not a valid port`);
      }
    }
  }

  // --- metadata and its assets ---
  const metadata = script.metadata;
  if (isObject(metadata)) {
    for (const key of ["name", "description", "icon", "version"]) {
      if (typeof metadata[key] !== "string" || !(metadata[key] as string).trim()) {
        err(file, `metadata.${key} is missing`);
      }
    }
    if (typeof metadata.icon === "string") checkAssetPath(file, "metadata.icon", metadata.icon);
    for (const [i, shot] of ((metadata.screenshots as unknown[]) ?? []).entries()) {
      if (typeof shot === "string") checkAssetPath(file, `metadata.screenshots[${i}]`, shot);
    }
  }

  // --- questions ---
  const questionKeys = new Set<string>();
  const collectQuestion = (q: unknown, where: string, scopeKeys?: Set<string>) => {
    if (!isObject(q)) return;
    const key = q.key;
    if (typeof key !== "string" || !key.trim()) {
      err(file, `${where}: question is missing a key`);
      return;
    }
    const dupeSet = scopeKeys ?? questionKeys;
    if (dupeSet.has(key)) err(file, `${where}: duplicate question key "${key}"`);
    dupeSet.add(key);
    questionKeys.add(key);
    if (typeof q.type !== "string" || !(QUESTION_TYPES as readonly string[]).includes(q.type)) {
      err(file, `${where}: question "${key}" has invalid type "${String(q.type)}"`);
    }
    if (q.type === "select") {
      const options = q.options;
      if (!Array.isArray(options) || options.length === 0) {
        err(file, `${where}: select question "${key}" has no options`);
      }
    }
  };

  for (const [i, q] of ((script.installation_questions as unknown[]) ?? []).entries()) {
    collectQuestion(q, `installation_questions[${i}]`);
  }

  // --- ensure_directories_exists ---
  for (const [i, entry] of ((script.ensure_directories_exists as unknown[]) ?? []).entries()) {
    const where = `ensure_directories_exists[${i}]`;
    if (!isObject(entry)) {
      err(file, `${where}: v${version} entries must be objects with a path`);
      continue;
    }
    if (typeof entry.path !== "string" || !entry.path.trim()) {
      err(file, `${where}: path is missing`);
    }
    // owner accepts a bare username string as shorthand for { user }.
    if (entry.owner !== undefined) {
      if (typeof entry.owner === "string") {
        if (!entry.owner.trim()) err(file, `${where}.owner: username is empty`);
      } else if (!isObject(entry.owner)) {
        err(file, `${where}.owner: must be a username string or { "user": "apps" }`);
      } else {
        if (typeof entry.owner.user !== "string" || !entry.owner.user.trim()) {
          err(file, `${where}.owner.user is missing`);
        }
        if (entry.owner.group !== undefined && typeof entry.owner.group !== "string") {
          err(file, `${where}.owner.group must be a string`);
        }
      }
    }
    if (entry.snapshot !== undefined) {
      if (!isObject(entry.snapshot) || typeof entry.snapshot.id !== "string") {
        err(file, `${where}.snapshot: must be an object with an id`);
      }
    }
    if (entry.network_share !== undefined && typeof entry.network_share !== "boolean") {
      err(file, `${where}.network_share must be a boolean`);
    }
  }

  // --- app_values ---
  if (!isObject(script.app_values)) err(file, "app_values is missing");

  // --- hooks (v5 and v6) ---
  const hookIds = new Set<string>();
  for (const [i, hook] of ((script.hooks as unknown[]) ?? []).entries()) {
    const where = `hooks[${i}]`;
    if (!isObject(hook)) {
      err(file, `${where}: must be an object`);
      continue;
    }
    if (version !== 5 && version !== 6) err(file, `${where}: hooks require version 5 or 6`);
    const id = hook.id;
    if (typeof id !== "string" || !id.trim()) {
      err(file, `${where}: id is missing`);
    } else {
      if (hookIds.has(id)) err(file, `${where}: duplicate hook id "${id}"`);
      hookIds.add(id);
    }

    if (version === 6) {
      if (typeof hook.title !== "string" || !hook.title.trim()) {
        err(file, `${where}: title is missing`);
      }
      if (hook.kind !== undefined) {
        if (typeof hook.kind !== "string" || !(HOOK_KINDS as readonly string[]).includes(hook.kind)) {
          err(file, `${where}: kind "${String(hook.kind)}" is not a known hook kind`);
        }
      }
      // V5's singular field in a V6 entry is rejected by the backend — it
      // would otherwise silently turn a lifecycle hook into a user verb.
      if (hook.event !== undefined) {
        err(file, `${where}: v6 uses events (array) — found v5-style singular event`);
      }

      // Trigger analysis mirrors the backend's superRefine: absent events
      // defaults to ["userAction"], and several fields are legal only for
      // one firing class.
      const upgradeEvents = new Set(["onBeforeUpgrade", "onAfterUpgrade"]);
      const installEvents = new Set(["onBeforeInstall", "onAfterInstall"]);
      const eventKeys: string[] = [];
      let hasVersionGate = false;
      let eventsValid = true;
      if (hook.events !== undefined) {
        if (!Array.isArray(hook.events) || hook.events.length === 0) {
          err(file, `${where}: events must be a non-empty array`);
          eventsValid = false;
        } else {
          for (const [j, ev] of hook.events.entries()) {
            if (typeof ev === "string") {
              if (!(HOOK_EVENT_SPECS as readonly string[]).includes(ev)) {
                err(file, `${where}.events[${j}]: "${ev}" is not a known event spec`);
                eventsValid = false;
              } else {
                eventKeys.push(ev);
              }
            } else if (isObject(ev)) {
              const evName = ev.event;
              if (typeof evName !== "string" || !(HOOK_EVENT_SPECS as readonly string[]).includes(evName) || evName === "userAction") {
                err(file, `${where}.events[${j}]: event object must name a lifecycle event`);
                eventsValid = false;
                continue;
              }
              const extraKeys = Object.keys(ev).filter((k) => !["event", "from", "to"].includes(k));
              if (extraKeys.length > 0) {
                err(file, `${where}.events[${j}]: unknown keys ${extraKeys.join(", ")}`);
              }
              if ((ev.from !== undefined || ev.to !== undefined) && !upgradeEvents.has(evName)) {
                err(file, `${where}.events[${j}]: from/to gate upgrade transitions — legal on upgrade events only`);
              }
              if (ev.from !== undefined || ev.to !== undefined) hasVersionGate = true;
              eventKeys.push(evName);
            } else {
              err(file, `${where}.events[${j}]: must be a string or event object`);
              eventsValid = false;
            }
          }
        }
      } else {
        eventKeys.push("userAction");
      }
      const userTriggerable = eventKeys.includes("userAction");
      const lifecycleCount = eventKeys.filter((k) => k !== "userAction").length;
      const hasInstall = eventKeys.some((k) => installEvents.has(k));

      if (eventsValid) {
        const seen = new Map<string, number>();
        for (const k of eventKeys) seen.set(k, (seen.get(k) ?? 0) + 1);
        for (const [k, count] of seen) {
          if (count > 1) err(file, `${where}: duplicate trigger entries for "${k}"`);
        }
        const keys = [...seen.keys()];
        if (keys.filter((k) => installEvents.has(k)).length > 1) {
          err(file, `${where}: onBeforeInstall and onAfterInstall cannot share a declaration`);
        }
        if (keys.filter((k) => upgradeEvents.has(k)).length > 1) {
          err(file, `${where}: onBeforeUpgrade and onAfterUpgrade cannot share a declaration`);
        }
        if (hasVersionGate && userTriggerable) {
          err(file, `${where}: version-gated triggers cannot share a declaration with "userAction"`);
        }

        // rerun: required iff user-triggerable.
        if (hook.rerun === undefined) {
          if (userTriggerable) err(file, `${where}: rerun is required on user-triggerable hooks`);
        } else {
          if (typeof hook.rerun !== "string" || !(HOOK_RERUNS as readonly string[]).includes(hook.rerun)) {
            err(file, `${where}: rerun "${String(hook.rerun)}" is not a known rerun mode`);
          }
          if (!userTriggerable) err(file, `${where}: rerun applies to user firings only`);
        }
        if (hook.optional !== undefined && lifecycleCount === 0) {
          err(file, `${where}: optional requires a lifecycle trigger`);
        }
        if (hook.userOptional !== undefined) {
          if (!hasInstall) {
            err(file, `${where}: userOptional requires an install trigger (onBeforeInstall/onAfterInstall)`);
          }
          if (!isObject(hook.userOptional)) {
            err(file, `${where}: userOptional must be an object`);
          } else if (hook.userOptional.link !== undefined) {
            const link = hook.userOptional.link;
            if (!isObject(link) || typeof link.url !== "string" || !/^https?:\/\//.test(link.url) || typeof link.label !== "string" || !link.label.trim()) {
              err(file, `${where}: userOptional.link needs a valid url and a label`);
            }
          }
        }
        if (hook.target !== undefined && lifecycleCount > 0) {
          err(file, `${where}: file-targeted hooks are user-fired only`);
        }
      }

      if (hook.surfaces !== undefined) {
        if (!Array.isArray(hook.surfaces) || hook.surfaces.length === 0) {
          err(file, `${where}: surfaces must be a non-empty array`);
        } else {
          for (const s of hook.surfaces) {
            if (typeof s !== "string" || !(HOOK_SURFACES as readonly string[]).includes(s)) {
              err(file, `${where}: surface "${String(s)}" is not known`);
            }
          }
        }
      }
      if (hook.conditions !== undefined) {
        if (!Array.isArray(hook.conditions)) {
          err(file, `${where}: conditions must be an array`);
        } else {
          for (const [j, cond] of hook.conditions.entries()) {
            checkCondition(file, `${where}.conditions[${j}]`, cond);
          }
        }
      }
      if (hook.target !== undefined) {
        if (!isObject(hook.target)) {
          err(file, `${where}: target must be an object`);
        } else {
          if (typeof hook.target.type !== "string" || !(HOOK_TARGET_TYPES as readonly string[]).includes(hook.target.type)) {
            err(file, `${where}: target.type "${String(hook.target.type)}" is not known`);
          }
          if (hook.target.type === "files") {
            if (!Array.isArray(hook.target.accepts) || hook.target.accepts.length === 0) {
              err(file, `${where}: target.accepts must be a non-empty array of extensions`);
            } else {
              for (const ext of hook.target.accepts) {
                if (typeof ext !== "string" || !/^\.[a-z0-9]+$/i.test(ext)) {
                  err(file, `${where}: target.accepts "${String(ext)}" — extensions are dot-prefixed (e.g. ".mkv")`);
                }
              }
            }
            if (hook.target.maxFiles !== undefined && (typeof hook.target.maxFiles !== "number" || !Number.isInteger(hook.target.maxFiles) || hook.target.maxFiles <= 0)) {
              err(file, `${where}: target.maxFiles must be a positive integer`);
            }
            if (hook.target.requiresTargetMount !== undefined && typeof hook.target.requiresTargetMount !== "boolean") {
              err(file, `${where}: target.requiresTargetMount must be a boolean`);
            }
          }
        }
      }
      if (hook.requiresHooks !== undefined) {
        if (!Array.isArray(hook.requiresHooks) || hook.requiresHooks.length > 8) {
          err(file, `${where}: requiresHooks must be an array of at most 8 hook ids`);
        }
      }
      if (hook.retries !== undefined && (typeof hook.retries !== "number" || !Number.isInteger(hook.retries) || hook.retries < 0)) {
        err(file, `${where}: retries must be a non-negative integer`);
      }
    } else {
      if (typeof hook.event !== "string" || !(HOOK_EVENTS as readonly string[]).includes(hook.event)) {
        err(file, `${where}: event "${String(hook.event)}" is not a known hook event`);
      }
    }

    const hasFile = typeof hook.script === "string" && hook.script.trim().length > 0;
    const hasInline = typeof hook.scriptContent === "string" && hook.scriptContent.trim().length > 0;
    if (!hasFile && !hasInline) {
      err(file, `${where}: needs either script or scriptContent`);
    } else if (hasFile && hasInline) {
      err(file, `${where}: declares both script and scriptContent`);
    } else if (hasFile) {
      checkAssetPath(file, `${where}.script`, hook.script as string);
    }
    if (typeof hook.entrypoint !== "string" || !hook.entrypoint.trim()) {
      err(file, `${where}: entrypoint is missing`);
    }
    if (hook.timeout !== undefined && (typeof hook.timeout !== "number" || hook.timeout <= 0)) {
      err(file, `${where}: timeout must be a positive number`);
    }
    const hookQuestionScope = version === 6 ? new Set<string>() : undefined;
    for (const [j, input] of ((hook.inputs as unknown[]) ?? []).entries()) {
      if (!isObject(input)) continue;
      if (input.type === "question") collectQuestion(input.question, `${where}.inputs[${j}]`, hookQuestionScope);
    }
  }

  // requiresHooks may forward-reference, so resolve after all ids are known.
  for (const [i, hook] of ((script.hooks as unknown[]) ?? []).entries()) {
    if (!isObject(hook) || !Array.isArray(hook.requiresHooks)) continue;
    for (const ref of hook.requiresHooks) {
      if (typeof ref === "string" && !hookIds.has(ref)) {
        err(file, `hooks[${i}]: requiresHooks references unknown hook id "${ref}"`);
      }
    }
  }

  // --- widgets (v6) ---
  if (script.widgets !== undefined) {
    if (version !== 6) err(file, "widgets require version 6");
    if (script.widgetsSchema !== undefined && script.widgetsSchema !== SUPPORTED_WIDGETS_SCHEMA) {
      err(file, `widgetsSchema ${script.widgetsSchema} is not supported (expected ${SUPPORTED_WIDGETS_SCHEMA})`);
    }
    if (!Array.isArray(script.widgets)) {
      err(file, "widgets must be an array");
    } else {
      const widgetIds = new Set<string>();
      for (const [i, widget] of script.widgets.entries()) {
        const where = `widgets[${i}]`;
        if (!isObject(widget)) {
          err(file, `${where}: must be an object`);
          continue;
        }
        const wid = widget.id;
        if (typeof wid !== "string" || !wid.trim()) {
          err(file, `${where}: id is missing`);
        } else {
          if (!/^[a-z0-9_-]+$/.test(wid)) {
            err(file, `${where}: id "${wid}" must be lowercase alphanumeric with hyphens/underscores`);
          }
          if (widgetIds.has(wid)) err(file, `${where}: duplicate widget id "${wid}"`);
          widgetIds.add(wid);
        }
        if (typeof widget.title !== "string" || !widget.title.trim()) {
          err(file, `${where}: title is missing`);
        }
        if (widget.refresh !== undefined) {
          if (typeof widget.refresh !== "number" || !Number.isInteger(widget.refresh) || widget.refresh <= 0) {
            err(file, `${where}: refresh must be a positive integer`);
          } else if (widget.refresh < 10) {
            warn(file, `${where}: refresh ${widget.refresh} is below the 10s floor — the platform clamps it to 10`);
          }
        }
        const hasFile = typeof widget.script === "string" && widget.script.trim().length > 0;
        const hasInline = typeof widget.scriptContent === "string" && widget.scriptContent.trim().length > 0;
        if (!hasFile && !hasInline) {
          err(file, `${where}: needs either script or scriptContent`);
        } else if (hasFile && hasInline) {
          err(file, `${where}: declares both script and scriptContent`);
        } else if (hasFile) {
          checkAssetPath(file, `${where}.script`, widget.script as string);
        }
        if (typeof widget.entrypoint !== "string" || !widget.entrypoint.trim()) {
          err(file, `${where}: entrypoint is missing`);
        }
        if (widget.timeout !== undefined && (typeof widget.timeout !== "number" || widget.timeout <= 0)) {
          err(file, `${where}: timeout must be a positive number`);
        }
        if (widget.conditions !== undefined) {
          if (!Array.isArray(widget.conditions)) {
            err(file, `${where}: conditions must be an array`);
          } else {
            for (const [j, cond] of widget.conditions.entries()) {
              checkCondition(file, `${where}.conditions[${j}]`, cond);
            }
          }
        }
        if (widget.sizes !== undefined) {
          if (!isObject(widget.sizes)) {
            err(file, `${where}: sizes must be an object`);
          } else {
            for (const sizeKey of ["small", "large"] as const) {
              const size = widget.sizes[sizeKey];
              if (size === undefined) continue;
              if (!isObject(size)) {
                err(file, `${where}.sizes.${sizeKey}: must be an object`);
                continue;
              }
              if (size.media !== undefined) {
                const placements = sizeKey === "small" ? ["top", "bottom"] : ["left", "right", "both"];
                if (!isObject(size.media) || typeof size.media.placement !== "string" || !placements.includes(size.media.placement)) {
                  err(file, `${where}.sizes.${sizeKey}.media: placement must be one of ${placements.join("/")}`);
                } else if (typeof size.media.field !== "string" || !size.media.field.trim()) {
                  err(file, `${where}.sizes.${sizeKey}.media: field is missing`);
                }
              }
              const slots = size.slots;
              if (!Array.isArray(slots) || slots.length === 0) {
                err(file, `${where}.sizes.${sizeKey}: slots must be a non-empty array`);
              } else {
                const maxSlots = sizeKey === "small" ? 3 : 4;
                if (slots.length > maxSlots) {
                  err(file, `${where}.sizes.${sizeKey}: max ${maxSlots} slots`);
                }
                for (const [k, slot] of slots.entries()) {
                  if (!isObject(slot)) continue;
                  if (typeof slot.type !== "string" || !(WIDGET_SLOT_TYPES as readonly string[]).includes(slot.type)) {
                    err(file, `${where}.sizes.${sizeKey}.slots[${k}]: type "${String(slot.type)}" is not known`);
                  }
                  if (typeof slot.field !== "string" || !slot.field.trim()) {
                    err(file, `${where}.sizes.${sizeKey}.slots[${k}]: field is missing`);
                  }
                }
              }
            }
          }
        }
        if (widget.buttons !== undefined) {
          if (!Array.isArray(widget.buttons)) {
            err(file, `${where}: buttons must be an array`);
          } else {
            if (widget.buttons.length > 4) err(file, `${where}: max 4 buttons`);
            const seen = new Set<string>();
            for (const btn of widget.buttons) {
              if (typeof btn !== "string") continue;
              if (seen.has(btn)) err(file, `${where}: duplicate button "${btn}"`);
              seen.add(btn);
              if (!hookIds.has(btn)) err(file, `${where}: button "${btn}" references unknown hook id`);
            }
          }
        }
      }
    }
  }

  checkMacros(file, script, questionKeys);

  // A location used by a macro but never declared still installs — the path
  // resolves — but HexOS never prompts for it, so the requirements screen and
  // the permission grant are both wrong.
  const used = new Set(
    [...JSON.stringify(script).matchAll(/\$LOCATION\(([^)]+)\)/g)].map((m) => m[1].trim()),
  );
  for (const loc of used) {
    if ((LOCATIONS as readonly string[]).includes(loc) && !declaredLocations.has(loc)) {
      warn(file, `$LOCATION(${loc}) is used but not declared in requirements.locations`);
    }
  }
}

// --- run ---

const files = readdirSync(".")
  .filter((f) => f.endsWith(".json"))
  .sort();

if (files.length === 0) {
  console.error("No install scripts found. Is the working directory the repo root?");
  process.exit(1);
}

for (const file of files) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Bun.file(file).text());
  } catch (cause) {
    err(file, `is not valid JSON: ${(cause as Error).message}`);
    continue;
  }
  if (!isObject(parsed)) {
    err(file, "top level must be an object");
    continue;
  }
  validate(file, parsed);
}

// Assets are cheap to orphan and invisible when they rot, so name the ones
// nothing points at rather than letting them accumulate.
const referenced = new Set<string>();
for (const file of files) {
  try {
    for (const { value } of strings(JSON.parse(await Bun.file(file).text()))) {
      if (value.includes("/") && !/^[a-z][a-z0-9+.-]*:/i.test(value) && existsSync(value)) {
        referenced.add(value);
      }
    }
  } catch { /* already reported as a parse error */ }
}

const group = (problems: Problem[]) => {
  const byFile = new Map<string, string[]>();
  for (const p of problems) {
    if (!byFile.has(p.file)) byFile.set(p.file, []);
    byFile.get(p.file)!.push(p.message);
  }
  return byFile;
};

for (const [file, messages] of group(warnings)) {
  console.log(`\n⚠ ${file}`);
  for (const m of messages) console.log(`    ${m}`);
}

for (const [file, messages] of group(errors)) {
  console.log(`\n✗ ${file}`);
  for (const m of messages) console.log(`    ${m}`);
}

console.log(
  `\n${files.length} install scripts checked — ` +
    `${errors.length} error(s), ${warnings.length} warning(s)`,
);

process.exit(errors.length > 0 ? 1 : 0);
