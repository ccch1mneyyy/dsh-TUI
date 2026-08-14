import React, { type ReactNode } from 'react'
import { Box, Text } from '../../ui.js'
import { useDeclaredCursor } from '../../ink/hooks/use-declared-cursor.js'
import { POINTER, DOWN_ARROW, UP_ARROW, TICK } from '../../cc/figures.js'

export type ListItemProps = {
  /** Whether this item is currently focused (keyboard selection).
   *  Shows the pointer indicator (❯) when true. */
  isFocused: boolean
  /** Whether this item is selected (chosen/checked).
   *  Shows the checkmark indicator (✓) when true. */
  isSelected?: boolean
  /** The content to display for this item. */
  children: ReactNode
  /** Optional description text displayed below the main content. */
  description?: string
  /** Show a down arrow indicator instead of pointer (scroll hints). */
  showScrollDown?: boolean
  /** Show an up arrow indicator instead of pointer (scroll hints). */
  showScrollUp?: boolean
  /** Whether to apply automatic styling based on focus/selection state. */
  styled?: boolean
  /** Disabled items show dimmed text and no indicators. */
  disabled?: boolean
  /**
   * Whether this ListItem should declare the terminal cursor position.
   * Set false when a child (e.g. BaseTextInput) declares its own cursor.
   * @default true
   */
  declareCursor?: boolean
}

/**
 * A list item for selection UIs (ported from the leak's
 * design-system/ListItem.tsx): `❯` pointer for the focused row, `✓`
 * checkmark for the selected row, description on an indented second line,
 * and CC's color states (focused = suggestion blue, selected = success
 * green).
 */
export function ListItem({
  isFocused,
  isSelected = false,
  children,
  description,
  showScrollDown,
  showScrollUp,
  styled = true,
  disabled = false,
  declareCursor,
}: ListItemProps): React.ReactNode {
  // Park the native terminal cursor on the pointer indicator so screen
  // readers / magnifiers track the focused item (CC behavior). (0,0) is the
  // top-left of this Box, where the pointer renders.
  const cursorRef = useDeclaredCursor({
    line: 0,
    column: 0,
    active: isFocused && !disabled && declareCursor !== false,
  })

  function renderIndicator(): ReactNode {
    if (disabled) {
      return <Text> </Text>
    }
    if (isFocused) {
      return <Text color="suggestion">{POINTER}</Text>
    }
    if (showScrollDown) {
      return <Text dimColor>{DOWN_ARROW}</Text>
    }
    if (showScrollUp) {
      return <Text dimColor>{UP_ARROW}</Text>
    }
    return <Text> </Text>
  }

  function getTextColor(): 'success' | 'suggestion' | 'inactive' | undefined {
    if (disabled) return 'inactive'
    if (!styled) return undefined
    if (isSelected) return 'success'
    if (isFocused) return 'suggestion'
    return undefined
  }

  return (
    <Box ref={cursorRef} flexDirection="column">
      <Box flexDirection="row" gap={1}>
        {renderIndicator()}
        {styled ? (
          <Text color={getTextColor()} dimColor={disabled}>
            {children}
          </Text>
        ) : (
          children
        )}
        {isSelected && !disabled && <Text color="success">{TICK}</Text>}
      </Box>
      {description && (
        <Box paddingLeft={2}>
          <Text color="inactive">{description}</Text>
        </Box>
      )}
    </Box>
  )
}
