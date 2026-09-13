/**
 * Replay-shadow isolation.
 *
 * Replay Shadow is only allowed inside an explicitly entered isolated replay
 * harness. This module is intentionally not re-exported through the kernel
 * public index: production code cannot accidentally enable replay semantics.
 *
 * The isolation is an explicit, scoped harness context rather than a mutable
 * process-global boolean:
 *
 * - `withReplayIsolation(callback)` runs `callback` inside an
 *   AsyncLocalStorage context. The context lasts only for that callback's
 *   async work; a thrown/rejected callback cannot leave a global permit
 *   behind.
 * - `enterReplayIsolation()` may only be called while already inside a
 *   `withReplayIsolation` scope (for nested leases). Calling it outside the
 *   scope throws, so a forgotten release cannot accidentally enable replay
 *   semantics on a real host.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

interface ReplayIsolationState {
  depth: number
}

const replayIsolationStorage = new AsyncLocalStorage<ReplayIsolationState>()

/** Run a callback inside an explicitly isolated replay context. */
export function withReplayIsolation<T>(callback: () => T): T {
  return replayIsolationStorage.run({ depth: 1 }, callback)
}

/** Enter a nested replay-isolation lease. Must be called inside a
 * `withReplayIsolation` scope; returns a disposer that decrements the depth. */
export function enterReplayIsolation(): () => void {
  const state = replayIsolationStorage.getStore()
  if (state === undefined) {
    throw new Error(
      'dsh-tui: replay isolation must be entered through withReplayIsolation() or runReplayShadow(); a process-global replay permit is not allowed',
    )
  }
  state.depth += 1
  let released = false
  return () => {
    if (released) return
    released = true
    state.depth -= 1
  }
}

/** True while an isolated replay context is active in the current async chain. */
export function isReplayIsolationActive(): boolean {
  return (replayIsolationStorage.getStore()?.depth ?? 0) > 0
}
