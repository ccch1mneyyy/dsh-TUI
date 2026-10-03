import React from 'react'
import { Box, Text, useInput, ScrollBox, type ScrollBoxHandle, useTerminalSize } from '../ui.js'
import type { SubagentOutputLine, SubagentState } from '../dsh-adapter/subagents.js'
import type { SubagentTranscriptView, ToolRow } from '../adapter/ports/channel-view.js'
import type { SubagentTranscriptWindow } from '../agent/capabilities.js'
import type { AgentEvent } from '../agent/events.js'
import { ARGS_PREVIEW_LIMIT, preview, RESULT_PREVIEW_LIMIT } from '../channel/transcript.js'
import { AssistantTextLeafRow, ThinkingLeafRow, ToolLeafRow } from './messages/TranscriptLeaves.js'
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
type DetailPage = (typeof PAGES_WITH_TRANSCRIPT)[number]

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

// ── the Agent-Transcript page (design agent-team-panels §2) ──────────────

/** One folded leaf of the child's transcript: thinking (a real body, or
 *  the honest "body unavailable" marker a signature/count-only block
 *  degrades to), text and tool cards — the vocabulary the shared leaf
 *  renderers paint, so a child row reads exactly like a main one. */
type TranscriptLeaf =
  | { kind: 'thinking'; key: string; text: string }
  | { kind: 'thinking-unavailable'; key: string; tokens: number | undefined }
  | { kind: 'text'; key: string; text: string }
  | { kind: 'tool'; key: string; tool: ToolRow }

/** Presentations that never earn a duplicate card here either (the main
 *  projector's rule): a nested delegation renders as the subagent card, a
 *  todo write lives in the todo panel, a question in its dialog. */
const TRANSCRIPT_SUPPRESSED_CARDS: ReadonlySet<string> = new Set(['subagent', 'todo', 'question'])

/** Fold one history page's lane events into leaf rows (oldest first;
 *  `into` may already hold the older pages' rows). A tool result without
 *  its call is dropped — nothing to attach it to; consecutive blocks of
 *  one API message join (the store splits a message into per-block
 *  entries sharing the anchor). */
function foldTranscriptLeaves(events: readonly AgentEvent[], into: TranscriptLeaf[]): void {
  for (const event of events) {
    if (event.type === 'tool.call') {
      if (event.presentation !== undefined && TRANSCRIPT_SUPPRESSED_CARDS.has(event.presentation.card)) continue
      into.push({ kind: 'tool', key: event.callId, tool: {
        callId: event.callId,
        name: event.name,
        argsText: preview(event.argsJson, ARGS_PREVIEW_LIMIT),
        argsFull: event.argsJson,
        status: 'running',
        callView: event.presentation as ToolRow['callView'],
        startedAt: event.time,
      } })
      continue
    }
    if (event.type === 'tool.result') {
      let row: Extract<TranscriptLeaf, { kind: 'tool' }> | undefined
      for (let i = into.length - 1; i >= 0; i -= 1) {
        const leaf = into[i]!
        if (leaf.kind === 'tool' && leaf.tool.callId === event.callId) { row = leaf; break }
      }
      if (row === undefined) continue
      const tool = row.tool
      tool.durationMs = Math.max(0, event.time - tool.startedAt)
      if (event.isError) {
        tool.status = 'error'
        tool.errorText = event.errorText ?? ''
      } else {
        tool.status = 'ok'
        tool.resultText = event.text !== '' ? preview(event.text, RESULT_PREVIEW_LIMIT) : undefined
        tool.resultFull = event.text !== '' ? event.text : undefined
        tool.resultView = event.presentation as ToolRow['resultView']
      }
      continue
    }
    if (event.type === 'assistant.message') {
      for (const block of event.blocks) {
        if (block.type === 'reasoning') {
          const last = into.at(-1)
          if (last !== undefined && last.kind === 'thinking' && last.key === event.anchor) last.text = last.text === '' ? block.text ?? '' : `${last.text}\n${block.text ?? ''}`
          else into.push({ kind: 'thinking', key: event.anchor, text: block.text ?? '' })
          continue
        }
        if (block.type === 'reasoning-tokens' || block.type === 'reasoning-signature') {
          into.push({ kind: 'thinking-unavailable', key: `${event.anchor}:ua`, tokens: block.type === 'reasoning-tokens' && Number.isFinite(Number(block.text)) ? Number(block.text) : undefined })
          continue
        }
        if (block.type === 'text') {
          const last = into.at(-1)
          if (last !== undefined && last.kind === 'text' && last.key === event.anchor) last.text = `${last.text}\n${block.text ?? ''}`
          else into.push({ kind: 'text', key: event.anchor, text: block.text ?? '' })
        }
      }
    }
  }
}

