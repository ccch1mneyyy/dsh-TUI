import React from 'react'
import { Box, Text, useInput, ScrollBox, type ScrollBoxHandle, useTerminalSize } from '../ui.js'
import type { SubagentOutputLine, SubagentState } from '../dsh-adapter/subagents.js'
import { AgentMessageLeafRow, AssistantTextLeafRow, ThinkingLeafRow, ToolLeafRow } from './messages/TranscriptLeaves.js'
import { AgentMessageFlowRow } from './messages/AgentMessageFlow.js'
import { AgentMessageComposer, type ComposerKeyHandler } from './AgentMessageComposer.js'
import type { AgentComposeTarget, AgentMessageControl, AgentMessageView } from './messages/agentTeam.js'
import { subagentDetailMemory } from './subagentDetailMemory.js'
import {
  mergeLiveWindow,
  OUTPUT_WINDOW_CAP,
  TRANSCRIPT_OLDER_CHUNK,
  useSubagentTranscript,
  type TranscriptLoader,
} from './messages/subagentTranscript.js'
import { t } from '../i18n.js'
import { Divider } from './design-system/Divider.js'
import { ExitButton, isPanelPlainReturn } from './SubagentDashboard.js'
import { isPlainReturnInput } from '../utils/modifiers.js'
import { toolNameColor } from './messages/AssistantToolUseMessage.js'
import { Markdown } from './Markdown.js'
import { getCliHighlightPromise } from '../terminal-utils/cliHighlight.js'
import { isMinimalUiMode } from '../minimalUiMode.js'
import { usePanelInput } from './sidePanel/usePanelInput.js'
import type { SidePanelKeyFlags } from './sidePanel/types.js'
import type { Theme } from '../theme.js'
import { THINKING_SETTLED_MARKER } from '../terminal-utils/figures.js'

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const min = Math.floor(ms / 60000)
  const sec = Math.floor((ms % 60000) / 1000)
  return `${min}m${sec}s`
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}

function statusGlyph(status: SubagentState['status']): { glyph: string; color: keyof Theme | undefined; label: string } {
  const minimalUi = isMinimalUiMode()
  if (status === 'completed') return { glyph: minimalUi ? '✓' : '🟢', color: minimalUi ? undefined : 'success', label: 'done' }
  if (status === 'failed') return { glyph: minimalUi ? '×' : '🔴', color: minimalUi ? undefined : 'error', label: 'failed' }
  if (status === 'cancelled') return { glyph: minimalUi ? '×' : '🔴', color: minimalUi ? undefined : 'error', label: 'cancelled' }
  if (status === 'unknown') return { glyph: minimalUi ? '·' : '⚪', color: minimalUi ? undefined : 'subtle', label: 'history' }
  return { glyph: minimalUi ? '·' : '🟡', color: minimalUi ? undefined : 'warning', label: 'running' }
}

const PAGES_WITHOUT_TRANSCRIPT = ['summary', 'output', 'tools'] as const
const PAGES_WITH_TRANSCRIPT = ['summary', 'output', 'transcript', 'tools'] as const
type DetailPage = (typeof PAGES_WITH_TRANSCRIPT)[number] | 'messages'

/** One label/value row of the summary stats card. */
function StatRow({ label, children }: { label: string; children: React.ReactNode }): React.ReactNode {
  return (
    <Box flexDirection="row">
      <Box width={14} flexShrink={0}><Text dimColor>{label}</Text></Box>
      <Box flexDirection="row" flexGrow={1}>{children}</Box>
    </Box>
  )
}

/** Two-column key/value stats grid (Kimi Code settled summary style). */
function StatGrid({ subagent, totalTokens, elapsed, statusLabel, statusColor }: {
  subagent: SubagentState
  totalTokens: number
  elapsed: number | undefined
  statusLabel: string
  statusColor: keyof Theme | undefined
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      <StatRow label={t('subagent-status-label')}>
        <Text color={statusColor}>{statusLabel}</Text>
      </StatRow>
      <StatRow label={t('subagent-model')}>
        <Text>{subagent.model ?? subagent.provider ?? 'default'}</Text>
      </StatRow>
      <StatRow label={t('subagent-duration')}>
        <Text>{elapsed !== undefined ? formatDuration(elapsed) : '—'}</Text>
      </StatRow>
      <StatRow label="tokens">
        <Text>{totalTokens || '—'}{subagent.tokens?.input !== undefined ? ` (in ${subagent.tokens.input} · out ${subagent.tokens.output ?? 0})` : ''}</Text>
      </StatRow>
      <StatRow label={t('subagent-tools')}>
        <Text>{subagent.reportedToolUses ?? subagent.toolCalls.length}</Text>
      </StatRow>
      {subagent.lastTool !== undefined && (
        <StatRow label={t('subagent-last-tool')}>
          <Text>{subagent.lastTool}</Text>
        </StatRow>
      )}
      <StatRow label={t('subagent-started')}>
        <Text>{formatTimestamp(subagent.startedAt)}</Text>
      </StatRow>
      {subagent.completedAt !== undefined && (
        <StatRow label={t('subagent-completed')}>
          <Text>{formatTimestamp(subagent.completedAt)}</Text>
        </StatRow>
      )}
    </Box>
  )
}

