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
import { readFileSync as snapshotRead, writeFileSync as snapshotWrite, mkdirSync as snapshotMkdir } from 'node:fs'
import { basename, join } from 'node:path'
import {
  digestSession,
  recoverAppendedTitle,
  recoverSessionTitle,
  sessionTitleAnchor,
} from './digest.js'
import { fileFacts } from './frames.js'
import { classify, readHeader, type RawSessionHeader } from './header.js'
import { findSessionLogFile, resolveLocatedPath } from '../compat/sessionLog.js'
import { readIndex, writeIndex, type DerivedEntry, type SessionIndex } from './store.js'
import { DATA_DIR } from '../../utils/paths.js'
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
  /** Headers alone, for a backend or version without snapshots. */
  list?: (signal?: AbortSignal) => Promise<readonly unknown[]>
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
 *
 * `list()` itself is read dual-shape: 0.1.5 folded snapshots INTO it (each
 * element is `{ header, revision, sizeBytes }`), while every older backend
 * returns bare headers — so each element is tried as a snapshot first and
 * then as a bare header.
 */
export async function enumerateSessions(source: SessionSource, signal?: AbortSignal): Promise<Listed[]> {
  if (typeof source.listSnapshots === 'function') {
    const snapshots = await source.listSnapshots(signal)
    return snapshots.map(readSnapshot).filter((entry): entry is Listed => entry !== undefined)
  }
  if (typeof source.list === 'function') {
    const headers = await source.list(signal)
    return headers
      .map((raw): Listed | undefined => readSnapshot(raw) ?? bareListed(raw))
      .filter((entry): entry is Listed => entry !== undefined)
  }
  return []
}

/**
 * Enumerated-sessions disk snapshot: the upstream `listSnapshots()` walk is
 * the dominant cost of a session-screen open (headers of EVERY stored
 * session, ~3ms each — a migrated store with 2000+ sessions pays ~7s, every
 * open, in-process). The snapshot lets a fresh process paint the screen from
 * the last walk immediately and refresh in the background, and the idle
 * warmer below keeps both the snapshot and the derivation index warm so the
 * background refresh converges instead of re-paying the cold cost.
 *
 * Best-effort like the index: a corrupt or missing file reads as absent.
 */
const ENUMERATE_SNAPSHOT_FILE = join(DATA_DIR, 'session-enumerate.json')
const ENUMERATE_SNAPSHOT_VERSION = 1

/** Headers persisted by the last completed enumeration, newest info the
 *  backend gave. Revision tokens are NOT kept: they describe "did this log
 *  change since" and go stale the moment another client writes — a snapshot
 *  row therefore always re-derives against the live file identity. */
interface SnapshotRow {
  readonly header: RawSessionHeader
  /** Artifact path from the enumeration that wrote this row; snapshot
   *  consumers hand it back through their stub source's locate(). */
  readonly path: string | undefined
}

