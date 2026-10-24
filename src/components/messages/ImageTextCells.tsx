import React from 'react'
import { NoSelect, Text } from '../../ui.js'
import type { ImageTextGrid } from './imageTextFallback.js'

/**
 * Paint an {@link ImageTextGrid}: one row per line, one span per run. The
 * cells are pixels, not text, so they stay out of fullscreen copy; the
 * caller keeps a readable label next to them.
 */
export function ImageTextCells({ grid }: { readonly grid: ImageTextGrid }): React.ReactNode {
  return (
    <NoSelect flexDirection="column" flexShrink={0}>
      {grid.map((runs, row) => (
        <Text key={row} wrap="truncate">
          {runs.map((run, index) => (
            <Text key={index} color={run.color} backgroundColor={run.backgroundColor}>{run.text}</Text>
          ))}
        </Text>
      ))}
    </NoSelect>
  )
}
