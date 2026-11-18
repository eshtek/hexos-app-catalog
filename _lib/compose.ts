// Hand-synced mirror of hexos-platform packages/shared/eshtek/composeApps.ts: the compose subset
// a version-7 install script may use. The catalog is public and the platform private, so CI cannot
// import the real one; keep the two in step, as contract.ts is kept.

/**
 * Install scripts with several containers (version 7). Their `app_values` is a compose document
 * that the box installs as one TrueNAS custom app (`custom_app` with `custom_compose_config`), so
 * the owner sees one app however many containers it runs.
 *
 * Only a subset of compose is allowed. Everything an app keeps must sit in a host folder its
 * script creates, because TrueNAS removes every Docker volume of a compose app on `app.delete`
 * (`remove_volumes=True`), and HexOS's uninstall planner only sees folders a script names.
 */

/** The install-script version whose `app_values` is a compose document. */
export const COMPOSE_SCRIPT_VERSION = 7;

/** At most this many containers in one app. */
export const COMPOSE_MAX_SERVICES = 8;

const SERVICE_KEYS = new Set([
    'image',
    'environment',
    'volumes',
    'ports',
    'depends_on',
    'restart',
    'stdin_open',
    'tty',
    'command',
    'entrypoint',
    'user',
    'healthcheck',
    'deploy',
]);

/** Named so the refusal says why: a fixed name collides on a second copy, the rest reach past the app. */
const REFUSED_SERVICE_KEYS: Record<string, string> = {
    container_name: 'a fixed container name collides when the app is installed twice',
    network_mode: 'every container stays on the app’s own network',
    networks: 'every container stays on the app’s own network',
    devices: 'devices and graphics cards are not supported in apps with several containers',
    cap_add: 'added capabilities are not allowed',
    volumes_from: 'volumes are not allowed',
    pid: 'sharing the host’s processes is not allowed',
    ipc: 'sharing the host’s memory is not allowed',
};

const TOP_LEVEL_KEYS = new Set(['services', 'x-portals', 'x-notes']);
const RESTART_POLICIES = new Set(['no', 'always', 'unless-stopped', 'on-failure']);
const DEPENDS_CONDITIONS = new Set(['service_started', 'service_healthy', 'service_completed_successfully']);
const HEALTHCHECK_KEYS = new Set([
    'test',
    'interval',
    'timeout',
    'retries',
    'start_period',
    'start_interval',
    'disable',
]);
const SERVICE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const PORT_MACRO = /^\$PORT\((\d{1,5})\)$/;

export interface ComposeBind {
    service: string;
    hostPath: string;
    mountPath: string;
    readOnly: boolean;
}

