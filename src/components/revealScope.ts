import { createContext, useContext } from 'react'

/**
 * Which Chat root owns a reveal key. The reveal tables in `smoothReveal.ts`
 * are module-level (the transcript's memo/height pipeline reads them during
 * render), so two Chat roots — two renderers, two stdout streams, each with
 * its own agent and row ids — would otherwise share them: one root's rebind
 * reset wiped the other's completed keys and re-typewrote its history.
 *
 * `undefined` is the shared scope: scripts and tests that mount a transcript
 * without a Chat provider keep the single-root behaviour and bare keys.
 */
export const RevealScopeContext = createContext<string | undefined>(undefined)

/** The calling component's Chat root scope (`undefined` outside a provider). */
export function useRevealScope(): string | undefined {
  return useContext(RevealScopeContext)
}
