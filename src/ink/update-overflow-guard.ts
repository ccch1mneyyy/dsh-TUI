/**
 * Self-healing guard for React's nested-update overflow — Minified React
 * error #185 ("Maximum update depth exceeded").
 *
 * WHY THIS EXISTS — the crash is a ratchet, not a single bad component.
 * react-reconciler counts consecutive commits that each end with more
 * pending Sync/InputContinuous/Default-lane updates on the same root
 * (`nestedUpdateCount`); once 50 commits pass without one that drains the
 * queue, the NEXT update enqueue throws #185 — from whichever timer or
 * store notification happens to fire first, which is why the stack points
 * at an innocent animation tick while the actual oscillating component is
 * someone else entirely (the upstream fork lineage hit this repeatedly:
 * Divider measure loops, MessageList streaming measure cascades, and the
 * sibling projects' identical fixes — Vercel ink's useBoxMetrics deferral
 * and claude-code's SyntaxHighlightedDiff loop).
 *
 * The throw is SELF-HEALING BY CONTRACT: `getRootForUpdatedFiber` resets
 * `nestedUpdateCount` to 0 and clears `rootWithNestedUpdates` *before*
 * throwing, so swallowing exactly this error class skips at most one frame
 * of animation while the next commit starts from a clean counter. That
 * turns a process-killing crash into a dropped tick plus a rate-limited
 * diagnostic breadcrumb naming the enqueue site that surfaced it.
 *
 * This guard deliberately does NOT swallow anything else: unknown errors
 * rethrow unchanged.
 */

import { logError } from '../utils/log.js'

/** Message fragments that identify the nested-update overflow error. */
const OVERFLOW_MARKERS = ['Minified React error #185', 'Maximum update depth'] as const

/** Window for log rate limiting (ms): first hit logs, the rest just count. */
const LOG_WINDOW_MS = 10_000

/** Circuit breaker: same source tripping this many times inside one log
 * window is a SUSTAINED oscillation, not a one-off — absorbing alone would
 * leave the process alive but burning CPU on the oscillation's own commit
 * storm. Trip the source's quench (pause its timer) so "alive" cannot
 * degrade into "alive but very laggy". */
const TRIP_THRESHOLD = 5
/** First quench duration (ms); doubles per consecutive trip, capped. */
const TRIP_BACKOFF_BASE_MS = 5_000
const TRIP_BACKOFF_MAX_MS = 60_000

/** Quench action for a source: pause its notification channel for `ms`. */
export type OverflowQuench = (ms: number) => void
const quenches = new Map<string, OverflowQuench>()

/** Per-source state: log window + circuit-breaker bookkeeping. */
type SourceState = { windowStart: number; logged: boolean; count: number; trips: number; quenchUntil: number }
const sources = new Map<string, SourceState>()

/** Test seam: reset rate-limit bookkeeping. */
export function resetUpdateOverflowGuardForTest(): void {
  sources.clear()
}

/**
 * Register a circuit-breaker action for a source. When the source trips
 * (sustained oscillation), the quench pauses its notification channel for
 * the backoff window — the strongest self-healing the guard can do without
 * killing the process. Sources without a quench (data channels that must
 * not stall) only get the escalated ERROR log.
 */
export function registerOverflowQuench(source: string, quench: OverflowQuench): void {
  quenches.set(source, quench)
}

/**
 * Whether an error is the nested-update overflow (#185) — by message, the
 * only signal the production build exposes.
 */
export function isNestedUpdateOverflow(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return OVERFLOW_MARKERS.some(marker => error.message.includes(marker))
}

/**
 * Swallow the nested-update overflow error, logging (rate-limited, with a
 * running count per window) which enqueue site surfaced it. Any other error
 * returns false so callers rethrow it untouched.
 *
 * @param error - The caught error from a subscriber/enqueue notification.
 * @param source - Stable label naming the enqueue site (for the log line).
 * @returns true when the error was the overflow and has been absorbed.
 */
