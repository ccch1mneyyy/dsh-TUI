/**
 * Persisted-session metadata — the adapter-side barrel.
 *
 * This directory is the only part of the session browser allowed to know how
 * sessions are stored: the persistence service's shape, the log's frame
 * container, the header's lineage fields. The browser screen and its
 * components are pure UI over the types re-exported here and never touch a
 * session log directly, which is what `verify-adapter-boundary` enforces.
 *
 * @module @deepseek-harness-tui/dsh-tui/sessions
 */

export {
  classify,
  readHeader,
  readInheritedCut,
  type RawSessionHeader,
} from './header.js'

export { digestSession, previewSession } from './digest.js'

export { listSummaries, locateSession, type SessionSource } from './list.js'

export { noteBranch, readIndex, writeIndex, type IndexEntry, type SessionIndex } from './store.js'

export type {
  PreviewEntry,
  SessionDigest,
  SessionKind,
  SessionSummary,
  SessionTitle,
  TitleSource,
} from './types.js'
