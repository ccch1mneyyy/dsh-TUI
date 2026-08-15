/**
 * Workspace-target extension seam for terminal front doors.
 *
 * The TUI owns local URI parsing and session switching. Optional plugins add
 * providers for external schemes without coupling the TUI to them.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, isAbsolute, resolve } from 'node:path';
import { Service } from '@deepseek-ai/cordis';
export const name = 'dsh-tui-workspaces';
/** Registry and local fallback shared by the TUI and workspace plugins. */
export class TuiWorkspaceRuntime extends Service {
    providers = new Set();
    providerWaiters = new Set();
    constructor(ctx) {
        super(ctx, 'tuiWorkspaces');
    }
    register(provider) {
        this.providers.add(provider);
        this.notifyProviderWaiters();
        return () => {
            this.providers.delete(provider);
            this.notifyProviderWaiters();
        };
    }
    async list(currentCwd, signal) {
        signal?.throwIfAborted();
        const targets = new Map();
        for (const provider of this.providers) {
            try {
                for (const target of await provider.list(signal))
                    targets.set(target.uri, this.withStoredTitle(target));
            }
            catch (error) {
                this.ctx.logger.warn(`dsh-tui: workspace provider list failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        // The official registry is the durable catalog. Provider-owned aliases
        // have already been added above with richer URI/badge metadata; remaining
        // records are ordinary local workspaces.
        for (const workspace of this.workspaceRegistry()?.list() ?? []) {
            if ([...targets.values()].some(target => sameCwd(target.cwd, workspace.path)))
                continue;
            targets.set(localWorkspaceUri(workspace.path), {
                ...localWorkspaceTarget(workspace.path),
                label: workspace.title,
            });
        }
        // The current local directory is always selectable, even in a bare TUI
        // composition without dsh-workspace or another provider.
        if (![...targets.values()].some(target => sameCwd(target.cwd, currentCwd))) {
            const local = localWorkspaceTarget(currentCwd);
            targets.set(local.uri, local);
        }
        return [...targets.values()].sort((left, right) => {
            if (left.kind !== right.kind)
                return left.kind === 'local' ? -1 : 1;
            return left.label.localeCompare(right.label);
        });
    }
    /** Resolve a URI, briefly allowing concurrently mounted providers to register. */
    async resolve(reference, currentCwd = process.cwd(), signal) {
        if (isAbsolute(reference))
            return localWorkspaceTarget(reference);
        const deadline = Date.now() + 5000;
        const scheme = uriScheme(reference);
        if (scheme === undefined) {
            const owner = [...this.providers].find((provider) => {
                try {
                    return provider.describe(currentCwd) !== undefined;
                }
                catch {
                    return false;
                }
            });
            if (owner !== undefined)
                return owner.resolvePath?.(reference, currentCwd, signal);
            return localWorkspaceTarget(resolve(currentCwd, reference));
        }
        const local = parseLocalWorkspaceReference(reference);
        if (local !== undefined)
            return local;
        for (;;) {
            signal?.throwIfAborted();
            const owners = [...this.providers].filter(provider => provider.schemes.some(candidate => candidate.toLowerCase() === scheme));
            for (const provider of owners) {
                const target = await provider.resolve(reference, signal);
                if (target !== undefined)
                    return target;
            }
            if (owners.length > 0)
                return undefined;
            if (Date.now() >= deadline)
                return undefined;
            await this.waitForProvider(Math.min(100, deadline - Date.now()), signal);
        }
    }
    describe(cwd) {
        for (const provider of this.providers) {
            let target;
            try {
                target = provider.describe(cwd);
            }
            catch (error) {
                this.ctx.logger.warn(`dsh-tui: workspace provider describe failed: ${error instanceof Error ? error.message : String(error)}`);
                continue;
            }
            if (target !== undefined)
                return this.withStoredTitle(target);
        }
        return this.withStoredTitle(localWorkspaceTarget(cwd));
    }
    async commandShell(cwd) {
        for (const provider of this.providers) {
            let shell;
            try {
                shell = await provider.commandShell?.(cwd);
            }
            catch (error) {
                this.ctx.logger.warn(`dsh-tui: workspace provider commandShell failed: ${error instanceof Error ? error.message : String(error)}`);
                continue;
            }
            if (shell !== undefined)
                return shell;
        }
        return undefined;
    }
    async rename(cwd, title) {
        const normalizedTitle = title.trim();
        if (normalizedTitle.length === 0)
            throw new Error('workspace title must not be empty');
        for (const provider of this.providers) {
            let owned = false;
            try {
                owned = provider.describe(cwd) !== undefined;
            }
            catch {
                continue;
            }
            if (!owned)
                continue;
            // A provider without rename (or returning undefined) falls through to
            // the local durable ledger below — the title stays visible everywhere
            // this runtime runs. A rename that THROWS propagates to the caller's
            // failure notification instead of silently writing a local record.
            const renamed = await provider.rename?.(cwd, normalizedTitle);
            if (renamed !== undefined)
                return this.withStoredTitle(renamed);
            break;
        }
        const registry = this.workspaceRegistry();
        if (registry === undefined)
            throw new Error('workspace registry is unavailable');
        const workspace = registry.list().find(candidate => sameCwd(candidate.path, cwd))
            ?? await registry.create(cwd, normalizedTitle);
        await workspace.setTitle(normalizedTitle);
        return { ...this.describe(cwd), label: normalizedTitle };
    }
    commands() {
        return [...this.providers].flatMap(provider => provider.commands ?? []).map(command => ({
            name: command.name,
            aliases: command.aliases,
            description: command.description,
        }));
    }
    async runCommand(name, input, cwd, signal) {
        const normalized = name.toLowerCase();
        for (const provider of this.providers) {
            const command = provider.commands?.find(candidate => candidate.name.toLowerCase() === normalized
                || candidate.aliases?.some(alias => alias.toLowerCase() === normalized));
            if (command !== undefined)
                return command.run(input, { cwd }, signal);
        }
        return undefined;
    }
    workspaceRegistry() {
        return this.ctx.get('workspaceRegistry');
    }
    withStoredTitle(target) {
        const workspace = this.workspaceRegistry()?.list().find(candidate => sameCwd(candidate.path, target.cwd));
        return workspace === undefined ? target : { ...target, label: workspace.title };
    }
    notifyProviderWaiters() {
        for (const waiter of this.providerWaiters)
            waiter();
        this.providerWaiters.clear();
    }
    waitForProvider(timeoutMs, signal) {
        if (timeoutMs <= 0)
            return Promise.resolve();
        return new Promise((resolveWait, reject) => {
            let settled = false;
            const finish = () => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
                this.providerWaiters.delete(finish);
                resolveWait();
            };
            const abort = () => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                this.providerWaiters.delete(finish);
                reject(signal?.reason instanceof Error ? signal.reason : new Error('workspace resolution aborted'));
            };
            const timer = setTimeout(finish, timeoutMs);
            this.providerWaiters.add(finish);
            signal?.addEventListener('abort', abort, { once: true });
        });
    }
}
/** Local-only fallback for direct embedders that call createChannel() without
 * mounting the optional workspace registry/provider service. */
export function createLocalWorkspaceRuntime() {
    return {
        async list(currentCwd) {
            return [localWorkspaceTarget(currentCwd)];
        },
        async resolve(reference, currentCwd = process.cwd()) {
            if (isAbsolute(reference))
                return localWorkspaceTarget(reference);
            const local = parseLocalWorkspaceReference(reference);
            if (local !== undefined)
                return local;
            if (uriScheme(reference) !== undefined)
                return undefined;
            return localWorkspaceTarget(resolve(currentCwd, reference));
        },
        describe(cwd) {
            return localWorkspaceTarget(cwd);
        },
        async commandShell() {
            return undefined;
        },
        async rename() {
            throw new Error('workspace registry is unavailable');
        },
        commands() {
            return [];
        },
        async runCommand() {
            return undefined;
        },
    };
}
export function localWorkspaceUri(path) {
    return pathToFileURL(resolve(path)).href;
}
/** Resolve a native absolute path or the standard file URL form. */
export function parseLocalWorkspaceReference(reference) {
    if (isAbsolute(reference))
        return localWorkspaceTarget(reference);
    let parsed;
    try {
        parsed = new URL(reference);
    }
    catch {
        return undefined;
    }
    if (parsed.protocol !== 'file:')
        return undefined;
    const cwd = fileURLToPath(parsed);
    if (!isAbsolute(cwd))
        throw new Error(`file workspace URI must resolve to an absolute path: ${reference}`);
    return localWorkspaceTarget(cwd);
}
function localWorkspaceTarget(cwd) {
    const absolute = resolve(cwd);
    return {
        uri: localWorkspaceUri(absolute),
        cwd: absolute,
        label: basename(absolute) || absolute,
        description: absolute,
        kind: 'local',
        badge: 'LOCAL',
    };
}
function uriScheme(uri) {
    return /^([a-z][a-z0-9+.-]*):/iu.exec(uri)?.[1]?.toLowerCase();
}
function sameCwd(left, right) {
    return process.platform === 'win32'
        ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
        : resolve(left) === resolve(right);
}
export default TuiWorkspaceRuntime;