export interface ComposePort {
    service: string;
    /** A number, or `$PORT(n)` in a script not yet processed. */
    published: number | string;
    target: number;
    protocol: 'tcp' | 'udp';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

const isPortNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;

/** Whether a script is one of these: version 7, or a value that is a compose document. */
export function isComposeScript(script: unknown): boolean {
    return isRecord(script) && script.version === COMPOSE_SCRIPT_VERSION;
}

/** Whether an app's values (a script's, or TrueNAS's live config) are a compose document. */
export function isComposeDocument(values: unknown): values is { services: Record<string, unknown> } {
    return isRecord(values) && isRecord(values.services);
}

/** Whether a script's hooks and widgets read as version 6's: versions 6 and 7 share them. */
export function usesV6Hooks(script: unknown): boolean {
    return isRecord(script) && (script.version === 6 || script.version === COMPOSE_SCRIPT_VERSION);
}

/** A bind's host side: a host path as written, `/mnt/x:/data:ro` or `{ type: bind, source, target }`. */
function parseBind(entry: unknown): { hostPath: string; mountPath: string; readOnly: boolean } | null {
    if (typeof entry === 'string') {
        const parts = entry.split(':');
        if (parts.length < 2 || parts.length > 3) return null;
        const [hostPath = '', mountPath = '', mode] = parts;
        if (mode !== undefined && mode !== 'ro' && mode !== 'rw') return null;
        // Compose reads a source that isn't a path as a volume's name
        if (!/^[/.~$]/.test(hostPath)) return null;
        return { hostPath, mountPath, readOnly: mode === 'ro' };
    }
    if (
        isRecord(entry) &&
        entry.type === 'bind' &&
        typeof entry.source === 'string' &&
        typeof entry.target === 'string'
    ) {
        return { hostPath: entry.source, mountPath: entry.target, readOnly: entry.read_only === true };
    }
    return null;
}

/** Every host folder a compose document binds, by service. A tmpfs mount binds none. */
export function composeBinds(values: unknown): ComposeBind[] {
    if (!isComposeDocument(values)) return [];
    const binds: ComposeBind[] = [];
    for (const [service, definition] of Object.entries(values.services)) {
        if (!isRecord(definition) || !Array.isArray(definition.volumes)) continue;
        for (const entry of definition.volumes) {
            const bind = parseBind(entry);
            if (bind) binds.push({ service, ...bind });
        }
    }
    return binds;
}

/** Every port a compose document publishes, in its long form. */
export function composePorts(values: unknown): ComposePort[] {
    if (!isComposeDocument(values)) return [];
    const ports: ComposePort[] = [];
    for (const [service, definition] of Object.entries(values.services)) {
        if (!isRecord(definition) || !Array.isArray(definition.ports)) continue;
        for (const entry of definition.ports) {
            if (!isRecord(entry) || !isPortNumber(entry.target)) continue;
            const published = entry.published;
            if (!isPortNumber(published) && !(typeof published === 'string' && PORT_MACRO.test(published))) continue;
            ports.push({
                service,
                published,
                target: entry.target,
                protocol: entry.protocol === 'udp' ? 'udp' : 'tcp',
            });
        }
    }
    return ports;
}

/**
 * A host path as the subset allows it: absolute once processed, absolute or `$LOCATION()` before.
 * Never relative, `${VAR}` or `..`, since the uninstall planner reads literal paths only.
 */
function hostPathProblem(path: string, processed: boolean): string | null {
    if (path.includes('${') || /\$[A-Za-z_{]/.test(path.replace(/\$[A-Z_]+\([^)]*\)/g, ''))) {
        return 'uses a variable, which HexOS can’t read';
    }
    if (path.split('/').includes('..')) return 'climbs out of its folder with ..';
    if (processed) {
        if (!path.startsWith('/')) return 'is not an absolute path';
        if (path.includes('$')) return 'still holds a macro';
        if (!path.startsWith('/mnt/')) return 'is not in a pool';
        return null;
    }
    if (!path.startsWith('/') && !path.startsWith('$LOCATION(')) return 'is not an absolute path or a $LOCATION() path';
    return null;
}

function servicePortsProblems(service: string, ports: unknown, problems: string[]): void {
    if (!Array.isArray(ports)) {
        problems.push(`${service}: ports must be a list`);
        return;
    }
    for (const entry of ports) {
        if (!isRecord(entry)) {
            problems.push(`${service}: write each port as { target, published, protocol }, not as text`);
            continue;
        }
        for (const key of Object.keys(entry)) {
            if (!['target', 'published', 'protocol'].includes(key)) {
                problems.push(`${service}: a port can't set ${key}`);
            }
        }
        if (!isPortNumber(entry.target)) problems.push(`${service}: a port's target must be a port number`);
        const published = entry.published;
        if (!isPortNumber(published) && !(typeof published === 'string' && PORT_MACRO.test(published))) {
            problems.push(`${service}: a port's published must be $PORT(n) or a port number`);
        }
        if (entry.protocol !== undefined && entry.protocol !== 'tcp' && entry.protocol !== 'udp') {
            problems.push(`${service}: a port's protocol must be tcp or udp`);
        }
    }
}

function serviceVolumesProblems(service: string, volumes: unknown, processed: boolean, problems: string[]): void {
    if (!Array.isArray(volumes)) {
        problems.push(`${service}: volumes must be a list`);
        return;
    }
    for (const entry of volumes) {
        if (isRecord(entry) && entry.type === 'tmpfs' && typeof entry.target === 'string') continue;
        const bind = parseBind(entry);
        if (!bind) {
            problems.push(
                `${service}: ${JSON.stringify(entry)} is not a host folder bind. Named volumes are refused, because TrueNAS deletes them on every uninstall`,
            );
            continue;
        }
        const problem = hostPathProblem(bind.hostPath, processed);
        if (problem) problems.push(`${service}: the bind ${bind.hostPath} ${problem}`);
        if (!bind.mountPath.startsWith('/'))
            problems.push(`${service}: the bind target ${bind.mountPath} is not absolute`);
    }
}

function serviceDependsProblems(service: string, dependsOn: unknown, names: Set<string>, problems: string[]): void {
    const check = (name: string) => {
        if (!names.has(name)) problems.push(`${service}: depends on ${name}, which isn't a service here`);
        if (name === service) problems.push(`${service}: depends on itself`);
    };
    if (Array.isArray(dependsOn)) {
        for (const name of dependsOn) {
            if (typeof name === 'string') check(name);
            else problems.push(`${service}: depends_on lists something that isn't a service name`);
        }
        return;
    }
    if (!isRecord(dependsOn)) {
        problems.push(`${service}: depends_on must be a list or a map`);
        return;
    }
    for (const [name, condition] of Object.entries(dependsOn)) {
        check(name);
        if (!isRecord(condition) || !DEPENDS_CONDITIONS.has(String(condition.condition))) {
            problems.push(`${service}: depends_on ${name} needs a condition of ${[...DEPENDS_CONDITIONS].join(', ')}`);
        }
    }
}

function serviceDeployProblems(service: string, deploy: unknown, problems: string[]): void {
    const limits = isRecord(deploy) && isRecord(deploy.resources) ? deploy.resources.limits : undefined;
    const onlyLimits =
        isRecord(deploy) &&
        Object.keys(deploy).every((key) => key === 'resources') &&
        isRecord(deploy.resources) &&
        Object.keys(deploy.resources).every((key) => key === 'limits') &&
        isRecord(limits) &&
        Object.keys(limits).every((key) => key === 'cpus' || key === 'memory');
    if (!onlyLimits) problems.push(`${service}: deploy may only set resources.limits.cpus and resources.limits.memory`);
}

/**
 * What's wrong with a compose document as an app's values, as sentences; empty when it's allowed.
 * `processed` is true once the box has filled in its macros.
 */
export function composeDocumentProblems(
    values: unknown,
    { processed, opticalDrives = false }: { processed: boolean; opticalDrives?: boolean },
): string[] {
    const problems: string[] = [];
    if (!isComposeDocument(values)) return ['app_values must be a compose document with services'];
    for (const key of Object.keys(values)) {
        if (!TOP_LEVEL_KEYS.has(key)) problems.push(`app_values can't set ${key}`);
    }
    const names = new Set(Object.keys(values.services));
    if (names.size === 0) problems.push('app_values has no services');
    if (names.size > COMPOSE_MAX_SERVICES) problems.push(`app_values has more than ${COMPOSE_MAX_SERVICES} services`);

    for (const [service, definition] of Object.entries(values.services)) {
        if (!SERVICE_NAME.test(service))
            problems.push(`${service}: a service name is lowercase letters, digits, - and _`);
        if (!isRecord(definition)) {
            problems.push(`${service}: must be a map`);
            continue;
        }
        for (const key of Object.keys(definition)) {
            // The platform lets the catalog's own script run a privileged container when it asks for
            // the server's optical drives (requirements.optical_drives), and refuses it in every other
            if (key === 'privileged') {
                if (!opticalDrives)
                    problems.push(
                        `${service}: privileged is refused, a privileged container is only for an app that needs the server’s optical drives (requirements.optical_drives)`,
                    );
                else if (definition.privileged !== true) problems.push(`${service}: privileged must be true or left out`);
            } else if (REFUSED_SERVICE_KEYS[key])
                problems.push(`${service}: ${key} is refused, ${REFUSED_SERVICE_KEYS[key]}`);
            else if (!SERVICE_KEYS.has(key)) problems.push(`${service}: ${key} is not allowed`);
        }
        if (typeof definition.image !== 'string' || definition.image.trim() === '') {
            problems.push(`${service}: needs an image`);
        }
        if (definition.environment !== undefined) {
            const env = definition.environment;
            if (!isRecord(env)) problems.push(`${service}: environment must be a map of names to values`);
            else {
                for (const [name, value] of Object.entries(env)) {
                    if (!['string', 'number', 'boolean'].includes(typeof value)) {
                        problems.push(`${service}: environment ${name} must be text, a number or true/false`);
                    }
                }
            }
        }
        if (definition.volumes !== undefined) serviceVolumesProblems(service, definition.volumes, processed, problems);
        if (definition.ports !== undefined) servicePortsProblems(service, definition.ports, problems);
        if (definition.depends_on !== undefined)
            serviceDependsProblems(service, definition.depends_on, names, problems);
        if (definition.restart !== undefined && !RESTART_POLICIES.has(String(definition.restart))) {
            problems.push(`${service}: restart must be one of ${[...RESTART_POLICIES].join(', ')}`);
        }
        if (definition.healthcheck !== undefined) {
            if (!isRecord(definition.healthcheck)) problems.push(`${service}: healthcheck must be a map`);
            else {
                for (const key of Object.keys(definition.healthcheck)) {
                    if (!HEALTHCHECK_KEYS.has(key)) problems.push(`${service}: healthcheck can't set ${key}`);
                }
            }
        }
        if (definition.deploy !== undefined) serviceDeployProblems(service, definition.deploy, problems);
    }

    const portals = (values as Record<string, unknown>)['x-portals'];
    if (portals !== undefined) {
        if (!Array.isArray(portals)) problems.push('x-portals must be a list');
        else {
            for (const portal of portals) {
                const port = isRecord(portal) ? portal.port : undefined;
                if (!isPortNumber(port) && !(typeof port === 'string' && PORT_MACRO.test(port))) {
                    problems.push('each x-portals entry needs a port');
                }
            }
        }
    }
    return problems;
}

/**
 * Binds that no folder the script creates holds. The uninstall planner claims an app's folders from
 * its script while TrueNAS can't list the app, so a folder only its compose binds would go unclaimed
 * there, and another app's uninstall could delete it. A bare location never counts as holding one.
 */
export function bindsOutsideEnsuredFolders(script: unknown): ComposeBind[] {
    if (!isRecord(script)) return [];
    const entries = Array.isArray(script.ensure_directories_exists) ? script.ensure_directories_exists : [];
    const ensured = entries
        .map((entry) => (isRecord(entry) && typeof entry.path === 'string' ? entry.path.replace(/\/+$/, '') : null))
        .filter((path): path is string => !!path && !/^\$LOCATION\([^)]*\)$/.test(path));
    return composeBinds(script.app_values).filter(({ hostPath }) => {
        const path = hostPath.replace(/\/+$/, '');
        return !ensured.some((folder) => path === folder || path.startsWith(`${folder}/`));
    });
}

