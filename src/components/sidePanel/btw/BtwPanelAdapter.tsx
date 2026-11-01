/**
 * btw 侧栏面板：线程滚动 + Markdown + 底部 composer 连续追问。Esc 先退出
 * composer 编辑（草稿保留），列表层不消费 Esc，再交宿主回聊天；Tab 在列表
 * 与 composer 间切焦点；未消费的键交宿主（←/→ 切面板——编辑层里光标贴到
 * 行首/行尾后也让位）。
 *
 * badge 派生（镜像 jobs/agents 适配器）：面板不可见期间完成的新 answer
 * 增 info unread、失败 error level 计未读、运行中只亮点不计未读；进入
 * 面板（visible）即 markSeen 清 unread——仅开始生成不清旧未读。
 */
import React from 'react'
import { Box, Text, type ScrollBoxHandle } from '../../../ui.js'
import { t } from '../../../i18n.js'
import { panelStore } from '../PanelStore.js'
import { useSidePanelChannel, useSidePanelFocusChat } from '../SidePanelRuntimeContext.js'
import { usePanelInput } from '../usePanelInput.js'
import { truncateWidth } from '../../../trajectory/format.js'
import { stringWidth } from '../../../ink/stringWidth.js'
import { setClipboard } from '../../../ink/termio/osc.js'
import { btwThreads } from './threads.js'
import { getBtwContextBudget, getBtwContextTurns } from '../../../tuiDisplayPrefs.js'
import { BtwComposer, btwComposerKey, type BtwComposerState } from './BtwComposer.js'
import { useBtwComposerPaste } from './useBtwComposerPaste.js'
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
  // 送聊天后把列焦点交回主输入框（宿主没接时 undefined = 焦点不动）。
  const focusChat = useSidePanelFocusChat()
  const sessionId = String(channel.agentId)
  const thread = useBtwThread(sessionId)
  const version = thread?.version ?? 0
  const busy = thread !== undefined && thread.activeTurnId !== null
  // 默认阅读层：箭头归导航（←/→ 切面板、↑/↓ 滚动）；Enter/Tab/点击输入框
  // 才进编辑层，箭头变光标——光标贴到行首/行尾后再按同一个键同样落回宿主
  // 切面板（BtwComposer 的到头让位），所以底栏「←/→ 切换」在两层都成立；
  // 聚焦状态另有边框高亮与框内提示兜底。
  const [composerFocus, setComposerFocusState] = React.useState(false)
  // 聚焦位也骑 ref：Enter 聚焦后紧接着的按键（两键之间没有重渲染）必须
  // 已经看见编辑层——与 caret 同一款契约，否则第一个字符会被列表层吃掉。
  const composerFocusRef = React.useRef(false)
  const setComposerFocus = React.useCallback((next: boolean) => {
    composerFocusRef.current = next
    setComposerFocusState(next)
  }, [])
  const activateComposer = React.useCallback(() => setComposerFocus(true), [setComposerFocus])
  // The caret rides a ref too: two keys arriving before a re-render must
  // see each other's caret (the draft itself is read from the store).
  const caretRef = React.useRef(0)
  const [caret, setCaretState] = React.useState(0)
  const setCaret = React.useCallback((next: number) => {
    caretRef.current = next
    setCaretState(next)
  }, [])
  const [notice, setNotice] = React.useState<{ readonly text: string; readonly failure: boolean } | null>(null)
  // Ctrl+V / Alt+V：读剪贴板是异步的，落点用实时草稿与 caret（见 hook）。
  const paste = useBtwComposerPaste({ sessionId, caretRef, setCaret, setNotice })
  // 列表态的滚动句柄（阅读态：↑/↓/PgUp/PgDn 归线程，编辑态仍归输入框）。
  const scrollRef = React.useRef<ScrollBoxHandle | null>(null)

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

  /** 该轮是否已经挂在主输入框上（sourceId = turnId；部分夹具没有这个面）。 */
  const attachedEntryOf = React.useCallback((turnId: string) => {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: partial fixture channels
    return (channel.attachedContexts ?? []).find(entry => entry.sourceId === turnId)
  }, [channel])

  /**
   * `s` = 送聊天，再按一次 = 撤回（选中行 → 动作）。送出去之后把列焦点交回主
   * 输入框：chip 就在眼前、可直接接着打字，toast 里那句「Esc 可撤」也才成立
   * （剥 chip 的 Esc 只有主输入框有焦点才收得到）。
   */
  const sendToChat = React.useCallback((turn: BtwTurn) => {
    const staged = attachedEntryOf(turn.turnId)
    if (staged !== undefined) {
      if (typeof channel.detachContext === 'function') channel.detachContext(staged.id)
      channel.notify(t('panel-context-detached'), { color: 'success' })
      return
    }
    if (attachTurn(turn)) focusChat?.()
  }, [attachTurn, attachedEntryOf, channel, focusChat])

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
  }, [channel, sessionId, setCaret])

  const newTopic = React.useCallback(() => {
    btwThreads.newTopic(sessionId)
    setNotice(null)
    channel.notify(t('btw-thread-clear'), { timeoutMs: 2500 })
  }, [sessionId, channel])

  const copyLatest = React.useCallback(() => {
    const latest = [...(btwThreads.get(sessionId)?.turns ?? [])].reverse().find(turn => turn.phase === 'completed')
    if (latest === undefined) return
    void setClipboard(latest.answer)
    channel.notify(t('copied-chars', { n: latest.answer.length }), { timeoutMs: 1500 })
  }, [sessionId, channel])

  // ── 选中轮：列表形态（composer 不聚焦）的键盘归它 ─────────────────────
  // 选中态存在线程 store 里（与 draft 同理：面板与全屏场景共用），快照给的
  // selectedTurnId 已经解析过「跟最后一条」——null 只在空线程上出现。
  const turns = thread?.turns ?? []
  const selectedId = thread?.selectedTurnId ?? null
  const selectedTurn = turns.find(turn => turn.turnId === selectedId)
  /** ↑/↓ 移动选中（夹在两端；到底再按 ↓ 由调用方回输入框）。 */
  const moveSelection = React.useCallback((delta: number) => {
    btwThreads.moveSelection(sessionId, delta)
  }, [sessionId])
  /** 点标题行：选中那一轮并离开编辑层（高亮只在列表态显示，见 listActive）。 */
  const selectTurn = React.useCallback((turnId: string) => {
    btwThreads.select(sessionId, turnId)
    setComposerFocus(false)
  }, [sessionId, setComposerFocus])
  /** 选中轮本身（读实时线程，不依赖渲染期快照）。 */
  const selectedTurnNow = React.useCallback((): BtwTurn | undefined => {
    return btwThreads.selectedTurn(sessionId)
  }, [sessionId])
  /** `c` = 复制选中轮的答案（选中轮还没答案时退回「最后一条已完成」）。 */
  const copySelected = React.useCallback(() => {
    const turn = selectedTurnNow()
    if (turn !== undefined && turn.answer !== '') {
      void setClipboard(turn.answer)
      channel.notify(t('copied-chars', { n: turn.answer.length }), { timeoutMs: 1500 })
      return
    }
    copyLatest()
  }, [selectedTurnNow, copyLatest, channel])

  // ── 键盘：composer 层 > 列表层 > 宿主（未消费的键返回 false）──────────
  const onKey = React.useCallback<PanelKeyHandler>((input, key) => {
    if (composerFocusRef.current) {
      const text = btwThreads.get(sessionId)?.draft ?? ''
      const result = btwComposerKey({ text, caret: caretRef.current }, input, key as Parameters<typeof btwComposerKey>[2])
      if (result === null) return false
      if (result.exitFocus === true) { setComposerFocus(false); return true }
      if (result.submit === true) { submitDraft(); return true }
      if (result.paste === true) { paste(); return true }
      if (result.state !== undefined) {
        btwThreads.setDraft(sessionId, result.state.text)
        setCaret(result.state.caret)
        setNotice(null)
      }
      return true
    }
    const tabKey = (key as { readonly tab?: boolean }).tab === true || input === '\t'
    const enterKey = key.return_ === true || (key as { readonly return?: boolean }).return === true || /^[\r\n]+$/u.test(input)
    // Enter/Tab 都回编辑层：列表态不是死胡同，一键继续问（Enter 不进
    // composer 的提交分支——那是聚焦后的下一次按键的事）。
    if (tabKey || enterKey) { setComposerFocus(true); return true }
    if (input === 'n' && key.ctrl !== true && key.meta !== true) { newTopic(); return true }
    // 选中轮 + s/c：与 jobs 面板同一套「选中行 → 动作」契约（s 再按一次撤回）。
    if (input === 's' && key.ctrl !== true && key.meta !== true) {
      const turn = selectedTurnNow()
      if (turn !== undefined) sendToChat(turn)
      return true
    }
    if (input === 'c' && key.ctrl !== true && key.meta !== true) { copySelected(); return true }
    // 列表键盘：↑/↓ 只挪选中——滚动交给 BtwThreadView 的「最小揭示」：目标标题
    // 已经在视口里就一动不动，出了视口才滚到恰好露出那一行。已经在最后一条时
    // 再按 ↓ = 回输入框（与输入框里按 ↑ 上到标题互为往返）。
    if (key.upArrow === true) { moveSelection(-1); return true }
    if (key.downArrow === true) {
      const list = btwThreads.get(sessionId)?.turns ?? []
      const current = btwThreads.selectedTurn(sessionId)
      const at = current === undefined ? list.length - 1 : list.findIndex(turn => turn.turnId === current.turnId)
      if (list.length === 0 || at === list.length - 1) { setComposerFocus(true); return true }
      moveSelection(1)
      return true
    }
    // 翻页仍归滚动（列表里 ↑/↓ 已经改成移动选中了）。
    if (key.pageUp === true) { scrollRef.current?.scrollBy(-(height - 6)); return true }
    if (key.pageDown === true) { scrollRef.current?.scrollBy(height - 6); return true }
    // 其余不独占：返回 false 交宿主（Esc 回聊天、←/→ 切面板、1-9 跳面板）。
    return false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, submitDraft, newTopic, sendToChat, copySelected, moveSelection, selectedTurnNow, height, setCaret, paste])
  usePanelInput(onKey, { active: focused && visible })

  // ── 头部（只有线程后才画）：首问标题 + 状态徽 + 新话题，下压一条细线 ──
  // 空线程不画头部：标题没有内容，`新话题` 在空线程上也无事可做（清空/换题的
  // 语义只对已有线程成立）——面板标签栏已经给了这块版面的标题。
  const newLabel = t('btw-thread-new')
  const turnCount = thread?.turns.length ?? 0
  const title = turnCount > 0 ? thread!.turns[0]!.question : ''
  const chip = busy ? '● ' + t('btw-answering') : turnCount > 0 ? `Q${turnCount}` : ''
  const budget = Math.max(6, width - 2)
  const titleRoom = budget - stringWidth(newLabel) - stringWidth(chip) - 4
  const header = turnCount === 0 ? null : (
    <Box flexDirection="column" width="100%" flexShrink={0}>
      <Box flexDirection="row" width="100%" height={1} paddingLeft={1}>
        <Text bold wrap="truncate">{truncateWidth(title, Math.max(2, titleRoom))}</Text>
        <Box flexGrow={1} flexShrink={1}><Text> </Text></Box>
        {chip !== '' && (
          <Box flexShrink={0}>
            <Text color={busy ? 'warning' : undefined} dimColor={!busy}>{chip} </Text>
          </Box>
        )}
        <Box
          flexShrink={0}
          onClick={event => { event.stopImmediatePropagation(); newTopic() }}
        >
          <Text color="permission">[n] {newLabel}</Text>
        </Box>
      </Box>
      <Box width="100%" height={1}>
        <Text dimColor>{'─'.repeat(Math.max(4, width - 2))}</Text>
      </Box>
    </Box>
  )

  // 选中高亮 + 光标声明只在列表态出现：光标在主输入框（列没聚焦）或侧栏输入框
  // （composer 编辑层）时都不显示——用户要的是「列表拿着键盘」这个状态的指示，
  // 不是常驻标记。
  const listActive = focused && visible && !composerFocus
  // 底栏广告按层走（层内状态只有面板自己知道，所以由面板发、宿主只拼）：
  // - 列表层：有轮才说 s/c（已附加的那一轮同一个键是撤回）；
  // - 编辑层：s/c 在输入框里只是打字，只说「↑ 回标题」；
  // - 空线程没有可选的轮，明确广告空串（连能力位那一段也不画，免得广告一个按
  //   下去没反应的 s）；
  // - 光标在主输入框时面板根本收不到键，整段不画。
  const selectedAttached = selectedTurn !== undefined && attachedEntryOf(selectedTurn.turnId) !== undefined
  const hintText = !focused || !visible
    ? ''
    : composerFocus
      ? t('btw-hint-edit-back')
      : turns.length === 0
        ? ''
        : t(selectedAttached ? 'btw-list-hint-attached' : 'btw-list-hint')
  React.useEffect(() => {
    panelStore.setHint('btw', hintText)
    return () => { panelStore.setHint('btw', '') }
  }, [hintText])
  return (
    <Box flexDirection="column" width="100%" height={height} overflow="hidden">
      {header}
      <BtwThreadView
        thread={thread}
        width={width}
        height={Math.max(3, height - (header === null ? 4 : 6))}
        alive={visible}
        selectedTurnId={listActive ? selectedId ?? undefined : undefined}
        onSelectTurn={selectTurn}
        scrollHandleRef={scrollRef}
      />
      <BtwComposer
        state={{ text: thread?.draft ?? '', caret }}
        focused={composerFocus && focused && visible}
        busy={busy}
        notice={notice === undefined || notice === null ? undefined : notice}
        onActivate={activateComposer}
      />
    </Box>
  )
}
