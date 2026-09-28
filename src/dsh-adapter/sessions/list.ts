/**
 * Building the session list.
 *
 * One resolution path produces one usable, honestly-classified record per
 * stored session — every kind, empties included — and callers decide what to
 * show. That split is deliberate: the old picker filtered while it resolved,
 * so "hide sub-agent runs" and "resolve a title" were the same pass and
 * neither could change without disturbing the other. Here the browser can
 * toggle sub-agent runs into view, or offer to clean up boot artifacts,
 * without re-deriving anything.
 *
 * Cost: backend enumeration plus a revision comparison per session. Only a
 * changed revision needs artifact I/O, and append-only changes read the new
 * suffix. Incomplete titles are recovered after the list is returned. The path
 * this replaces decompressed every frame of the twenty most recent logs on
 * every open — 3.9 s over a 31 MB history.
 *
 * @module @deepseek-harness-tui/dsh-tui/sessions/list
 */
import { basename } from 'node:path'
import { beginListingSnapshot } from './snapshot.js'
import {
  digestAppendedSuffix,
  digestSession,
  sessionTitleAnchor,
} from './digest.js'
import { fileFacts } from './frames.js'
import { scheduleTitleRecovery, titleRecoveryNeedsWork } from './recovery.js'
import { classify, readHeader, type RawSessionHeader } from './header.js'
import { findSessionLogFile, resolveLocatedPath } from '../compat/sessionLog.js'
import { indexFileStamp, readIndex, writeIndex, type DerivedEntry, type SessionIndex } from './store.js'
import type { SessionSummary } from './types.js'
import { readLastUsed } from '../../sessionHistory.js'

/** A late overlapping listing must not write an older index over a newer one. */
const listingVersions = new WeakMap<object | symbol, number>()
/** Large append batches use bounded windows, then background title recovery. */
const FOREGROUND_SUFFIX_BYTES = 2 * 1024 * 1024

/**
 * The slice of `ctx.sessionPersistence` this module uses.
 *
 * Structural and fully optional: the service is resolved from a running
 * context whose packages may be a version apart from ours, and a listing that
 * degrades is worth more than one that throws.
 */