/** The transcript page's load state. `ready` keeps its rows while a newer
 *  page reloads (settlement) and while an older window prepends. */
type TranscriptState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'ready'; agentId: string; leaves: TranscriptLeaf[]; parentAgentId: string | null; hasOlder: boolean; skippedFromStart: number; loadingOlder: boolean }

/** One load-older window (messages; matches the backend's newest page). */
const TRANSCRIPT_OLDER_CHUNK = 400

/** The retained output window both stores keep (channel/activity.ts and
 *  dsh-adapter/subagents.ts): a tail at this size is a WINDOW, and the
 *  output page says so when no transcript source can show the rest. */
const OUTPUT_WINDOW_CAP = 160

/** A live tail line as the transcript page renders it below the history. */
type LiveLeaf = { kind: 'live'; line: SubagentOutputLine }

const capLike = (line: string): string => (line.length > 400 ? `${line.slice(0, 400)}…` : line)

/** Merge the channel's live window into the folded history: tool records
 *  pair by call id (live status/previews win while the disk has not
 *  recorded the result; a call the history never saw appends as live),
 *  and text/thinking tail lines the loaded history already paints are
 *  suppressed — a settled block's lines are identical on both sides — so
 *  history and live neither double a row nor drop a tail. */
function mergeLiveWindow(leaves: readonly TranscriptLeaf[], subagent: SubagentState, hasHistory: boolean): (TranscriptLeaf | LiveLeaf)[] {
  const rows: (TranscriptLeaf | LiveLeaf)[] = [...leaves]
  for (const call of subagent.toolCalls) {
    let leaf: Extract<TranscriptLeaf, { kind: 'tool' }> | undefined
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i]!
      if (row.kind === 'tool' && row.tool.callId === call.id) { leaf = row; break }
    }
    if (leaf !== undefined) {
      if (leaf.tool.status === 'running' && call.status !== 'running') {
        leaf.tool.status = call.status === 'failed' ? 'error' : 'ok'
        leaf.tool.errorText = call.error
        leaf.tool.resultText = call.resultPreview
        if (call.endedAt !== undefined) leaf.tool.durationMs = Math.max(0, call.endedAt - leaf.tool.startedAt)
      }
      continue
    }
    rows.push({ kind: 'tool', key: call.id ?? call.name, tool: {
      callId: call.id ?? call.name,
      name: call.name,
      argsText: call.argsPreview ?? '',
      status: call.status === 'failed' ? 'error' : call.status === 'running' ? 'running' : 'ok',
      startedAt: call.startedAt,
      ...(call.endedAt !== undefined ? { durationMs: Math.max(0, call.endedAt - call.startedAt) } : {}),
      ...(call.resultPreview !== undefined ? { resultText: call.resultPreview } : {}),
      ...(call.error !== undefined ? { errorText: call.error } : {}),
    } })
  }
  if (!hasHistory) {
    for (const line of subagent.outputEvents) rows.push({ kind: 'live', line })
    return rows
  }
  const seen = new Set<string>()
  for (const leaf of leaves) {
    if (leaf.kind !== 'text' && leaf.kind !== 'thinking') continue
    for (const line of leaf.text.split('\n')) if (line.trim() !== '') seen.add(capLike(line))
  }
  for (const line of subagent.outputEvents) {
    if (line.text.trim() !== '' && seen.has(capLike(line.text))) continue
    rows.push({ kind: 'live', line })
  }
  return rows
}

