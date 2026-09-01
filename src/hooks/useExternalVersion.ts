import React from 'react'

/**
 * Subscribe to an external store's version counter at DEFAULT lane.
 *
 * Deliberately NOT useSyncExternalStore for HIGH-FREQUENCY stores: a store
 * change forces a SYNCLANE re-render (forceStoreRerender hardcodes lane 2),
 * and during streaming that sync render preempts/discards whatever
 * DefaultLane render is in flight. Every such sync commit then ends with
 * Default work still pending, which React's commit-end lane accounting
 * counts as a NESTED update with no reset — 50 consecutive dirty commits
 * throw error #185 from whichever timer dispatches next, killing the
 * process (the beta.3 crash; same mechanism as useRevealVersion in
 * PR #680, which fixed the reveal store half of it).
 *
 * A manual subscription dispatches setState from the notification callback
 * at DEFAULT lane instead: the wakeup coalesces into the in-flight render
 * instead of preempting it, commits end clean, and the counter resets.
 *
 * The store's DATA stays synchronous to read during render (callers read
 * the store directly — rows, status, whatever); the version number is only
 * a render trigger, its value carries no meaning. This is safe against a
 * one-beat-stale version: the next wakeup re-reads fresh data, and version
 * counters are monotonic. Not a general useSyncExternalStore replacement —
 * use it for version-counter wakeups where the caller re-reads the store
 * during render anyway (mirrors the tearing analysis in useRevealVersion).
 *
 * @param subscribe - Store subscribe(fn) → unsubscribe.
 * @param getVersion - Returns the store's monotonic version counter.
 * @param enabled - Pass false to idle (no subscription).
 * @returns The version number (trigger only; may trail by one wakeup).
 */
export function useExternalVersion(
  subscribe: (listener: () => void) => () => void,
  getVersion: () => number,
  enabled: boolean = true,
): number {
  const [version, setVersion] = React.useState(getVersion)
  // Latest-refs, NOT effect deps: callers pass inline closures (e.g.
  // `() => channel.version`), and a fresh reference per render would re-run
  // the effect after EVERY render — re-subscribing and dispatching
  // setVersion(getVersion()) from the passive effect. On a slow machine
  // (CI) each re-run can land while the version changed again, chaining
  // passive updates until React's dev-build nested-update check throws
  // "Maximum update depth exceeded". Subscribe exactly once per enabled
  // window; the listener reads the fresh getter through the ref.
  const latest = React.useRef({ subscribe, getVersion })
  latest.current = { subscribe, getVersion }
  React.useEffect(() => {
    if (!enabled) return
    // Catch up on any store change between the first render and this
    // effect's mount — the subscription alone would miss it.
    setVersion(latest.current.getVersion())
    return latest.current.subscribe(() => setVersion(latest.current.getVersion()))
  }, [enabled])
  return version
}
