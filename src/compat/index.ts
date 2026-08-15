/**
 * Compat boundary — every inelegant patch aimed at the harness core lives
 * here, behind one import seam, so the render/interaction code stays clean.
 *
 * House rules for modules in this directory:
 *  - Each patch carries its own capability probe and self-disables or
 *    degrades to pre-patch behavior when upstream absorbs the quirk.
 *  - A patch must never throw into the caller: failure means "act as if the
 *    patch did not exist".
 *  - A patch states plainly which upstream change would retire it.
 *
 * Current residents:
 *  - sessionLog: marks third-party session-event types `ignorable` before
 *    resume, retiring the day `session.append` exposes `ignorable` or the
 *    types enter KNOWN_SESSION_EVENT_TYPES upstream.
 * @module @deepseek-harness-tui/dsh-tui/compat
 */
export { prepareSessionForResume, repairSessionLogForResume } from './sessionLog.js'
export type { ResumeRepairOutcome } from './sessionLog.js'