function readEnumerateSnapshot(): readonly SnapshotRow[] | undefined {
  try {
    const parsed: unknown = JSON.parse(snapshotRead(ENUMERATE_SNAPSHOT_FILE, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const version = (parsed as { version?: unknown }).version
    const rows = (parsed as { rows?: unknown }).rows
    if (version !== ENUMERATE_SNAPSHOT_VERSION || !Array.isArray(rows)) return undefined
    const typed: SnapshotRow[] = []
    for (const row of rows) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
      const header = readHeader((row as { header?: unknown }).header)
      if (header === undefined) continue
      const path = (row as { path?: unknown }).path
      typed.push({ header, path: typeof path === 'string' ? path : undefined })
    }
    return typed
  } catch {
    return undefined
  }
}

function writeEnumerateSnapshot(listed: readonly Listed[], source: SessionSource): void {
  try {
    snapshotMkdir(DATA_DIR, { recursive: true })
    snapshotWrite(ENUMERATE_SNAPSHOT_FILE, JSON.stringify({
      version: ENUMERATE_SNAPSHOT_VERSION,
      rows: listed.map(entry => ({ header: entry.header, path: locate(source, entry.raw, entry.header.id) })),
    }))
  } catch {
    // A read-only home costs the next open its fast path, nothing else.
  }
}

/** The snapshot as listing input: bare entries (no revision ⇒ re-derive
 *  against file facts, same as a pre-0.1.5 backend) with cached derivations
 *  supplying the titles. */
export function snapshotListed(): Listed[] | undefined {
  const rows = readEnumerateSnapshot()
  return rows === undefined
    ? undefined
    : rows.map(row => ({
      header: row.header,
      // The snapshot's stored path rides in `raw`: a stub source's locate()
      // hands it back, giving the derivation pass its file facts.
      raw: { path: row.path },
      revision: undefined,
    }))
}

/**
 * Enumerate with the disk-snapshot fast path: with `preferSnapshot` the
 * last completed walk paints instantly and NO backend call is made (the
 * caller follows up with a fresh pass); without it the backend is enumerated
 * and the snapshot is refreshed for the next fast-path consumer.
 */
export async function enumerateSessionsCached(
  source: SessionSource,
  options: { preferSnapshot?: boolean, signal?: AbortSignal } = {},
): Promise<Listed[]> {
  if (options.preferSnapshot === true) {
    const snap = snapshotListed()
    if (snap !== undefined) return snap
  }
  const listed = await enumerateSessions(source, options.signal)
  if (listed.length > 0) writeEnumerateSnapshot(listed, source)
  return listed
}

function fileFactsOf(entry: Listed, source: SessionSource): ReturnType<typeof fileFacts> | undefined {
  const path = locate(source, entry.raw, entry.header.id)
  return path === undefined ? undefined : fileFacts(path)
}

/** How many entries a warmer batch may derive before yielding. */
const WARMER_BATCH = 64
/** Idle gap between warmer batches (low-power duty cycling). */
const WARMER_BATCH_PAUSE_MS = 200

export interface WarmProgress {
  readonly warmed: number
  readonly total: number
}

/**
 * Background low-power index warmer: repeated FULL listings with pauses.
 *
 * Each round is one ordinary `listSummaries()` — it derives exactly the
 * entries whose revision/title-completeness miss the index, under that
 * listing's own title-recovery byte budget (a natural throttle), and writes
 * the merged index (carry semantics: hits survive). Rounds pause between
 * each other (`shouldPause` idles them under a working turn); progress
 * persists in the index, so an interrupted warm resumes next run. Converges
 * when a round adds no new complete entries.
 *
 * A previous per-batch stub design was wrong: a batch's writeIndex REPLACES
 * the whole file, so late batches erased earlier ones' entries.
 */
export async function warmSessionIndex(
  source: SessionSource,
  options: { signal?: AbortSignal, shouldPause?: () => boolean } = {},
): Promise<WarmProgress> {
  const before = readIndex()
  const total = await (async () => {
    try {
      return (await enumerateSessions(source, options.signal)).filter(entry => {
        const cached = before.get(entry.header.id)
        return cached === undefined || cached.derived === undefined || cached.derived.titleComplete !== true
      }).length
    } catch {
      return 0
    }
  })()
  const aborted = (): boolean => options.signal?.aborted === true
  for (let round = 0; round < 64 && !aborted(); round++) {
    while (options.shouldPause?.() === true) {
      if (aborted()) return { warmed: warmedSoFar(before), total }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    const indexSizeBefore = readIndex().size
    try {
      await listSummaries(source, { signal: options.signal })
    } catch {
      break
    }
    const indexSizeAfter = readIndex().size
    const completeAfter = countComplete(readIndex())
    if (completeBefore(readIndex()) === completeAfter && indexSizeAfter === indexSizeBefore) break
    await new Promise(resolve => setTimeout(resolve, WARMER_BATCH_PAUSE_MS * 4))
  }
  return { warmed: Math.min(warmedSoFar(before), total), total }
}

function countComplete(index: SessionIndex): number {
  let n = 0
  for (const entry of index.values()) if (entry.derived?.titleComplete === true) n += 1
  return n
}

function completeBefore(index: SessionIndex): number {
  return countComplete(index)
}

function warmedSoFar(previous: SessionIndex): number {
  return countComplete(readIndex()) - countComplete(previous)
}


/** Pull a bare header out of one pre-0.1.5 `list()` element. */
function bareListed(raw: unknown): Listed | undefined {
  const header = readHeader(raw)
  return header === undefined ? undefined : { header, raw, revision: undefined }
}

/**
 * Absolute artifact path for one session.
 *
 * The backend's own `locate()` is authoritative and is asked first — but
 * since 0.1.5 it answers the CURRENT generation's path without touching the
 * filesystem, which does not exist for a session still stored as an older
 * generation; resolve older generations inside that same directory. Only
 * backends without a location fall back to scanning session roots, as the
 * compat layer has always done (generation-aware there) and is deliberately
 * independent of the backend's workspace-key scheme — so a runtime whose
 * persistence service predates `locate`, whose key sanitization changes, or
 * whose current-generation path has not materialized yet still resolves.
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
      if (typeof path === 'string' && path.length > 0) return resolveLocatedPath(path)?.path
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
  options: { preferSnapshot?: boolean, signal?: AbortSignal } = {},
): Promise<readonly SessionSummary[]> {
  const signal = options.signal
  let listed: Listed[]
  try {
    listed = await enumerateSessionsCached(source, options)
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
      const hasPrompt = digest.hasPrompt
      let titleComplete = digest.titleComplete === true
      const previous = cached?.derived

      // Across an append-only revision, validate the old EOF neighborhood then
      // scan only the new frames. This preserves an older authoritative title
      // without trusting file size alone, and still observes a newly appended
      // rename even when later output pushed it outside the cheap tail window.
      // Only title evidence carries forward: a formerly empty session can
      // have acquired its first human message in the appended suffix.
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
    listed = await enumerateSessions(source, signal)
  } catch {
    return undefined
  }
  const match = listed.find(entry => entry.header.id === sessionId)
  return match === undefined ? undefined : locate(source, match.raw, sessionId)
}
