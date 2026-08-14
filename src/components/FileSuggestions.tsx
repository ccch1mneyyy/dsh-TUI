import React from 'react'
import { Box, Text } from '../ui.js'
import { stringWidth } from '../ink/stringWidth.js'
import { truncateToWidth } from '../ink/truncateToWidth.js'

/**
 * The `@` file-completion overlay in CC's suggestion style: `+` icon prefix
 * (CC's file suggestions) + name column + description. The selected row
 * renders in the theme's `suggestion` color, others dim.
 */
export function FileSuggestions({
  files,
  selectedIndex,
  columns,
}: {
  files: readonly string[]
  selectedIndex: number
  columns: number
}): React.ReactNode {
  if (files.length === 0) return null

  const maxVisible = 6
  const startIndex = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(maxVisible / 2),
      files.length - maxVisible,
    ),
  )
  const visible = files.slice(startIndex, startIndex + maxVisible)

  return (
    <Box flexDirection="column">
      {visible.map(file => {
        const isSelected = file === files[selectedIndex]
        const isDir = file.endsWith('/')
        const name = isDir ? file.slice(0, -1) : file
        const descriptionWidth = Math.max(0, columns - 24)
        const description = isDir ? 'directory' : 'file'
        return (
          <Text key={file} wrap="truncate">
            <Text color={isSelected ? 'suggestion' : undefined} dimColor={!isSelected}>
              + {name}
            </Text>
            <Text color={isSelected ? 'suggestion' : undefined} dimColor={!isSelected}>
              {' '.repeat(Math.max(1, 20 - stringWidth(name)))}
              {stringWidth(description) > descriptionWidth
                ? truncateToWidth(description, descriptionWidth - 1) + '…'
                : description}
            </Text>
          </Text>
        )
      })}
    </Box>
  )
}
