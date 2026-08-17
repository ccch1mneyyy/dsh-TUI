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
 *  - sessionLog: tolerant title reads plus offline rename/delete helpers for
 *    persisted sessions that are not currently owned by a live Agent, the
 *    resume-seam registration of vouched-for legacy event types into every
 *    reachable KNOWN_SESSION_EVENT_TYPES copy (issue #153), and the bounded
 *    tolerant log reader behind the session tree (event + scanned budgets,
 *    both stock encodings) — the registration retires the day upstream's
 *    shared catalog adopts the types or ships a real registration API, the
 *    reader the day the backend offers a tolerant bounded read itself.
 * @module @deepseek-harness-tui/dsh-tui/compat
 */
export {
  appendSessionTitle,
  defaultMaxScanned,
  deleteSessionLog,
  ensureLegacySessionEventTypes,
  findSessionLogFile,
  LEGACY_SESSION_EVENT_TYPES,
  readSessionEventsFromFile,
  readSessionEventsFromLog,
  readSessionTitleFromLog,
  sessionsRoots,
  titleFromEvents,
} from './sessionLog.js'
export type { SessionLogRead } from './sessionLog.js'
