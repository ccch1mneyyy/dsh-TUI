import figures from 'figures'
import React from 'react'
import Text from '../../ink/components/Text.js'

type Status = 'success' | 'error' | 'warning' | 'info' | 'pending' | 'loading'

const STATUS_CONFIG: Record<
  Status,
  { icon: string; color: 'success' | 'error' | 'warning' | 'suggestion' | undefined }
> = {
  success: { icon: figures.tick, color: 'success' },
  error: { icon: figures.cross, color: 'error' },
  warning: { icon: figures.warning, color: 'warning' },
  info: { icon: figures.info, color: 'suggestion' },
  pending: { icon: figures.circle, color: undefined },
  loading: { icon: '…', color: undefined },
}

/**
 * A status indicator icon with the CC color mapping (ported from the leak's
 * design-system/StatusIcon.tsx): ✓ green / ✗ red / ⚠ amber / ℹ blue /
 * ○ dim / … dim.
 */
export function StatusIcon({
  status,
  withSpace = false,
}: {
  /** The status to display; determines both the icon and color. */
  status: Status
  /** Include a trailing space after the icon. Useful when followed by text. */
  withSpace?: boolean
}): React.ReactNode {
  const config = STATUS_CONFIG[status]
  return (
    <Text color={config.color}>
      {config.icon}
      {withSpace ? ' ' : ''}
    </Text>
  )
}
