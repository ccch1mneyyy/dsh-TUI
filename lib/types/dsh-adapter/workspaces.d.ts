/**
 * Workspace-target extension seam for terminal front doors.
 *
 * The TUI owns local URI parsing and session switching. Optional plugins add
 * providers for external schemes without coupling the TUI to them.
 */
import { Context, Service } from '@deepseek-ai/cordis';
export type TuiWorkspaceKind = 'local' | 'provider';
export interface TuiWorkspaceTarget {
    /** Stable, user-pasteable target identifier. */
    uri: string;
    /** Host-side cwd recorded in the DSH session header. */
    cwd: string;
    /** Compact picker/status label. */
    label: string;
    /** Optional secondary picker copy. */
    description?: string;
    kind: TuiWorkspaceKind;
    /** Provider-owned compact badge; the TUI does not interpret it. */
    badge: string;
}
export interface TuiWorkspaceChoice {
    id: string;
    label: string;
    description?: string;
    badge?: string;
    choose(signal?: AbortSignal): Promise<TuiWorkspaceCommandResult> | TuiWorkspaceCommandResult;
    /** Optional inline editor entered with Tab while this choice is focused. */
    input?: {
        initialValue?: string;
        placeholder?: string;
        submit(value: string, signal?: AbortSignal): Promise<TuiWorkspaceCommandResult> | TuiWorkspaceCommandResult;
    };
}
export type TuiWorkspaceCommandResult = {
    kind: 'choices';
    title: string;
    choices: readonly TuiWorkspaceChoice[];
} | {
    kind: 'target';
    target: TuiWorkspaceTarget;
};
export interface TuiWorkspaceCommand {
    name: string;
    aliases?: readonly string[];
    description: string;
    run(input: string, context: {
        cwd: string;
    }, signal?: AbortSignal): Promise<TuiWorkspaceCommandResult> | TuiWorkspaceCommandResult;
}
export interface TuiCommandShell {
    resolve(request: {
        command: string;
        workdir?: string;
        timeoutMs?: number;
    }): unknown;
    run(spec: unknown): Promise<{
        exitCode: number | null;
        stdout: {
            text: string;
        };
        stderr: {
            text: string;
        };
        timedOut: boolean;
    }>;
}
export interface TuiWorkspaceProvider {
    /** URI schemes owned by this provider, without the trailing colon. */
    schemes: readonly string[];
    /** Enumerate targets owned by this provider. */
    list(signal?: AbortSignal): Promise<readonly TuiWorkspaceTarget[]> | readonly TuiWorkspaceTarget[];
    /** Resolve a provider URI, or return undefined when its scheme is not owned. */
    resolve(uri: string, signal?: AbortSignal): Promise<TuiWorkspaceTarget | undefined> | TuiWorkspaceTarget | undefined;
    /** Resolve a path relative to a cwd already owned by this provider. */
    resolvePath?(path: string, cwd: string, signal?: AbortSignal): Promise<TuiWorkspaceTarget | undefined> | TuiWorkspaceTarget | undefined;
    /** Describe an already-recorded cwd without performing I/O. */
    describe(cwd: string): TuiWorkspaceTarget | undefined;
    /** Override `!command` execution for a provider-owned cwd. */
    commandShell?(cwd: string): Promise<TuiCommandShell | undefined> | TuiCommandShell | undefined;
    /** Rename a provider-owned workspace durably. */
    rename?(cwd: string, title: string): Promise<TuiWorkspaceTarget | undefined> | TuiWorkspaceTarget | undefined;
    /** Provider-owned `/workspace <command>` extensions. */
    commands?: readonly TuiWorkspaceCommand[];
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        tuiWorkspaces: TuiWorkspaceRuntime;
    }
}
export declare const name = "dsh-tui-workspaces";
/** Registry and local fallback shared by the TUI and workspace plugins. */
export declare class TuiWorkspaceRuntime extends Service {
    private readonly providers;
    private readonly providerWaiters;
    constructor(ctx: Context);
    register(provider: TuiWorkspaceProvider): () => void;
    list(currentCwd: string, signal?: AbortSignal): Promise<readonly TuiWorkspaceTarget[]>;
    /** Resolve a URI, briefly allowing concurrently mounted providers to register. */
    resolve(reference: string, currentCwd?: string, signal?: AbortSignal): Promise<TuiWorkspaceTarget | undefined>;
    describe(cwd: string): TuiWorkspaceTarget;
    commandShell(cwd: string): Promise<TuiCommandShell | undefined>;
    rename(cwd: string, title: string): Promise<TuiWorkspaceTarget>;
    commands(): readonly Pick<TuiWorkspaceCommand, 'name' | 'aliases' | 'description'>[];
    runCommand(name: string, input: string, cwd: string, signal?: AbortSignal): Promise<TuiWorkspaceCommandResult | undefined>;
    private workspaceRegistry;
    private withStoredTitle;
    private notifyProviderWaiters;
    private waitForProvider;
}
/** Local-only fallback for direct embedders that call createChannel() without
 * mounting the optional workspace registry/provider service. */
export declare function createLocalWorkspaceRuntime(): Pick<TuiWorkspaceRuntime, 'list' | 'resolve' | 'describe' | 'commandShell' | 'rename' | 'commands' | 'runCommand'>;
export declare function localWorkspaceUri(path: string): string;
/** Resolve a native absolute path or the standard file URL form. */
export declare function parseLocalWorkspaceReference(reference: string): TuiWorkspaceTarget | undefined;
export default TuiWorkspaceRuntime;
//# sourceMappingURL=workspaces.d.ts.map