export interface SessionRecord {
    id: string;
    title: string;
    cwd: string;
    createdAt: number;
    updatedAt: number;
}
/** Store the session to resume and report the launcher invocation. */
export declare function writeResumeTarget(sessionId: string): void;
/** Forget the resume marker (`/new` starts a fresh conversation). */
export declare function clearResumeTarget(): void;
/** The session id requested by `dsh-cc --resume`, if any. */
export declare function readResumeTarget(): string | undefined;
/** session-id → last-used epoch ms (best effort; missing file = empty). */
export declare function readLastUsed(): Readonly<Record<string, number>>;
/** Record that a session was just used (resumed or written to) so `/resume`
 *  can sort most-recently-used first. Best effort — never throws. */
export declare function touchSession(sessionId: string): void;
//# sourceMappingURL=sessionHistory.d.ts.map