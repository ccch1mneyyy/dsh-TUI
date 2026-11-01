/**
 * BtwThreadScene（btw 面板的 ⤢ 全屏）：完整问题与 Markdown 长文、线程
 * 滚动、composer 追问。Esc 返回侧栏，面板状态原样（mountPolicy=enabled
 * 不卸载，thread 与 draft 都在线程 store）。
 *
 * 键层级：composer 编辑（Esc 收起草稿、↑ 上到标题）> 场景动作（↑/↓ 选轮、
 * s 送聊天/撤回、c 复制）> Esc 退出场景。选中态与侧栏面板同源（线程 store），
 * 两个形态的键位与落点逐条对齐。
 */
import React from 'react'
import { Box, Text, useInput, useTerminalSize, type ScrollBoxHandle } from '../../../ui.js'
import { t } from '../../../i18n.js'
import type { ChannelUi } from '../../../adapter/channel/ui-policy.js'
import { setClipboard } from '../../../ink/termio/osc.js'
import { btwThreads } from './threads.js'
import { getBtwContextBudget, getBtwContextTurns } from '../../../tuiDisplayPrefs.js'
import { BtwComposer, btwComposerKey } from './BtwComposer.js'
import { useBtwComposerPaste } from './useBtwComposerPaste.js'
import { BtwThreadView } from './BtwThreadView.js'
import type { BtwTurn } from './threads.js'
import type { ClipboardRead } from '../../../utils/clipboard.js'

