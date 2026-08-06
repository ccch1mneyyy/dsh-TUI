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
//# sourceMappingURL=sessionHistory.d.ts.map