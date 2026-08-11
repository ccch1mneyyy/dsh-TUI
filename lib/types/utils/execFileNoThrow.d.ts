/** The settled outcome of a no-throw command run. */
export interface ExecFileNoThrowResult {
    code: number | null;
    stdout: string;
    stderr: string;
}
/**
 * Options for {@link execFileNoThrow}: stdin payload, timeout, and child
 * working directory.
 */
export interface ExecFileNoThrowOptions {
    /** Stdin payload (OSC 52 clipboard helpers and tmux load-buffer). */
    input?: string;
    /** Kill the child after this many milliseconds. */
    timeout?: number;
    /**
     * Accepted for call-site compatibility with the original execa-based
     * implementation; `false` (the only value the Ink core passes) matches this
     * shim's behavior of running in the current working directory.
     */
    useCwd?: boolean;
    /** Working directory for the child; defaults to the parent's cwd. */
    cwd?: string;
}
/**
 * Run a command without throwing: resolves with `{ code, stdout, stderr }`
 * even when the process exits non-zero or cannot spawn.
 * @param file - The executable path to spawn.
 * @param args - Command-line arguments; defaults to none.
 * @param options - Spawn options (input, timeout, cwd).
 * @returns The process outcome: exit code, captured stdout, and captured stderr.
 */
export declare function execFileNoThrow(file: string, args?: readonly string[], options?: ExecFileNoThrowOptions): Promise<ExecFileNoThrowResult>;
//# sourceMappingURL=execFileNoThrow.d.ts.map