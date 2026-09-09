import type { SessionSummary, SessionKind, SessionTitle, TitleSource, PreviewEntry } from '../../adapter/ports/channel-session.js'
export type { SessionSummary, SessionKind, SessionTitle, TitleSource, PreviewEntry } from '../../adapter/ports/channel-session.js'


/**
 * Facts a bounded read can recover from one session log.
 *
 * No "last event time" here on purpose: for an append-only log the file's
 * mtime says the same thing, is already read for {@link SessionSummary.bytes},
 * and needs no cache entry of its own.
 */
export interface SessionDigest {
  readonly title: SessionTitle | undefined
  readonly hasPrompt: boolean
  readonly model: string | undefined
  readonly label: string | undefined
  /** The whole log was covered, or the winning title was observed in the
   * trailing window; no unseen middle event can supersede it. */
  readonly titleComplete?: true
}
