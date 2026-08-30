import React from 'react'
import { Box, Text } from '../ui.js'
import type { Color } from '../ink/styles.js'
import {
  USED_SEGMENTS,
  allocateBarColumns,
  centeredText,
  chooseLabel,
  composeFreeSegmentText,
  formatTokens,
  type ContextSegments,
} from '../screens/StatusMetrics.js'

/** Free-segment colors, mirroring StatusMetrics' dark-theme defaults. */
const FREE_FILL: Color = '#E8E8E8'
const FREE_TEXT: Color = '#4A4A4A'
const USED_TEXT: Color = '#FFFFFF'

/**
 * The hoverable JSX twin of `renderContextBar`: the same segmented context
 * bar (same largest-remainder column split, same label fallback ladder,
 * same free-segment readout), rendered as one Box per segment so each
 * carries its own mouse handlers. Hovering a segment reports its key (or
 * `free`) upward through `onHover`; the footer turns that into a detail
 * readout on its supplemental row.
 *
 * Pixel parity with the ANSI path is the contract: this exists so the bar
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
  /** Hover signal: a segment key (`system`…`tools`), `free`, or null on
   *  leave. Absent handlers render a static bar (tests, headless embeds). */
  onHover?: (segment: string | null) => void
}): React.ReactNode {
  if (width <= 0 || contextWindow <= 0) return null

  const freeTokens = Math.max(0, contextWindow - usedTokens)
  const values = [...USED_SEGMENTS.map(segment => segments[segment.key]), freeTokens]
  const columns = allocateBarColumns(values, width)
  const percent = `${((usedTokens / contextWindow) * 100).toFixed(1)}%`
  const total = `${formatTokens(usedTokens)}/${formatTokens(contextWindow)}`
  const free = formatTokens(contextWindow - usedTokens)

  const nodes: React.ReactNode[] = []
  for (const [index, segment] of USED_SEGMENTS.entries()) {
    const segmentWidth = columns[index] ?? 0
    if (segmentWidth <= 0) continue
    const label = chooseLabel(segment.labels, segmentWidth)
    nodes.push(
      <Box
        key={segment.key}
        width={segmentWidth}
        height={1}
        flexShrink={0}
        backgroundColor={segment.color}
        onMouseEnter={onHover === undefined ? undefined : () => onHover(segment.key)}
        onMouseLeave={onHover === undefined ? undefined : () => onHover(null)}
      >
        <Text color={USED_TEXT}>
          {label.length > 0 ? centeredText(label, segmentWidth) : ' '.repeat(segmentWidth)}
        </Text>
      </Box>,
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
        backgroundColor={colors?.freeFill ?? FREE_FILL}
        onMouseEnter={onHover === undefined ? undefined : () => onHover('free')}
        onMouseLeave={onHover === undefined ? undefined : () => onHover(null)}
      >
        <Text color={colors?.freeText ?? FREE_TEXT}>
          {composeFreeSegmentText(
            [
              `ctx ${total} ${percent} ${free}`,
              `${total} ${percent} ${free}`,
              `${total} ${percent}`,
              percent,
            ],
            freeWidth,
          )}
        </Text>
      </Box>,
    )
  }

  return (
    <Box flexDirection="row" flexShrink={0} width={width}>
      {nodes}
    </Box>
  )
}
