import React from 'react'
import Box from '../ink/components/Box.js'
import { ListItem } from './design-system/ListItem.js'

export type SelectOption = {
  value: string
  /** Row content; plain strings render inline, richer rows may carry color swatches. */
  label: React.ReactNode
  description?: string
}

/**
 * A single-choice select list in the CC CustomSelect style (ported visual:
 * ListItem rows with ❯ focus pointer, ✓ selected checkmark, descriptions,
 * scroll arrows). Keyboard navigation is owned by the parent dialog, which
 * passes focus/selection indices back in.
 */
export function Select({
  options,
  focusIndex,
  selectedValue,
  visibleOptionCount = 5,
}: {
  options: readonly SelectOption[]
  /** Index of the keyboard-focused row (shows the ❯ pointer). */
  focusIndex: number
  /** Value of the chosen row (shows the ✓ checkmark). */
  selectedValue: string | undefined
  visibleOptionCount?: number
}): React.ReactNode {
  // Window around the focus row, with scroll hints at the edges (CC style).
  const startIndex = Math.max(
    0,
    Math.min(
      focusIndex - Math.floor(visibleOptionCount / 2),
      options.length - visibleOptionCount,
    ),
  )
  const endIndex = Math.min(startIndex + visibleOptionCount, options.length)
  const visible = options.slice(startIndex, endIndex)

  return (
    <Box flexDirection="column">
      {visible.map((option, index) => {
        const absoluteIndex = startIndex + index
        return (
          <ListItem
            key={option.value}
            isFocused={absoluteIndex === focusIndex}
            isSelected={option.value === selectedValue}
            description={option.description}
            showScrollUp={absoluteIndex === startIndex && startIndex > 0}
            showScrollDown={
              absoluteIndex === endIndex - 1 && endIndex < options.length
            }
          >
            {option.label}
          </ListItem>
        )
      })}
    </Box>
  )
}