/**
 * A processed compose document as TrueNAS gets it. `$MEMORY()` gives megabytes, where compose
 * reads a bare number as bytes, so a number becomes `<n>M`. A `$` in text the container reads
 * (environment, command, entrypoint, healthcheck) is doubled, so compose passes it through
 * rather than reading it as a variable of the host's.
 */
export function composeForTrueNAS(values: Record<string, unknown>): Record<string, unknown> {
    const document = structuredClone(values) as { services: Record<string, Record<string, unknown>> };
    const escapeDollars = (value: unknown): unknown => {
        if (typeof value === 'string') return value.replace(/\$/g, '$$$$');
        if (Array.isArray(value)) return value.map(escapeDollars);
        return value;
    };
    for (const definition of Object.values(document.services)) {
        if (!isRecord(definition)) continue;
        if (isRecord(definition.environment)) {
            definition.environment = Object.fromEntries(
                Object.entries(definition.environment).map(([name, value]) => [name, escapeDollars(value)]),
            );
        }
        for (const key of ['command', 'entrypoint'] as const) {
            if (definition[key] !== undefined) definition[key] = escapeDollars(definition[key]);
        }
        if (isRecord(definition.healthcheck) && definition.healthcheck.test !== undefined) {
            definition.healthcheck.test = escapeDollars(definition.healthcheck.test);
        }
        const limits =
            isRecord(definition.deploy) && isRecord(definition.deploy.resources)
                ? definition.deploy.resources.limits
                : undefined;
        if (isRecord(limits) && typeof limits.memory === 'number') limits.memory = `${limits.memory}M`;
    }
    return document;
}

