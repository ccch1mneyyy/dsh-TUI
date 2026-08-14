import React from 'react'
import Box from '../ink/components/Box.js'
import Text from '../ink/components/Text.js'
import type { LocalCommand } from '../commands.js'

/**
 * The `?` help menu, ported from the leak's `PromptInputHelpMenu.tsx`
 * (three-column shortcut layout, trimmed to the keys dsh-tui actually binds).
 * The command column lists the merged slash-command surface: built-in
 * commands plus plugin-registered ones from the DSH registry (plan/goal/…).
 */
export function HelpMenu({
  commands,
}: {
  commands: readonly LocalCommand[]
}): React.ReactNode {
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
          <Text dimColor>ctrl+o for verbose output</Text>
        </Box>
        <Box>
          <Text dimColor>ctrl+t to toggle context</Text>
        </Box>
        <Box>
          <Text dimColor>ctrl+r to search history</Text>
        </Box>
        <Box>
          <Text dimColor>ctrl+c to interrupt</Text>
        </Box>
        <Box>
          <Text dimColor>ctrl+d to exit</Text>
        </Box>
        <Box>
          <Text dimColor>ctrl+l to redraw</Text>
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
          <Text dimColor>ctrl+←/→ for word jumps</Text>
        </Box>
        <Box>
          <Text dimColor>tab to complete command</Text>
        </Box>
        <Box>
          <Text dimColor>shift+tab to cycle effort</Text>
        </Box>
      </Box>
      <Box flexDirection="column" flexShrink={1}>
        <Text dimColor>commands:</Text>
        {commands.map(command => (
          <Box key={command.name}>
            <Text dimColor wrap="truncate-end">
              /{command.name} — {command.description}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}
