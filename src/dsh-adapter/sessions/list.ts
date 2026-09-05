/**
 * Building the session list.
 *
 * One resolution path produces one complete, honestly-classified record per
 * stored session — every kind, empties included — and callers decide what to
 * show. That split is deliberate: the old picker filtered while it resolved,
 * so "hide sub-agent runs" and "resolve a title" were the same pass and
 * neither could change without disturbing the other. Here the browser can
 * toggle sub-agent runs into view, or offer to clean up boot artifacts,
 * without re-deriving anything.
 *
 * Cost: one `stat` per session always, plus one bounded log read per session
 * whose revision moved since the last listing. On a warm index that is zero
 * log reads. A log whose opening prompt exceeds the cheap window takes one
 * progressive, memory-bounded recovery scan and caches the result. The path
 * this replaces decompressed every frame of the twenty most recent logs on
 * every open — 3.9 s over a 31 MB history.
 *
 * @module @deepseek-harness-tui/dsh-tui/sessions/list
 */
import { basename } from 'node:path'
import {
  digestSession,
  recoverAppendedTitle,
  recoverSessionTitle,
  sessionTitleAnchor,
} from './digest.js'
import { fileFacts } from './frames.js'
import { classify, readHeader, type RawSessionHeader } from './header.js'
import { findSessionLogFile } from '../compat/sessionLog.js'
import { readIndex, writeIndex, type DerivedEntry, type SessionIndex } from './store.js'
import type { SessionSummary } from './types.js'
import { readLastUsed } from '../../sessionHistory.js'

/** Compressed bytes one listing may spend on full-log title recovery scans. */
const TITLE_SCAN_BUDGET_BYTES = 16 * 1024 * 1024

/**
 * The slice of `ctx.sessionPersistence` this module uses.
 *
 * Structural and fully optional: the service is resolved from a running
 * context whose packages may be a version apart from ours, and a listing that
 * degrades is worth more than one that throws.
 */
export interface SessionSource {
  /** Headers plus per-log change tokens — the contract built for this. */
  listSnapshots?: (signal?: AbortSignal) => Promise<readonly unknown[]>
  /**
   * Headers (or dsh 0.1.2-rc.1+ snapshot records) alone, for a backend or
   * version without listSnapshots. Dual-shape: rc.1+ takes an options object
   * ({ signal }); older hosts took the positional signal and ignore an object.
   */
  list?: ((options?: { signal?: AbortSignal }) => Promise<readonly unknown[]>)
    & ((signal?: AbortSignal) => Promise<readonly unknown[]>)
  /** Absolute artifact path for one header; absent for storeless backends. */
  locate?: (meta: unknown) => unknown
}

/** A header paired with the backend's change token, when it offered one. */
interface Listed {
  readonly header: RawSessionHeader
  readonly raw: unknown
  readonly revision: string | undefined
}

/** Pull `{ header, revision }` out of one `listSnapshots()` element. */
function readSnapshot(value: unknown): Listed | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const raw = record['header']
  const header = readHeader(raw)
  if (header === undefined) return undefined
  const revision = record['revision']
  return { header, raw, revision: typeof revision === 'string' ? revision : undefined }
}

/**
 * Enumerate stored sessions.
 *
 * Prefers `listSnapshots()` because its revision is the backend's own answer
 * to "has this log changed", and falls back to `list()` when the resolved
 * service predates it — in which case the change token is derived from the
 * file's own size and mtime further down. Both are honest change tokens for an
 * append-only log; only the authority differs.
 */
async function enumerate(source: SessionSource, signal?: AbortSignal): Promise<Listed[]> {
  if (typeof source.listSnapshots === 'function') {
    const snapshots = await source.listSnapshots(signal)
    return snapshots.map(readSnapshot).filter((entry): entry is Listed => entry !== undefined)
  }
  if (typeof source.list === 'function') {
    // dsh 0.1.2-rc.1: list() takes an options object ({ signal }). Legacy
    // positional-signal hosts ignore the object (their signal simply goes
    // unused), so the object shape is safe on both lines.
    const entries = await source.list(signal !== undefined ? { signal } : undefined)
    // dsh 0.1.2-rc.1: persistence.list() returns SessionPersistenceSnapshot
    // records ({ header, revision }) rather than bare headers. Both shapes
    // pass through readSnapshot first; a bare header (older hosts) has no
    // `header` key, so it falls through to the legacy readHeader parse and
    // keeps its undefined revision (derived from the file below).
    return entries
      .map((raw): Listed | undefined => readSnapshot(raw) ?? (() => {
        const header = readHeader(raw)
        return header === undefined ? undefined : { header, raw, revision: undefined }
      })())
      .filter((entry): entry is Listed => entry !== undefined)
  }
  return []
}