export function BtwThreadScene({
  channel,
  onClose,
  onFocusChat,
  readClipboardOverride,
}: {
  readonly channel: ChannelUi
  readonly onClose: () => void
  /** 送聊天之后把焦点交回主输入框（宿主没接时只关场景）。 */
  readonly onFocusChat?: (() => void) | undefined
  /**
   * 测试缝：composer 的 Ctrl+V 走这里读剪贴板（默认真实平台读取），
   * 无头回归注入假 reader——与问卷面板 #786 的契约同型。
   */
  readonly readClipboardOverride?: (() => Promise<ClipboardRead>) | undefined
}): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const sessionId = String(channel.agentId)
  const thread = React.useSyncExternalStore(btwThreads.subscribe, () => btwThreads.get(sessionId))
  const [composerFocus, setComposerFocus] = React.useState(true)
  const activateComposer = React.useCallback(() => setComposerFocus(true), [])
  const caretRef = React.useRef(0)
  const [caret, setCaretState] = React.useState(0)
  const setCaret = (next: number): void => {
    caretRef.current = next
    setCaretState(next)
  }
  const [notice, setNotice] = React.useState<{ readonly text: string; readonly failure: boolean } | null>(null)
  // Ctrl+V / Alt+V：与侧栏面板同一份实现（落点用实时草稿与 caret）。
  const paste = useBtwComposerPaste({ sessionId, caretRef, setCaret, setNotice, readClipboardOverride })
  const scrollRef = React.useRef<ScrollBoxHandle | null>(null)
  const busy = thread !== undefined && thread.activeTurnId !== null
  // 选中轮与侧栏面板同源（线程 store）：↑/↓ 移动、s 送聊天/撤回、c 复制。
  const turns = thread?.turns ?? []
  const selectedId = thread?.selectedTurnId ?? null
  const selectedTurn = turns.find(turn => turn.turnId === selectedId)

  const attachTurn = React.useCallback((turn: BtwTurn): boolean => {
    if (turn.phase !== 'completed') return false
    if (typeof channel.attachContext !== 'function') return false
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
    return true
  }, [channel])

  /**
   * `s` = 送聊天，再按一次 = 撤回（与侧栏面板、jobs/companion 同一契约）。
   * 送出去之后这个整屏场景就让位：关掉场景 + 焦点交回主输入框——等价于侧栏
   * 形态里「面板留着、焦点回到输入框」，两种形态的落点一致。
   */
  const sendToChat = React.useCallback((turn: BtwTurn) => {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: partial fixture channels
    const staged = (channel.attachedContexts ?? []).find(entry => entry.sourceId === turn.turnId)
    if (staged !== undefined) {
      if (typeof channel.detachContext === 'function') channel.detachContext(staged.id)
      channel.notify(t('panel-context-detached'), { color: 'success' })
      return
    }
    if (!attachTurn(turn)) return
    onFocusChat?.()
    onClose()
  }, [attachTurn, channel, onFocusChat, onClose])

  /** 点标题行：选中那一轮并离开编辑层（高亮只在列表态显示）。 */
  const selectTurn = React.useCallback((turnId: string) => {
    btwThreads.select(sessionId, turnId)
    setComposerFocus(false)
  }, [sessionId])

  const copySelected = React.useCallback(() => {
    const turn = btwThreads.selectedTurn(sessionId)
    const answer = turn !== undefined && turn.answer !== ''
      ? turn.answer
      : [...(btwThreads.get(sessionId)?.turns ?? [])].reverse().find(candidate => candidate.phase === 'completed')?.answer
    if (answer === undefined) return
    void setClipboard(answer)
    channel.notify(t('copied-chars', { n: answer.length }), { timeoutMs: 1500 })
  }, [sessionId, channel])

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
        if (result.paste === true) { paste(); return }
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
    // ↑/↓ 只挪选中，滚动交给 BtwThreadView 的「最小揭示」（出了视口才滚）。
    if (key.upArrow) {
      event.stopImmediatePropagation()
      btwThreads.moveSelection(sessionId, -1)
      return
    }
    if (key.downArrow) {
      event.stopImmediatePropagation()
      const list = btwThreads.get(sessionId)?.turns ?? []
      const current = btwThreads.selectedTurn(sessionId)
      const at = current === undefined ? list.length - 1 : list.findIndex(turn => turn.turnId === current.turnId)
      // 已在最后一条：↓ 回输入框（与输入框里按 ↑ 上到标题互为往返）。
      if (list.length === 0 || at === list.length - 1) { setComposerFocus(true); return }
      btwThreads.moveSelection(sessionId, 1)
      return
    }
    if (key.pageUp) { scrollRef.current?.scrollBy(-(rows - 4)); event.stopImmediatePropagation(); return }
    if (key.pageDown) { scrollRef.current?.scrollBy(rows - 4); event.stopImmediatePropagation(); return }
    // ink reports a plain Tab as key.tab with an empty input.
    // Enter/Tab 都回编辑层：列表态不是死胡同，一键继续问。
    if (key.tab || input === '\t' || key.return || /^[\r\n]+$/u.test(input)) { setComposerFocus(true); event.stopImmediatePropagation(); return }
    if (input === 'n' && !key.ctrl && !key.meta) {
      btwThreads.newTopic(sessionId)
      channel.notify(t('btw-thread-clear'), { timeoutMs: 2500 })
      event.stopImmediatePropagation()
      return
    }
    if (input === 's' && !key.ctrl && !key.meta) {
      const turn = btwThreads.selectedTurn(sessionId)
      if (turn !== undefined) sendToChat(turn)
      event.stopImmediatePropagation()
      return
    }
    if (input === 'c' && !key.ctrl && !key.meta) {
      copySelected()
      event.stopImmediatePropagation()
    }
  })

  return (
    <Box flexDirection="column" width={columns} height={rows} paddingX={1}>
      <Box flexDirection="row" width="100%" height={1} flexShrink={0}>
        <Text color="warning" bold>{t('btw-fullscreen-title')}</Text>
        <Text dimColor wrap="truncate">{'  ' + t('btw-scene-hints')}</Text>
      </Box>
      <BtwThreadView
        thread={thread}
        width={columns - 2}
        height={Math.max(3, rows - 4)}
        alive
        selectedTurnId={composerFocus ? undefined : selectedId ?? undefined}
        onSelectTurn={selectTurn}
        scrollHandleRef={scrollRef}
      />
      <BtwComposer
        state={{ text: thread?.draft ?? '', caret }}
        focused={composerFocus}
        busy={busy}
        notice={notice === null ? undefined : notice}
        onActivate={activateComposer}
      />
    </Box>
  )
}
