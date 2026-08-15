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
 * Read a session's display title from its persisted log, tolerantly.
 *
 * Why not `persistence.load()`: the backend validates every event against
 * KNOWN_SESSION_EVENT_TYPES and throws the WHOLE load when a third-party
 * plugin wrote an unmarked unknown type (e.g. activity/status before the
 * resume repair touched it) — which is exactly why pickers fell back to the
 * cwd basename for every working-activity session. A picker label is
 * read-only UI state: decoding frames directly here keeps titles working
 * for logs the strict path refuses, now and for future plugin event types.
 *
 * Title precedence: the LAST `session/title` event wins (a /rename append
 * overrides the first-prompt auto title), falling back to the first user
 * message text. `hasUserMessage` drives the picker's launch-artifact filter.
 * @param sessionId - Session whose log should be read.
 * @returns The title info, or undefined when the log is absent/undecodable.
 */
export declare function readSessionTitleFromLog(sessionId: string): {
    title?: string;
    hasUserMessage: boolean;
} | undefined;
/**
 * Compat entry for the resume path: repair the target session's log, then
 * let resume proceed regardless of outcome. Never throws, never blocks on
 * anything but one small file — a repair miss degrades to the exact
 * pre-patch behavior (resume may still succeed or fail as before).
 * @param sessionId - Session about to be resumed.
 */
export declare function prepareSessionForResume(sessionId: string): Promise<void>;
//# sourceMappingURL=sessionLog.d.ts.map