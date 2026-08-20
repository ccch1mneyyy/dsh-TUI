import React from 'react'
import { Box, ScrollBox, Text, type ScrollBoxHandle } from '../ui.js'
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
  viewportHeight,
  viewportWidth,
  scrollRef,
}: {
  commands: readonly LocalCommand[]
  /** Fixed viewport supplied by the prompt overlay; unset for standalone renders. */
  viewportHeight?: number
  /** Terminal width used to collapse the three-column layout when necessary. */
  viewportWidth?: number
  /** PromptInput owns keyboard routing and drives this scroll viewport. */
  scrollRef?: React.Ref<ScrollBoxHandle>
}): React.ReactNode {
  const chrome = commands.filter(command => !command.skill)
  const primaryShortcuts = (
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
  )
  const secondaryShortcuts = (
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
  )
  const commandRows = chrome.map(command => (
    <Box key={command.name} flexShrink={0}>
      <Text dimColor wrap="truncate-end">
        /{command.name} — {localizedDescription(command)}
      </Text>
    </Box>
  ))
  const compactCommandRows = chrome.map(command => (
    <Box key={command.name} flexShrink={0}>
      <Text dimColor wrap="truncate-end">
        /{command.name} — {localizedDescription(command)}
      </Text>
    </Box>
  ))
  const commandList = (
    <Box flexDirection="column" flexShrink={0}>
      <Text dimColor>{t('help-commands-title')}</Text>
      {commandRows}
    </Box>
  )
  const content = (
    <Box paddingX={2} flexDirection="row" gap={4}>
      {primaryShortcuts}
      {secondaryShortcuts}
      <Box flexDirection="column" flexShrink={1}>
        {commandList}
      </Box>
    </Box>
  )

  // Standalone renders (notably the i18n verifier) keep the historical
  // intrinsic-height layout. The real prompt overlay supplies an explicit
  // height so a growing command registry cannot escape the terminal.
  if (viewportHeight === undefined) return content

  const compact = viewportWidth !== undefined && viewportWidth < 72

  return (
    <Box height={viewportHeight} flexDirection="column">
      {compact ? (
        <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1} flexShrink={1} paddingX={2}>
          {/* Below 72 columns the two fixed shortcut columns would consume
              almost the whole screen. Stack every section into one reachable
              viewport instead of squeezing the command list to zero width. */}
          {primaryShortcuts}
          {secondaryShortcuts}
          <Text dimColor>{t('help-commands-title')}</Text>
          {compactCommandRows}
        </ScrollBox>
      ) : (
        <Box paddingX={2} flexDirection="row" gap={4} flexGrow={1}>
          {primaryShortcuts}
          {secondaryShortcuts}
          {/* Keep the shortcut reference stable while only the unbounded
              command registry moves. This avoids a mostly-empty left side
              after scrolling deep into the command list. */}
          <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1} flexShrink={1}>
            {commandList}
          </ScrollBox>
        </Box>
      )}
      <Box paddingX={2} flexShrink={0}>
        <Text dimColor wrap="truncate-end">{t('help-scroll-hint')}</Text>
      </Box>
    </Box>
  )
}
