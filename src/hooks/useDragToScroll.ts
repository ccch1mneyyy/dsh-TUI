import React from 'react'
import { useSelection } from '../ink/hooks/use-selection.js'
import type { ScrollBoxHandle } from '../ui.js'

/** Rows scrolled per tick, and the tick period, while a drag holds at an edge. */
const STEP_ROWS = 2
const TICK_MS = 50

/**
 * Scroll the transcript while a selection drag sits on its top or bottom edge
 * (or past it, over the prompt), so a selection can grow beyond one screen
 * (#1272). Each tick captures the selected rows about to leave the viewport,
 * moves the anchor with its text, and scrolls with `scrollTo`, which the
 * renderer does not treat as a follow-scroll: the focus stays under the
 * pointer instead of being carried off-screen with the text.
 * @param box - The transcript scroll box; null until it mounts.
 */
export function useDragToScroll(box: ScrollBoxHandle | null): void {
  const { getState, subscribe, captureScrolledRows, shiftAnchor } = useSelection()
  React.useEffect(() => {
    if (box === null) return
    let timer: ReturnType<typeof setInterval> | undefined
    let dir = 0
    let last = { top: 0, bottom: 0 }
    const tick = (): void => {
      const top = box.getViewportTop()
      const bottom = top + box.getViewportHeight() - 1
      // Leaving the bottom mounts the sticky header, which pushes the viewport
      // (and its text) down. The renderer reads that as an edge resize and
      // leaves the anchor; a translate it already shifts itself.
      if (top !== last.top && bottom - top !== last.bottom - last.top) shiftAnchor(top - last.top, top, bottom)
      last = { top, bottom }
      const scrollTop = box.getScrollTop()
      const room = dir < 0 ? scrollTop : box.getScrollHeight() - box.getViewportHeight() - scrollTop
      const rows = Math.min(STEP_ROWS, room)
      if (rows <= 0) return
      if (dir < 0) captureScrolledRows(bottom - rows + 1, bottom, 'below')
      else captureScrolledRows(top, top + rows - 1, 'above')
      shiftAnchor(-dir * rows, top, bottom)
      box.scrollTo(scrollTop + dir * rows)
    }
    const sync = (): void => {
      const s = getState()
      const top = box.getViewportTop()
      const bottom = top + box.getViewportHeight() - 1
      // Only a drag that started on the transcript scrolls it; one in the
      // prompt or an overlay panel leaves the transcript alone.
      const row = s?.isDragging === true && s.anchor !== null && s.anchor.row >= top && s.anchor.row <= bottom
        ? s.focus?.row
        : undefined
      const next = row === undefined ? 0 : row <= top ? -1 : row >= bottom ? 1 : 0
      if (next === dir) return
      dir = next
      clearInterval(timer)
      last = { top, bottom }
      timer = dir === 0 ? undefined : setInterval(tick, TICK_MS)
    }
    const unsubscribe = subscribe(sync)
    return () => {
      unsubscribe()
      clearInterval(timer)
    }
  }, [box, getState, subscribe, captureScrolledRows, shiftAnchor])
}
