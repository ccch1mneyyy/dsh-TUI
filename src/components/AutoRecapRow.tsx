import React from 'react'
import { Box, Text } from '../ui.js'
import { Divider } from './design-system/Divider.js'
import { t } from '../i18n.js'

/**
 * Auto-recap row (`dsh-tui.recapOnOpen` setting): a quiet, dim recap shown
 * at the bottom of the transcript after an automatic summary on session
 * open/resume — a thin divider, then a `回顾：` line showing the session
 * tail in FULL (wraps over lines rather than truncating, like a colleague
 * catching the user up). Hover reveals the affordances on their own row;
 * click expands into the full RecapPanel; the dismiss chip hides the row
 * until the next session switch. It bows out on its own once the user
 * starts a new message (see Chat.tsx). Keyboard users keep `/recap` for
 * the full panel.
 */
export function AutoRecapRow({
  summary,
  streaming,
  onExpand,
  onDismiss,
}: {
  /** The one-line summary (streamed raw, then replaced on settle). */
  summary: string
  /** True while the recap call is in flight. */
  streaming: boolean
  /** Expand into the full RecapPanel (click on the row). */
  onExpand: () => void
  /** Dismiss the row until the next session switch. */
  onDismiss: () => void
}): React.ReactNode {
  const [hovered, setHovered] = React.useState(false)
  const line = t('recap-auto-line', {
    summary: streaming ? t('recap-answering') : summary,
  })
  return (
    <Box flexDirection="column" marginTop={1}>
      <Divider />
      <Box
        flexDirection="column"
        marginTop={1}
        marginLeft={1}
        onClick={onExpand}
        onMouseEnter={(): void => setHovered(true)}
        onMouseLeave={(): void => setHovered(false)}
      >
        {/* 默认 wrap：完整换行显示，不截断。 */}
        <Text dimColor={!hovered}>{line}</Text>
        {hovered && (
          <Box flexDirection="row" marginTop={1}>
            <Text dimColor> [{t('recap-auto-hint')}]</Text>
            <Box onClick={onDismiss}>
              <Text color="warning"> [× {t('recap-auto-close')}]</Text>
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  )
}