export interface SessionSource {
  /** Public provider configuration scopes optional disk snapshots. */
  readonly name?: string
  readonly config?: unknown
  /** Stable through Context proxies, unlike the service wrapper object. */
  readonly identity?: symbol
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
    // Handle-based providers take an options object; legacy providers took a
    // bare signal. identity is part of the handle-based service contract.
    const headers = typeof source.identity === 'symbol'
      ? await (source.list as (options?: { signal?: AbortSignal }) => Promise<readonly unknown[]>).call(source, { signal })
      : await source.list(signal)
    return headers
      .map((raw): Listed | undefined => readSnapshot(raw) ?? bareListed(raw))
      .filter((entry): entry is Listed => entry !== undefined)
  }
  return []
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
  signal?: AbortSignal,
  onEnriched?: (summary: SessionSummary) => void,
  onPartial?: (summaries: readonly SessionSummary[]) => void,
): Promise<readonly SessionSummary[]> {
  const identity = source.identity ?? source
  const version = (listingVersions.get(identity) ?? 0) + 1
  listingVersions.set(identity, version)
  const saveSnapshot = beginListingSnapshot(source)
  // A failed enumeration is not a successful empty store. Let the screen keep
  // its snapshot beside an error instead of erasing it (including on disk).
  const listed = await enumerateSessions(source, signal)
  signal?.throwIfAborted()

  // Children are counted from the same listing rather than by walking logs:
  // lineage lives in the header, so a parent's sub-agent count is free.
  const children = new Map<string, number>()
  for (const entry of listed) {
    if (entry.header.origin !== 'subagent') continue
    const parent = entry.header.parentSession
    if (parent === undefined) continue
    children.set(parent, (children.get(parent) ?? 0) + 1)
  }

  const indexStamp = indexFileStamp()
  const index = readIndex()
  const next: SessionIndex = new Map()
  const lastUsed = readLastUsed()
  // Recent conversations lead cold partial batches; backend directory order
  // must not keep the useful rows behind thousands of old delegated runs.
  const activity = (entry: Listed): number => Math.max(index.get(entry.header.id)?.derived?.modifiedAt ?? 0, lastUsed[entry.header.id] ?? 0, entry.header.createdAt ?? 0)
  listed.sort((a, b) => activity(b) - activity(a))
  let changed = false
  const records: Array<{
    header: RawSessionHeader
    facts: ReturnType<typeof fileFacts>
    cached: ReturnType<typeof index.get>
    derived: DerivedEntry | undefined
  }> = []
  const summaryOf = ({ header, facts, cached, derived }: typeof records[number]): SessionSummary => ({
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
    createdAt: header.createdAt ?? derived?.modifiedAt ?? facts?.modifiedAt ?? 0,
    updatedAt: Math.max(derived?.modifiedAt ?? facts?.modifiedAt ?? 0, lastUsed[header.id] ?? 0, header.createdAt ?? 0),
    bytes: derived?.bytes ?? facts?.bytes,
    // Without a readable artifact nothing can be proven empty, and hiding a
    // real session is the worse error — so an unreadable log is listed.
    hasPrompt: derived?.hasPrompt ?? true,
    agentPreset: header.agentPreset,
    model: derived?.model,
    label: derived?.label,
    branch: cached?.branch,
    childCount: children.get(header.id) ?? 0,
  })
  const recordsById = new Map<string, typeof records[number]>()
  const earlyEnrichments = new Map<string, DerivedEntry>()
  let summariesReady = false
  const notifyEnriched = (id: string, enriched: DerivedEntry): void => {
    if (!summariesReady) {
      earlyEnrichments.set(id, enriched)
      return
    }
    const record = recordsById.get(id)
    if (record === undefined || record.derived?.revision !== enriched.revision) return
    record.derived = enriched
    onEnriched?.(summaryOf(record))
  }
  const scanWork: Array<{
    id: string
    revision: string
    path: string
    bytes: number
    stamp: string
    priority: number
  }> = []

  for (const { header, raw, revision } of listed) {
    const cached = index.get(header.id)
    let facts: ReturnType<typeof fileFacts>
    let derived = cached?.derived
    let path: string | undefined
    if (revision !== undefined && derived?.revision === revision && derived.modifiedAt === undefined) {
      // Schema v3 held the same derived facts but not mtime. Upgrade that
      // record with one metadata read rather than re-decoding its log.
      path = locate(source, raw, header.id)
      facts = path === undefined ? undefined : fileFacts(path)
      derived = { ...derived, modifiedAt: facts?.modifiedAt ?? 0 }
      changed = true
    }
    // The backend's opaque revision is authoritative. A hit does not even
    // resolve a path; incomplete titles are handled by the recovery queue.
    if (revision === undefined || derived === undefined || derived.revision !== revision) {
      path = locate(source, raw, header.id)
      facts = path === undefined ? undefined : fileFacts(path)
      // Older persistence implementations provide no revision. Their one
      // metadata read per entry remains necessary to detect changes.
      const token = revision ?? facts?.stamp
      if (facts !== undefined && derived?.artifactStamp === facts.stamp) {
        // Historical logical revisions include the whole corpus. Our digest
        // reads only this artifact. Retain the original revision as well so
        // unrelated appends cannot restart title recovery or reset its backoff.
        // Only fallback text depends on the freshly enumerated header.
        const fallback = basename(header.cwd ?? '')
        if (derived.titleSource === 'fallback' && derived.title !== fallback) {
          derived = { ...derived, title: fallback }
          changed = true
        }
      } else if (token === undefined || derived?.revision !== token) {
        derived = undefined
        if (cached?.derived !== undefined) changed = true
        if (path !== undefined && token !== undefined) {
          const previous = cached?.derived
          const appendGrowth = (
            facts !== undefined && previous?.identity !== undefined &&
            previous.identity === facts.identity && previous.anchor !== undefined &&
            facts.bytes > previous.bytes &&
            await sessionTitleAnchor(path, previous.bytes, signal) === previous.anchor
          )
          if (appendGrowth && facts !== undefined && previous !== undefined && facts.bytes - previous.bytes <= FOREGROUND_SUFFIX_BYTES) {
            const suffix = await digestAppendedSuffix(path, previous.bytes, facts.bytes, signal)
            if (suffix.complete) {
              derived = {
                revision: token,
                bytes: facts.bytes,
                modifiedAt: facts.modifiedAt,
                identity: facts.identity,
                artifactStamp: facts.stamp,
                anchor: await sessionTitleAnchor(path, facts.bytes, signal),
                title: suffix.title?.text ?? previous.title,
                titleSource: suffix.title?.source ?? previous.titleSource,
                titleComplete: suffix.title !== undefined || previous.titleComplete,
                hasPrompt: previous.hasPrompt || suffix.hasHumanPrompt,
                model: suffix.model ?? previous.model,
                label: suffix.label ?? previous.label,
              }
            }
          }
          if (derived === undefined) {
            const digest = digestSession(path, header.cwd ?? '')
            const carried = appendGrowth && digest.titleComplete !== true ? previous : undefined
            derived = {
              revision: token,
              bytes: facts?.bytes ?? 0,
              modifiedAt: facts?.modifiedAt,
              identity: facts?.identity,
              artifactStamp: facts?.stamp,
              anchor: facts === undefined ? undefined : await sessionTitleAnchor(path, facts.bytes, signal),
              title: carried?.title ?? digest.title?.text ?? '',
              titleSource: carried?.titleSource ?? digest.title?.source ?? 'fallback',
              titleComplete: digest.titleComplete === true,
              hasPrompt: digest.hasPrompt,
              model: digest.model ?? carried?.model,
              label: digest.label ?? carried?.label,
            }
          }
          changed = true
        }
      }
    }
    if (
      derived !== undefined && !derived.titleComplete && signal?.aborted !== true &&
      titleRecoveryNeedsWork(header.id, derived.revision, enriched => notifyEnriched(header.id, enriched))
    ) {
      // A revision hit still may need enrichment, but locating that rare log
      // stays off the ordinary warm path once recovery has been scheduled.
      if (path === undefined) path = locate(source, raw, header.id)
      if (facts === undefined && path !== undefined) facts = fileFacts(path)
      if (path !== undefined && facts !== undefined && derived.bytes === facts.bytes) {
        scanWork.push({
          id: header.id,
          revision: derived.revision,
          path,
          bytes: facts.bytes,
          stamp: facts.stamp,
          priority: Math.max(facts.modifiedAt, lastUsed[header.id] ?? 0, header.createdAt ?? 0),
        })
      }
    }
    // Carry every entry that holds anything worth keeping — including a pure
    // cache hit, which must survive into the next index or the following
    // listing would re-derive everything it just reused.
    if (derived !== undefined || cached?.branch !== undefined) {
      next.set(header.id, { derived, branch: cached?.branch })
    }
    const record = { header, facts, cached, derived }
    records.push(record)
    recordsById.set(header.id, record)
    // Yield even for a cold index: scanning many individually bounded logs
    // must not freeze the renderer. Partial rows are never saved as a snapshot.
    if (records.length % 32 === 0) {
      if (listingVersions.get(identity) === version) onPartial?.(records.map(summaryOf).sort(compareSummaries))
      await new Promise<void>(resolve => setImmediate(resolve))
      signal?.throwIfAborted()
    }
  }
  // Entries for sessions the backend no longer lists are dropped here; that is
  // the whole of the cache's garbage collection, and it runs on every listing.
  signal?.throwIfAborted()
  const newest = listingVersions.get(identity) === version
  if (newest && (changed || next.size !== index.size) && indexFileStamp() === indexStamp) writeIndex(next)

  for (const [id, enriched] of earlyEnrichments) {
    const record = recordsById.get(id)
    if (record?.derived?.revision === enriched.revision) record.derived = enriched
  }
  const summaries: SessionSummary[] = records.map(summaryOf)
  summariesReady = true

  if (newest) {
    for (const work of scanWork) {
      scheduleTitleRecovery(work, derived => notifyEnriched(work.id, derived))
    }
  }

  // A total order, not just a sort key. `updatedAt` is dominated by the log's
  // mtime, and sessions written inside the same millisecond tie on it — which
  // would leave their relative order down to whatever the backend happened to
  // enumerate first, so the same history could list differently twice in a
  // row. Creation time breaks the tie, and the id breaks that.
  summaries.sort(compareSummaries)
  if (newest) saveSnapshot(summaries)
  return summaries
}

function compareSummaries(left: SessionSummary, right: SessionSummary): number {
  return right.updatedAt - left.updatedAt || right.createdAt - left.createdAt ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
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
