/**
 * BtwPanelFallback：btw 面板未启用/不存在/配置禁用时的 /btw 浮层回退
 * （设计 btw-panel.md §快路径与 fallback）。同一问答不允许 overlay 与
 * side panel 双份呈现——Chat 只在面板未启用时挂本浮层。
 *
 * 数据源是线程 store 的当前 session 线程（read-only：无 composer、无
 * attach），键位沿用旧 BtwPanel 契约：Esc/Enter/Space 关闭（关闭即
 * abort 在途轮，Chat 侧接线）、↑/↓ 滚动、c 复制；浮层拥有键盘期间吞
 * 掉一切泄漏。footer 附「启用 btw 面板」引导（不偷改用户 panel 列表）。
 */
import React from 'react'
import { Box, Text, useInput, useTerminalSize, type ScrollBoxHandle } from '../ui.js'
import { t } from '../i18n.js'
import { isPlainReturnInput } from '../utils/modifiers.js'
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

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" maxHeight={Math.max(5, rows - 8)}>
        <BtwThreadView
          thread={thread}
          width={columns}
          height={Math.max(5, rows - 10)}
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
