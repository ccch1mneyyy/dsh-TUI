import React from 'react'
import Box from '../ink/components/Box.js'
import Text from '../ink/components/Text.js'
import type { LocalCommand } from '../commands.js'
import { localizedDescription } from '../commands.js'
import { t } from '../i18n.js'
import { modLabel } from '../utils/modifiers.js'

/**
 * The `?` help menu, mirroring Claude Code's `PromptInputHelpMenu.tsx`
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
          <Text dimColor>{t('help-for-commands')}</Text>
        </Box>
        <Box>
          <Text dimColor>{t('help-this-help')}</Text>
        </Box>
        <Box>
          <Text dimColor>{t('help-verbose-output', { mod: modLabel })}</Text>
        </Box>
        <Box>
          <Text dimColor>{t('help-open-trajectory', { mod: modLabel })}</Text>
        </Box>
        <Box>
          <Text dimColor>{t('help-search-history', { mod: modLabel })}</Text>
        </Box>
        <Box>
          <Text dimColor>{t('help-interrupt')}</Text>
        </Box>
        <Box>
          <Text dimColor>{t('help-exit')}</Text>
        </Box>
        <Box>
          <Text dimColor>{t('help-redraw', { mod: modLabel })}</Text>
        </Box>
      </Box>
      <Box flexDirection="column" width={24} flexShrink={0}>
        <Box>
          <Text dimColor>{t('help-clear-input')}</Text>
        </Box>
        <Box>
          <Text dimColor>{t('help-history-nav')}</Text>
        </Box>
        <Box>
          <Text dimColor>{t('help-move-cursor')}</Text>
        </Box>
        <Box>
          <Text dimColor>{t('help-word-jumps', { mod: modLabel })}</Text>
        </Box>
        <Box>
          <Text dimColor>{t('help-complete-command')}</Text>
        </Box>
        <Box>
          <Text dimColor>{t('help-cycle-mode')}</Text>
        </Box>
        <Box>
          <Text dimColor>{t('help-open-editor')}</Text>
        </Box>
      </Box>
      <Box flexDirection="column" flexShrink={1}>
        <Text dimColor>{t('help-commands-title')}</Text>
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