export function swallowNestedUpdateOverflow(error: unknown, source: string): boolean {
  if (!isNestedUpdateOverflow(error)) return false
  const now = Date.now()
  let state = sources.get(source)
  if (state === undefined || now - state.windowStart >= LOG_WINDOW_MS) {
    state = { windowStart: now, logged: false, count: 0, trips: state?.trips ?? 0, quenchUntil: state?.quenchUntil ?? 0 }
    sources.set(source, state)
  }
  state.count += 1
  if (!state.logged) {
    state.logged = true
    logError(
      new Error(
        `Recovered from React nested-update overflow (#185) at ${source} — ` +
          `dropped 1 update, counter reset by React. If this repeats, a ` +
          `component is oscillating state updates in a tight commit chain.`,
      ),
    )
  }
  // Circuit breaker: a SUSTAINED oscillation keeps re-filling React's
  // counter between absorptions. Swallowing alone would keep the process
  // alive while the oscillation's commit storm burns the CPU ("alive but
  // laggy"). Trip the quench instead: pause the source's channel for an
  // escalating window, freezing at most an animation, never data.
  if (state.count >= TRIP_THRESHOLD && now >= state.quenchUntil) {
    state.trips += 1
    const ms = Math.min(TRIP_BACKOFF_BASE_MS * 2 ** (state.trips - 1), TRIP_BACKOFF_MAX_MS)
    state.quenchUntil = now + ms
    state.count = 0
    const quench = quenches.get(source)
    if (quench !== undefined) {
      quench(ms)
      logError(
        new Error(
          `Sustained rendering oscillation at ${source} (#185 x${TRIP_THRESHOLD} in ${LOG_WINDOW_MS / 1000}s) — ` +
            `its channel is PAUSED for ${ms / 1000}s to break the loop ` +
            `(trip #${state.trips}, backoff doubles; animations freeze, no data loss). ` +
            `This is a bug: please report the component involved.`,
        ),
      )
    } else {
      logError(
        new Error(
          `SUSTAINED rendering oscillation at ${source} (#185 x${TRIP_THRESHOLD} in ${LOG_WINDOW_MS / 1000}s, ` +
            `trip #${state.trips}) — no quench registered for this source, absorbing only. ` +
            `This is a bug: please report the component involved.`,
        ),
      )
    }
  }
  return true
}

/**
 * Invoke a notification callback with the overflow guard applied. The
 * callback's own non-overflow errors propagate unchanged.
 *
 * @param source - Stable label naming the enqueue site (for the log line).
 * @param onChange - The subscriber callback about to run.
 */
export function callWithUpdateOverflowGuard(source: string, onChange: () => void): void {
  try {
    onChange()
  } catch (error) {
    if (swallowNestedUpdateOverflow(error, source)) return
    throw error
  }
}

/**
 * Process-level backstop for the overflow error. The hotspot guards above
 * cover the known enqueue sites (clock tick, reveal tick, channel emit,
 * scroll/selection notify), but the throw surfaces from whichever timer or
 * microtask dispatches next — any not-yet-guarded path (a script's own
 * feeder, a future timer, a plugin's store) would still kill the process.
 * This installs uncaughtException/unhandledRejection handlers that absorb
 * exactly the overflow error class (same self-healing contract: React
 * already reset the counter before throwing) and rethrow everything else
 * unchanged. Idempotent; opt out with DSH_TUI_NO_185_PROCESS_GUARD=1 when a
 * host owns process error policy.
 */
let processGuardInstalled = false
export function installNestedUpdateOverflowProcessGuard(): void {
  if (processGuardInstalled) return
  if (process.env.DSH_TUI_NO_185_PROCESS_GUARD === '1') return
  processGuardInstalled = true
  process.on('uncaughtException', error => {
    if (swallowNestedUpdateOverflow(error, 'process.uncaught')) return
    // Unknown errors keep Node's default semantics: rethrowing from a
    // listener crashes the process with the original error.
    throw error
  })
  process.on('unhandledRejection', error => {
    if (swallowNestedUpdateOverflow(error, 'process.rejection')) return
    throw error as Error
  })
}
