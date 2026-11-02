import React from 'react'
import { Box, NoSelect, Text, useTheme } from '../../ui.js'
import { BLACK_CIRCLE } from '../../terminal-utils/figures.js'
import { AssistantTextColorContext, Markdown } from '../Markdown.js'
import { getTheme } from '../../theme.js'

type Props = {
  text: string
  /** Adds the top margin between messages. */
  marginTopOnTurn: boolean
  /** Message-selection mode highlight. */
  isSelected?: boolean
  /** Row expanded on its own (persistent hover-grey background). */
  isExpanded?: boolean
}

/**
 * Assistant text message: bullet + markdown body.
 *
 * Deliberately not clickable: the transcript is reading material and the
 * mouse's job there is text selection (user feedback — row hover tints and
 * fold toggling were noise, not affordance).
 */
export function AssistantTextMessage({
  text,
  marginTopOnTurn,
  isSelected = false,
  isExpanded = false,
}: Props): React.ReactNode {
  const [themeName] = useTheme()
  const palette = getTheme(themeName)
  const assistantTextColor = palette.assistantText !== undefined ? 'assistantText' : 'text'

  return (
    <Box
      alignItems="flex-start"
      flexDirection="row"
      justifyContent="space-between"
      marginTop={marginTopOnTurn ? 1 : 0}
      width="100%"
      backgroundColor={
        isSelected
          ? 'messageActionsBackground'
          : isExpanded
            ? 'userMessageBackgroundHover'
            : undefined
      }
    >
      <Box flexDirection="row">
        <NoSelect fromLeftEdge minWidth={2}>
          <Text color={isSelected ? 'suggestion' : 'text'}>{BLACK_CIRCLE}</Text>
        </NoSelect>
        <Box flexDirection="column">
          <AssistantTextColorContext.Provider value={assistantTextColor}>
            <Markdown>{text}</Markdown>
          </AssistantTextColorContext.Provider>
        </Box>
      </Box>
    </Box>
  )
}
