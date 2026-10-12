import React from 'react'
import Text from './ThemedText.js'
import { useDeclaredCursor, useNativeCursor } from '../../ink/hooks/use-declared-cursor.js'

/** A caret cell for a row Box; use it beside Text leaves, which own layout. */
export function InputCaret({
  children,
  active = true,
}: {
  readonly children: string
  readonly active?: boolean
}): React.ReactNode {
  const native = useNativeCursor()
  const ref = useDeclaredCursor({ line: 0, column: 0, active, visible: native })
  return <Text ref={ref} inverse={active && !native}>{children}</Text>
}
