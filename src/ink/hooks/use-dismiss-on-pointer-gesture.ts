import { useEffect, useRef } from 'react'
import { getPointerGestureSnapshot, subscribePointerGesture } from '../pointer-gesture.js'

/**
 * Dismiss a hover-driven floating card when a pointer gesture starts.
 *
 * While a physical button is held (drag-select in progress), the renderer
 * stops dispatching hover events — a card that is already on screen never
 * sees its `onMouseLeave` and stays frozen over the text the user is trying
 * to select. Every hover-card owner (tooltip layer, rail preview card,
 * scrollbar chip) needs the same rising-edge dismissal, which is this hook.
 *
 * @param dismiss - clears the card AND its pending dwell timer. Stored in a
 *   ref, so an inline closure is fine and never re-subscribes.
 */
export function useDismissOnPointerGesture(dismiss: () => void): void {
  const dismissRef = useRef(dismiss)
  dismissRef.current = dismiss
  useEffect(() => {
    return subscribePointerGesture(() => {
      if (getPointerGestureSnapshot()) dismissRef.current()
    })
  }, [])
}
