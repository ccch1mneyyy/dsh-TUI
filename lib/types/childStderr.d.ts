/**
 * Child-process stderr guard (issue #17).
 *
 * MCP servers spawned through `@deepseek-ai/dsh-mcp-client` run under the MCP
 * SDK's `StdioClientTransport`, whose stderr defaults to `'inherit'`
 * (`stdio: ['pipe', 'pipe', server.stderr ?? 'inherit']`). An inherited fd 2
 * is written by the CHILD process straight to the terminal device — those
 * bytes never pass through this process's patched `process.stderr.write`
 * (see `ink.tsx` patchStderr), so they land at the parked cursor, scroll the
 * alt-screen, and interleave with the diff renderer's absolute-coordinate
 * writes. A server in a reconnect loop (e.g. a proxy repeatedly printing
 * `Error: Non-HTTPS URLs ...` + its usage line) turns that into the
 * overlapping garbage shown in the issue screenshot.
 *
 * The guard patches `child_process.spawn` and rewrites requests whose stderr
 * would be inherited (`'inherit'` as the whole-stdio string, stdio array slot
 * 2, or raw fd 2) to a pipe, then drains the pipe line by line into a sink.
 * Only fd 2 is touched; stdin/stdout keep their requested modes, so MCP's
 * JSON-RPC stdio channel is unaffected.
 *
 * Reachability note: the MCP SDK spawns via `cross-spawn`, which reads
 * `child_process.spawn` off the CJS exports object at call time, so this
 * patch covers it (verified by scripts/verify-child-stderr.tsx). A consumer
 * holding a snapshotted ESM named import (`import { spawn } from
 * 'node:child_process'`) would bypass the patch — no known consumer in the
 * dependency tree does that.
 */
/**
 * Take over inherited child stderr for the TUI's lifetime: any `spawn` whose
 * stderr would hit the terminal directly is piped and drained into `sink`
 * instead. Returns a restore function that reverts the patch; in-flight
 * children keep their (already piped) streams.
 */
export declare function installChildStderrGuard(sink: (line: string) => void): () => void;
/** Notification callback signature — structurally `Channel['notify']`. */
export interface ChildStderrNotify {
    (text: string, options?: {
        color?: 'error' | 'warning' | 'success';
        timeoutMs?: number;
    }): void;
}
export interface ChildStderrReporterOptions {
    /** Quiet window that batches a burst of repeats into one notice (default 1500ms). */
    debounceMs?: number;
    /** After a notice, the same line stays silent for this long (default 30s). */
    cooldownMs?: number;
    /** Single-line length cap; longer lines are truncated with an ellipsis (default 200). */
    maxLineLength?: number;
}
export interface ChildStderrReporter {
    /** Feed one raw stderr line. */
    push(line: string): void;
    /** Cancel pending debounce timers (teardown). */
    dispose(): void;
}
/**
 * Turn a raw child-stderr line stream into bounded, deduplicated
 * notifications: identical lines inside a short debounce window collapse into
 * one "（重复 N 次）" notice, and a line that was just shown stays silent for
 * a cooldown so a failing reconnect loop can't spam the status area.
 */
export declare function createChildStderrReporter(notify: ChildStderrNotify, options?: ChildStderrReporterOptions): ChildStderrReporter;
//# sourceMappingURL=childStderr.d.ts.map