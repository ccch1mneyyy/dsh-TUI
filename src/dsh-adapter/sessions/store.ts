/**
 * The session index — a local cache keyed by the backend's own change token.
 *
 * Deriving a session's title costs a bounded read; doing it for every session
 * on every picker open costs that read times the history. The persistence
 * service already hands out the exact token needed to avoid it:
 * `listSnapshots()` returns, per session, an opaque revision that changes
 * whenever the stored log changes. An entry whose revision still matches is
 * reused verbatim; anything else is re-derived. Steady state is therefore zero
 * log reads, and a session edited by another client (the store is shared with
 * dsh web) invalidates itself without any coordination.
 *
 * The revision is treated as opaque, as its contract requires. It happens to
 * be stat-derived today, but parsing it to shortcut a `stat` would couple this
 * cache to one backend's private format and break the moment a store without
 * per-session files is used.
 *
 * Two halves live in one entry because they have different lifetimes:
 * `derived` facts come from the log and die with the revision, while `branch`
 * is a local note about how this install used the session and no log change
 * can invalidate it. Keeping them in one record with one governing revision
 * field makes that boundary explicit instead of implied.
 *
 * Every operation is best-effort. The index is a cache: a corrupt file, a
 * losing concurrent write, or a read-only home directory costs a re-derivation
 * and nothing else, so nothing here throws.
 *
 * @module @deepseek-harness-tui/dsh-tui/sessions/store
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../../utils/paths.js'
import type { TitleSource } from './types.js'

/**
 * Bumped when an entry's shape changes. A mismatch drops the whole file
 * rather than migrating it — re-deriving is cheap and bounded, whereas a
 * migration path is code that runs once and is never exercised again.
 */
const SCHEMA_VERSION = 1

const INDEX_FILE = join(DATA_DIR, 'session-index.json')

/** Facts derived from a log at one revision. */
export interface DerivedEntry {
  readonly revision: string
  readonly title: string
  readonly titleSource: TitleSource
  readonly hasPrompt: boolean
  readonly model: string | undefined
  readonly label: string | undefined
}

/** One session's cached record: derived facts plus this install's own notes. */
export interface IndexEntry {
  readonly derived: DerivedEntry | undefined
  /** Git branch this install was on when it last used the session. */
  readonly branch: string | undefined
}

/** The whole cache, session id → entry. */
export type SessionIndex = Map<string, IndexEntry>

/** A title source as written to disk, or undefined for anything unexpected. */
function readTitleSource(value: unknown): TitleSource | undefined {
  return value === 'renamed' || value === 'auto' || value === 'prompt' || value === 'fallback'
    ? value
    : undefined
}

/** Narrow one persisted entry; an unrecognizable record is simply absent. */
function readEntry(value: unknown): IndexEntry | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const branch = typeof record['branch'] === 'string' ? record['branch'] : undefined
  const raw = record['derived']
  if (raw === null || typeof raw !== 'object') return { derived: undefined, branch }
  const derived = raw as Record<string, unknown>
  const revision = derived['revision']
  const title = derived['title']
  const titleSource = readTitleSource(derived['titleSource'])
  if (typeof revision !== 'string' || typeof title !== 'string' || titleSource === undefined) {
    return { derived: undefined, branch }
  }
  return {
    branch,
    derived: {
      revision,
      title,
      titleSource,
      hasPrompt: derived['hasPrompt'] === true,
      model: typeof derived['model'] === 'string' ? derived['model'] : undefined,
      label: typeof derived['label'] === 'string' ? derived['label'] : undefined,
    },
  }
}

/**
 * Load the cache.
 * @returns The parsed index; an unreadable, malformed, or stale-schema file
 *   yields an empty one, which costs a rebuild and never an error.
 */
export function readIndex(): SessionIndex {
  const index: SessionIndex = new Map()
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(INDEX_FILE, 'utf8'))
  } catch {
    return index
  }
  if (parsed === null || typeof parsed !== 'object') return index
  const file = parsed as Record<string, unknown>
  if (file['version'] !== SCHEMA_VERSION) return index
  const entries = file['entries']
  if (entries === null || typeof entries !== 'object') return index
  for (const [id, value] of Object.entries(entries as Record<string, unknown>)) {
    const entry = readEntry(value)
    if (entry !== undefined) index.set(id, entry)
  }
  return index
}

/**
 * Persist the cache, atomically.
 *
 * The write goes to a per-process temporary name and is renamed into place, so
 * a reader never observes a half-written file and a crash never leaves one.
 * A concurrent writer may win the rename; the loser's derivations are simply
 * recomputed next time.
 *
 * @param index - The index to store. Entries are written in insertion order.
 */
export function writeIndex(index: SessionIndex): void {
  const entries: Record<string, unknown> = {}
  for (const [id, entry] of index) {
    entries[id] = {
      ...(entry.derived === undefined ? {} : { derived: entry.derived }),
      ...(entry.branch === undefined ? {} : { branch: entry.branch }),
    }
  }
  const temporary = `${INDEX_FILE}.${process.pid}.tmp`
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(temporary, JSON.stringify({ version: SCHEMA_VERSION, entries }))
    renameSync(temporary, INDEX_FILE)
  } catch {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // Nothing left to do; the cache stays as it was.
    }
  }
}

/**
 * Record the git branch this install is on for a session.
 *
 * Kept here rather than in the log because it is not a fact about the session,
 * it is a fact about how this machine used it — the same reason it is reported
 * as "branch when last used" and omitted entirely for sessions that predate
 * the note. Inventing a branch for them would be worse than showing none.
 *
 * @param sessionId - Session being used.
 * @param branch - Current branch, or undefined to leave any note untouched.
 */
export function noteBranch(sessionId: string, branch: string | undefined): void {
  if (branch === undefined || branch.length === 0) return
  const index = readIndex()
  const existing = index.get(sessionId)
  if (existing?.branch === branch) return
  index.set(sessionId, { derived: existing?.derived, branch })
  writeIndex(index)
}

/*
 * Deliberately absent: a "forget this entry" call for the picker's delete, and
 * a "patch this title" call for its rename. Listing prunes entries whose
 * session no longer exists, and a renamed log has a new revision whose
 * re-derivation reads the very title event the rename just appended — both
 * paths already converge on the right answer, so a second mechanism to reach
 * it could only disagree with the first.
 */