/**
 * Absolute artifact path for one session.
 *
 * The backend's own `locate()` is authoritative and is asked first. The
 * fallback scans the session roots for the id, which is what the compat layer
 * has always done and is deliberately independent of the backend's
 * workspace-key scheme — so a runtime whose persistence service predates
 * `locate`, or whose key sanitization changes, still resolves.
 *
 * A backend that stores no per-session artifact (SQLite) answers neither, and
 * its sessions are summarized from their headers alone.
 */
function locate(source: SessionSource, raw: unknown, sessionId: string): string | undefined {
  if (typeof source.locate === 'function') {
    let location: unknown
    try {
      location = source.locate(raw)
    } catch {
      location = undefined
    }
    if (location !== null && typeof location === 'object') {
      const path = (location as Record<string, unknown>)['path']
      if (typeof path === 'string' && path.length > 0) return path
    }
  }
  return findSessionLogFile(sessionId)
}

/**
 * Read every stored session into a complete summary.
 *
 * @param source - The persistence service.
 * @param signal - Optional cancellation for the backend's own listing work.
 * @returns One summary per stored session, most recently active first. No
 *   filtering of any kind is applied — sub-agent runs and sessions with no
 *   conversation are present and labelled as such.
 */
export async function listSummaries(
  source: SessionSource,
  signal?: AbortSignal,
): Promise<readonly SessionSummary[]> {
  let listed: Listed[]
  try {
    listed = await enumerate(source, signal)
  } catch {
    return []
  }

  // Children are counted from the same listing rather than by walking logs:
  // lineage lives in the header, so a parent's sub-agent count is free.
  const children = new Map<string, number>()
  for (const entry of listed) {
    if (entry.header.origin !== 'subagent') continue
    const parent = entry.header.parentSession
    if (parent === undefined) continue
    children.set(parent, (children.get(parent) ?? 0) + 1)
  }

  const index = readIndex()
  const next: SessionIndex = new Map()
  const lastUsed = readLastUsed()
  let changed = false
  const records: Array<{
    header: RawSessionHeader
    facts: ReturnType<typeof fileFacts>
    cached: ReturnType<typeof index.get>
    derived: DerivedEntry | undefined
  }> = []
  // Full-log recovery scans are charged against one budget per listing and run
  // most-recent-first, so a cold cache after an upgrade improves incrementally
  // instead of decompressing the whole history in one open.
  const scanWork: Array<{ id: string; path: string; bytes: number; updatedAt: number }> = []

  for (const { header, raw, revision } of listed) {
    const cached = index.get(header.id)
    const path = locate(source, raw, header.id)
    const facts = path === undefined ? undefined : fileFacts(path)
    // Falls back to the file's own identity when the backend offered no token.
    const token = revision ?? (facts === undefined ? undefined : `${facts.bytes}:${facts.modifiedAt}`)

    let derived: DerivedEntry | undefined
    if (
      cached?.derived !== undefined &&
      token !== undefined &&
      cached.derived.revision === token &&
      cached.derived.titleComplete
    ) {
      derived = cached.derived
    } else if (path !== undefined && token !== undefined) {
      const digest = digestSession(path, header.cwd ?? '')
      let title = digest.title
      let hasPrompt = digest.hasPrompt
      let titleComplete = digest.titleComplete === true
      const previous = cached?.derived

      // Across an append-only revision, validate the old EOF neighborhood then
      // scan only the new frames. This preserves an older authoritative title
      // without trusting file size alone, and still observes a newly appended
      // rename even when later output pushed it outside the cheap tail window.
      if (
        !titleComplete &&
        previous !== undefined &&
        facts !== undefined &&
        previous.identity !== undefined &&
        previous.identity === facts.identity &&
        previous.anchor !== undefined &&
        facts.bytes >= previous.bytes
      ) {
        const oldAnchor = await sessionTitleAnchor(path, previous.bytes, signal)
        if (oldAnchor === previous.anchor) {
          if (facts.bytes === previous.bytes && previous.titleComplete) {
            title = previous.title.length === 0
              ? undefined
              : { text: previous.title, source: previous.titleSource }
            hasPrompt = previous.hasPrompt
            titleComplete = true
          } else if (facts.bytes > previous.bytes) {
            const appended = await recoverAppendedTitle(path, previous.bytes, facts.bytes, signal)
            if (appended.title !== undefined) title = appended.title
            if (appended.complete && (appended.title !== undefined || previous.titleComplete)) {
              if (appended.title === undefined) {
                title = previous.title.length === 0
                  ? undefined
                  : { text: previous.title, source: previous.titleSource }
              }
              hasPrompt = previous.hasPrompt
              titleComplete = true
            }
          }
        }
      }

      derived = {
        revision: token,
        bytes: facts?.bytes ?? 0,
        identity: facts?.identity,
        anchor: facts === undefined ? undefined : await sessionTitleAnchor(path, facts.bytes, signal),
        title: title?.text ?? '',
        titleSource: title?.source ?? 'fallback',
        titleComplete,
        hasPrompt,
        model: digest.model,
        label: digest.label,
      }
      changed = true
      if (
        !titleComplete &&
        facts !== undefined &&
        signal?.aborted !== true
      ) {
        const createdAt = header.createdAt ?? facts.modifiedAt
        scanWork.push({
          id: header.id,
          path,
          bytes: facts.bytes,
          updatedAt: Math.max(facts.modifiedAt, lastUsed[header.id] ?? 0, createdAt),
        })
      }
    }
    // Carry every entry that holds anything worth keeping — including a pure
    // cache hit, which must survive into the next index or the following
    // listing would re-derive everything it just reused.
    if (derived !== undefined || cached?.branch !== undefined) {
      next.set(header.id, { derived, branch: cached?.branch })
    }
    records.push({ header, facts, cached, derived })
  }
  const recordsById = new Map(records.map(record => [record.header.id, record]))

  // Phase 2: full-log title recovery, most-recent-first, under one byte budget.
  scanWork.sort((left, right) => right.updatedAt - left.updatedAt)
  let scanBudget = TITLE_SCAN_BUDGET_BYTES
  for (const work of scanWork) {
    if (scanBudget <= 0) break
    let recovered: Awaited<ReturnType<typeof recoverSessionTitle>> | undefined
    try {
      recovered = await recoverSessionTitle(work.path, work.bytes, signal)
    } catch {
      continue
    }
    if (recovered === undefined) continue
    scanBudget -= work.bytes
    const entry = next.get(work.id)
    if (entry?.derived === undefined) continue
    const base = entry.derived
    if (recovered.title === undefined && recovered.complete) {
      // A conclusive no-title scan with no prompt anywhere is a boot artifact;
      // otherwise the opening prompt stands in as the title.
      next.set(work.id, {
        ...entry,
        derived: {
          ...base,
          title: '',
          titleSource: 'fallback',
          titleComplete: recovered.complete,
          hasPrompt: recovered.hasPrompt ?? base.hasPrompt,
        },
      })
    } else {
      next.set(work.id, {
        ...entry,
        derived: {
          ...base,
          title: recovered.title?.text ?? base.title,
          titleSource: recovered.title?.source ?? base.titleSource,
          titleComplete: recovered.complete,
          hasPrompt: recovered.hasPrompt ?? base.hasPrompt,
        },
      })
    }
    const record = recordsById.get(work.id)
    if (record !== undefined) record.derived = next.get(work.id)!.derived
  }

  // Entries for sessions the backend no longer lists are dropped here; that is
  // the whole of the cache's garbage collection, and it runs on every listing.
  if (changed || next.size !== index.size) writeIndex(next)

  const summaries: SessionSummary[] = records.map(({ header, facts, cached, derived }) => ({
    id: header.id,
    kind: classify(header),
    title: {
      text:
        derived?.title !== undefined && derived.title.length > 0
          ? derived.title
          : basename(header.cwd ?? '') || header.id.slice(0, 8),
      source: derived?.titleSource ?? 'fallback',
    },
    cwd: header.cwd ?? '',
    createdAt: header.createdAt ?? facts?.modifiedAt ?? 0,
    updatedAt: Math.max(facts?.modifiedAt ?? 0, lastUsed[header.id] ?? 0, header.createdAt ?? 0),
    bytes: facts?.bytes,
    // Without a readable artifact nothing can be proven empty, and hiding a
    // real session is the worse error — so an unreadable log is listed.
    hasPrompt: derived?.hasPrompt ?? true,
    agentPreset: header.agentPreset,
    model: derived?.model,
    label: derived?.label,
    branch: cached?.branch,
    childCount: children.get(header.id) ?? 0,
  }))

  // A total order, not just a sort key. `updatedAt` is dominated by the log's
  // mtime, and sessions written inside the same millisecond tie on it — which
  // would leave their relative order down to whatever the backend happened to
  // enumerate first, so the same history could list differently twice in a
  // row. Creation time breaks the tie, and the id breaks that.
  return summaries.sort(
    (left, right) =>
      right.updatedAt - left.updatedAt ||
      right.createdAt - left.createdAt ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  )
}

/**
 * Resolve one session's artifact path.
 *
 * Listing headers is a first-line-only read per log — about 2 ms across a
 * fifty-session history — so the preview pane resolves its target this way
 * rather than making every summary carry a filesystem path it has no business
 * knowing about.
 *
 * @param source - The persistence service.
 * @param sessionId - Session to locate.
 * @returns The absolute artifact path, or undefined when the backend owns no
 *   per-session file or the session is gone.
 */
export async function locateSession(
  source: SessionSource,
  sessionId: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  let listed: Listed[]
  try {
    listed = await enumerate(source, signal)
  } catch {
    return undefined
  }
  const match = listed.find(entry => entry.header.id === sessionId)
  return match === undefined ? undefined : locate(source, match.raw, sessionId)
}
