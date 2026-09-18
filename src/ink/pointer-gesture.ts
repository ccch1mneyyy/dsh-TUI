/**
 * Pointer-gesture latch as a subscribable store.
 *
 * While a physical button is held (drag-select in progress), the renderer
 * stops dispatching hover events — a hover-driven floating card that is
 * already on screen therefore never sees its `onMouseLeave` and stays
 * frozen over the text the user is trying to select. Ink cannot call into
 * React component state, so the latch is published here and hover-card
 * owners (TooltipLayer, TimelineRail's preview card, ScrollbarGutter's
 * position chip) subscribe and dismiss themselves on the rising edge.
 *
 * Writer: `Ink.setPointerGestureActive` (the App `onPointerGestureChange`
 * callback). Readers: `useSyncExternalStore` consumers in components.
 */
let active = false
const listeners = new Set<() => void>()

/** Subscribe to gesture latch changes; returns an unsubscribe function. */
export function subscribePointerGesture(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Stable snapshot for useSyncExternalStore (boolean identity). */
export function getPointerGestureSnapshot(): boolean {
  return active
}

/** Publish the latch state. Notifies only on actual transitions. */
export function setPointerGestureActive(next: boolean): void {
  if (next === active) return
  active = next
  for (const listener of listeners) listener()
}
