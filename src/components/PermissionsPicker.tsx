import React from 'react'
import { t } from '../i18n.js'
import { Box, Text } from '../ui.js'
import { Pane } from './design-system/Pane.js'
import { Select } from './Select.js'
import { HintLine } from './design-system/HintLine.js'
import type { PermissionPresetOption } from '../dsh-adapter/channel.js'

/**
 * `/permission` sandbox-preset picker. The command itself is registered by
 * the harness side (dsh-sandbox-policy / dsh-base permission-presets row);
 * bare `/permission` opens this picker and Enter dispatches
 * `/permission <preset>` through the same external-command path a hand-typed
 * argument takes. The roster comes from the adapter snapshot so host plugins
 * can contribute additional preset identities without UI changes.
 */
export function PermissionsPicker({
  options,
  focusIndex,
  currentValue,
  cwd,
  onPick,
}: {
  options: readonly PermissionPresetOption[]
  focusIndex: number
  currentValue: string | undefined
  cwd: string
  /** Mouse pick (fullscreen): clicked row's absolute index (Chat applies
   *  the same code path as the keyboard Enter). */
  onPick?: (index: number) => void
}): React.ReactNode {
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            {t('permission-picker-title')}
          </Text>
        </Box>
        <Select
          options={options.map(option => ({
            value: option.value,
            label: option.value === 'read-only'
              ? t('permission-preset-readonly')
              : option.value === 'workspace-write'
                ? t('permission-preset-workspace-write')
                : option.value === 'danger-full-access'
                  ? t('permission-preset-full-access')
                  : option.name,
            description: option.value === 'read-only'
              ? t('permission-preset-readonly-desc')
              : option.value === 'workspace-write'
                ? t('permission-preset-workspace-write-desc')
                : option.value === 'danger-full-access'
                  ? t('permission-preset-full-access-desc')
                  : option.description ?? option.name,
          }))}
          focusIndex={focusIndex}
          selectedValue={currentValue}
          onPick={onPick ? index => onPick(index) : undefined}
        />
        <Text dimColor italic>
          <HintLine text={t('hint-confirm-exit')} />
        </Text>
        <Text dimColor>
          {t('permission-root-hint', { cwd })}
        </Text>
      </Box>
    </Pane>
  )
}
