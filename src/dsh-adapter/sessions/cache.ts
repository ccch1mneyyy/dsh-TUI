/**
 * Process-level memo over the persisted-session listing.
 *
 * Every open of `/resume` (and every agent-view refresh) re-ran the whole
 * listing pipeline: the backend enumeration, one `resolveLocatedPath` + one
 * `stat` per session, an index parse, and a last-used parse — tens of
 * milliseconds per hundred sessions even on a warm index, and the backend's
 * own `listSnapshots` work again on top. Measured by
 * `scripts/perf-session-scan.ts` (issue #987): a warm 200-session open costs
 * ~30 ms of TUI-side pipeline with an idealized backend, scaling linearly,
 * and nothing in the pipeline depends on work done since the previous one.
 *
 * Correctness argument. A summary is a pure function of the backend headers,
 * the derived index, and `last-used.json`. The listing rebuilds the index
 * from scratch and writes it atomically, so an unchanged `(mtime, size)` on
 * `session-index.json` and `last-used.json` means byte-identical inputs from
 * both files, and the memoized summaries are exactly what a fresh listing
 * would re-derive from them. Headers are NOT re-checked — that is the point:
 * skipping the backend call is where the win lives — so a header written by
 * another process (a session created on dsh web, a fork in a sibling
 * terminal) stays invisible for at most one consistency window,
 * {@link LISTING_MEMO_TTL_MS}. The window is a freshness bound, not a
 * correctness condition: the cache holds only projections of the durable
 * logs, every consumer can bypass it ({@link listSummariesCached} with
 * `bypass`, the supervisor's Ctrl+L), and deleting `session-index.json`
 * degrades to the pre-memo behavior with nothing else changed.
 *
 * Shape: one immutable slot, replaced per listing — no per-session objects,
 * no timers (the TTL is checked lazily on read), no handles, nothing to
 * dispose. Writers that move the underlying files themselves (a listing
 * rewriting the index, `touchSession` bumping last-used) invalidate the slot
 * through the fingerprint; log mutations that no fingerprint can see (the
 * picker's rename append and delete) call {@link invalidateListedSessions}
 * explicitly.
 *
 * @module @deepseek-harness-tui/dsh-tui/sessions/cache
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../../utils/paths.js'
import { listSummaries, type SessionSource } from './list.js'
import type { SessionSummary } from './types.js'

/**
 * How long a memoized listing may serve without re-asking the backend for
 * headers. Bounds the visibility window of sessions created elsewhere; inside
 * it, unchanged index/last-used fingerprints still guarantee fresh derived
 * facts (a rename by another TUI invalidates through the index rewrite).
 */
const LISTING_MEMO_TTL_MS = 3_000

const INDEX_FILE = join(DATA_DIR, 'session-index.json')
const LAST_USED_FILE = join(DATA_DIR, 'last-used.json')

/** `(mtime, size)` of one cache file, or undefined when it does not exist. */
function fingerprint(path: string): string | undefined {
  try {
    const stats = statSync(path)
    return `${stats.mtimeMs}:${stats.size}`
  } catch {
    return undefined
  }
}

interface ListingMemo {
  readonly summaries: readonly SessionSummary[]
  readonly builtAt: number
  readonly index: string | undefined
  readonly lastUsed: string | undefined
}

let memo: ListingMemo | undefined
let inFlight: Promise<readonly SessionSummary[]> | undefined

/** True when the slot exists, is inside its TTL, and its file inputs stand. */
function fresh(): ListingMemo | undefined {
  if (memo === undefined) return undefined
  if (Date.now() - memo.builtAt >= LISTING_MEMO_TTL_MS) return undefined
  if (fingerprint(INDEX_FILE) !== memo.index) return undefined
  if (fingerprint(LAST_USED_FILE) !== memo.lastUsed) return undefined
  return memo
}

/**
 * The last listing's summaries, served synchronously.
 *
 * The snapshot-then-refresh seam for the session supervisor: painting this
 * before the (possibly slow) refresh starts is what removes the picker's
 * cold-start blank. The snapshot consults neither the TTL nor the
 * fingerprints, so it may be older than one consistency window — staleness
 * ends where the refresh that immediately follows lands, and every action
 * still re-verifies against the real store. Undefined before the first
 * listing.
 */
export function cachedListedSessions(): readonly SessionSummary[] | undefined {
  return memo?.summaries
}

/** Drop the memoized listing. Called when this process mutates a log in a way no fingerprint can observe. */
export function invalidateListedSessions(): void {
  memo = undefined
}

/**
 * Memoized {@link listSummaries}.
 *
 * Concurrent callers share one in-flight listing, so the supervisor opening
 * and an agent-view refresh firing together cost one pipeline, not two.
 * `bypass` skips the memo read (an explicit reload such as Ctrl+L) but still
 * joins an in-flight listing — one that started moments ago is fresh by
 * construction.
 *
 * @param source - The persistence service.
 * @param options - `bypass` forces a fresh listing; `signal` cancels the
 *   backend's own listing work (a cancelled result is not memoized).
 */
export async function listSummariesCached(
  source: SessionSource,
  options: { bypass?: boolean; signal?: AbortSignal } = {},
): Promise<readonly SessionSummary[]> {
  if (!options.bypass) {
    const hit = fresh()
    if (hit !== undefined) return hit.summaries
  }
  if (inFlight !== undefined) return inFlight
  const listing = (async (): Promise<readonly SessionSummary[]> => {
    try {
      const summaries = await listSummaries(source, options.signal)
      // A listing that was cancelled mid-flight has no claim on being the
      // freshest view; only a completed one may take the slot.
      if (options.signal?.aborted !== true) {
        memo = {
          summaries,
          builtAt: Date.now(),
          index: fingerprint(INDEX_FILE),
          lastUsed: fingerprint(LAST_USED_FILE),
        }
      }
      return summaries
    } finally {
      inFlight = undefined
    }
  })()
  inFlight = listing
  return listing
}
