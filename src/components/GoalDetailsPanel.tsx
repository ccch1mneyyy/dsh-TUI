import React from 'react'
import { Box, Text, ScrollBox, useInput, useTerminalSize, type ScrollBoxHandle } from '../ui.js'
import type { ChannelGoal } from '../dsh-adapter/channel.js'
import { Pane } from './design-system/Pane.js'
import { useOverlayListRows } from './OverlayAbove.js'
import { t } from '../i18n.js'
import wrapText from '../ink/wrap-text.js'

/** Full goal text in the existing prompt-anchored modal layer. */
export function GoalDetailsPanel({ goal, onClose, inputEnabled = true }: {
  goal: ChannelGoal
  onClose: () => void
  inputEnabled?: boolean
}): React.ReactNode {
  const scrollRef = React.useRef<ScrollBoxHandle | null>(null)
  const { columns } = useTerminalSize()
  const innerWidth = Math.max(1, columns - 4)
  const wrappedRows = (text: string) => wrapText(text, innerWidth, 'wrap').split('\n').length
  const hint = t('goal-details-hint')
  const hintRows = wrappedRows(hint)
  const bodyRows = useOverlayListRows(3 + hintRows)
  const blockedMessage = goal.phase === 'blocked' ? goal.blockedReason?.message : undefined
  // A definite height keeps the ScrollBox scrollable; fit it to short goals.
  const contentRows = wrappedRows(goal.objective) + (blockedMessage === undefined ? 0 : wrappedRows(blockedMessage))
  const viewportRows = Math.max(1, Math.min(contentRows, bodyRows))
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
  }, { isActive: inputEnabled })
  if (!inputEnabled) return null
  return (
    <Box flexDirection="column" backgroundColor="toolCardBackground">
      <Pane color="permission">
        <Box height={1} flexShrink={0}>
          <Text color="remember" bold wrap="truncate">{t('goal-details-title')}</Text>
        </Box>
        <ScrollBox ref={scrollRef} flexDirection="column" height={viewportRows} flexShrink={0}>
          <Text wrap="wrap">{goal.objective}</Text>
          {blockedMessage !== undefined && (
            <Text color="error" wrap="wrap">{blockedMessage}</Text>
          )}
        </ScrollBox>
        <Box onClick={onClose} flexShrink={0}>
          <Text dimColor wrap="wrap">{hint}</Text>
        </Box>
      </Pane>
    </Box>
  )
}
