import React from 'react'
import { getRevealVersion, subscribeReveal } from '../components/smoothReveal.js'

/**
 * Reveal-frame wakeup as a React hook — bumps once per advancing ~30fps
 * scheduler tick so consumers re-run their render-phase cursor reads
 * ({@link revealTextOf}/{@link revealLinesOf}) and feed fresh slices through
 * the MemoRow prop pipeline. The returned number is a render trigger only;
 * its value carries no meaning.
 *
 * Deliberately NOT useSyncExternalStore: a store change forces a SYNCLANE
 * re-render (forceStoreRerender hardcodes lane 2), and at 30fps that sync
 * render preempts/discards whatever DefaultLane streaming render is in
 * flight. Every such sync commit then ends with Default work still pending,
 * which React's commit-end lane accounting counts as a NESTED update —
 * 50 consecutive dirty commits throw error #185 from whichever timer
 * dispatches next, killing the process (beta.3 crash). A manual subscription
 * dispatches setState from the tick callback at DEFAULT lane instead (no
 * current event → resolveEventPriority → DefaultEventPriority): the wakeup
 * coalesces into the in-flight render instead of preempting it, so ticks
 * collapse into one render per window and commits end clean.
 */
export function useRevealVersion(enabled: boolean = true): number {
  const [version, setVersion] = React.useState(getRevealVersion)
  React.useEffect(() => {
    if (!enabled) return
    // Catch up on any tick that fired between the first render and this
    // effect's mount — the subscription alone would miss it.
    setVersion(getRevealVersion())
    return subscribeReveal(() => setVersion(getRevealVersion()))
  }, [enabled])
  return version
}
