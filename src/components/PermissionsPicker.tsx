import React from 'react'
import { t } from '../i18n.js'
import { Box, Text } from '../ui.js'
import { Pane } from './design-system/Pane.js'
import { Select } from './Select.js'
import { HintLine } from './design-system/HintLine.js'

/**
 * `/permission` sandbox-preset picker. The command itself is registered by
 * the harness side (dsh-sandbox-policy / dsh-base permission-presets row);
 * bare `/permission` opens this picker and Enter dispatches
 * `/permission <preset>` through the same external-command path a hand-typed
 * argument takes. The list mirrors the `sandbox/mode` vocabulary the session
 * modes use (`sessionModes.ts`), so the ✓ mark stays consistent with the
 * mode the TUI derives from the session log.
 */
export const PERMISSION_PRESET_IDS = [
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const

export type PermissionPresetId = (typeof PERMISSION_PRESET_IDS)[number]

export function PermissionsPicker({
  focusIndex,
  currentMode,
  cwd,
  onPick,
}: {
  focusIndex: number
  currentMode: string | undefined
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
          options={[
            { value: 'read-only', label: t('permission-preset-readonly'), description: t('permission-preset-readonly-desc') },
            { value: 'workspace-write', label: t('permission-preset-workspace-write'), description: t('permission-preset-workspace-write-desc') },
            { value: 'danger-full-access', label: t('permission-preset-full-access'), description: t('permission-preset-full-access-desc') },
          ]}
          focusIndex={focusIndex}
          selectedValue={currentMode}
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
