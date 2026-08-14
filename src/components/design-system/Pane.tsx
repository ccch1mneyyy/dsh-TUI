import React from 'react'
import Box from '../../ink/components/Box.js'
import { Divider } from './Divider.js'
import type { Theme } from '../../theme.js'

/**
 * A pane — a region below the prompt bounded by a colored top line with a
 * one-row gap above and horizontal padding (ported from the leak's
 * design-system/Pane.tsx). Used by the slash-command dialogs (/thinking,
 * /model, /resume).
 *
 * @example
 * <Pane color="permission">...</Pane>
 */
export function Pane({
  children,
  color,
}: {
  children: React.ReactNode
  /** Theme color for the top border line. */
  color?: keyof Theme
}): React.ReactNode {
  return (
    <Box flexDirection="column" paddingTop={1}>
      <Divider color={color} />
      <Box flexDirection="column" paddingX={2}>
        {children}
      </Box>
    </Box>
  )
}
