import React from 'react'
import { t } from '../i18n.js'
import { Box, Text } from '../ui.js'
import { Pane } from './design-system/Pane.js'
import { Select, type SelectOption } from './Select.js'
import { Byline } from './design-system/Byline.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { getTheme, THEME_NAMES, type Theme } from '../theme.js'
import { buildTheme, listCustomThemes } from '../customTheme.js'
import type { Color } from '../ink/styles.js'

/** One double-block swatch character per preview key, in a row. */
const SWATCH = '██'

/** Theme keys previewed in the picker, chosen for visual contrast. */
const SWATCH_KEYS = ['claude', 'text', 'success'] as const

function swatches(theme: Theme): React.ReactNode {
  return (
    <>
      {SWATCH_KEYS.map(key => (
        <Text key={key} color={theme[key] as Color}>
          {SWATCH}
        </Text>
      ))}
    </>
  )
}

/** A picker row: display name + color swatches. */
function optionFor(name: string, displayName: string, theme: Theme, description: string): SelectOption {
  return {
    value: name,
    label: (
      <>
        {displayName}
        {'  '}
        {swatches(theme)}
      </>
    ),
    description,
  }
}

/**
 * The full selectable theme list: the three built-in palettes (display
 * order) followed by discovered user themes from ~/.dsh-tui/themes (sorted
 * by file name). Shared by ThemePicker (render) and the /theme command
 * (focus index), so both always see the same ordering.
 */
export function getThemeOptions(): SelectOption[] {
  const builtins = THEME_NAMES.map(name => {
    const theme = getTheme(name)
    return optionFor(name, name, theme, t('theme-builtin-base', { name }))
  })
  const custom = listCustomThemes().map(spec =>
    optionFor(
      spec.name,
      spec.displayName,
      buildTheme(spec),
      t('theme-user-base', { base: spec.base, name: spec.name }),
    ),
  )
  return [...builtins, ...custom]
}

/**
 * Color-theme picker in the ActivityPicker style: a permission-colored Pane
 * listing the built-in palettes first, then every user theme found in
 * ~/.dsh-tui/themes — each row shows the display name, its base and three
 * key color swatches; `❯` marks focus, `✓` the active theme. Enter applies
 * through the ThemeProvider setter (persists to ~/.dsh-tui/theme.json and
 * hot swaps), Esc cancels.
 */
export function ThemePicker({
  focusIndex,
  currentTheme,
}: {
  focusIndex: number
  currentTheme: string | undefined
}): React.ReactNode {
  const options = React.useMemo(() => getThemeOptions(), [])
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            Color theme
          </Text>
        </Box>
        <Select
          options={options}
          focusIndex={focusIndex}
          selectedValue={currentTheme}
          visibleOptionCount={6}
        />
        <Text dimColor italic>
          <Byline>
            <KeyboardShortcutHint shortcut="Enter" action="confirm" bold />
            <KeyboardShortcutHint shortcut="Esc" action="exit" />
          </Byline>
        </Text>
      </Box>
    </Pane>
  )
}
