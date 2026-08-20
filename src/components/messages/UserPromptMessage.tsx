import React from 'react'
import { Box, Text } from '../../ui.js'
import { POINTER } from '../../cc/figures.js'

type Props = {
  text: string
  /** Adds the top margin between turns (CC: addMargin). */
  addMargin: boolean
  /** Message-selection mode highlight. */
  isSelected?: boolean
  onClick?(): void
}

/**
 * User prompt bubble: `❯ text` in bold briefLabelYou gold with no background
 * fill (Kimi Code style: the user turn gets a distinct bold tint so it reads
 * apart from assistant text; only selection mode paints a highlight).
 */
export function UserPromptMessage({
  text,
  addMargin,
  isSelected = false,
  onClick,
}: Props): React.ReactNode {
  return (
    <Box
      flexDirection="column"
      marginTop={addMargin ? 1 : 0}
      backgroundColor={isSelected ? 'messageActionsBackground' : undefined}
      paddingRight={1}
      onClick={onClick}
    >
      <Text color="briefLabelYou" bold>
        {POINTER} {text}
      </Text>
    </Box>
  )
}
