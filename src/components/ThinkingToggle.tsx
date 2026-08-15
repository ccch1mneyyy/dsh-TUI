import React from 'react'
import { t } from '../i18n.js'
import { Box, Text } from '../ui.js'
import { Pane } from './design-system/Pane.js'
import { Select } from './Select.js'
import { HintLine } from './design-system/HintLine.js'

/**
 * The `/thinking` dialog, ported from the leak's ThinkingToggle.tsx: a
 * permission-colored Pane with a bold title, the Enabled/Disabled select
 * (with CC's option descriptions), and the Enter/Esc hint line.
 *
 * When `confirmationPending` is set (mid-conversation toggle), the select is
 * replaced by CC's yellow warning block and the hint line becomes
 * Enter confirm / Esc cancel; keyboard handling lives in the caller (Chat).
 */
export function ThinkingToggle({
  currentValue,
  focusIndex,
  confirmationPending,
}: {
  currentValue: boolean
  focusIndex: number
  /** Set while a mid-conversation toggle awaits Enter confirmation. */
  confirmationPending: boolean | null
}): React.ReactNode {
  const options = [
    {
      value: 'true',
      label: t('thinking-enabled'),
      description: t('thinking-enabled-desc'),
    },
    {
      value: 'false',
      label: t('thinking-disabled'),
      description: t('thinking-disabled-desc'),
    },
  ]

  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1} flexDirection="column">
          <Text color="remember" bold>
            {t('thinking-title')}
          </Text>
          <Text dimColor>{t('thinking-subtitle')}</Text>
        </Box>

        {confirmationPending !== null ? (
          <Box flexDirection="column" marginBottom={1} gap={1}>
            <Text color="warning">
              {t('thinking-mid-warning')}
            </Text>
            <Text color="warning">{t('thinking-proceed')}</Text>
          </Box>
        ) : (
          <Box flexDirection="column" marginBottom={1}>
            <Select
              options={options}
              focusIndex={focusIndex}
              selectedValue={currentValue ? 'true' : 'false'}
              visibleOptionCount={2}
            />
          </Box>
        )}
      </Box>
      <Text dimColor italic>
        <HintLine text={confirmationPending !== null ? t('hint-confirm-cancel') : t('hint-confirm-exit')} />
      </Text>
    </Pane>
  )
}
