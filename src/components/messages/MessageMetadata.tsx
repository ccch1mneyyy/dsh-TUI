import React from 'react'
import Box from '../../ink/components/Box.js'
import Text from '../../ink/components/Text.js'
import { stringWidth } from '../../ink/stringWidth.js'

type Props = {
  /** Wall-clock ms of the assistant message event. */
  timestamp?: number
  /** Model id shown next to the time (session model). */
  model: string
}

/**
 * Transcript-mode metadata row: `HH:MM · model`, right-aligned above the
 * assistant text (ported from the leak's MessageTimestamp + MessageModel,
 * collapsed into one row).
 */
export function MessageMetadata({
  timestamp,
  model,
}: Props): React.ReactNode {
  if (timestamp === undefined) return null

  const formatted = new Date(timestamp).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })
  const text = `${formatted} · ${model}`
  return (
    <Box minWidth={stringWidth(text)}>
      <Text dimColor>{text}</Text>
    </Box>
  )
}
