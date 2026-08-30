import React from 'react'
import { Box, NoSelect, Text } from '../../ui.js'
import { BLACK_CIRCLE, GROUP_RULE } from '../../cc/figures.js'
import { Markdown } from '../Markdown.js'

type Props = {
  text: string
  /** Adds the top margin between messages (CC: addMargin). */
  addMargin: boolean
  /** Cockpit message frame: muted left rule instead of the CC bullet. */
  cockpit?: boolean
  /** Message-selection mode highlight. */
  isSelected?: boolean
  /** Row expanded on its own (persistent hover-grey background, CC). */
  isExpanded?: boolean
}

/**
 * Assistant text message:  bullet + markdown body (mirroring Claude Code's  default branch).
 *
 * Deliberately not clickable: the transcript is reading material and the
 * mouse's job there is text selection (user feedback — row hover tints and
 * fold toggling were noise, not affordance).
 */
export function AssistantTextMessage({
  text,
  addMargin,
  cockpit = false,
  isSelected = false,
  isExpanded = false,
}: Props): React.ReactNode {
  return (
    <Box
      alignItems="flex-start"
      flexDirection="row"
      justifyContent="space-between"
      marginTop={addMargin ? 1 : 0}
      paddingX={cockpit ? 1 : 0}
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
          <Text color={cockpit ? 'promptBorder' : isSelected ? 'suggestion' : 'text'}>
            {cockpit ? GROUP_RULE : BLACK_CIRCLE}
          </Text>
        </NoSelect>
        <Box flexDirection="column">
          <Markdown>{text}</Markdown>
        </Box>
      </Box>
    </Box>
  )
}
