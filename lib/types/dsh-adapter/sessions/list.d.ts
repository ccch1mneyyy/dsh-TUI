import type { SessionSummary } from './types.js';
/**
 * The slice of `ctx.sessionPersistence` this module uses.
 *
 * Structural and fully optional: the service is resolved from a running
 * context whose packages may be a version apart from ours, and a listing that
 * degrades is worth more than one that throws.
 */
export interface SessionSource {
    /** Headers plus per-log change tokens — the contract built for this. */
    listSnapshots?: (signal?: AbortSignal) => Promise<readonly unknown[]>;
    /** Headers alone, for a backend or version without snapshots. */
    list?: (signal?: AbortSignal) => Promise<readonly unknown[]>;
    /** Absolute artifact path for one header; absent for storeless backends. */
    locate?: (meta: unknown) => unknown;
}
/**
 * Read every stored session into a complete summary.
 *
 * @param source - The persistence service.
 * @param signal - Optional cancellation for the backend's own listing work.
 * @returns One summary per stored session, most recently active first. No
 *   filtering of any kind is applied — sub-agent runs and sessions with no
 *   conversation are present and labelled as such.
 */
export declare function listSummaries(source: SessionSource, signal?: AbortSignal): Promise<readonly SessionSummary[]>;
/**
 * Resolve one session's artifact path.
 *
 * Listing headers is a first-line-only read per log — about 2 ms across a
 * fifty-session history — so the preview pane resolves its target this way
 * rather than making every summary carry a filesystem path it has no business
 * knowing about.
 *
 * @param source - The persistence service.
 * @param sessionId - Session to locate.
 * @returns The absolute artifact path, or undefined when the backend owns no
 *   per-session file or the session is gone.
 */
export declare function locateSession(source: SessionSource, sessionId: string, signal?: AbortSignal): Promise<string | undefined>;
//# sourceMappingURL=list.d.ts.map