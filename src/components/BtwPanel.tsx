/**
 * BtwPanelFallback：btw 侧栏面板未启用时的 /btw 浮层。同一问答只在一处
 * 呈现，Chat 只在面板未启用时挂它。
 *
 * 内容是当前 session 的 btw 线程（只读：无 composer、无 attach）。键位：
 * Esc/Enter/Space 关闭（关闭即中止在途的一轮，由 Chat 接线）、↑/↓ 滚动、
 * c 复制；浮层打开时吞掉其余所有键。底部提示如何启用 btw 面板，不替用户
 * 改面板列表。
 */
import React from 'react'
import { Box, Text, useInput, useTerminalSize, type ScrollBoxHandle } from '../ui.js'
import { t } from '../i18n.js'
import { isPlainReturnInput } from '../utils/modifiers.js'
import { truncateWidth } from '../trajectory/format.js'
import { BtwThreadView } from './sidePanel/btw/BtwThreadView.js'
import type { BtwThreadSnapshot } from './sidePanel/btw/threads.js'

export function BtwPanelFallback({
  thread,
  onClose,
  onCopy,
}: {
  readonly thread: BtwThreadSnapshot | undefined
  readonly onClose: () => void
  readonly onCopy: (answer: string) => void
}): React.ReactNode {
  const scrollRef = React.useRef<ScrollBoxHandle | null>(null)
  const { rows, columns } = useTerminalSize()

  useInput((input, key, event) => {
    // A pasted chunk can carry the return flag; it must not close the
    // overlay (closing aborts the side question in flight).
    if (key.escape || isPlainReturnInput(input, key) || input === ' ') {
      event.stopImmediatePropagation()
      onClose()
      return
    }
    if (key.upArrow || key.downArrow) {
      scrollRef.current?.scrollBy(key.upArrow ? -3 : 3)
      event.stopImmediatePropagation()
      return
    }
    if (input === 'c' && !key.ctrl) {
      event.stopImmediatePropagation()
      const latest = latestAnswer(thread)
      if (latest !== '') onCopy(latest)
      return
    }
    // 浮层拥有键盘：吞掉其余一切，不泄漏进身后的输入框。
    event.stopImmediatePropagation()
  })

  const title = thread !== undefined && thread.turns.length > 0 ? thread.turns[0]!.question : ''

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" width="100%" flexShrink={0}>
        <Text color="warning" bold>{t('panel-title-btw')} </Text>
        <Text dimColor wrap="truncate">{truncateWidth(title, Math.max(4, columns - 10))}</Text>
      </Box>
      <Box flexDirection="column" maxHeight={Math.max(5, rows - 9)}>
        <BtwThreadView
          thread={thread}
          width={columns}
          height={Math.max(5, rows - 11)}
          alive
          scrollHandleRef={scrollRef}
        />
      </Box>
      <Box onClick={settled(thread) ? () => { const latest = latestAnswer(thread); if (latest !== '') onCopy(latest) } : undefined}>
        <Text dimColor>
          {settled(thread) ? t('btw-hint-done') : t('btw-hint-loading')}
          {'  ·  '}
          {t('btw-panel-unavailable')}
        </Text>
      </Box>
    </Box>
  )
}

function latestAnswer(thread: BtwThreadSnapshot | undefined): string {
  if (thread === undefined) return ''
  for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
    const turn = thread.turns[index]!
    if (turn.answer !== '') return turn.answer
  }
  return ''
}

function settled(thread: BtwThreadSnapshot | undefined): boolean {
  const active = thread?.turns.find(turn => turn.turnId === thread.activeTurnId)
  return thread === undefined || active === undefined || active.answer !== '' || active.phase === 'failed'
}