export interface SubagentDetailSceneProps {
  subagent: SubagentState
  onBack: () => void
  onInterrupt?: (agentId: string) => void
  /** The child's full transcript source (the channel's `subagentControl.history`,
   *  Claude's store read). Absent = this backend has no transcript data
   *  plane (DSH): the Transcript page is not rendered and the output tail
   *  keeps its retained-range note (design agent-team-panels §2). */
  loadTranscript?: (agentId: string, window?: SubagentTranscriptWindow) => Promise<SubagentTranscriptView | null>
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
  variant = 'default',
  focused = true,
  visible = true,
}: SubagentDetailSceneProps): React.ReactNode {
  const panelMode = variant === 'panel'
  const scrollRef = React.useRef<ScrollBoxHandle | null>(null)
  const { rows, columns } = useTerminalSize()
  const [page, setPage] = React.useState<DetailPage>('summary')
  // The page roster is capability-driven: without a transcript source the
  // page (and its tab) does not exist — a missing capability is not an error
  // state to apologize for (design §2 graceful degradation).
  const pages: readonly DetailPage[] = loadTranscript === undefined ? PAGES_WITHOUT_TRANSCRIPT : PAGES_WITH_TRANSCRIPT

  const isRunning = subagent.status === 'running' || subagent.status === 'starting'
  // Only a live run ticks; discovered history (`unknown`) shows no duration.
  const elapsed = isRunning
    ? Date.now() - subagent.startedAt
    : subagent.completedAt !== undefined ? subagent.completedAt - subagent.startedAt : undefined
  const info = statusGlyph(subagent.status)
  const totalTokens = subagent.tokens?.total ?? ((subagent.tokens?.input ?? 0) + (subagent.tokens?.output ?? 0) || 0)
  // The backend's own reports win over locally kept records (R6 review); no
  // report → the locally kept fallback.
  const toolsCount = subagent.reportedToolUses ?? subagent.toolCalls.length
  const shownDuration = subagent.reportedDurationMs ?? elapsed
  const pageIndex = pages.indexOf(page)

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

  // ── the Agent-Transcript page (capability-driven; design §2) ─────────
  const [transcript, setTranscript] = React.useState<TranscriptState>({ status: 'idle' })
  /** The transcript page's one expanded tool card (a click toggles; the
   *  output page's single-fold rhythm, applied to cards). */
  const [expandedLeaf, setExpandedLeaf] = React.useState<string | null>(null)
  // The loader rides a ref: the channel UI proxy mints a fresh function per
  // read, and the load effect must key on WHAT changed (the page, the child,
  // settlement) — not on a churning identity.
  const loaderRef = React.useRef(loadTranscript)
  loaderRef.current = loadTranscript
  const transcriptAgent = subagent.agentId
  React.useEffect(() => {
    if (page !== 'transcript' || loaderRef.current === undefined) return
    const load = loaderRef.current
    let alive = true
    setExpandedLeaf(null)
    setTranscript(prev => prev.status === 'ready' && prev.agentId === transcriptAgent ? prev : { status: 'loading' })
    load(transcriptAgent).then(loaded => {
      if (!alive) return
      if (loaded === null) { setTranscript({ status: 'unavailable' }); return }
      const leaves: TranscriptLeaf[] = []
      foldTranscriptLeaves(loaded.events, leaves)
      setTranscript({ status: 'ready', agentId: transcriptAgent, leaves, parentAgentId: loaded.parentAgentId, hasOlder: loaded.hasOlder, skippedFromStart: loaded.skippedFromStart, loadingOlder: false })
    }, () => { if (alive) setTranscript({ status: 'unavailable' }) })
    return () => { alive = false }
    // Settlement makes the disk copy final: the isRunning flip reloads the
    // page once, picking up what streamed in live.
  }, [page, transcriptAgent, isRunning])

  const loadOlderTranscript = (): void => {
    if (transcript.status !== 'ready' || !transcript.hasOlder || transcript.loadingOlder || loaderRef.current === undefined) return
    const load = loaderRef.current
    const count = Math.min(TRANSCRIPT_OLDER_CHUNK, transcript.skippedFromStart)
    setTranscript({ ...transcript, loadingOlder: true })
    load(transcript.agentId, { count, skipFromStart: transcript.skippedFromStart }).then(older => {
      setTranscript(prev => {
        if (prev.status !== 'ready' || older === null) return older === null && prev.status === 'ready' ? { ...prev, loadingOlder: false } : prev
        const fresh: TranscriptLeaf[] = []
        foldTranscriptLeaves(older.events, fresh)
        const existing = new Set(prev.leaves.map(leaf => leaf.key))
        return { ...prev, leaves: [...fresh.filter(leaf => !existing.has(leaf.key)), ...prev.leaves], hasOlder: older.hasOlder, skippedFromStart: older.skippedFromStart, loadingOlder: false }
      })
    }, () => {
      setTranscript(prev => prev.status === 'ready' ? { ...prev, loadingOlder: false } : prev)
    })
  }

  const hasTranscriptThinking = transcript.status === 'ready' && transcript.leaves.some(leaf => leaf.kind === 'thinking' || leaf.kind === 'thinking-unavailable')

  const turnPage = (delta: number): void => {
    const next = (pageIndex + delta + pages.length) % pages.length
    setPage(pages[next]!)
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
    if (page !== 'output' && page !== 'transcript') return
    const first = setImmediate(() => scrollRef.current?.scrollTo?.(0))
    return () => clearImmediate(first)
  }, [thinkingOpen, page])

  const outputLength = subagent.outputEvents.length
  React.useEffect(() => {
    if ((page !== 'output' && page !== 'transcript') || !isRunning) return
    scrollRef.current?.scrollToBottom()
  }, [page, isRunning, outputLength])

  useInput((input, key, event) => {
    if (panelMode) return
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
    if (isPlainReturnInput(input, key)) {
      event.stopImmediatePropagation()
      // Enter folds the reasoning while the output or transcript page is
      // showing (the transcript's ctrl+o equivalent). Elsewhere it keeps its
      // "leave the detail" meaning, which Esc and the ✕ button still provide.
      if ((page === 'output' && hasThinking) || (page === 'transcript' && hasTranscriptThinking)) setThinkingOpen(open => !open)
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
    if (isPanelPlainReturn(input, key)) {
      // Enter 与整屏形态同义：输出/转录页有思考块时先折叠它，别处退回 Dashboard。
      if ((page === 'output' && hasThinking) || (page === 'transcript' && hasTranscriptThinking)) setThinkingOpen(open => !open)
      else onBack()
      return true
    }
    return false
  }
  usePanelInput(panelKeyHandler, { active: panelMode && focused && visible })

  const tab = (name: DetailPage, label: string): React.ReactNode => {
    const active = page === name
    return (
      <React.Fragment key={name}>
        <Box
          onClick={() => setPage(name)}
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
        {/* 能力缺失即无此页签（DSH 无转录数据面，不硬凑） */}
        {loadTranscript !== undefined && tab('transcript', t('subagent-tab-transcript'))}
        {tab('tools', toolsCount > 0 ? `${t('subagent-tools')} ${toolsCount}` : t('subagent-tools'))}
        <Text dimColor>{`  ${pageIndex + 1}/${pages.length}`}</Text>
      </Box>
      <Text dimColor>{'─'.repeat(Math.max(20, Math.min(72, columns - 6)))}</Text>

      {/* Paged body */}
      {/* 行数预算：整屏形态沿用原公式；侧栏形态的 rows 已是宿主高度，单独
          收一档，保证底部提示行仍在可视区内。 */}
      {/* 无转录数据源的后端（DSH）只有这个有界 tail：如实标注保留范围，
          不假装完整（设计 §2 优雅降级）。置于分隔线上方——范围内标注必须
          第一眼可见，而不是被 160 行 tail 淹没在滚动区顶部。 */}
      {page === 'output' && loadTranscript === undefined && subagent.outputEvents.length >= OUTPUT_WINDOW_CAP && (
        <Text dimColor>{t('subagent-transcript-retained', { count: subagent.outputEvents.length })}</Text>
      )}
      <Box flexDirection="column" paddingX={1} maxHeight={panelMode ? Math.max(6, rows - 10) : Math.max(10, rows - 14)}>
        <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1}>
          {page === 'summary' && (
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
          {page === 'output' && (
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
          {page === 'transcript' && loadTranscript !== undefined && (
            <Box flexDirection="column">
              {/* 范围与谱系：历史/只读标注；parent_agent_id 非空=真实父代理，
                  null 且嵌套=旧格式 metadata（按深度展示，不画孤儿）。 */}
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
                          : `▸ ${t('subagent-transcript-load-older', { count: Math.min(TRANSCRIPT_OLDER_CHUNK, transcript.skippedFromStart) })}`}</Text>
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
          {page === 'tools' && (
            subagent.toolCalls.length === 0 && subagent.reportedToolUses === undefined ? (
              <Text dimColor>{t('subagent-no-tools')}</Text>
            ) : (
              <Box flexDirection="column">
              {/* The backend reported N tool uses but only these records were
                  kept (missed lane frames, window tail): say so — never
                  fabricate the missing records (R6 review). */}
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
        </ScrollBox>
      </Box>

      <Divider color="subtle" title="" />
      {/* Footer hint */}
      <Box marginTop={0} flexDirection="row">
        <Text dimColor>
          {`←/→ ${t('subagent-hint-page')} · ↑/↓ ${t('subagent-hint-scroll')}`
            + (page === 'output' && hasThinking ? ` · ${t('subagent-hint-fold')}` : '')}
        </Text>
        {isRunning && onInterrupt && (
          <>
            <Text dimColor>{' · '}</Text>
            <Box onClick={() => onInterrupt(subagent.agentId)}>
              <Text dimColor bold color="warning">X interrupt</Text>
            </Box>
          </>
        )}
        <Text dimColor>{` · Esc ${t('subagent-hint-back')}`}</Text>
      </Box>
    </Box>
  )
}
