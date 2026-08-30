import React, { useLayoutEffect, useRef, useState } from 'react'
import Box from '../../ink/components/Box.js'
import Text from '../../ink/components/Text.js'
import type { DOMElement } from '../../ink/dom.js'
import measureElement from '../../ink/measure-element.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { useTerminalSize } from '../../ink/hooks/use-terminal-size.js'
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
}

/**
 * A horizontal divider line, optionally with a title in the middle
 * (in the Claude Code visual language).
 *
 * The rule fills the width Yoga actually grants it: the stretched Box is
 * measured after layout (SearchBox pattern — a resize re-layouts without
 * any prop change, so measure on every commit; the setState is a no-op
 * when the width is unchanged) and the terminal column count only seeds
 * the first frame. A full-terminal-width rule nested in a narrower
 * container (e.g., the transcript beside the 2-column timeline rail)
 * would otherwise wrap onto a second row.
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
}: DividerProps): React.ReactNode {
  const { columns } = useTerminalSize()
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null)
  const boxRef = useRef<DOMElement | null>(null)
  useLayoutEffect(() => {
    const node = boxRef.current
    if (!node) return
    const w = measureElement(node).width
    if (w > 0) setMeasuredWidth(prev => (prev === w ? prev : w))
  })
  const available = measuredWidth ?? columns
  const lineWidth = Math.max(0, Math.min(available, width ?? columns) - padding)
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
    <Box ref={boxRef}>
      <Text dimColor={!color} color={color} wrap="truncate-end">
        {text}
      </Text>
    </Box>
  )
}
