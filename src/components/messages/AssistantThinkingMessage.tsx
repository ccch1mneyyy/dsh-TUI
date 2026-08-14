import React from 'react'
import { Box, Text } from '../../ui.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { Markdown } from '../Markdown.js'
import { formatDuration } from '../../cc/format.js'

type Props = {
  thinking: string
  /** Adds the top margin between messages (CC: addMargin). */
  addMargin: boolean
  /** True when Ctrl+O transcript/verbose mode is on — show the full text. */
  verbose: boolean
  /** Thinking wall-clock duration once the reasoning block settled (ms). */
  durationMs?: number
  /** Message-selection mode highlight. */
  isSelected?: boolean
  onClick?(): void
}

/**
 * Thinking block: folded `∴ Thinking (ctrl+o to expand)`, expanded shows the
 * full reasoning text indented under `∴ Thinking…` (ported from the leak's
 * `messages/AssistantThinkingMessage.tsx`). When the channel records the
 * reasoning duration, the label carries it (`∴ Thinking · 12s …`) — dsh-tui's
 * take on making thinking time visible in the transcript.
 */
export function AssistantThinkingMessage({
  thinking,
  addMargin,
  verbose,
  durationMs,
  isSelected = false,
  onClick,
}: Props): React.ReactNode {
  if (!thinking) return null

  const duration =
    durationMs !== undefined && durationMs >= 1000
      ? ` · ${formatDuration(durationMs)}`
      : ''

  if (!verbose) {
    return (
      <Box
        marginTop={addMargin ? 1 : 0}
        backgroundColor={isSelected ? 'messageActionsBackground' : undefined}
        onClick={onClick}
      >
        <Text dimColor italic>
          ∴ Thinking{duration}{' '}
          <Text dimColor>
            <KeyboardShortcutHint shortcut="ctrl+o" action="expand" parens />
          </Text>
        </Text>
      </Box>
    )
  }

  return (
    <Box
      flexDirection="column"
      gap={1}
      marginTop={addMargin ? 1 : 0}
      width="100%"
      backgroundColor={isSelected ? 'messageActionsBackground' : undefined}
      onClick={onClick}
    >
      <Text dimColor italic>
        ∴ Thinking{duration}…
      </Text>
      <Box paddingLeft={2}>
        <Markdown dimColor>{thinking}</Markdown>
      </Box>
    </Box>
  )
}