/** Tool args line: JSON-looking args get cli-highlight syntax colors (loaded
 * lazily through the shared promise); anything else stays a dim flat line. */
function JsonArgsText({ raw }: { raw: string }): React.ReactNode {
  const flat = raw.replace(/\s+/g, ' ').trim()
  const json = flat.startsWith('{') || flat.startsWith('[')
  const [highlighted, setHighlighted] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!json) return
    let alive = true
    void getCliHighlightPromise().then(cli => {
      if (!alive || cli === null) return
      try {
        setHighlighted(cli.highlight(flat, { language: 'json' }))
      } catch {
        // Not parseable JSON after all — keep the dim fallback.
      }
    })
    return () => { alive = false }
  }, [flat, json])
  if (json && highlighted !== null) return <Text wrap="wrap">{highlighted}</Text>
  return <Text dimColor wrap="wrap">{flat}</Text>
}

/**
 * One rendered row of the output page: either a run of consecutive reasoning
 * rows (folded into the chat's thinking grammar, \`⚓ Thinking · 12s\`) or a
 * single event line. Folding by RUN keeps the transcript order intact while
 * stopping a long chain of thought from burying the answer.
 */
type DetailBlock =
  | { kind: 'thinking'; lines: SubagentOutputLine[] }
  | { kind: 'prose'; lines: SubagentOutputLine[] }
  | { kind: 'line'; line: SubagentOutputLine }

function groupOutputEvents(events: readonly SubagentOutputLine[]): DetailBlock[] {
  const blocks: DetailBlock[] = []
  for (const line of events) {
    if (line.kind === 'thinking') {
      const last = blocks[blocks.length - 1]
      if (last !== undefined && last.kind === 'thinking') last.lines.push(line)
      else blocks.push({ kind: 'thinking', lines: [line] })
      continue
    }
    // Consecutive prose lines are ONE markdown document: without the fold a
    // `**bold**` line, its list items and its paragraph break would render as
    // raw syntax separated by blank rows. Activity pointers and tool/error
    // rows stay independent single lines.
    if (line.kind === 'text' && !isActivityLine(line.text)) {
      const last = blocks[blocks.length - 1]
      if (last !== undefined && last.kind === 'prose') last.lines.push(line)
      else blocks.push({ kind: 'prose', lines: [line] })
      continue
    }
    blocks.push({ kind: 'line', line })
  }
  return blocks
}

/** The child's own status line reaches us as a text delta (\`⏵ reading …\`);
 *  it is activity, not prose, so it renders as a dim pointer row. */
const ACTIVITY_GLYPHS = ['⏵', '▶', '▸', '»']

function isActivityLine(text: string): boolean {
  return ACTIVITY_GLYPHS.includes(text.trimStart().slice(0, 1))
}


export interface SubagentDetailSceneProps {
  subagent: SubagentState
  onBack: () => void
  onInterrupt?: (agentId: string) => void
  /** The child's full transcript (`subagentControl.history`). Absent = no
   *  transcript source for this session: no Transcript page, and the
   *  output tail keeps its retained-range note. */
  loadTranscript?: TranscriptLoader
  /** 打开主屏只读 Agent View。 */
  onOpenView?: () => void
  /** 代理↔代理消息流：非空时出现 Messages 页。 */
  messages?: readonly AgentMessageView[]
  /** 发送能力：存在才渲染 composer；独立草稿，不经父 PromptInput。 */
  compose?: { readonly control: AgentMessageControl; readonly target: AgentComposeTarget }
  /** 'panel' 挂在侧栏宿主里（去外层 padding、键盘走 usePanelInput 分发器）；
   *  default（缺省）与整屏形态逐字节一致。 */
  variant?: 'default' | 'panel'
  /** panel 形态：宿主报告焦点/可见性；非 active 时保留状态但收不到键。 */
  focused?: boolean
  visible?: boolean
}

/**
 * SubagentDetailScene — full-screen paged detail view for one subagent.
 * Header block (identity + stats) stays fixed; the body pages through
 * 摘要 / 输出 / 工具 with ←/→. Follow-up delivery was removed: the official
 * seam only accepts continuable children, and one-shot spawn children are
 * disposed at settlement, so the affordance would be a dead control.
 */
