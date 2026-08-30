import React from 'react'
import { t } from '../i18n.js'
import { Box, Text } from '../ui.js'
import { Pane } from './design-system/Pane.js'
import { Select, type SelectOption } from './Select.js'
import { HintLine } from './design-system/HintLine.js'
import { type Theme } from '../theme.js'
import { listThemeCatalog } from '../themeCatalog.js'
import type { TuiThemeHost } from '../dsh-adapter/themes.js'
import { useRuntimeThemeSnapshot } from '../hooks/useRuntimeThemeSnapshot.js'
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
 * Build the full selectable list from the shared catalog: `auto`, built-ins,
 * static JSON themes, and optional plugin themes. Shared by ThemePicker (render)
 * and the /theme command (focus index), so both always see the same ordering.
 */
export function getThemeOptions(themeHost?: TuiThemeHost): SelectOption[] {
  return listThemeCatalog(themeHost).map(item => {
    const base = item.base ?? 'dark'
    const description = item.source === 'auto'
      ? t('theme-auto-base')
      : item.source === 'builtin'
        ? t('theme-builtin-base', { name: item.name })
        : item.source === 'runtime'
          ? t('theme-plugin-base', { base, name: item.name })
          : t('theme-user-base', { base, name: item.name })
    return optionFor(item.name, item.displayName, item.theme, description)
  })
}

/**
 * Color-theme picker in the ActivityPicker style: a permission-colored Pane
 * listing the `auto` pseudo-theme and built-in palettes first, followed by
 * static JSON and plugin themes — each row shows the display name, base and
 * three key color swatches; `❯` marks focus, `✓` the active theme. Enter
 * applies through the ThemeProvider setter (persists to ~/.dsh-tui/theme.json
 * and hot swaps), Esc cancels.
 */
export function ThemePicker({
  focusIndex,
  currentTheme,
  themeHost,
  onPick,
}: {
  focusIndex: number
  currentTheme: string | undefined
  /** Optional runtime theme host; static themes work without it. */
  themeHost?: TuiThemeHost
  /** Mouse pick (fullscreen): clicked row's absolute index (Chat applies
   *  the same code path as the keyboard Enter). */
  onPick?: (index: number) => void
}): React.ReactNode {
  const runtimeThemeSnapshot = useRuntimeThemeSnapshot(themeHost)
  const options = React.useMemo(
    () => getThemeOptions(themeHost),
    [runtimeThemeSnapshot, themeHost],
  )
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            {t('picker-title-theme')}
          </Text>
        </Box>
        <Select
          options={options}
          focusIndex={focusIndex}
          selectedValue={currentTheme}
          visibleOptionCount={6}
          onPick={onPick ? index => onPick(index) : undefined}
        />
        <Text dimColor italic>
          <HintLine text={t('hint-confirm-exit')} />
        </Text>
      </Box>
    </Pane>
  )
}
