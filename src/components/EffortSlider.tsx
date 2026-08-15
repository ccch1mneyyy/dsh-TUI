import React from 'react'
import { t } from '../i18n.js'
import { Box, Text } from '../ui.js'
import { Pane } from './design-system/Pane.js'
import { HintLine } from './design-system/HintLine.js'
import type { EffortOption } from '../channel.js'

/**
 * Reasoning-effort slider (`/effort`): a rheostat row of the live route's
 * adapter-owned levels in adapter order, ←/→ moving focus (each move applies
 * immediately through `channel.setEffort` — the slider IS the control; Enter
 * or Esc just closes it). The current level carries `✓`; the focused level's
 * description renders below the row.
 */
export function EffortSlider({
  options,
  focusIndex,
  currentId,
}: {
  options: readonly EffortOption[]
  focusIndex: number
  currentId: string | undefined
}): React.ReactNode {
  const focused = options[focusIndex]
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            {t('picker-title-effort')}
          </Text>
        </Box>
        <Box flexDirection="row">
          {options.map((option, index) => (
            <React.Fragment key={option.id}>
              {index > 0 ? (
                <Text dimColor> ── </Text>
              ) : null}
              <Text
                inverse={index === focusIndex}
                bold={index === focusIndex}
              >
                {option.name}
              </Text>
              {option.id === currentId ? <Text color="remember">✓</Text> : null}
            </React.Fragment>
          ))}
        </Box>
        {focused?.description !== undefined ? (
          <Text dimColor>{focused.description}</Text>
        ) : null}
        <Text dimColor italic>
          <HintLine text={t('hint-adjust-done')} />
        </Text>
      </Box>
    </Pane>
  )
}