export function SubagentDetailScene({
  subagent,
  onBack,
  onInterrupt,
  loadTranscript,
  onOpenView,
  messages = [],
  compose,
  variant = 'default',
  focused = true,
  visible = true,
}: SubagentDetailSceneProps): React.ReactNode {
  const panelMode = variant === 'panel'
  const scrollRef = React.useRef<ScrollBoxHandle | null>(null)
  const { rows, columns } = useTerminalSize()
  // 主屏 Agent View 盖过 Detail 时组件会卸载；从 Agent View 回来时按记忆
  // 恢复页码与滚动位置。
  const remembered = subagentDetailMemory.read(subagent.agentId)
  const [page, setPage] = React.useState<DetailPage>(remembered === undefined ? 'summary' : remembered.page as DetailPage)
  // Pages follow the capabilities: no transcript source, no Transcript page;
  // no agent messages, no Messages page.
  const pages: readonly DetailPage[] = [
    ...(loadTranscript === undefined ? PAGES_WITHOUT_TRANSCRIPT : PAGES_WITH_TRANSCRIPT),
    ...(messages.length > 0 ? (['messages'] as const) : []),
  ]
  const rememberedPageValid = pages.includes(page)
  const activePage: DetailPage = rememberedPageValid ? page : pages[0]!
  const setPageSafe = (next: DetailPage): void => { setPage(pages.includes(next) ? next : pages[0]!) }
  // 记忆只在主屏 Agent View 往返间生效：打开视图时置位，卸载时据位决定
  // 保存（page+scroll）还是清除（常规返回 Dashboard = 全新一次浏览）。
  const activePageRef = React.useRef(activePage)
  activePageRef.current = activePage
  const viewOpenedRef = React.useRef(false)
  const openMainView = (): void => {
    if (onOpenView === undefined) return
    viewOpenedRef.current = true
    onOpenView()
  }
  React.useEffect(() => {
    if (remembered !== undefined && remembered.scrollTop > 0) scrollRef.current?.scrollTo?.(remembered.scrollTop)
    return () => {
      if (viewOpenedRef.current) {
        const top = scrollRef.current?.getScrollTop?.() ?? 0
        subagentDetailMemory.save(subagent.agentId, { page: activePageRef.current, scrollTop: top })
      } else {
        subagentDetailMemory.clear(subagent.agentId)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- save-on-unmount only
  }, [])

  const isRunning = subagent.status === 'running' || subagent.status === 'starting'
  // Only a live run ticks; discovered history (`unknown`) shows no duration.
  const elapsed = isRunning
    ? Date.now() - subagent.startedAt
    : subagent.completedAt !== undefined ? subagent.completedAt - subagent.startedAt : undefined
  const info = statusGlyph(subagent.status)
  const totalTokens = subagent.tokens?.total ?? ((subagent.tokens?.input ?? 0) + (subagent.tokens?.output ?? 0) || 0)
  // The backend's own counts win over the locally kept records (a missed
  // lane frame must not undercount); no report → the local records.
  const toolsCount = subagent.reportedToolUses ?? subagent.toolCalls.length
  const shownDuration = subagent.reportedDurationMs ?? elapsed
  const pageIndex = pages.indexOf(activePage)

  /** Folded reasoning runs (the transcript's thinking grammar). Enter flips
   *  every run at once so one key stays predictable across thought steps. */
  const [thinkingOpen, setThinkingOpen] = React.useState(false)
  const blocks = groupOutputEvents(subagent.outputEvents)
  const hasThinking = blocks.some(block => block.kind === 'thinking')
  const settled = !isRunning
  // The deliverable is the LAST prose block: a `── Conclusion ──` rule goes in
  // front of it once the run settles, so the answer is never the last line of
  // a wall of reasoning.
  const answerBlock = ((): number => {
    if (!settled) return -1
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i]!
      if (block.kind === 'prose' && block.lines.some(p => p.text.trim() !== '')) return i
      if (block.kind === 'line' && block.line.kind === 'text' && block.line.text.trim() !== '') return i
    }
    return -1
  })()

  // ── the Agent-Transcript page (only with a transcript source) ─────────
  /** The transcript page's one expanded tool card (a click toggles; the
   *  output page's single-fold rhythm, applied to cards). */
  const [expandedLeaf, setExpandedLeaf] = React.useState<string | null>(null)
  // Settlement makes the disk copy final: the isRunning flip reloads the
  // page once, picking up what streamed in live.
  const transcriptActive = activePage === 'transcript'
  const { transcript, loadOlder: loadOlderTranscript } = useSubagentTranscript(loadTranscript, subagent.agentId, transcriptActive, isRunning, messages)
  React.useEffect(() => {
    if (transcriptActive) setExpandedLeaf(null)
  }, [transcriptActive, subagent.agentId, isRunning])

  const hasTranscriptThinking = transcript.status === 'ready' && transcript.leaves.some(leaf => leaf.kind === 'thinking' || leaf.kind === 'thinking-unavailable')

  const turnPage = (delta: number): void => {
    const next = (pageIndex + delta + pages.length) % pages.length
    setPageSafe(pages[next]!)
    scrollRef.current?.scrollTo?.(0)
  }

  // tail -f: while the subagent runs and the output page is showing, follow
  // the newest streamed line. Page switches or settlement stop the follow so
  // manual ↑ scrolling wins.
  // Expanding the reasoning grows the box past its viewport, and the renderer
  // then treats the growth as "was at bottom" (maxScroll was 0 while the folded
  // body fit) and re-pins the view to the bottom — pushing the fold header out
  // of sight. Re-anchor AFTER that frame: the first immediate lands behind the
  // renderer's own scheduling, and the second behind the re-pin frame it caused.
  React.useEffect(() => {
    if (page !== 'output' && activePage !== 'transcript') return
    const first = setImmediate(() => scrollRef.current?.scrollTo?.(0))
    return () => clearImmediate(first)
  }, [thinkingOpen, page])

  const outputLength = subagent.outputEvents.length
  React.useEffect(() => {
    if (!isRunning) return
    if (page === 'output') {
      scrollRef.current?.scrollToBottom()
      return
    }
    // The transcript page follows only while it is pinned to the bottom: a
    // reader who scrolled up into the history (or towards "load older")
    // must not be pulled back down by every streamed line.
    const handle = scrollRef.current
    if (activePage === 'transcript' && handle !== null && handle.isSticky()) handle.scrollToBottom()
  }, [page, isRunning, outputLength])

  // Detail 的主手势是翻页阅读，composer 默认不聚焦（'i' 聚焦、Esc 让焦）；
  // 聚焦期 ←/→/Esc/Enter 归编辑器，↑/↓ 仍滚动正文。
  const [composerFocused, setComposerFocused] = React.useState(false)
  const composerKeys = React.useRef<ComposerKeyHandler | null>(null)
  useInput((input, key, event) => {
    if (panelMode) return
    if (compose !== undefined && composerFocused) {
      if (key.upArrow || key.downArrow) {
        event.stopImmediatePropagation()
        scrollRef.current?.scrollBy(key.upArrow ? -3 : 3)
      }
      return
    }
    if (key.escape || (key.ctrl && input === 'c')) {
      event.stopImmediatePropagation()
      onBack()
      return
    }
    if (key.leftArrow) {
      event.stopImmediatePropagation()
      turnPage(-1)
      return
    }
    if (key.rightArrow) {
      event.stopImmediatePropagation()
      turnPage(1)
      return
    }
    if (key.upArrow) {
      event.stopImmediatePropagation()
      scrollRef.current?.scrollBy(-3)
      return
    }
    if (key.downArrow) {
      event.stopImmediatePropagation()
      scrollRef.current?.scrollBy(3)
      return
    }
    if (input.toLowerCase() === 'x' && isRunning && onInterrupt) {
      event.stopImmediatePropagation()
      onInterrupt(subagent.agentId)
      return
    }
    // v = 主屏查看。
    if (input.toLowerCase() === 'v' && onOpenView) {
      event.stopImmediatePropagation()
      openMainView()
      return
    }
    // i = 聚焦 composer（发送输入的入口；Esc 让焦回来）。
    if (input.toLowerCase() === 'i' && compose !== undefined) {
      event.stopImmediatePropagation()
      setComposerFocused(true)
      return
    }
    // o = 转录页载入更早一页（与页首按钮同一动作）。
    if (input.toLowerCase() === 'o' && activePage === 'transcript') {
      event.stopImmediatePropagation()
      loadOlderTranscript()
      return
    }
    if (isPlainReturnInput(input, key)) {
      event.stopImmediatePropagation()
      // Enter folds the reasoning while the output or transcript page is
      // showing (the transcript's ctrl+o equivalent). Elsewhere it keeps its
      // "leave the detail" meaning, which Esc and the ✕ button still provide.
      if ((activePage === 'output' && hasThinking) || (activePage === 'transcript' && hasTranscriptThinking)) setThinkingOpen(open => !open)
      else onBack()
      return
    }
    event.stopImmediatePropagation()
  }, { isActive: !panelMode })

  // Panel form（v2.1 键盘契约）：这一层自己吃掉整个业务键面。Esc/Ctrl+C 必须
  // 返回 true —— Detail → Dashboard 是面板内部的一级，绝不能落给宿主（宿主
  // 的 Esc 回退是「焦点回聊天」）。其余未认的键返回 false，让 [/]、数字、
  // z、+/- 继续可用。
  const panelKeyHandler = (input: string, key: SidePanelKeyFlags): boolean => {
    // composer 聚焦时键先给编辑器（含 Esc）；↑/↓ 仍滚动正文。
    if (compose !== undefined && composerFocused) {
      if (key.upArrow === true || key.downArrow === true) {
        scrollRef.current?.scrollBy(key.upArrow === true ? -3 : 3)
        return true
      }
      return composerKeys.current?.(input, key) ?? false
    }
    if (key.escape === true || (key.ctrl === true && input === 'c')) {
      onBack()
      return true
    }
    if (key.leftArrow === true) {
      turnPage(-1)
      return true
    }
    if (key.rightArrow === true) {
      turnPage(1)
      return true
    }
    if (key.upArrow === true) {
      scrollRef.current?.scrollBy(-3)
      return true
    }
    if (key.downArrow === true) {
      scrollRef.current?.scrollBy(3)
      return true
    }
    if (input.toLowerCase() === 'x' && isRunning && onInterrupt !== undefined) {
      onInterrupt(subagent.agentId)
      return true
    }
    if (input.toLowerCase() === 'v' && onOpenView !== undefined) {
      openMainView()
      return true
    }
    if (input.toLowerCase() === 'i' && compose !== undefined) {
      setComposerFocused(true)
      return true
    }
    if (input.toLowerCase() === 'o' && activePage === 'transcript') {
      loadOlderTranscript()
      return true
    }
    if (isPanelPlainReturn(input, key)) {
      // Enter 与整屏形态同义：输出/转录页有思考块时先折叠它，别处退回 Dashboard。
      if ((activePage === 'output' && hasThinking) || (activePage === 'transcript' && hasTranscriptThinking)) setThinkingOpen(open => !open)
      else onBack()
      return true
    }
    return false
  }
  usePanelInput(panelKeyHandler, { active: panelMode && focused && visible })

  const tab = (name: DetailPage, label: string): React.ReactNode => {
    const active = activePage === name
    return (
      <React.Fragment key={name}>
        <Box
          onClick={() => setPageSafe(name)}
          backgroundColor={!active ? 'userMessageBackgroundHover' : undefined}
        >
          <Text color={active ? 'accent' : undefined} bold={active} inverse={active}>
            {` ${label} `}
          </Text>
        </Box>
        <Text dimColor>{name === pages[pages.length - 1] ? '' : '│'}</Text>
      </React.Fragment>
    )
  }

  // 外层留白：整屏形态保持原样；侧栏形态只留左右各 1 格（PanelBar 与宿主
  // 提示行已经承担其余 chrome）。
  const outer = panelMode
    ? { paddingLeft: 1, paddingRight: 1, paddingTop: 0 }
    : { paddingX: 2, paddingY: 1 }

  return (
    <Box flexDirection="column" {...outer}>
      {/* Header: identity line, stats line, timing line */}
      <Box flexDirection="row" gap={1}>
        <Text color={info.color} bold>{info.glyph}</Text>
        <Text bold>{`${t('subagent-card-prefix')}${subagent.description}`}</Text>
        <Text dimColor>·</Text>
        <Text color={info.color}>{info.label}</Text>
        {subagent.mode === 'continuable' && <Text color="warning">{t('subagent-mode-continuable')}</Text>}
        {subagent.mode === 'one-shot' && <Text dimColor>{t('subagent-mode-one-shot')}</Text>}
        <Box flexGrow={1} />
        {/* 主屏查看（'v' 键的鼠标等价）。只放字形：窄面板里长标签会把
            Subagent: <名> 顶到下一行。 */}
        {onOpenView !== undefined && (
          <Box onClick={openMainView}>
            <Text color="subtle">⤢</Text>
          </Box>
        )}
        {/* 可点击退出（Esc/Enter 的鼠标等价），hover 提亮 */}
        <ExitButton onClick={onBack} />
      </Box>
      <Text>
        <Text>{subagent.model ?? subagent.provider ?? 'default'}</Text>
        <Text dimColor>{shownDuration !== undefined ? ` · ${formatDuration(shownDuration)} · ` : ' · '}{totalTokens || '—'} tok · {toolsCount} tools</Text>
      </Text>
      <Text dimColor>
        {`${t('subagent-started')} ${formatTimestamp(subagent.startedAt)}`
        + (subagent.completedAt ? ` · ${t('subagent-completed')} ${formatTimestamp(subagent.completedAt)}` : '')}
        {` · id ${subagent.agentId.slice(0, 8)}`}
      </Text>
      {subagent.error && (
        <Box marginTop={0}>
          <Text color="error" wrap="wrap">{`${t('subagent-error-label')}: ${subagent.error}`}</Text>
        </Box>
      )}

      {/* Tab bar with page indicator */}
      <Box flexDirection="row" gap={0} marginTop={1}>
        {tab('summary', t('subagent-tab-summary'))}
        {tab('output', subagent.outputEvents.length > 0 ? `${t('subagent-output-label')} ${subagent.outputEvents.length}` : t('subagent-output-label'))}
        {/* 没有转录来源就没有这个页签 */}
        {loadTranscript !== undefined && tab('transcript', t('subagent-tab-transcript'))}
        {tab('tools', toolsCount > 0 ? `${t('subagent-tools')} ${toolsCount}` : t('subagent-tools'))}
        {/* 消息流页：feed 非空才存在 */}
        {messages.length > 0 && tab('messages', `${t('agent-messages-tab')} ${messages.length}`)}
        <Text dimColor>{`  ${pageIndex + 1}/${pages.length}`}</Text>
      </Box>
      <Text dimColor>{'─'.repeat(Math.max(20, Math.min(72, columns - 6)))}</Text>

      {/* Paged body */}
      {/* 行数预算：整屏形态沿用原公式；侧栏形态的 rows 已是宿主高度，单独
          收一档，保证底部提示行仍在可视区内。 */}
      {/* 没有转录来源时只有这段有界 tail：标出保留范围。放在分隔线上方，
          免得被 160 行 tail 压到滚动区顶部看不见。 */}
      {activePage === 'output' && loadTranscript === undefined && subagent.outputEvents.length >= OUTPUT_WINDOW_CAP && (
        <Text dimColor>{t('subagent-transcript-retained', { count: subagent.outputEvents.length })}</Text>
      )}
      <Box flexDirection="column" paddingX={1} maxHeight={panelMode ? Math.max(6, rows - 10) : Math.max(10, rows - 14)}>
        <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1}>
          {activePage === 'summary' && (
            <Box flexDirection="column">
              {/* Stats card: two-column key/value grid (Kimi Code settled
               * summary style) above the final answer. */}
              <StatGrid subagent={subagent} totalTokens={totalTokens} elapsed={elapsed} statusLabel={info.label} statusColor={info.color} />
              {subagent.summary && (
                <Box flexDirection="column" marginTop={1}>
                  <Text dimColor bold>{'─ summary '}</Text>
                  <Text wrap="wrap">{subagent.summary}</Text>
                </Box>
              )}
              {!subagent.summary && (
                <Text dimColor>{isRunning ? t('subagent-no-output') : t('subagent-no-summary')}</Text>
              )}
            </Box>
          )}
          {activePage === 'output' && (
            subagent.outputEvents.length === 0 && subagent.output.length === 0 ? (
              <Text dimColor>{t('subagent-no-output')}</Text>
            ) : (
              <>
              {blocks.map((block, index) => {
                if (block.kind === 'thinking') {
                  const text = block.lines.map(line => line.text).join('\n')
                  const chars = text.replace(/\s+/g, '').length
                  const label = `${THINKING_SETTLED_MARKER} ${t('subagent-thinking-fold', { count: block.lines.length, chars })}`
                  const hint = thinkingOpen ? t('subagent-thinking-collapse') : t('subagent-thinking-expand')
                  return (
                    <Box key={`think-${index}`} flexDirection="column">
                      <Text italic dimColor>{`${label}  ·  ${hint}`}</Text>
                      {thinkingOpen ? (
                        <Box flexDirection="column" paddingLeft={2}>
                          {block.lines.map((line, i) => (
                            <Text key={i} dimColor italic wrap="wrap">{line.text}</Text>
                          ))}
                        </Box>
                      ) : (
                        <Text dimColor italic wrap="truncate-end">{`  ${block.lines[0]?.text.replace(/\s+/g, ' ').trim() ?? ''}`}</Text>
                      )}
                    </Box>
                  )
                }
                if (block.kind === 'prose') {
                  const proseText = block.lines.map(p => p.text).join('\n')
                  const proseUnsettled = isRunning && block.lines.some(p => p.settled === false)
                  const isProseAnswer = index === answerBlock
                  return (
                    <Box key={`prose-${index}`} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
                      {isProseAnswer && (
                        <Text dimColor>{`── ${t('subagent-conclusion')} ${'─'.repeat(Math.max(8, Math.min(60, columns - 16)))}`}</Text>
                      )}
                      <Markdown dimColor={false} cacheTokens>{proseText}</Markdown>
                      {proseUnsettled && <Text dimColor>{'▌'}</Text>}
                    </Box>
                  )
                }
                const line = block.line
                const unsettled = !line.settled && isRunning ? ' ▍' : ''
                if (line.kind === 'text' && isActivityLine(line.text)) {
                  return (
                    <Box key={`act-${index}`} flexDirection="row" gap={1}>
                      <Text color="accent">{'⏵'}</Text>
                      <Text dimColor wrap="truncate-end">{line.text.replace(/^[\s⏵▶▸»]+/, '')}{unsettled}</Text>
                    </Box>
                  )
                }
                const isAnswer = index === answerBlock
                // Tool / error / system rows get a leading row gap so a wall
                // of streamed rows stops reading as one cramped paragraph.
                const rowGap = line.kind === 'tool' || line.kind === 'error' || line.kind === 'system'
                return (
                  <Box key={`line-${index}`} flexDirection="column" marginTop={rowGap && index !== 0 ? 1 : 0}>
                    {isAnswer && (
                      <Text dimColor>{`── ${t('subagent-conclusion')} ${'─'.repeat(Math.max(8, Math.min(60, columns - 16)))}`}</Text>
                    )}
                    <Text
                      wrap="wrap"
                      bold={isAnswer}
                      dimColor={line.kind === 'system'}
                      color={line.kind === 'error' ? 'error' : line.kind === 'tool' ? 'accent' : undefined}
                    >
                      {line.kind === 'tool' ? `● ${line.text}` : line.text}{unsettled}
                    </Text>
                  </Box>
                )
              })}
              </>
            )
          )}
          {activePage === 'transcript' && loadTranscript !== undefined && (
            <Box flexDirection="column">
              {/* parent_agent_id 非空 = 父代理；为 null 且嵌套 = 旧格式
                  metadata，只按深度说明，不猜父代理。 */}
              <Text dimColor>{`${t('subagent-transcript-history')} · ${t('subagent-transcript-readonly')}`}</Text>
              {transcript.status === 'ready' && transcript.parentAgentId !== null && (
                <Text dimColor>{t('subagent-transcript-parent', { id: transcript.parentAgentId.slice(0, 8) })}</Text>
              )}
              {transcript.status === 'ready' && transcript.parentAgentId === null && (subagent.depth ?? 1) >= 2 && (
                <Text dimColor>{t('subagent-transcript-old-format', { depth: subagent.depth ?? 2 })}</Text>
              )}
              {transcript.status === 'loading' && <Text dimColor>{`⏳ ${t('subagent-transcript-loading')}`}</Text>}
              {transcript.status === 'unavailable' && <Text color="error">{t('subagent-transcript-unavailable')}</Text>}
              {transcript.status === 'ready' && (() => {
                const merged = mergeLiveWindow(transcript.leaves, subagent, true)
                const liveStart = merged.findIndex(row => row.kind === 'live')
                if (merged.length === 0) return <Text dimColor>{t('subagent-transcript-empty')}</Text>
                return (
                  <>
                    {transcript.hasOlder && (
                      <Box onClick={loadOlderTranscript} marginTop={1}>
                        <Text color="accent">{transcript.loadingOlder
                          ? `⏳ ${t('subagent-transcript-loading')}`
                          : `▸ ${t('subagent-transcript-load-older', { count: transcript.sourceCursor === undefined ? Math.min(TRANSCRIPT_OLDER_CHUNK, transcript.skippedFromStart) : TRANSCRIPT_OLDER_CHUNK })}`}</Text>
                      </Box>
                    )}
                    {merged.map((row, index) => {
                      const margin = index > 0
                      if (row.kind === 'live') {
                        const line = row.line
                        const unsettled = !line.settled && isRunning ? ' ▍' : ''
                        return (
                          <React.Fragment key={`live-${index}`}>
                            {index === liveStart && <Text dimColor>{`── ${t('subagent-transcript-live')} ──`}</Text>}
                            {line.kind === 'text' && isActivityLine(line.text)
                              ? (
                                <Box flexDirection="row" gap={1}>
                                  <Text color="accent">{'⏵'}</Text>
                                  <Text dimColor wrap="truncate-end">{line.text.replace(/^[\s⏵▶▸»]+/, '')}{unsettled}</Text>
                                </Box>
                              )
                              : (
                                <Text
                                  wrap="wrap"
                                  dimColor={line.kind === 'thinking' || line.kind === 'system'}
                                  italic={line.kind === 'thinking'}
                                  color={line.kind === 'error' ? 'error' : undefined}
                                >
                                  {line.text}{unsettled}
                                </Text>
                              )}
                          </React.Fragment>
                        )
                      }
                      if (row.kind === 'thinking') {
                        return <ThinkingLeafRow key={`think-${row.key}`} thinking={row.text} marginTopOnTurn={margin} verbose={thinkingOpen} />
                      }
                      if (row.kind === 'thinking-unavailable') {
                        return (
                          <Box key={`ua-${row.key}`} marginTop={margin ? 1 : 0}>
                            <Text dimColor italic>{row.tokens !== undefined ? t('subagent-thinking-count-only', { tokens: row.tokens }) : t('subagent-thinking-unavailable')}</Text>
                          </Box>
                        )
                      }
                      if (row.kind === 'text') {
                        return <AssistantTextLeafRow key={`text-${row.key}`} text={row.text} marginTopOnTurn={margin} />
                      }
                      if (row.kind === 'agent-message') {
                        return <AgentMessageLeafRow key={`am-${row.key}`} message={row.message} selfAgentId={subagent.agentId} marginTopOnTurn={margin} />
                      }
                      return (
                        <ToolLeafRow
                          key={`tool-${row.key}`}
                          tool={row.tool}
                          marginTopOnTurn={margin}
                          verbose={expandedLeaf === row.key}
                          isExpanded={expandedLeaf === row.key}
                          onClick={() => setExpandedLeaf(prev => prev === row.key ? null : row.key)}
                        />
                      )
                    })}
                  </>
                )
              })()}
            </Box>
          )}
          {activePage === 'tools' && (
            subagent.toolCalls.length === 0 && subagent.reportedToolUses === undefined ? (
              <Text dimColor>{t('subagent-no-tools')}</Text>
            ) : (
              <Box flexDirection="column">
              {/* The backend reported N tool uses but only these records were
                  kept (missed lane frames, window tail): say so rather than
                  invent the missing ones. */}
              {subagent.reportedToolUses !== undefined && subagent.reportedToolUses !== subagent.toolCalls.length && (
                <Text dimColor>{t('subagent-tools-kept', { kept: subagent.toolCalls.length, reported: subagent.reportedToolUses })}</Text>
              )}
              {subagent.toolCalls.map((tool, index) => (
                <Box key={tool.id ?? index} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
                  <Box flexDirection="row" gap={1}>
                    <Text color={tool.status === 'failed' ? 'error' : tool.status === 'running' ? 'warning' : 'success'}>
                      {tool.status === 'running' ? '·' : tool.status === 'failed' ? '×' : '✓'}
                    </Text>
                    <Text color={toolNameColor(tool.name)}>{tool.name}</Text>
                    {tool.endedAt && <Text dimColor>{formatDuration(tool.endedAt - tool.startedAt)}</Text>}
                  </Box>
                  {tool.argsPreview && (
                    <Box flexDirection="row" paddingLeft={2}>
                      <JsonArgsText raw={tool.argsPreview} />
                    </Box>
                  )}
                  {tool.resultPreview && (
                    <Box flexDirection="row" paddingLeft={2}>
                      <Text dimColor wrap="wrap">{`⎿ ${tool.resultPreview}`}</Text>
                    </Box>
                  )}
                  {tool.error && (
                    <Box flexDirection="row" paddingLeft={2}>
                      <Text color="error" wrap="wrap">{tool.error}</Text>
                    </Box>
                  )}
                </Box>
              ))}
              </Box>
            )
          )}
          {activePage === 'messages' && messages.length > 0 && (
            <Box flexDirection="column">
              {/* sender/target/正文/transport/state/sourceRef，最新在下；
                  状态只显示通道给的事实。 */}
              {messages.map((message, index) => (
                <Box key={message.messageId} marginTop={index === 0 ? 0 : 1}>
                  <AgentMessageFlowRow message={message} selfAgentId={subagent.agentId} />
                </Box>
              ))}
            </Box>
          )}
        </ScrollBox>
      </Box>

      {/* 有发送能力才渲染；Detail 自己的草稿，不碰父输入框。 */}
      {compose !== undefined && (
        <Box flexDirection="column" marginTop={1}>
          <AgentMessageComposer
            target={compose.target}
            control={compose.control}
            messages={messages}
            focused={composerFocused && (!panelMode || (focused && visible))}
            onFocusChange={setComposerFocused}
            {...(panelMode ? { keyHandlerRef: composerKeys } : {})}
          />
        </Box>
      )}

      <Divider color="subtle" title="" />
      {/* Footer hint */}
      <Box marginTop={0} flexDirection="row">
        <Text dimColor>
          {`←/→ ${t('subagent-hint-page')} · ↑/↓ ${t('subagent-hint-scroll')}`
            + ((activePage === 'output' && hasThinking) || (activePage === 'transcript' && hasTranscriptThinking) ? ` · ${t('subagent-hint-fold')}` : '')
            + (activePage === 'transcript' && transcript.status === 'ready' && transcript.hasOlder
              ? ` · o ${t('subagent-transcript-load-older', { count: transcript.sourceCursor === undefined ? Math.min(TRANSCRIPT_OLDER_CHUNK, transcript.skippedFromStart) : TRANSCRIPT_OLDER_CHUNK })}`
              : '')}
        </Text>
        {isRunning && onInterrupt && (
          <>
            <Text dimColor>{' · '}</Text>
            <Box onClick={() => onInterrupt(subagent.agentId)}>
              <Text dimColor bold color="warning">X interrupt</Text>
            </Box>
          </>
        )}
        {compose !== undefined && <Text dimColor>{` · i ${t('subagent-hint-compose')}`}</Text>}
        <Text dimColor>{` · Esc ${t('subagent-hint-back')}`}</Text>
      </Box>
    </Box>
  )
}
