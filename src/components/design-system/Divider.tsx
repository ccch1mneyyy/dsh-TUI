import React from 'react'
import Text from '../../ink/components/Text.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { useTerminalSize } from '../../ink/hooks/use-terminal-size.js'
import type { Theme } from '../../theme.js'

type DividerProps = {
  /**
   * Width of the divider in characters.
   * Defaults to terminal width.
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
 * (ported from the leak's design-system).
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
  const lineWidth = Math.max(0, (width ?? columns) - padding)
  const titleWidth = title ? stringWidth(title) : 0

  if (title && titleWidth < lineWidth) {
    const lineLength = lineWidth - titleWidth
    const leftLength = Math.floor(lineLength / 2)
    const rightLength = Math.ceil(lineLength / 2)

    return (
      <Text dimColor={!color} color={color}>
        {char.repeat(leftLength)}
        {title}
        {char.repeat(rightLength)}
      </Text>
    )
  }

  return (
    <Text dimColor={!color} color={color}>
      {char.repeat(lineWidth)}
    </Text>
  )
}
