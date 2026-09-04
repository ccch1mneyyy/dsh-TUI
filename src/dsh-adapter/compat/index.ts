/**
 * Compat boundary — every inelegant patch aimed at the harness core lives
 * here, behind one import seam, so the render/interaction code stays clean.
 *
 * House rules for modules in this directory:
 *  - Each patch carries its own capability probe and self-disables or
 *    degrades to pre-patch behavior when upstream absorbs the quirk.
 *  - Optional compatibility patches degrade to pre-patch behavior. Required
 *    transcript contracts fail loudly rather than fabricating an empty log.
 *  - A patch states plainly which upstream change would retire it.
 *
 * Current residents:
 *  - liveSession: rc.2 `events`/`seedLength` vs alpha.4
 *    `snapshotEvents`/`seq`/`isSeeded`/`inheritedEventCount`. Seed copies
 *    slice the source log; they never use `sessions.fork()` as an extractor.
 *    A child snapshot length cannot reliably be used as the inherited cut.
 *  - sessionLog: tolerant title reads plus offline rename/delete helpers for
 *    persisted sessions that are not currently owned by a live Agent, the
 *    resume-seam registration of vouched-for legacy event types into every
 *    reachable KNOWN_SESSION_EVENT_TYPES copy (retiring the day upstream's
 *    shared catalog adopts the types or ships a real registration API —
 *    issue #153), and the bounded read-only log reader behind the session
 *    tree (chunked I/O, lazy zstd frame walk, event + scan budgets,
 *    inherited-prefix skip).
 * @module @deepseek-harness-tui/dsh-tui/compat
 */
export {
  appendInterruptedTurnEnd,
  liveSessionCreateOptions,
  liveSessionListingFields,
  liveSessionOffset,
  sliceLiveSessionSeed,
  snapshotLiveSessionEvents,
} from './liveSession.js'
export {
  appendSessionTitle,
  defaultMaxScanned,
  deleteSessionLog,
  ensureLegacySessionEventTypes,
  findSessionLogFile,
  LEGACY_SESSION_EVENT_TYPES,
  readPhysicalHeaderSeedLength,
  readPhysicalHeaderSeedLengthForSession,
  readSessionEventsFromFile,
  readSessionEventsFromLog,
  readSessionTitleFromLog,
  type SessionLogRead,
  sessionsRoots,
} from './sessionLog.js'
