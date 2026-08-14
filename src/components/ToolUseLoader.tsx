import React from 'react'
import Box from '../ink/components/Box.js'
import Text from '../ink/components/Text.js'
import { useBlink } from '../hooks/useBlink.js'
import { BLACK_CIRCLE } from '../cc/figures.js'

type Props = {
  isError: boolean
  isUnresolved: boolean
  shouldAnimate: boolean
}

/**
 * The status dot on tool-call rows (ported from the leak's ToolUseLoader):
 * blinking `●` while running, green on success, red on error, dim when queued.
 */
export function ToolUseLoader({
  isError,
  isUnresolved,
  shouldAnimate,
}: Props): React.ReactNode {
  const [ref, isBlinking] = useBlink(shouldAnimate)
  const color = isUnresolved ? undefined : isError ? 'error' : 'success'
  const char =
    !shouldAnimate || isBlinking || isError || !isUnresolved
      ? BLACK_CIRCLE
      : ' '

  return (
    <Box ref={ref} minWidth={2}>
      <Text color={color} dimColor={isUnresolved}>
        {char}
      </Text>
    </Box>
  )
}
