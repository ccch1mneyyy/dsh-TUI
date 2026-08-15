/** Repair outcomes, surfaced for regression assertions and debug logging. */
export type ResumeRepairOutcome = 'repaired' | 'clean' | 'unavailable';
/**
 * Session-log storage roots, in priority order, mirroring the persistence
 * backend's `root` resolution: cordis.patch.yml sets `DSH_CC_SESSION_ROOT ?? dshHomePath(
 * 'sessions')` where dshHomePath is `$DSH_HOME ?? ~/.dsh`; the unpatched
 * cordis.yml base falls back to ~/.dsh-cc/sessions, kept here as the legacy
 * last resort. Every candidate is scanned — the first hit wins, so an
 * explicit DSH_CC_SESSION_ROOT always outranks the defaults.
 */
export declare function sessionsRoots(): string[];
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
/**
 * Append a `session/title` event to a persisted session's log — the
 * `/resume` picker rename for a NON-LIVE session (the live one goes through
 * `session.append` in the channel). The backend flushes by appending zstd
 * frames, so the new event lands as one more frame: existing bytes stay
 * untouched (the frame-0 header invariant holds), and `last title wins` in
 * {@link readSessionTitleFromLog} surfaces the new name. The seq continues
 * the log's contiguity contract (seq = event count) by taking maxSeq + 1.
 * The frame is APPEND-ONLY (O_APPEND), matching the backend's own flush
 * discipline: this store is shared with dsh web (#24), and a
 * read-concat-rewrite (tmp + rename) would silently drop a frame another
 * writer lands between our read and replace. A single append never rewrites
 * existing bytes, so concurrent frames all survive; the worst remaining
 * race is a duplicate seq when the maxSeq read above passes another
 * appender — benign next to lost frames, since last-title-wins keeps the
 * rename semantics. Never throws.
 * @param sessionId - Session to rename.
 * @param title - New display title (already trimmed by the caller).
 * @returns 'appended', or 'unavailable' when the log is absent/undecodable.
 */
export declare function appendSessionTitle(sessionId: string, title: string): 'appended' | 'unavailable';
/**
 * Delete a persisted session's log directory (`<root>/<workspace>/<id>/`),
 * the `/resume` picker delete. The directory holds only session.jsonl.zstd
 * today; removing it whole keeps future sidecar files from orphaning. The
 * backend's list() materializes entries from these logs, so the session
 * drops out of the picker on the next refresh. Never throws.
 * @param sessionId - Session to delete (must not be the live session).
 * @returns 'deleted', or 'unavailable' when the log is absent.
 */
export declare function deleteSessionLog(sessionId: string): 'deleted' | 'unavailable';
//# sourceMappingURL=sessionLog.d.ts.map