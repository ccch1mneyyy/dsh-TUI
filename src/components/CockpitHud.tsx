import React from 'react'
import { Box, Text } from '../ui.js'
import { Divider } from './design-system/Divider.js'
import { t } from '../i18n.js'
import type { Channel } from '../dsh-adapter/channel.js'
import { modeDisplayName } from '../sessionModes.js'

/**
 * Pinned one-line identity HUD above the scrolling transcript. Mounted by
 * Chat when `channel.cockpit` is on and minimal mode is off. Missing fields
 * are omitted; a missing llm modality table omits `io` rather than throwing.
 */
export function CockpitHud({ channel }: { channel: Channel }): React.ReactNode {
  const chips: { key: string; label: string; value: string }[] = []
  if (channel.provider !== '') {
    chips.push({ key: 'prov', label: t('cockpit-label-prov'), value: channel.provider })
  }
  if (channel.model !== '') {
    chips.push({ key: 'model', label: t('cockpit-label-model'), value: channel.model })
  }
  if (channel.reasoningEffort !== undefined && channel.reasoningEffort !== '') {
    chips.push({ key: 'eff', label: t('cockpit-label-eff'), value: channel.reasoningEffort })
  }
  if (channel.modeIndex > 0) {
    chips.push({ key: 'mode', label: t('cockpit-label-mode'), value: modeDisplayName(channel.mode) })
  }
  const io = ioChip(channel.inputModalities)
  if (io !== undefined) {
    chips.push({ key: 'io', label: t('cockpit-label-io'), value: io })
  }

  return (
    <Box flexDirection="column" flexShrink={0} width="100%">
      <Box flexDirection="row" width="100%" height={1} paddingX={1} flexShrink={0}>
        {chips.map((chip, index) => (
          <React.Fragment key={chip.key}>
            {index > 0 ? <Text color="subtle">  </Text> : null}
            <Text color="inactive">{chip.label} </Text>
            <Text color="text" wrap="truncate">{chip.value}</Text>
          </React.Fragment>
        ))}
      </Box>
      <Divider color="promptBorder" />
    </Box>
  )
}

/** `vision` when image is accepted, `text` when the table is known without image, omit when unknown. */
function ioChip(modalities: readonly string[] | undefined): string | undefined {
  if (modalities === undefined) return undefined
  return modalities.includes('image') ? t('cockpit-io-vision') : t('cockpit-io-text')
}
