import React from 'react'
import { Box, Text, NoSelect, type ScrollBoxHandle } from '../ui.js'
import { RAIL_MIN_TERMINAL_WIDTH, RAIL_WIDTH } from '../ink/timeline-rail.js'

/** Thumb glyph across the 2-col gutter: solid, clearly positional —
 *  deliberately distinct from the timeline's ━━ active tick. */
const THUMB = '██'

/**
 * Proportional scrollbar for the fullscreen transcript's gutter — the
 * `scrollbar` option of the `dsh-tui.scrollGutter` setting (the timeline
 * rail's sibling; same 2-column slot, same chrome rules):
 *
 *  - the thumb (██) shows the visible window's position AND size over the
 *    whole content (viewport²/content tall, positioned by scrollTop);
 *  - clicking the track scrolls the clicked position to the viewport top
 *    (classic scrollbar semantics — the thumb centers under the click
 *    through the follow-up renders);
 *  - the gutter is permanent while scrollable (Qwen's rule: an
 *    auto-hiding gutter that changes content width rewraps everything);
 *    hidden below 60 terminal columns or when the content fits (inline
 *    mode keeps the terminal's native scrollback);
 *  - NoSelect fences the glyphs out of click-drag text selection; the
 *    wheel over the gutter scrolls the transcript.
 *
 * Thumb dragging is intentionally NOT implemented (Grok's MVP rule): a
 * proportional thumb encodes position, and the tick rail remains the
 * semantic navigator. Click-to-position covers the same need.
 */
export function ScrollbarGutter({
  handle,
  terminalWidth,
}: {
  handle: ScrollBoxHandle | null
  terminalWidth: number
}): React.ReactNode {
  const [, setTick] = React.useState(0)
  React.useEffect(() => {
    if (!handle) return
    return handle.subscribe(() => setTick(t => t + 1))
  }, [handle])

  if (!handle) return null
  const viewport = handle.getViewportHeight()
  const content = handle.getScrollHeight()
  const maxScroll = Math.max(0, content - viewport)
  if (viewport < 2 || content <= viewport || terminalWidth < RAIL_MIN_TERMINAL_WIDTH) return null

  // Thumb: the visible window mapped onto the gutter. Height proportional
  // to the visible fraction (≥2 rows so it is always grabbable-looking);
  // top follows scrollTop over the scroll range.
  const thumbH = Math.max(2, Math.round((viewport * viewport) / content))
  const trackH = Math.max(1, viewport - thumbH)
  const thumbTop = Math.round((handle.getScrollTop() / Math.max(1, maxScroll)) * trackH)
  const thumbBottom = Math.min(viewport, thumbTop + thumbH)

  // Clicking the track maps the clicked row's position on the track back
  // to a scrollTop and scrolls that content position to the viewport top.
  const trackScrollTop = (y: number): number => {
    if (y <= 0) return 0
    if (y >= trackH) return maxScroll
    return Math.round((y / trackH) * maxScroll)
  }

  const rows: React.ReactNode[] = []
  for (let y = 0; y < viewport; y++) {
    const inThumb = y >= thumbTop && y < thumbBottom
    rows.push(
      <Box
        key={y}
        height={1}
        flexShrink={0}
        onClick={() => handle.scrollTo(trackScrollTop(y))}
      >
        <Text color={inThumb ? 'inactive' : undefined}>{inThumb ? THUMB : '  '}</Text>
      </Box>,
    )
  }

  return (
    <NoSelect fromLeftEdge>
      {/* Raw ink-box (not the themed Box): onWheel is a host-level prop
          (same as ScrollBox's viewport) — wheel over the gutter scrolls
          the transcript, the gutter has no scroll of its own. */}
      <ink-box
        onWheel={e => {
          if (e.deltaY !== 0) handle.scrollBy(e.deltaY)
        }}
        style={{ flexDirection: 'column', flexShrink: 0, width: RAIL_WIDTH }}
      >
        {rows}
      </ink-box>
    </NoSelect>
  )
}
