import React from 'react'
import { Box, Text } from '../ui.js'
import type { Color } from '../ink/styles.js'
import {
  FREE_SEGMENT_FILL,
  FREE_SEGMENT_TEXT,
  USED_SEGMENTS,
  allocateBarColumns,
  contextBarReadout,
  contextPressureStep,
  rightAlignBarText,
  type ContextSegments,
} from '../screens/StatusMetrics.js'

/**
 * The hoverable JSX twin of `renderContextBar`: the same segmented context
 * bar (same largest-remainder column split, same free-segment readout),
 * rendered as one Box per segment so the bar can react to the pointer.
 *
 * A used segment is its fill color and nothing else — no label (community
 * feedback on the old `s`/`p`/`t` letters: they read as noise on a row that is
 * already decorative, and they never fit the narrow segments anyway). The only
 * text left is the free segment's right-aligned usage readout.
 *
 * ONE hover target for the whole bar rather than one per segment. The colors
 * are named where there is room for words: hovering anywhere on the bar parks
 * the full per-content-type breakdown on the footer's supplemental row. A
 * per-segment target also made every crossing of the five fills an
 * enter+leave pair, hence a footer re-render per crossing.
 *
 * The component path follows the ANSI path's geometry: this exists so the bar
 * can react to the pointer, not to restyle it.
 */
export function ContextBarView({
  segments,
  usedTokens,
  contextWindow,
  width,
  colors,
  onHover,
}: {
  /** Used tokens per content type. */
  segments: ContextSegments
  /** Total used tokens, driving the usage readout. */
  usedTokens: number
  /** The context window size in tokens. */
  contextWindow: number
  /** Total bar width in terminal columns. */
  width: number
  /** Theme overrides for the free segment (light theme passes its own). */
  colors?: { freeFill: Color; freeText: Color }
  /** Hover signal: true while the pointer is anywhere on the bar, false on
   *  leave. Absent handlers render a static bar (tests, headless embeds). */
  onHover?: (hovered: boolean) => void
}): React.ReactNode {
  if (width <= 0 || contextWindow <= 0) return null

  const freeTokens = Math.max(0, contextWindow - usedTokens)
  const values = [...USED_SEGMENTS.map(segment => segments[segment.key]), freeTokens]
  const columns = allocateBarColumns(values, width)
  // The readout is the bar's only text, and its one pressure signal: amber
  // from 80% occupancy, red from 95% (the footer's shared thresholds). The
  // theme key wins over the free-text color, which stays for comfortable
  // occupancy.
  const readout = contextBarReadout(usedTokens, contextWindow)
  const pressure = contextPressureStep((usedTokens / contextWindow) * 100)

  const nodes: React.ReactNode[] = []
  for (const [index, segment] of USED_SEGMENTS.entries()) {
    const segmentWidth = columns[index] ?? 0
    if (segmentWidth <= 0) continue
    // Childless on purpose: the renderer fills a node's own rect with its
    // backgroundColor, so the segment is a pure colored block (render-node-to-
    // output's ownBackgroundColor fill).
    nodes.push(
      <Box
        key={segment.key}
        width={segmentWidth}
        height={1}
        flexShrink={0}
        backgroundColor={segment.color}
      />,
    )
  }

  const freeWidth = columns[USED_SEGMENTS.length] ?? 0
  if (freeWidth > 0) {
    nodes.push(
      <Box
        key="free"
        width={freeWidth}
        height={1}
        flexShrink={0}
        backgroundColor={colors?.freeFill ?? FREE_SEGMENT_FILL}
      >
        <Text color={pressure ?? colors?.freeText ?? FREE_SEGMENT_TEXT} wrap="truncate">
          {rightAlignBarText(readout, freeWidth)}
        </Text>
      </Box>,
    )
  }

  return (
    <Box
      flexDirection="row"
      flexShrink={0}
      width={width}
      onMouseEnter={onHover === undefined ? undefined : () => onHover(true)}
      onMouseLeave={onHover === undefined ? undefined : () => onHover(false)}
    >
      {nodes}
    </Box>
  )
}
