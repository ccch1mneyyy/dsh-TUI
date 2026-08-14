import React from 'react'
import { Box, NoSelect, Text } from '../../ui.js'
import { BLACK_CIRCLE } from '../../cc/figures.js'
import { Markdown } from '../Markdown.js'

type Props = {
  text: string
  /** Adds the top margin between messages (CC: addMargin). */
  addMargin: boolean
  /** Message-selection mode highlight. */
  isSelected?: boolean
  /** Row expanded on its own (persistent hover-grey background, CC). */
  isExpanded?: boolean
  onClick?(): void
}

/**
 * Assistant text message:  bullet + markdown body (ported from the
 * leak's  default branch).
 */
export function AssistantTextMessage({
  text,
  addMargin,
  isSelected = false,
  isExpanded = false,
  onClick,
}: Props): React.ReactNode {
  return (
    <Box
      alignItems="flex-start"
      flexDirection="row"
      justifyContent="space-between"
      marginTop={addMargin ? 1 : 0}
      width="100%"
      backgroundColor={
        isSelected
          ? 'messageActionsBackground'
          : isExpanded
            ? 'userMessageBackgroundHover'
            : undefined
      }
      onClick={onClick}
    >
      <Box flexDirection="row">
        <NoSelect fromLeftEdge minWidth={2}>
          <Text color={isSelected ? 'suggestion' : 'text'}>{BLACK_CIRCLE}</Text>
        </NoSelect>
        <Box flexDirection="column">
          <Markdown>{text}</Markdown>
        </Box>
      </Box>
    </Box>
  )
}
