/** Repair outcomes, surfaced for regression assertions and debug logging. */
export type ResumeRepairOutcome = 'repaired' | 'clean' | 'unavailable';
/**
 * Repair one session's persisted log ahead of `agents.resume`: mark every
 * event whose type is absent from KNOWN_SESSION_EVENT_TYPES as
 * `ignorable: true` (envelope-legal, read path skips it). Never throws.
 * @param sessionId - Session about to be resumed.
 * @returns The repair outcome; 'unavailable' leaves the file untouched.
 */
export declare function repairSessionLogForResume(sessionId: string): ResumeRepairOutcome;
/**
 * Compat entry for the resume path: repair the target session's log, then
 * let resume proceed regardless of outcome. Never throws, never blocks on
 * anything but one small file — a repair miss degrades to the exact
 * pre-patch behavior (resume may still succeed or fail as before).
 * @param sessionId - Session about to be resumed.
 */
export declare function prepareSessionForResume(sessionId: string): Promise<void>;
//# sourceMappingURL=sessionLog.d.ts.map