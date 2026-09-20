import React from 'react'
import { Box, Text, NoSelect, type ScrollBoxHandle } from '../ui.js'
import type { DragEvent } from '../ink/events/drag-event.js'
import { FRAME_INTERVAL_MS } from '../ink/constants.js'
import { RAIL_MIN_TERMINAL_WIDTH, RAIL_WIDTH } from '../ink/timeline-rail.js'

/** Thumb glyph across the 2-col gutter: solid, clearly positional —
 *  deliberately distinct from the timeline's ━━ active tick. */
const THUMB = '██'

/** Rest time before the hover position chip pops (anti-flash sweep gate). */
const CHIP_DWELL_MS = 250

/**
 * Post-landing settle reads (see the subscribe effect): how many deferred
 * re-reads follow a landing before giving up. The re-pinning Ink pass lands
 * a frame or two after the commit, so a single read can still catch the
 * pre-landing geometry — the bound only exists so a frame that never
 * settles cannot chain renders forever.
 */
const PIN_SETTLE_CHECKS = 3

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
 *  - dragging the track scrubs the transcript: the drag protocol's
 *    per-target localRow maps through the SAME trackScrollTop as a click
 *    (absolute mapping — drag to point, no grabbed thumb offset), so a
 *    drag is a continuous run of click-to-position jumps. The mapping only
 *    reads the render-time maxScroll/trackH and never re-reads scrollTop
 *    mid-gesture, so a throttled/clamped scrollTo cannot feed back into the
 *    pointer mapping (no jitter). Dragging the thumb therefore lands the
 *    pointer's row at the viewport top, exactly like clicking that row;
 *  - a landing (drag or the back-to-bottom affordance) breaks and re-pins
 *    sticky, which unmounts the chrome that had shrunk the transcript row;
 *    the re-pinning Ink pass follows the commit and fires no subscriber
 *    notify, so the gutter re-reads the handle once that frame lands (see
 *    the subscribe effect). Without it the thumb stays painted from the
 *    shrunken viewport and floats a few rows above the bottom until an
 *    unrelated render (hover) re-reads the handle;
 *  - the gutter is permanent while scrollable (Qwen's rule: an
 *    auto-hiding gutter that changes content width rewraps everything);
 *    hidden below 60 terminal columns or when the content fits (inline
 *    mode keeps the terminal's native scrollback);
 *  - NoSelect fences the glyphs out of click-drag text selection; the
 *    wheel over the gutter scrolls the transcript. Because the track is a
 *    drag target, an unmodified left drag scrubs instead of selecting, and
 *    multi-clicks on the track no longer feed the select-line chain;
 *    Shift/Alt/Ctrl drags never open a drag session and keep the
 *    selection path.
 */
export function ScrollbarGutter({
  handle,
  terminalWidth,
}: {
  handle: ScrollBoxHandle | null
  terminalWidth: number
}): React.ReactNode {
  const [, setTick] = React.useState(0)
  // Geometry the last render painted with. The Ink render pass runs AFTER
  // React's commit, so the commit that lands a pinned view can paint from
  // geometry that pass is about to change (see the subscribe effect).
  const geomRef = React.useRef('')
  // Hover readout: the row under the pointer brightens the thumb when it is
  // the hovered one, and floats a `62% · 340/540` chip left of the gutter
  // naming the position a click there would jump to. The chip is
  // dwell-gated (TimelineRail's preview-card rule): a sweep across the
  // track brightens rows but never pops chips — only ~250ms of rest does.
  // Once shown it follows row changes immediately; leaving hides it.
  const [hoverRow, setHoverRow] = React.useState<number | null>(null)
  const [chipRow, setChipRow] = React.useState<number | null>(null)
  const dwellTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearDwell = (): void => {
    if (dwellTimer.current !== null) {
      clearTimeout(dwellTimer.current)
      dwellTimer.current = null
    }
  }
  const clearChip = (): void => {
    clearDwell()
    setChipRow(null)
  }
  React.useEffect(() => clearDwell, [])
  React.useEffect(() => {
    if (!handle) return
    const readGeom = (): string =>
      `${handle.getScrollTop()}:${handle.getScrollHeight()}:${handle.getViewportHeight()}`
    let timer: ReturnType<typeof setTimeout> | null = null
    let checksLeft = 0
    // Landing settle re-read. Reaching the bottom breaks and then re-pins
    // sticky; the commit that consumes the notification paints while the
    // chrome that shrank the transcript row (`PinnedTurnHeader` +
    // "return to bottom" pill, both `!isSticky`) is still mounted, and the
    // NEXT Ink pass then grows the viewport back and re-pins scrollTop to
    // the taller maxScroll — with NO subscriber notify, because sticky
    // never flips again (ScrollBox's subscribe contract). Nothing would
    // re-read the handle, so the thumb stays painted from the shrunken
    // viewport and floats above the bottom until an unrelated render
    // (hover) rescues it. Re-read once that pass has landed and re-render
    // if the geometry moved; only pinned notifications arm this (a landing
    // is the one shape that can be re-pinned after the commit), so the
    // cost is a couple of timers per landing, never per scroll frame.
    const settle = (): void => {
      timer = null
      if (readGeom() !== geomRef.current) setTick(t => t + 1)
      if (--checksLeft > 0) timer = setTimeout(settle, FRAME_INTERVAL_MS)
    }
    const unsubscribe = handle.subscribe(() => {
      setTick(t => t + 1)
      if (!handle.isSticky()) return
      checksLeft = PIN_SETTLE_CHECKS
      if (timer === null) timer = setTimeout(settle, FRAME_INTERVAL_MS)
    })
    return () => {
      unsubscribe()
      if (timer !== null) clearTimeout(timer)
    }
  }, [handle])

  // Geometry the last COMMITTED render painted with: captured during render,
  // but the ref write happens in the layout effect below — this root is a
  // ConcurrentRoot, so a render pass can be discarded, and a render-phase
  // write would leak a frame that never painted into settle()'s diff.
  const viewport = handle === null ? 0 : handle.getViewportHeight()
  const content = handle === null ? 0 : handle.getScrollHeight()
  const scrollTop = handle === null ? 0 : handle.getScrollTop()
  const geom = handle === null ? null : `${scrollTop}:${content}:${viewport}`
  React.useLayoutEffect(() => {
    if (geom !== null) geomRef.current = geom
  }, [geom])

  if (!handle) return null
  const maxScroll = Math.max(0, content - viewport)
  if (viewport < 2 || content <= viewport || terminalWidth < RAIL_MIN_TERMINAL_WIDTH) return null

  // Thumb: the visible window mapped onto the gutter. Height proportional
  // to the visible fraction (≥2 rows so it is always grabbable-looking);
  // top follows scrollTop over the scroll range.
  const thumbH = Math.max(2, Math.round((viewport * viewport) / content))
  const trackH = Math.max(1, viewport - thumbH)
  const thumbTop = Math.round((scrollTop / Math.max(1, maxScroll)) * trackH)
  const thumbBottom = Math.min(viewport, thumbTop + thumbH)

  // Clicking the track maps the clicked row's position on the track back
  // to a scrollTop and scrolls that content position to the viewport top.
  // Dragging reuses the same mapping per motion through the drag protocol's
  // target-relative localRow (the outer track is the single drag target).
  const trackScrollTop = (y: number): number => {
    if (y <= 0) return 0
    if (y >= trackH) return maxScroll
    return Math.round((y / trackH) * maxScroll)
  }
  const applyDragRow = (event: DragEvent): void => {
    handle.scrollTo(trackScrollTop(event.localRow))
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
        onMouseEnter={() => {
          setHoverRow(y)
          // Resting pointer: chip follows immediately once dwell has
          // opened it; a sweep re-arms the dwell instead of flashing.
          clearDwell()
          if (chipRow !== null) {
            setChipRow(y)
          } else {
            dwellTimer.current = setTimeout(() => setChipRow(y), CHIP_DWELL_MS)
          }
        }}
        onMouseLeave={() => {
          setHoverRow(current => (current === y ? null : current))
          clearChip()
        }}
      >
        <Text
          color={
            inThumb
              ? hoverRow !== null && hoverRow >= thumbTop && hoverRow < thumbBottom
                ? 'professionalBlue'
                : 'inactive'
              : undefined
          }
        >
          {inThumb ? THUMB : '  '}
        </Text>
      </Box>,
    )
  }

  // The floating position chip, anchored left of the gutter on the
  // dwell-armed row (TimelineRail's preview-card geometry, one line tall).
  // Absolute + zero layout contribution: popping it never moves anything.
  // Fenced with noSelect: it floats over selectable transcript text.
  let hoverChip: React.ReactNode = null
  if (chipRow !== null && maxScroll > 0) {
    const jumpTop = trackScrollTop(chipRow)
    const pct = Math.round((jumpTop / maxScroll) * 100)
    const line = Math.min(content, jumpTop + 1)
    hoverChip = (
      <Box
        position="absolute"
        top={chipRow}
        right={RAIL_WIDTH + 1}
        flexShrink={0}
        backgroundColor="toolCardBackgroundDim"
        paddingX={1}
        noSelect
      >
        <Text color="text">{`${pct}% · ${line}/${content}`}</Text>
      </Box>
    )
  }

  return (
    // Plain NoSelect (box region only): the scrollbar is a RIGHT-side
    // gutter, so fromLeftEdge's [col 0 → box right edge] region would
    // fence the ENTIRE transcript row out of copy-on-select.
    <NoSelect>
      {/* Raw ink-box (not the themed Box): onWheel is a host-level prop
          (same as ScrollBox's viewport) — wheel over the gutter scrolls
          the transcript, the gutter has no scroll of its own. The row
          above extends past the page margin (Chat), so this track
          naturally lands at the terminal's right edge. The whole track is
          the single drag target: its localRow is the hovered row, so drag
          start/move/end all scrub through trackScrollTop. */}
      <ink-box
        onWheel={e => {
          if (e.deltaY !== 0) handle.scrollBy(e.deltaY)
        }}
        onDragStart={applyDragRow}
        onDragMove={applyDragRow}
        onDragEnd={applyDragRow}
        style={{ flexDirection: 'column', flexShrink: 0, width: RAIL_WIDTH }}
      >
        {rows}
        {hoverChip}
      </ink-box>
    </NoSelect>
  )
}
