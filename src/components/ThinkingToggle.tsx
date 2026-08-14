import React from 'react'
import { Box, Text } from '../ui.js'
import { Pane } from './design-system/Pane.js'
import { Select } from './Select.js'
import { Byline } from './design-system/Byline.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'

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
      label: 'Enabled',
      description: 'DeepSeek will think before responding',
    },
    {
      value: 'false',
      label: 'Disabled',
      description: 'DeepSeek will respond without extended thinking',
    },
  ]

  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1} flexDirection="column">
          <Text color="remember" bold>
            Toggle thinking mode
          </Text>
          <Text dimColor>Enable or disable thinking for this session.</Text>
        </Box>

        {confirmationPending !== null ? (
          <Box flexDirection="column" marginBottom={1} gap={1}>
            <Text color="warning">
              Changing thinking mode mid-conversation will increase latency and
              may reduce quality. For best results, set this at the start of a
              session.
            </Text>
            <Text color="warning">Do you want to proceed?</Text>
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
        <Byline>
          <KeyboardShortcutHint shortcut="Enter" action="confirm" bold />
          <KeyboardShortcutHint
            shortcut="Esc"
            action={confirmationPending !== null ? 'cancel' : 'exit'}
          />
        </Byline>
      </Text>
    </Pane>
  )
}
