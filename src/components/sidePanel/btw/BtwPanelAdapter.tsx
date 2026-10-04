/**
 * btw 侧栏面板（设计 btw-panel.md）：线程滚动 + Markdown + 底部 composer
 * 连续追问。Esc 层级按面板系统契约：composer 编辑（Esc 收起草稿） >
 * 线程列表滚动（无独占 Esc）> 宿主回退（Esc 回聊天）；Tab 在列表与
 * composer 间切焦点；未消费键交宿主，不吞 ←/→ 的 panel cycling。
 *
 * badge 派生（镜像 jobs/agents 适配器）：面板不可见期间完成的新 answer
 * 增 info unread、失败 error level 计未读、运行中只亮点不计未读；进入
 * 面板（visible）即 markSeen 清 unread——仅开始生成不清旧未读。
 */
import React from 'react'
import { Box, Text } from '../../../ui.js'
import { t } from '../../../i18n.js'
import { panelStore } from '../PanelStore.js'
import { useSidePanelChannel } from '../SidePanelRuntimeContext.js'
import { usePanelInput } from '../usePanelInput.js'
import { truncateWidth } from '../../../trajectory/format.js'
import { stringWidth } from '../../../ink/stringWidth.js'
import { btwThreads } from './threads.js'
import { getBtwContextBudget, getBtwContextTurns, subscribeBtwContextTurns } from '../../../tuiDisplayPrefs.js'
import { BtwComposer, btwComposerKey, type BtwComposerState } from './BtwComposer.js'
import { BtwThreadView } from './BtwThreadView.js'
import type { PanelKeyHandler, PanelProps } from '../types.js'
import type { BtwTurn } from './threads.js'

function useBtwThread(sessionId: string) {
  return React.useSyncExternalStore(btwThreads.subscribe, () => btwThreads.get(sessionId))
}

/** 提交时一次性读取线程上下文设置（dsh-tui.btw.*，live store）。 */
function btwContextOptions(): { readonly recentTurnsLimit: number; readonly contextBudget: number } {
  return { recentTurnsLimit: getBtwContextTurns(), contextBudget: getBtwContextBudget() }
}

