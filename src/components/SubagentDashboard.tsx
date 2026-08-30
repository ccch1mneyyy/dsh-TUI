import React from 'react'
import { Box, Text, useInput, ScrollBox, type ScrollBoxHandle, useTerminalSize } from '../ui.js'
import { SubagentCard } from './SubagentCard.js'
import type { SubagentState } from '../dsh-adapter/subagents.js'
import type { Theme } from '../theme.js'
import { t } from '../i18n.js'
import { Divider } from './design-system/Divider.js'
import { isPlainReturnInput } from '../utils/modifiers.js'

export interface SubagentDashboardProps {
  subagents: SubagentState[]
  onClose: () => void
  onSelect?: (agentId: string) => void
}

/** 可点击 ✕ 退出按钮：整屏/浮层场景的鼠标退出通道（Esc 等价）。 */
export function ExitButton({ onClick }: { onClick: () => void }): React.ReactNode {
  const [hovered, setHovered] = React.useState(false)
  return (
    <Box
      onClick={onClick}
      onMouseEnter={(): void => setHovered(true)}
      onMouseLeave={(): void => setHovered(false)}
    >
      <Text color={hovered ? 'text' : 'subtle'}>{' ✕'}</Text>
    </Box>
  )
}

/**
 * SubagentDashboard — overlay panel showing all active/recent subagents.
 * Keyboard: up/down to navigate, Enter to view detail, Esc to close.
 */
export function SubagentDashboard({ 
  subagents, 
  onClose, 
  onSelect 
}: SubagentDashboardProps): React.ReactNode {
  const [focusIndex, setFocusIndex] = React.useState(0)
  const scrollRef = React.useRef<ScrollBoxHandle | null>(null)
  const { rows, columns } = useTerminalSize()

  useInput((input, key, event) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      event.stopImmediatePropagation()
      onClose()
      return
    }
    
    if (key.upArrow) {
      event.stopImmediatePropagation()
      setFocusIndex(i => Math.max(0, i - 1))
      scrollRef.current?.scrollBy(-3)
      return
    }
    
    if (key.downArrow) {
      event.stopImmediatePropagation()
      setFocusIndex(i => Math.min(subagents.length - 1, i + 1))
      scrollRef.current?.scrollBy(3)
      return
    }
    
    if (isPlainReturnInput(input, key) && onSelect) {
      event.stopImmediatePropagation()
      const selected = subagents[focusIndex]
      if (selected) onSelect(selected.agentId)
      return
    }
    
    // Consume all input while dashboard is open
    event.stopImmediatePropagation()
  })

  const running = subagents.filter(s => s.status === 'running').length
  const completed = subagents.filter(s => s.status === 'completed').length
  const failed = subagents.filter(s => s.status === 'failed').length

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Divider 
        color="claude" 
        title={t('subagent-dashboard-title')} 
      />
      
      <Box flexDirection="row" gap={3} marginTop={1} marginBottom={1}>
        <Text>
          <Text color="claude">{running}</Text>
          <Text dimColor> {t('subagent-count-running')}</Text>
        </Text>
        <Text>
          <Text color="success">{completed}</Text>
          <Text dimColor> {t('subagent-count-completed')}</Text>
        </Text>
        {failed > 0 && (
          <Text>
            <Text color="error">{failed}</Text>
            <Text dimColor> {t('subagent-count-failed')}</Text>
          </Text>
        )}
        <Box flexGrow={1} />
        {/* 可点击退出（Esc 的鼠标等价），hover 提亮 */}
        <ExitButton onClick={onClose} />
      </Box>

      <Box flexDirection="column" maxHeight={Math.max(10, rows - 10)} marginTop={1}>
        <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1}>
          {subagents.length === 0 ? (
            <Box flexDirection="column" alignItems="center" marginTop={Math.max(2, Math.floor((rows - 16) / 3))}>
              <Text dimColor>{'○'}</Text>
              <Text dimColor>{t('subagent-none')}</Text>
              <Box marginTop={1}><Text dimColor>{t('subagent-empty-hint')}</Text></Box>
            </Box>
          ) : (
            subagents.map((subagent, index) => (
              <Box key={subagent.agentId} flexDirection="column">
                <SubagentCard
                  subagent={subagent}
                  focused={index === focusIndex}
                  onClick={onSelect !== undefined
                    // Click = view detail, same as Enter on the focused card.
                    ? () => onSelect(subagent.agentId)
                    : undefined}
                />
                {index < subagents.length - 1 && (
                  <Text dimColor>{'─'.repeat(Math.max(20, Math.min(72, columns - 6)))}</Text>
                )}
              </Box>
            ))
          )}
        </ScrollBox>
      </Box>

      <Divider color="subtle" title="" />
      <Box marginTop={0}>
        <Text dimColor>
          {onSelect 
            ? t('subagent-dashboard-hint-detail') 
            : t('subagent-dashboard-hint-basic')}
        </Text>
      </Box>
    </Box>
  )
}
