import type { DOMElement } from '../ink/dom.js'
import { useAnimationFrame } from '../ink/hooks/use-animation-frame.js'
import { useTerminalFocus } from '../ink/hooks/use-terminal-focus.js'

const BLINK_INTERVAL_MS = 600

/**
 * Hook for synchronized blinking animations that pause when offscreen
 * (ported from the leak's `src/hooks/useBlink.ts`).
 *
 * @param enabled - Whether blinking is active
 * @param intervalMs - Blink cycle length in ms; defaults to 600.
 * @returns [ref, isVisible] - Ref to attach to element, true when visible in blink cycle
 */
export function useBlink(
  enabled: boolean,
  intervalMs: number = BLINK_INTERVAL_MS,
): [ref: (element: DOMElement | null) => void, isVisible: boolean] {
  const focused = useTerminalFocus()
  const [ref, time] = useAnimationFrame(enabled && focused ? intervalMs : null)

  if (!enabled || !focused) return [ref, true]

  // Derive blink state from time - all instances see the same time so they sync
  const isVisible = Math.floor(time / intervalMs) % 2 === 0
  return [ref, isVisible]
}