/**
 * A compose script's new document with the live app's binds it would drop put back, on the same
 * service, where the new document has nothing at that container path. A script update never takes
 * a folder away from a running app unless the owner asked for a reset, as a chart's update keeps
 * its live mounts. A service the new document no longer has keeps nothing: its container is gone.
 */
export function keepLiveComposeBinds(next: Record<string, unknown>, live: unknown): Record<string, unknown> {
    if (!isComposeDocument(next) || !isComposeDocument(live)) return next;
    const merged = structuredClone(next) as { services: Record<string, Record<string, unknown>> };
    for (const bind of composeBinds(live)) {
        const service = merged.services[bind.service];
        if (!isRecord(service)) continue;
        const volumes = Array.isArray(service.volumes) ? service.volumes : [];
        const target = bind.mountPath.replace(/\/+$/, '');
        const taken = volumes.some((entry) => {
            const mounted = parseBind(entry)?.mountPath ?? (isRecord(entry) ? entry.target : undefined);
            return typeof mounted === 'string' && mounted.replace(/\/+$/, '') === target;
        });
        if (taken) continue;
        service.volumes = [
            ...volumes,
            { type: 'bind', source: bind.hostPath, target: bind.mountPath, read_only: bind.readOnly },
        ];
    }
    return merged;
}

