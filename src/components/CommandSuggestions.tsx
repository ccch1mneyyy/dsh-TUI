import React from 'react'
import { Box, Text } from '../ui.js'
import { stringWidth } from '../ink/stringWidth.js'
import { truncateToWidth } from '../ink/truncateToWidth.js'
import type { LocalCommand } from '../commands.js'

/**
 * The slash-command suggestion overlay, ported from the leak's
 * `PromptInputFooterSuggestions.tsx` (command layout only): a name column
 * padded to a fixed width, optional `[tag]`, then a truncated description.
 * The selected row renders in the theme's `suggestion` color, others dim.
 */
export function CommandSuggestions({
  commands,
  selectedIndex,
  columns,
}: {
  commands: readonly LocalCommand[]
  selectedIndex: number
  columns: number
}): React.ReactNode {
  if (commands.length === 0) return null

  // Cap the command name column at 40% of terminal width to ensure the
  // description has space (same as the leak).
  const maxNameWidth = Math.floor(columns * 0.4)
  const nameWidth = Math.min(
    Math.max(...commands.map(c => stringWidth(c.name))) + 5,
    maxNameWidth,
  )

  const maxVisible = 5
  const startIndex = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(maxVisible / 2),
      commands.length - maxVisible,
    ),
  )
  const visible = commands.slice(startIndex, startIndex + maxVisible)

  return (
    <Box flexDirection="column">
      {visible.map(command => {
        const isSelected = command.name === commands[selectedIndex]?.name
        const padded =
          command.name +
          ' '.repeat(Math.max(0, nameWidth - stringWidth(command.name)))
        const tagText = command.tag ? `[${command.tag}] ` : ''
        const tagWidth = stringWidth(tagText)
        const descriptionWidth = Math.max(
          0,
          columns - nameWidth - tagWidth - 4,
        )
        const description =
          stringWidth(command.description) > descriptionWidth
            ? truncateToWidth(command.description, descriptionWidth - 1) + '…'
            : command.description
        return (
          <Text key={command.name} wrap="truncate">
            <Text color={isSelected ? 'suggestion' : undefined} dimColor={!isSelected}>
              {padded}
            </Text>
            {tagText ? <Text dimColor>{tagText}</Text> : null}
            <Text color={isSelected ? 'suggestion' : undefined} dimColor={!isSelected}>
              {description}
            </Text>
          </Text>
        )
      })}
    </Box>
  )
}
