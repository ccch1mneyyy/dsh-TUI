import type { Writable } from 'stream';
import type { Diff } from './frame.js';
/**
 * Progress-report state for OSC 9;4: a state plus an optional percentage.
 */
export type Progress = {
    state: 'running' | 'completed' | 'error' | 'indeterminate';
    percentage?: number;
};
/**
 * Checks if the terminal supports OSC 9;4 progress reporting.
 * Supported terminals:
 * - ConEmu (Windows) - all versions
 * - Ghostty 1.2.0+
 * - iTerm2 3.6.6+
 *
 * Note: Windows Terminal interprets OSC 9;4 as notifications, not progress.
 * @returns true when the terminal supports OSC 9;4 progress reporting.
 */
export declare function isProgressReportingAvailable(): boolean;
/**
 * Checks if the terminal supports DEC mode 2026 (synchronized output).
 * When supported, BSU/ESU sequences prevent visible flicker during redraws.
 * @returns true when the terminal supports DEC 2026.
 */
export declare function isSynchronizedOutputSupported(): boolean;
/**
 * Record the XTVERSION response. Called once from App.tsx when the reply
 * arrives on stdin. No-op if already set (defend against re-probe).
 * @param name - the terminal name reported by the XTVERSION reply.
 */
export declare function setXtversionName(name: string): void;
/**
 * True if running in an xterm.js-based terminal (VS Code, Cursor, Windsurf
 * integrated terminals). Combines TERM_PROGRAM env check (fast, sync, but
 * not forwarded over SSH) with the XTVERSION probe result (async, survives
 * SSH — query/reply goes through the pty). Early calls may miss the probe
 * reply — call lazily (e.g. in an event handler) if SSH detection matters.
 * @returns true when the terminal is xterm.js-based.
 */
export declare function isXtermJs(): boolean;
/**
 * True if this terminal correctly handles extended key reporting
 * (Kitty keyboard protocol + xterm modifyOtherKeys).
 * @returns true when the terminal is on the extended-keys allowlist.
 */
export declare function supportsExtendedKeys(): boolean;
/**
 * True if the terminal scrolls the viewport when it receives cursor-up
 * sequences that reach above the visible area. On Windows, conhost's
 * SetConsoleCursorPosition follows the cursor into scrollback
 * (microsoft/terminal#14774), yanking users to the top of their buffer
 * mid-stream. WT_SESSION catches WSL-in-Windows-Terminal where platform
 * is linux but output still routes through conhost.
 * @returns true when the cursor-up viewport-yank bug applies.
 */
export declare function hasCursorUpViewportYankBug(): boolean;
/**
 * Whether synchronized output (DEC 2026) is available, computed once at
 * module load — terminal capabilities don't change mid-session. Exported
 * so callers can pass a sync-skip hint gated to specific modes.
 */
export declare const SYNC_OUTPUT_SUPPORTED: boolean;
/**
 * The output streams a terminal renders to.
 */
export type Terminal = {
    stdout: Writable;
    stderr: Writable;
};
/**
 * Write a frame diff to the terminal as a single buffered write. Wraps
 * the output in BSU/ESU synchronized-update markers unless skipSyncMarkers
 * is set. No-op when the diff contains no patches.
 * @param terminal - the terminal to write to.
 * @param diff - the frame diff patches to render.
 * @param skipSyncMarkers - when true, omit the BSU/ESU wrapping.
 */
export declare function writeDiffToTerminal(terminal: Terminal, diff: Diff, skipSyncMarkers?: boolean): void;
//# sourceMappingURL=terminal.d.ts.map