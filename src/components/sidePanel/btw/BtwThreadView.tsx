/**
 * BtwThreadView：Q/A 轮次的滚动列表（面板 / 全屏场景 / 浮层 fallback
 * 共用）。Question 走用户侧视觉（accent ❯ 前缀），Answer 走共享
 * Markdown；运行中显示本轮 spinner；失败只标本轮错误、保留既有答复。
 *
 * 跟尾：默认跟随尾部；用户上滚后暂停 follow，
 * 出现「有新回答」跳尾提示（点击回底）。ScrollBox 的 sticky 位就是
 * follow 信号——上滚打破 sticky，scrollToBottom/贴底恢复。
 */
import React from 'react'
import { Box, Text, ScrollBox, type ScrollBoxHandle } from '../../../ui.js'
import { Markdown } from '../../Markdown.js'
import { SpinnerGlyph } from '../../Spinner/SpinnerGlyph.js'
import { t } from '../../../i18n.js'
import type { BtwThreadSnapshot, BtwTurn } from './threads.js'

/** 80ms spinner 帧（只在有 running 轮且其还没收到首段文本时走时钟）。 */
const SPINNER_MS = 80

export function BtwThreadView({
  thread,
  width,
  height,
  /** 渲时钟的开关（面板不可见/场景失焦时停表）。 */
  alive,
  onAttachTurn,
  /** 宿主（全屏场景/浮层）接管键盘滚动用的句柄透传。 */
  scrollHandleRef,
}: {
  readonly thread: BtwThreadSnapshot | undefined
  readonly width: number
  /** 滚动区行预算（含滚动区自身；跳尾提示一行另计）。 */
  readonly height: number
  readonly alive: boolean
  /** 点击已完成轮的答案区触发送到聊天（fallback 形态不传 = 无该交互）。 */
  readonly onAttachTurn?: (turn: BtwTurn) => void
  readonly scrollHandleRef?: { current: ScrollBoxHandle | null }
}): React.ReactNode {
  const localScrollRef = React.useRef<ScrollBoxHandle | null>(null)
  const scrollRef = scrollHandleRef ?? localScrollRef
  const [frame, setFrame] = React.useState(0)
  const [follow, setFollow] = React.useState(true)
  const [pendingJump, setPendingJump] = React.useState(false)

  const activeTurn = thread === undefined
    ? undefined
    : thread.turns.find(turn => turn.turnId === thread.activeTurnId)
  const spinning = alive && activeTurn !== undefined && activeTurn.answer === ''

  React.useEffect(() => {
    if (!spinning) return
    const interval = setInterval(() => setFrame(previous => previous + 1), SPINNER_MS)
    return () => clearInterval(interval)
  }, [spinning])

  // 滚动订阅：sticky 位翻转 = follow 翻转（上滚离开底部即暂停跟尾）。
  // 空线程时不渲染 ScrollBox——turns 首次出现后（hasTurns 翻转）重新绑定。
  const hasTurns = thread !== undefined && thread.turns.length > 0
  React.useEffect(() => {
    if (!hasTurns) return
    const handle = scrollRef.current
    if (handle === null) return
    return handle.subscribe(() => {
      const sticky = handle.isSticky()
      setFollow(previous => (previous === sticky ? previous : sticky))
      if (sticky) setPendingJump(false)
    })
  }, [hasTurns])

  // 内容增长：跟尾则钉底；暂停跟尾且有新答案内容时亮「有新回答」。
  const version = thread?.version ?? 0
  const answerLengths = React.useMemo(
    () => thread?.turns.map(turn => turn.answer.length).join(',') ?? '',
    [thread],
  )
  const prevRef = React.useRef({ version: 0, answerLengths: '' })
  React.useEffect(() => {
    const previous = prevRef.current
    prevRef.current = { version, answerLengths }
    if (version === 0 || previous.version === 0) return
    const grew = answerLengths !== previous.answerLengths
    if (!grew) return
    if (follow) scrollRef.current?.scrollToBottom()
    else setPendingJump(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, answerLengths, follow])

  const jumpTail = React.useCallback(() => {
    scrollRef.current?.scrollToBottom()
    setFollow(true)
    setPendingJump(false)
  }, [])

  if (thread === undefined || thread.turns.length === 0) {
    return (
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <Box marginTop={1}>
          <Text color="subtle" wrap="truncate">{t('btw-thread-empty')}</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden" paddingX={1}>
      <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1} stickyScroll>
        {thread.turns.map(turn => (
          <Box key={turn.turnId} flexDirection="column">
            <Box flexDirection="row" flexShrink={0}>
              <Text color="accent" bold>{'❯ '}</Text>
              <Text color="accent" wrap="wrap">{turn.question}</Text>
            </Box>
            <Box marginLeft={2} flexDirection="column">
              {turn.phase === 'completed' ? (
                <Box
                  onClick={onAttachTurn === undefined ? undefined : event => {
                    event.stopImmediatePropagation()
                    onAttachTurn(turn)
                  }}
                >
                  <Markdown cacheTokens={false}>{turn.answer}</Markdown>
                </Box>
              ) : turn.phase === 'failed' ? (
                <Text color="error" wrap="wrap">{t('btw-thread-error')}{turn.error === undefined ? '' : ': ' + turn.error}</Text>
              ) : turn.phase === 'cancelled' ? (
                <Text dimColor italic>{t('btw-thread-cancelled')}</Text>
              ) : turn.answer !== '' ? (
                <Markdown cacheTokens={false}>{turn.answer}</Markdown>
              ) : (
                <Box flexShrink={0}>
                  <SpinnerGlyph frame={frame} messageColor="warning" />
                  <Text color="warning"> {t('btw-answering')}</Text>
                </Box>
              )}
              {turn.omittedOlderCount > 0 && (
                <Text dimColor italic wrap="truncate">
                  {t('btw-thread-context-omitted', { n: turn.omittedOlderCount })}
                </Text>
              )}
            </Box>
            <Box height={1} flexShrink={0} />
          </Box>
        ))}
      </ScrollBox>
      {pendingJump && !follow && (
        <Box flexShrink={0} onClick={event => { event.stopImmediatePropagation(); jumpTail() }}>
          <Text color="permission">↓ {t('btw-thread-unread')}</Text>
        </Box>
      )}
    </Box>
  )
}
