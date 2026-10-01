import React from 'react'
import { useTerminalSize, type Key, type ScrollBoxHandle } from '../ui.js'
import type { DOMElement } from '../ink/dom.js'
import measureElement from '../ink/measure-element.js'
import wrapText from '../ink/wrap-text.js'

/** Shared horizontal inset for approval and questionnaire panels. */
export const INTERACTION_PANEL_PADDING = 2

export function isInteractionScrollKey(key: Key): boolean {
  return key.pageUp || key.pageDown || key.wheelUp || key.wheelDown
}

/**
 * Bounded interaction body: measure the host's actual width, count wrapped
 * terminal rows and route paging to the body without changing answer focus.
 * Panels reserve their decision/input rows before assigning the body height.
 * Chat owns input priority; callers invoke scrollInput inside their existing
 * handler so collapsed panels and fold shortcuts retain their ordering.
 */
export function useInteractionViewport(maxHeight?: number) {
  const { rows, columns } = useTerminalSize()
  const panelRef = React.useRef<DOMElement | null>(null)
  const scrollRef = React.useRef<ScrollBoxHandle | null>(null)
  const [measuredWidth, setMeasuredWidth] = React.useState<number | null>(null)
  React.useLayoutEffect(() => {
    if (panelRef.current === null) return
    const width = measureElement(panelRef.current).width
    if (width > 0 && width !== measuredWidth) setMeasuredWidth(width)
  })

  const contentWidth = Math.max(1, (measuredWidth ?? columns) - 2 * INTERACTION_PANEL_PADDING)
  const budget = Math.max(1, Math.min(rows, maxHeight ?? rows))
  const lineCount = (text: string, width = contentWidth): number =>
    wrapText(text, width, 'wrap').split('\n').length
  const scrollInput = (key: Key): boolean => {
    if (!isInteractionScrollKey(key)) return false
    const handle = scrollRef.current
    if (key.pageUp || key.pageDown) {
      const page = Math.max(1, (handle?.getViewportHeight() ?? 1) - 1)
      // Absolute paging clears outstanding wheel motion immediately.
      handle?.scrollTo(handle.getScrollTop() + (key.pageUp ? -page : page))
    } else {
      handle?.scrollBy(key.wheelUp ? -3 : 3)
    }
    return true
  }

  return { panelRef, scrollRef, contentWidth, budget, lineCount, scrollInput }
}
