import React from 'react'
import { Box, Text } from '../../ui.js'
import { POINTER } from '../../cc/figures.js'

type Props = {
  text: string
  /** Adds the top margin between turns (CC: addMargin). */
  addMargin: boolean
  /** Message-selection mode highlight. */
  isSelected?: boolean
  /** Row expanded on its own (persistent hover-grey background, CC). */
  isExpanded?: boolean
  onClick?(): void
}

/**
 * User prompt bubble: `❯ text` on the theme's userMessageBackground grey
 * (ported from the leak's `messages/UserPromptMessage.tsx` +
 * `HighlightedThinkingText.tsx`, with the ultrathink rainbow removed).
 */
export function UserPromptMessage({
  text,
  addMargin,
  isSelected = false,
  isExpanded = false,
  onClick,
}: Props): React.ReactNode {
  return (
    <Box
      flexDirection="column"
      marginTop={addMargin ? 1 : 0}
      backgroundColor={
        isSelected
          ? 'messageActionsBackground'
          : isExpanded
            ? 'userMessageBackgroundHover'
            : 'userMessageBackground'
      }
      paddingRight={1}
      onClick={onClick}
    >
      <Text>
        <Text color="subtle">{POINTER} </Text>
        <Text color="text">{text}</Text>
      </Text>
    </Box>
  )
}