export function BtwPanelAdapter({ width, height, focused, visible }: PanelProps): React.ReactNode {
  const channel = useSidePanelChannel()
  const sessionId = String(channel.agentId)
  const thread = useBtwThread(sessionId)
  const version = thread?.version ?? 0
  const busy = thread !== undefined && thread.activeTurnId !== null
  const [composerFocus, setComposerFocus] = React.useState(true)
  const [caret, setCaret] = React.useState(0)
  const [notice, setNotice] = React.useState<{ readonly text: string; readonly failure: boolean } | null>(null)

  // badge（镜像 jobs：version/visible 驱动；可见即已读）。
  React.useEffect(() => {
    const running = thread?.turns.some(turn => turn.phase === 'running') ?? false
    if (visible) {
      btwThreads.markSeen(sessionId)
      panelStore.setBadge('btw', running ? { level: 'info', unread: 0 } : null)
      return
    }
    const unread = thread?.unread
    panelStore.setBadge(
      'btw',
      unread !== undefined && unread.count > 0
        ? { level: unread.error ? 'error' : 'info', unread: unread.count }
        : running ? { level: 'info', unread: 0 } : null,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- badge derives from the thread snapshot version
  }, [version, visible])

  const attachTurn = React.useCallback((turn: BtwTurn) => {
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

  const submitDraft = React.useCallback(() => {
    const text = btwThreads.get(sessionId)?.draft ?? ''
    if (text.trim() === '') return
    const result = btwThreads.submit(sessionId, text, (question, options) => channel.sideQuestion(question, options), btwContextOptions())
    if (!result.ok) {
      setNotice({
        text: t(result.reason === 'busy' || result.reason === 'congested' ? 'btw-thread-busy' : 'btw-thread-followup'),
        failure: true,
      })
      return
    }
    // 发送成功才清草稿（失败/忙保留原文，AgentMessageComposer 同款契约）。
    btwThreads.setDraft(sessionId, '')
    setCaret(0)
    setNotice(null)
  }, [channel, sessionId])

  const newTopic = React.useCallback(() => {
    btwThreads.newTopic(sessionId)
    setNotice(null)
    channel.notify(t('btw-thread-clear'), { timeoutMs: 2500 })
  }, [sessionId, channel])

  // ── 键盘（v2.1：composer 层 > 列表层 > 宿主回退；未消费交宿主）───────
  const onKey = React.useCallback<PanelKeyHandler>((input, key) => {
    if (composerFocus) {
      const text = btwThreads.get(sessionId)?.draft ?? ''
      const result = btwComposerKey({ text, caret }, input, key as Parameters<typeof btwComposerKey>[2])
      if (result === null) return false
      if (result.exitFocus === true) { setComposerFocus(false); return true }
      if (result.submit === true) { submitDraft(); return true }
      if (result.state !== undefined) {
        btwThreads.setDraft(sessionId, result.state.text)
        setCaret(result.state.caret)
        setNotice(null)
      }
      return true
    }
    const tabKey = (key as { readonly tab?: boolean }).tab === true || input === '\t'
    if (tabKey) { setComposerFocus(true); return true }
    if (input === 'n' && key.ctrl !== true && key.meta !== true) { newTopic(); return true }
    if (input === 's' && key.ctrl !== true && key.meta !== true) {
      const latest = [...(btwThreads.get(sessionId)?.turns ?? [])].reverse().find(turn => turn.phase === 'completed')
      if (latest !== undefined) attachTurn(latest)
      return true
    }
    // 列表层不独占 Esc/←/→：返回 false 交宿主（Esc 回聊天、←/→ 切面板）。
    return false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerFocus, caret, sessionId, submitDraft, newTopic, attachTurn])
  usePanelInput(onKey, { active: focused && visible })

  // ── 头部：/btw + 首问标题（单行裁切）+ 新话题 + 上下文覆盖提示 ────────
  const title = thread !== undefined && thread.turns.length > 0 ? thread.turns[0]!.question : ''
  const newLabel = t('btw-thread-new')
  // 覆盖提示跟随 dsh-tui.btw.contextTurns 的活值（/settings 改完即换词）。
  const contextTurns = React.useSyncExternalStore(subscribeBtwContextTurns, getBtwContextTurns)
  const contextLabel = t('btw-thread-context-recent', { n: contextTurns })
  const budget = Math.max(6, width - 2)
  const titleRoom = budget - stringWidth(newLabel) - stringWidth(contextLabel) - 5
  const header = (
    <Box flexDirection="row" width="100%" height={1} flexShrink={0}>
      <Text color="warning" bold>/btw </Text>
      <Text dimColor wrap="truncate">{truncateWidth(title, Math.max(2, titleRoom))}</Text>
      <Box flexGrow={1} flexShrink={1}><Text> </Text></Box>
      <Box
        flexShrink={0}
        onClick={event => { event.stopImmediatePropagation(); newTopic() }}
      >
        <Text color="permission">[n] {newLabel}</Text>
      </Box>
    </Box>
  )
  const contextNote = (
    <Box width="100%" height={1} flexShrink={0}>
      <Text dimColor italic wrap="truncate">{contextLabel}</Text>
    </Box>
  )

  return (
    <Box flexDirection="column" width="100%" height={height} overflow="hidden">
      {header}
      {contextNote}
      <BtwThreadView
        thread={thread}
        width={width}
        height={Math.max(3, height - 5)}
        alive={visible}
        onAttachTurn={attachTurn}
      />
      <BtwComposer
        state={{ text: thread?.draft ?? '', caret }}
        focused={composerFocus && focused && visible}
        busy={busy}
        notice={notice === undefined || notice === null ? undefined : notice}
      />
    </Box>
  )
}
