import React from 'react'
import Text from '../../ink/components/Text.js'

type Props = {
  /** The key or chord to display (e.g., "ctrl+o", "Enter", "↑/↓") */
  shortcut: string
  /** The action the key performs (e.g., "expand", "select", "navigate") */
  action: string
  /** Whether to wrap the hint in parentheses. Default: false */
  parens?: boolean
  /** Whether to render the shortcut in bold. Default: false */
  bold?: boolean
}

/**
 * Renders a keyboard shortcut hint like "ctrl+o to expand" or "(tab to toggle)"
 * (ported from the leak's design-system). Wrap in `<Text dimColor>` for the
 * common dim styling.
 */
export function KeyboardShortcutHint({
  shortcut,
  action,
  parens = false,
  bold = false,
}: Props): React.ReactNode {
  const shortcutText = bold ? <Text bold>{shortcut}</Text> : shortcut

  if (parens) {
    return (
      <Text>
        ({shortcutText} to {action})
      </Text>
    )
  }
  return (
    <Text>
      {shortcutText} to {action}
    </Text>
  )
}
