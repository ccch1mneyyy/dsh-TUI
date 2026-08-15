import React from 'react'
import Box from '../ink/components/Box.js'
import Text from '../ink/components/Text.js'
import type { LocalCommand } from '../commands.js'
import { localizedDescription } from '../commands.js'
import { modLabel } from '../utils/modifiers.js'

/**
 * The `?` help menu, ported from the leak's `PromptInputHelpMenu.tsx`
 * (three-column shortcut layout, trimmed to the keys dsh-tui actually binds).
 * The command column lists the merged slash-command surface: built-in
 * commands plus plugin-registered ones from the DSH registry (plan/goal/…).
 * Skill entries (user-invocable skills merged for `/` completion, issue
 * #86) are hidden — a skills directory can hold dozens of entries and the
 * menu is for chrome commands. Modifier labels follow the platform
 * convention: ⌘ on macOS, ctrl elsewhere.
 */
export function HelpMenu({
  commands,
}: {
  commands: readonly LocalCommand[]
}): React.ReactNode {
  const chrome = commands.filter(command => !command.skill)
  return (
    <Box paddingX={2} flexDirection="row" gap={4}>
      <Box flexDirection="column" width={26} flexShrink={0}>
        <Box>
          <Text dimColor>/ for commands</Text>
        </Box>
        <Box>
          <Text dimColor>? for this help</Text>
        </Box>
        <Box>
          <Text dimColor>{modLabel}o for verbose output</Text>
        </Box>
        <Box>
          <Text dimColor>{modLabel}t to toggle context</Text>
        </Box>
        <Box>
          <Text dimColor>{modLabel}r to search history</Text>
        </Box>
        <Box>
          <Text dimColor>ctrl+c to interrupt</Text>
        </Box>
        <Box>
          <Text dimColor>ctrl+d to exit</Text>
        </Box>
        <Box>
          <Text dimColor>{modLabel}l to redraw</Text>
        </Box>
      </Box>
      <Box flexDirection="column" width={24} flexShrink={0}>
        <Box>
          <Text dimColor>esc to clear input</Text>
        </Box>
        <Box>
          <Text dimColor>↑/↓ for history</Text>
        </Box>
        <Box>
          <Text dimColor>←/→ to move cursor</Text>
        </Box>
        <Box>
          <Text dimColor>{modLabel}←/→ for word jumps</Text>
        </Box>
        <Box>
          <Text dimColor>tab to complete command</Text>
        </Box>
        <Box>
          <Text dimColor>shift+tab to cycle mode</Text>
        </Box>
        <Box>
          <Text dimColor>ctrl+x to open editor</Text>
        </Box>
      </Box>
      <Box flexDirection="column" flexShrink={1}>
        <Text dimColor>commands:</Text>
        {chrome.map(command => (
          <Box key={command.name}>
            <Text dimColor wrap="truncate-end">
              /{command.name} — {localizedDescription(command)}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}
