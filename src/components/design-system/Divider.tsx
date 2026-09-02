import React, { useLayoutEffect, useRef, useState } from 'react'
import Box from '../../ink/components/Box.js'
import Text from '../../ink/components/Text.js'
import type { DOMElement } from '../../ink/dom.js'
import measureElement from '../../ink/measure-element.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { useTerminalSize } from '../../ink/hooks/use-terminal-size.js'
import { usePageInset } from '../PageMargin.js'
import type { Theme } from '../../theme.js'

type DividerProps = {
  /**
   * Width of the divider in characters.
   * Defaults to the available layout width.
   */
  width?: number

  /**
   * Theme color for the divider.
   * If not provided, dimColor is used.
   */
  color?: keyof Theme

  /**
   * Character to use for the divider line.
   * @default '─'
   */
  char?: string

  /**
   * Padding to subtract from the width (e.g., for indentation).
   * @default 0
   */
  padding?: number

  /**
   * Title shown in the middle of the divider.
   * May contain ANSI codes (e.g., chalk-styled text).
   */
  title?: string

  /**
   * Full-bleed: extend the rule into the page margins to the terminal
   * edges (page-level structural hairline — the page-margin convention:
   * TEXT stays inside the content column, structural lines bleed). Use for
   * screen-level dividers only; dividers inside cards, panels, or the
   * transcript stay at content width. No-op outside PageMargin.
   */
  bleed?: boolean
}

// Upper bound on distinct measurements applied per terminal-width
// generation. Converging layouts apply one or two; a non-converging
// context (content-sized Box, or a sibling negotiating space the same
// way) would keep changing the measured width once per commit forever,
// so freeze well before the reconciler's 50-nested-update limit.
const MAX_APPLIED_MEASUREMENTS = 8

/**
 * A horizontal divider line, optionally with a title in the middle
 * (in the Claude Code visual language).
 *
 * The rule fills the width Yoga actually grants it: the Box is measured
 * after layout (SearchBox pattern — a resize re-layouts without any prop
 * change, so measure on every commit) and the terminal column count only
 * seeds the first frame. A full-terminal-width rule nested in a narrower
 * container (e.g., the transcript beside the 2-column timeline rail)
 * would otherwise wrap onto a second row.
 *
 * Because the rendered rule width feeds back into the width Yoga grants
 * the Box, the measurement negotiation is bounded per terminal-width
 * generation (MAX_APPLIED_MEASUREMENTS below): a non-converging layout
 * degrades to a frozen, truncated rule instead of tripping React's max
 * update depth (error #185, a hard process crash).
 *
 * @example
 * // ─────────── Title ───────────
 * <Divider title="Title" />
 */
export function Divider({
  width,
  color,
  char = '─',
  padding = 0,
  title,
  bleed = false,
}: DividerProps): React.ReactNode {
  const { columns } = useTerminalSize()
  const inset = usePageInset()
  // Full-bleed: the rule spans the terminal columns, shifted left by the
  // page inset via a negative margin (the box reaches into the margin
  // area; the parent does not clip). `columns` here is the CONTENT width
  // (PageMargin narrows TerminalSizeContext), so +2·inset.x = terminal.
  const bleedX = bleed ? inset.x : 0
  const bleedWidth = columns + 2 * bleedX
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null)
  const boxRef = useRef<DOMElement | null>(null)
  // Measurement feedback guard: the rule width rendered from
  // `measuredWidth` feeds back into the width Yoga grants the Box, so
  // the measured value can drift or ping-pong without ever converging —
  // one setState per commit then trips React's max update depth (error
  // #185) and kills the process. Apply at most MAX_APPLIED_MEASUREMENTS
  // distinct widths per terminal-width generation and freeze once a
  // value repeats (A→B→A). truncate-end keeps an over-wide frozen rule
  // on one row, so freezing degrades gracefully; a resize (columns
  // change) reopens the negotiation.
  const negotiation = useRef({ columns, applied: [] as number[], frozen: false })
  useLayoutEffect(() => {
    const node = boxRef.current
    if (!node) return
    const state = negotiation.current
    if (state.columns !== columns) {
      state.columns = columns
      state.applied = []
      state.frozen = false
      // The current Yoga layout was rendered from the previous terminal
      // width. Clear it and let the next render seed from the new columns;
      // measuring this stale pass would keep a grown terminal permanently
      // pinned to its old narrow width.
      setMeasuredWidth(null)
      return
    }
    if (state.frozen) return
    const w = measureElement(node).width
    if (w <= 0) return
    const applied = state.applied
    if (w === applied[applied.length - 1]) return
    if (applied.includes(w) || applied.length >= MAX_APPLIED_MEASUREMENTS) {
      state.frozen = true
      return
    }
    applied.push(w)
    setMeasuredWidth(w)
  })
  const available = measuredWidth ?? bleedWidth
  const target = bleed ? bleedWidth : (width ?? columns)
  const lineWidth = Math.max(0, Math.min(available, target) - padding)
  const titleWidth = title ? stringWidth(title) : 0

  let text: string
  if (title) {
    if (titleWidth < lineWidth) {
      const lineLength = lineWidth - titleWidth
      const leftLength = Math.floor(lineLength / 2)
      const rightLength = Math.ceil(lineLength / 2)
      text = char.repeat(leftLength) + title + char.repeat(rightLength)
    } else {
      // Title wider than the line (long turn-error notices on narrow
      // windows): keep the message — truncate-end clips it to the
      // available width instead of dropping it for a bare rule.
      text = title
    }
  } else {
    text = char.repeat(lineWidth)
  }

  return (
    <Box
      ref={boxRef}
      {...(bleed
        ? { width: bleedWidth, marginLeft: -bleedX }
        : width !== undefined
          ? { width }
          : {})}
    >
      <Text dimColor={!color} color={color} wrap="truncate-end">
        {text}
      </Text>
    </Box>
  )
}
