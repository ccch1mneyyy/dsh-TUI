import type { PreviewEntry, SessionDigest } from './types.js';
/** Head window budget. Eight times the measured worst-case prompt offset. */
export declare const HEAD_WINDOW_BYTES: number;
/** Head frame ceiling — a cost bound independent of how the bytes compress. */
export declare const HEAD_MAX_FRAMES = 128;
/** Tail window budget. Wider than the head: trailing frames carry payloads. */
export declare const TAIL_WINDOW_BYTES: number;
/**
 * Read both windows of one session log.
 *
 * @param path - Absolute artifact path.
 * @param cwd - Working directory, for the last-resort title.
 * @returns The digest. An unreadable log still yields a usable record: the
 *   title falls back to the directory basename and says so through its source.
 */
export declare function digestSession(path: string, cwd: string): SessionDigest;
/**
 * The last exchanges of a session, for the browser's preview pane.
 *
 * Bounded like everything else here: the preview shows the end of the
 * conversation because that is what the tail window holds, and because the end
 * is what tells you whether this is the session you meant.
 *
 * @param path - Absolute artifact path.
 * @param limit - How many entries to keep, newest last.
 * @returns Entries in log order.
 */
export declare function previewSession(path: string, limit: number): PreviewEntry[];
//# sourceMappingURL=digest.d.ts.map