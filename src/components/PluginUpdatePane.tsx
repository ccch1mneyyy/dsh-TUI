import React from 'react'
import { t } from '../i18n.js'
import { Box, Text } from '../ui.js'
import { HintLine } from './design-system/HintLine.js'
import { LoadingState } from './design-system/LoadingState.js'
import { Pane } from './design-system/Pane.js'

/**
 * `/plugin update [bundle ...]`: the update run owns the profile until it
 * settles, so this pane exists only to keep the composer locked while the flow
 * writes. Every target's plan, progress and result goes to the transcript from
 * the flow itself (`dsh-adapter/plugin-update.ts`); the host checks the target
 * and restores the removed version on failure, which is why there is no
 * confirmation or partial-step UI here.
 *
 * Presentational only; Chat ignores keys while the overlay is open and closes
 * it from the flow's completion.
 */
export function PluginUpdatePane(): React.ReactNode {
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Text color="remember" bold>{t('plugins-update-pane-title')}</Text>
        <Box marginTop={1}>
          <LoadingState message={t('plugins-update-pane-working')} />
        </Box>
      </Box>
      <Text dimColor italic><HintLine text={t('plugins-update-key-wait')} /></Text>
    </Pane>
  )
}
