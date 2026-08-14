import React from 'react'
import Box from '../../ink/components/Box.js'
import Text from '../../ink/components/Text.js'
import { useAnimationFrame } from '../../ink/hooks/use-animation-frame.js'
import { SpinnerGlyph } from '../Spinner/SpinnerGlyph.js'
import { getDefaultCharacters } from '../Spinner/spinnerUtils.js'

const SPINNER_FRAMES = [
  ...getDefaultCharacters(),
  ...[...getDefaultCharacters()].reverse(),
]

/**
 * A spinner with a loading message for async operations, ported from the
 * leak's design-system/LoadingState.tsx (using the small animated glyph).
 *
 * @example
 * <LoadingState message="Loading models" bold subtitle="Querying the provider…" />
 */
export function LoadingState({
  message,
  bold = false,
  dimColor = false,
  subtitle,
}: {
  /** The loading message to display next to the spinner. */
  message: string
  /** Display the message in bold. @default false */
  bold?: boolean
  /** Display the message in dimmed color. @default false */
  dimColor?: boolean
  /** Optional subtitle displayed below the main message. */
  subtitle?: string
}): React.ReactNode {
  const [ref, time] = useAnimationFrame(80)
  const frame = Math.floor(time / 80) % SPINNER_FRAMES.length
  return (
    <Box ref={ref} flexDirection="column">
      <Box flexDirection="row">
        <SpinnerGlyph frame={frame} messageColor="text" time={time} />
        <Text bold={bold} dimColor={dimColor}>
          {' '}
          {message}
        </Text>
      </Box>
      {subtitle && <Text dimColor>{subtitle}</Text>}
    </Box>
  )
}
