import React from 'react'
import { t } from '../i18n.js'
import { Box, Text } from '../ui.js'
import { Pane } from './design-system/Pane.js'
import { Select } from './Select.js'
import { HintLine } from './design-system/HintLine.js'
import { SESSION_COLOR_NAMES, SESSION_COLORS } from '../cc/sessionColors.js'

/**
 * Session accent color picker (bare `/color`): a permission-colored Pane
 * listing the whole palette with a colored swatch per row, `❯` focus
 * pointer and `✓` on the session's current color. Enter applies through
 * `channel.setSessionColor`, Esc cancels. The palette is static, so the
 * picker never needs an async list.
 */
export function ColorPicker({
  focusIndex,
  currentColor,
  onPick,
}: {
  focusIndex: number
  /** The session's current accent color name ('' = theme default). */
  currentColor: string
  /** Mouse pick (fullscreen): clicked row's absolute index (Chat applies
   *  the same code path as the keyboard Enter). */
  onPick?: (index: number) => void
}): React.ReactNode {
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            {t('picker-title-color')}
          </Text>
        </Box>
        <Select
          options={SESSION_COLOR_NAMES.map(name => ({
            value: name,
            label: (
              <Text>
                <Text color={SESSION_COLORS[name]}>● </Text>
                {name}
              </Text>
            ),
          }))}
          focusIndex={focusIndex}
          selectedValue={currentColor === '' ? undefined : currentColor}
          onPick={onPick ? index => onPick(index) : undefined}
        />
        <Text dimColor italic>
          <HintLine text={t('hint-confirm-exit')} />
        </Text>
      </Box>
    </Pane>
  )
}
