import React from 'react'
import { Box, Text, ScrollBox, useInput, useTerminalSize, type ScrollBoxHandle } from '../ui.js'
import type { ChannelGoal } from '../dsh-adapter/channel.js'
import { Pane } from './design-system/Pane.js'
import { useOverlayListRows } from './OverlayAbove.js'
import { t } from '../i18n.js'
import wrapText from '../ink/wrap-text.js'

/** Full goal text in the existing prompt-anchored modal layer. */
export function GoalDetailsPanel({ goal, onClose }: {
  goal: ChannelGoal
  onClose: () => void
}): React.ReactNode {
  const scrollRef = React.useRef<ScrollBoxHandle | null>(null)
  const { columns } = useTerminalSize()
  const hint = t('goal-details-hint')
  const hintRows = wrapText(hint, Math.max(1, columns - 4), 'wrap').split('\n').length
  const bodyRows = useOverlayListRows(3 + hintRows)
  React.useEffect(() => {
    scrollRef.current?.scrollTo(0)
  }, [goal.objective, goal.blockedReason?.message])
  useInput((_input, key, event) => {
    if (key.escape) onClose()
    else if (key.upArrow || key.downArrow || key.wheelUp || key.wheelDown) {
      scrollRef.current?.scrollBy(key.upArrow || key.wheelUp ? -3 : 3)
    } else if (key.pageUp || key.pageDown) {
      const page = Math.max(1, (scrollRef.current?.getViewportHeight() ?? bodyRows) - 1)
      scrollRef.current?.scrollBy(key.pageUp ? -page : page)
    } else if (key.home) scrollRef.current?.scrollTo(0)
    else if (key.end) scrollRef.current?.scrollToBottom()
    event.stopImmediatePropagation()
  })
  return (
    <Box flexDirection="column" backgroundColor="toolCardBackground">
      <Pane color="permission">
        <Box height={1} flexShrink={0}>
          <Text color="remember" bold wrap="truncate">{t('goal-details-title')}</Text>
        </Box>
        <ScrollBox ref={scrollRef} flexDirection="column" height={bodyRows} flexShrink={0}>
          <Text wrap="wrap">{goal.objective}</Text>
          {goal.phase === 'blocked' && goal.blockedReason !== undefined && (
            <Text color="error" wrap="wrap">{goal.blockedReason.message}</Text>
          )}
        </ScrollBox>
        <Box onClick={onClose} flexShrink={0}>
          <Text dimColor wrap="wrap">{hint}</Text>
        </Box>
      </Pane>
    </Box>
  )
}
