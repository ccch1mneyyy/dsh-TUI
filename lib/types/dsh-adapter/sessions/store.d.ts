import type { TitleSource } from './types.js';
/** Facts derived from a log at one revision. */
export interface DerivedEntry {
    readonly revision: string;
    readonly title: string;
    readonly titleSource: TitleSource;
    readonly hasPrompt: boolean;
    readonly model: string | undefined;
    readonly label: string | undefined;
}
/** One session's cached record: derived facts plus this install's own notes. */
export interface IndexEntry {
    readonly derived: DerivedEntry | undefined;
    /** Git branch this install was on when it last used the session. */
    readonly branch: string | undefined;
}
/** The whole cache, session id → entry. */
export type SessionIndex = Map<string, IndexEntry>;
/**
 * Load the cache.
 * @returns The parsed index; an unreadable, malformed, or stale-schema file
 *   yields an empty one, which costs a rebuild and never an error.
 */
export declare function readIndex(): SessionIndex;
/**
 * Persist the cache, atomically.
 *
 * The write goes to a per-process temporary name and is renamed into place, so
 * a reader never observes a half-written file and a crash never leaves one.
 * A concurrent writer may win the rename; the loser's derivations are simply
 * recomputed next time.
 *
 * @param index - The index to store. Entries are written in insertion order.
 */
export declare function writeIndex(index: SessionIndex): void;
/**
 * Record the git branch this install is on for a session.
 *
 * Kept here rather than in the log because it is not a fact about the session,
 * it is a fact about how this machine used it — the same reason it is reported
 * as "branch when last used" and omitted entirely for sessions that predate
 * the note. Inventing a branch for them would be worse than showing none.
 *
 * @param sessionId - Session being used.
 * @param branch - Current branch, or undefined to leave any note untouched.
 */
export declare function noteBranch(sessionId: string, branch: string | undefined): void;
//# sourceMappingURL=store.d.ts.map