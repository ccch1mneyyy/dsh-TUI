/**
 * BtwThreadScene（btw 面板的 ⤢ 全屏）：完整问题与 Markdown 长文、线程
 * 滚动、composer 追问。Esc 返回侧栏，面板状态原样（mountPolicy=enabled
 * 不卸载，thread 与 draft 都在线程 store）。
 *
 * 键层级：composer 编辑（Esc 收起草稿）> 场景滚动/动作 > Esc 退出场景。
 */
import React from 'react'
import { Box, Text, useInput, useTerminalSize, type ScrollBoxHandle } from '../../../ui.js'
import { t } from '../../../i18n.js'
import type { ChannelUi } from '../../../adapter/channel/ui-policy.js'
import { setClipboard } from '../../../ink/termio/osc.js'
import { btwThreads } from './threads.js'
import { getBtwContextBudget, getBtwContextTurns } from '../../../tuiDisplayPrefs.js'
import { BtwComposer, btwComposerKey } from './BtwComposer.js'
import { BtwThreadView } from './BtwThreadView.js'

export function BtwThreadScene({
  channel,
  onClose,
}: {
  readonly channel: ChannelUi
  readonly onClose: () => void
}): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const sessionId = String(channel.agentId)
  const thread = React.useSyncExternalStore(btwThreads.subscribe, () => btwThreads.get(sessionId))
  const [composerFocus, setComposerFocus] = React.useState(true)
  const caretRef = React.useRef(0)
  const [caret, setCaretState] = React.useState(0)
  const setCaret = (next: number): void => {
    caretRef.current = next
    setCaretState(next)
  }
  const [notice, setNotice] = React.useState<{ readonly text: string; readonly failure: boolean } | null>(null)
  const scrollRef = React.useRef<ScrollBoxHandle | null>(null)
  const busy = thread !== undefined && thread.activeTurnId !== null

  const attachTurn = React.useCallback((turn: { readonly turnId: string; readonly question: string; readonly answer: string; readonly phase: string }) => {
    if (turn.phase !== 'completed') return
    if (typeof channel.attachContext !== 'function') return
    channel.attachContext({
      source: 'panel',
      sourceId: turn.turnId,
      title: '/btw: ' + turn.question,
      content: turn.answer,
    })
    const staged = channel.attachedContexts.find(entry => entry.sourceId === turn.turnId)
    channel.notify(
      staged?.truncated === true ? t('btw-thread-answer-truncated') : t('btw-thread-answer-attached'),
      { color: 'success' },
    )
  }, [channel])

  useInput((input, key, event) => {
    if (composerFocus) {
      const text = btwThreads.get(sessionId)?.draft ?? ''
      const result = btwComposerKey({ text, caret: caretRef.current }, input, key as Parameters<typeof btwComposerKey>[2])
      if (result !== null) {
        event.stopImmediatePropagation()
        if (result.exitFocus === true) { setComposerFocus(false); return }
        if (result.submit === true) {
          if (text.trim() !== '') {
            const outcome = btwThreads.submit(sessionId, text, (question, options) => channel.sideQuestion(question, options), { recentTurnsLimit: getBtwContextTurns(), contextBudget: getBtwContextBudget() })
            if (!outcome.ok) setNotice({ text: t('btw-thread-busy'), failure: true })
            else {
              btwThreads.setDraft(sessionId, '')
              setCaret(0)
              setNotice(null)
            }
          }
          return
        }
        if (result.state !== undefined) {
          btwThreads.setDraft(sessionId, result.state.text)
          setCaret(result.state.caret)
          setNotice(null)
        }
        return
      }
      return
    }
    if (key.escape) {
      event.stopImmediatePropagation()
      onClose()
      return
    }
    if (key.upArrow) { scrollRef.current?.scrollBy(-3); event.stopImmediatePropagation(); return }
    if (key.downArrow) { scrollRef.current?.scrollBy(3); event.stopImmediatePropagation(); return }
    if (key.pageUp) { scrollRef.current?.scrollBy(-(rows - 4)); event.stopImmediatePropagation(); return }
    if (key.pageDown) { scrollRef.current?.scrollBy(rows - 4); event.stopImmediatePropagation(); return }
    // ink reports a plain Tab as key.tab with an empty input.
    if (key.tab || input === '\t') { setComposerFocus(true); event.stopImmediatePropagation(); return }
    if (input === 'n' && !key.ctrl && !key.meta) {
      btwThreads.newTopic(sessionId)
      channel.notify(t('btw-thread-clear'), { timeoutMs: 2500 })
      event.stopImmediatePropagation()
      return
    }
    if (input === 's' && !key.ctrl && !key.meta) {
      const latest = [...(btwThreads.get(sessionId)?.turns ?? [])].reverse().find(turn => turn.phase === 'completed')
      if (latest !== undefined) attachTurn(latest)
      event.stopImmediatePropagation()
      return
    }
    if (input === 'c' && !key.ctrl && !key.meta) {
      const latest = [...(btwThreads.get(sessionId)?.turns ?? [])].reverse().find(turn => turn.phase === 'completed')
      if (latest !== undefined) {
        void setClipboard(latest.answer)
        channel.notify(t('copied-chars', { n: latest.answer.length }), { timeoutMs: 1500 })
      }
      event.stopImmediatePropagation()
    }
  })

  return (
    <Box flexDirection="column" width={columns} height={rows} paddingX={1}>
      <Box flexDirection="row" width="100%" height={1} flexShrink={0}>
        <Text color="warning" bold>{t('btw-fullscreen-title')}</Text>
        <Text dimColor>{'  ' + t('btw-thread-send-to-chat') + ' [s] · ' + t('btw-thread-new') + ' [n] · Esc'}</Text>
      </Box>
      <BtwThreadView
        thread={thread}
        width={columns - 2}
        height={Math.max(3, rows - 4)}
        alive
        onAttachTurn={attachTurn}
        scrollHandleRef={scrollRef}
      />
      <BtwComposer
        state={{ text: thread?.draft ?? '', caret }}
        focused={composerFocus}
        busy={busy}
        notice={notice === null ? undefined : notice}
      />
    </Box>
  )
}
