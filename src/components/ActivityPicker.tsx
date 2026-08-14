import React from 'react'
import { t } from '../i18n.js'
import { Box, Text } from '../ui.js'
import { Pane } from './design-system/Pane.js'
import { Select } from './Select.js'
import { Byline } from './design-system/Byline.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { FRAME_PRESETS, PRESET_NAMES } from './activityFrames.js'

/**
 * Working-activity indicator picker in the CC ModelPicker style (ported
 * from the pi extension's `/activity` interactive select): a
 * permission-colored Pane listing every preset (random first) with its
 * frame preview, `❯` focus pointer and `✓` on the active preset. Enter
 * applies through `channel.setActivityFrames`, Esc cancels.
 */
export function ActivityPicker({
  focusIndex,
  currentPreset,
}: {
  focusIndex: number
  currentPreset: string | undefined
}): React.ReactNode {
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            Indicator preset
          </Text>
        </Box>
        <Select
          options={PRESET_NAMES.map(name => ({
            value: name,
            label: name,
            description: name === 'random'
              ? t('activity-random-each-preset')
              : FRAME_PRESETS[name].frames.slice(0, 5).join(' '),
          }))}
          focusIndex={focusIndex}
          selectedValue={currentPreset}
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
