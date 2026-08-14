import React from 'react'
import { Text } from '../ui.js'

/**
 * The dim "interrupted" row shown when the user stops a turn, ported from
 * the leak's `InterruptedByUser.tsx`.
 */
export function InterruptedByUser(): React.ReactNode {
  return (
    <>
      <Text dimColor>Interrupted </Text>
      <Text dimColor>· What should DeepSeek do instead?</Text>
    </>
  )
}