/**
 * What's wrong with a whole version-7 script, as sentences: its compose document, a bind no folder
 * of the script holds, and anything that asks for a graphics card or a display, which apps with
 * several containers don't support yet.
 */
export function composeScriptProblems(script: unknown, { processed }: { processed: boolean }): string[] {
    if (!isRecord(script)) return ['the script is not an object'];
    const asks = (script as { requirements?: { optical_drives?: unknown } }).requirements;
    const problems = composeDocumentProblems(script.app_values, { processed, opticalDrives: asks?.optical_drives === true });
    for (const bind of bindsOutsideEnsuredFolders(script)) {
        problems.push(`${bind.service}: ${bind.hostPath} is bound but not among the folders the script creates`);
    }
    const requirements = isRecord(script.requirements) ? script.requirements : {};
    const specifications = Array.isArray(requirements.specifications) ? requirements.specifications : [];
    if (requirements.gpu !== undefined || requirements.gpu_hook !== undefined || specifications.includes('GPU')) {
        problems.push('apps with several containers can’t ask for a graphics card');
    }
    if (specifications.includes('DISPLAY')) problems.push('apps with several containers can’t draw on a display');
    if (/\$(GPU_CONFIG|DISPLAY_[A-Z_]+)\(/.test(JSON.stringify(script.app_values ?? null))) {
        problems.push('apps with several containers can’t use the graphics card or display macros');
    }
    return problems;
}
