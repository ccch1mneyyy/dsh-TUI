/** One persisted session as the `/resume` picker lists it. */
export interface SessionRecord {
    id: string;
    title: string;
    cwd: string;
    createdAt: number;
    updatedAt: number;
}
/**
 * Store the session to resume and report the launcher invocation.
 * @param sessionId - Session id for `dsh-tui --resume` on the next launch.
 */
export declare function writeResumeTarget(sessionId: string): void;
/** Forget the resume marker (`/new` starts a fresh conversation). */
export declare function clearResumeTarget(): void;
/**
 * The session id requested by `dsh-tui --resume`, if any.
 * @returns The stored session id, or undefined when none is set.
 */
export declare function readResumeTarget(): string | undefined;
/**
 * Session-id → last-used epoch ms map for MRU ordering.
 * @returns The parsed map; best effort, an unreadable file yields {}.
 */
export declare function readLastUsed(): Readonly<Record<string, number>>;
/**
 * Record that a session was just used (resumed or written to) so `/resume`
 * can sort most-recently-used first. Best effort — never throws.
 * @param sessionId - Session id to touch.
 */
export declare function touchSession(sessionId: string): void;
//# sourceMappingURL=sessionHistory.d.ts.map