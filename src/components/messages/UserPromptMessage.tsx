import React from 'react'
import { Box, Text, useTerminalSize } from '../../ui.js'
import { POINTER } from '../../cc/figures.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { wrapWidth } from '../../sessions/format.js'
import { useTooltip } from '../Tooltip.js'
import type { ClickEvent } from '../../ink/events/click-event.js'

type Props = {
  text: string
  /** Adds the top margin between turns (CC: addMargin). */
  addMargin: boolean
  /** Cockpit frame: dim the pointer, keep the prompt body in brief gold. */
  cockpit?: boolean
  /** Message-selection mode highlight. */
  isSelected?: boolean
  onClick?(event: ClickEvent): void
}

/**
 * User prompt bubble: `❯ text` in bold briefLabelYou gold with no background
 * fill (Kimi Code style: the user turn gets a distinct bold tint so it reads
 * apart from assistant text; only selection mode paints a highlight).
 */
export function UserPromptMessage({
  text,
  addMargin,
  cockpit = false,
  isSelected = false,
  onClick,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize()
  const promptPrefix = `${POINTER} `
  const prefixWidth = stringWidth(promptPrefix)
  // Wrap here instead of letting Ink wrap the whole Text node. Ink starts an
  // automatic continuation at column zero, while a prompt needs a hanging
  // indent for both explicit newlines and width-based visual lines.
  // Leave a small safety margin for the ScrollBox edge/scrollbar. The Text
  // nodes below are explicitly wrapped, so they must never be wrapped again by
  // Ink; a second wrap would move the continuation back to column zero.
  const lines = wrapWidth(text, Math.max(1, columns - prefixWidth - 3))
  const continuationIndent = ' '.repeat(prefixWidth)
  // Hover tooltip: a message that wrapped/truncated onto several visual
  // lines pops its full original text in one floating card (the pointer
  // row only shows one visual line at a time).
  const promptTooltip = useTooltip(text)
  const tooltipActive = lines.length > 1

  return (
    <Box
      flexDirection="column"
      marginTop={addMargin ? 1 : 0}
      paddingX={cockpit ? 1 : 0}
      backgroundColor={isSelected ? 'messageActionsBackground' : undefined}
      paddingRight={1}
      onClick={onClick}
      {...(tooltipActive ? promptTooltip : {})}
    >
      {lines.map((line, index) => (
        cockpit ? (
          <Box key={index} flexDirection="row">
            <Text color="inactive" dimColor>
              {index === 0 ? `${POINTER} ` : continuationIndent}
            </Text>
            <Text color="briefLabelYou" wrap="truncate-end">{line}</Text>
          </Box>
        ) : (
          <Text key={index} color="briefLabelYou" bold wrap="truncate-end">
            {index === 0 ? `${POINTER} ` : continuationIndent}
            {line}
          </Text>
        )
      ))}
    </Box>
  )
}
