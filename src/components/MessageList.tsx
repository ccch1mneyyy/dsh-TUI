import React from 'react'
import { t } from '../i18n.js'
import { Box, Text, useTerminalSize, type ScrollBoxHandle } from '../ui.js'
import type { ChatRow, ToolRow, ToolCallView, ToolResultView } from '../channel.js'
import type { DOMElement } from '../ink/dom.js'
import { Divider } from './design-system/Divider.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { UserPromptMessage } from './messages/UserPromptMessage.js'
import { AssistantTextMessage } from './messages/AssistantTextMessage.js'
import { AssistantThinkingMessage } from './messages/AssistantThinkingMessage.js'
import { AssistantToolUseMessage } from './messages/AssistantToolUseMessage.js'
import { InterruptedByUser } from './InterruptedByUser.js'
import { LogoV2 } from './LogoV2.js'
import { StreamingMarkdown } from './StreamingMarkdown.js'
import { MessageMetadata } from './messages/MessageMetadata.js'
import { stripNarration } from '../utils/narration.js'
import { stringWidth } from '../ink/stringWidth.js'
import { truncateToWidth } from '../ink/truncateToWidth.js'

/**
 * Transcript rows rendered in the Claude Code visual language: user prompts
 * on a grey bubble with a `❯` pointer, assistant text with a `●` bullet and
 * markdown, thinking folded to `∴ Thinking (ctrl+o to expand)`, tool calls as
 * status-dot cards. `expanded` (Ctrl+O) shows full reasoning + full tool
 * args/results; `expandedRows` (message-selection mode, Enter) expands single
 * rows; `selectedId` highlights the selected row.
 */
/** Render cap for very long sessions (CC's MAX_MESSAGES_WITHOUT_VIRTUALIZATION
 *  equivalent): older rows fold behind a Divider until Ctrl+E expands them. */
const MAX_RENDERED_ROWS = 300

// --- layout virtualization constants -------------------------------------
// Offscreen rows render as fixed-height spacers whose heights come from the
// previous commit's Yoga layout, so the pure-JS Yoga engine never walks
// their subtrees. Spacers preserve the scroll geometry (content height,
// sticky follow, scrollbar) of a fully-mounted list.
/** Lines of extra content mounted above/below the visible window. */
const OVERSCAN_LINES = 8
/** Fallback row height before the first measurement (terminal lines). */
const DEFAULT_ROW_HEIGHT = 2
/** Cold-start estimate of the header block above the rows; corrected by the
 *  first layout measurement. */
const DEFAULT_HEADER_LINES = 14

export function MessageList({
  rows,
  expanded,
  expandedRows,
  selectedId,
  onToggleRow,
  model,
  showAll,
  onToggleAll,
  onLoadOlder,
  thinkingVisible = true,
  registerRowRef,
  scrollHandle,
  forceMountRowId,
  newSinceRowId,
  onUnseenCount,
}: {
  rows: readonly ChatRow[]
  expanded: boolean
  expandedRows: ReadonlySet<number>
  selectedId: number | null
  onToggleRow: (rowId: number) => void
  model: string
  showAll: boolean
  onToggleAll: () => void
  /** Restore folded-away older rows from the session log (CC-style "load
   *  earlier messages" affordance; shown only when rows were folded). */
  onLoadOlder?: () => void
  thinkingVisible?: boolean
  /** Transcript search: register each row's DOM element for scroll-to-match. */
  registerRowRef?: (rowId: number, el: DOMElement | null) => void
  /** Scroll viewport the list virtualizes against. */
  scrollHandle?: ScrollBoxHandle | null
  /** Row that must be mounted this pass (seek target for scrollToElement). */
  forceMountRowId?: number | null
  /** "Seen up to" anchor for the new-messages pill: rows with id greater
   *  than this are new. Null when pinned to the bottom (nothing unseen). */
  newSinceRowId?: number | null
  /** Reports how many new rows still sit below the viewport bottom edge. */
  onUnseenCount?: (count: number) => void
}) {
  const hiddenCount = rows.length - MAX_RENDERED_ROWS
  // The thinking filter runs BEFORE virtualization so window indices line up.
  const visibleRows = (showAll || hiddenCount <= 0
    ? rows
    : rows.slice(hiddenCount)
  ).filter(row => thinkingVisible || row.kind !== 'reasoning')
  // CC addMargin: every rendered block gets a 1-row top margin except the
  // first. Pre-pass over the FULL list so a windowed row keeps the exact
  // spacing it would have in a fully-mounted list.
  const margins = new Map<number, boolean>()
  {
    let prev: ChatRow['kind'] | undefined
    for (const row of visibleRows) {
      margins.set(row.id, prev !== undefined)
      prev = row.kind
    }
  }
  // CC's expanded rows keep a persistent hover-grey background (VirtualItem:
  // `expanded ? userMessageBackgroundHover : undefined`).
  const rowBackground = (rowId: number) => {
    const isSelected = selectedId === rowId
    if (isSelected) return 'messageActionsBackground'
    if (expandedRows.has(rowId)) return 'userMessageBackgroundHover'
    return undefined
  }

  // --- layout virtualization ---------------------------------------------
  const { columns } = useTerminalSize()
  // Measured row heights, remembered after a row unmounts so virtualization
  // can compute total content height. Bounded: row ids grow monotonically
  // and rows are never removed from the transcript (foldRows keeps the
  // row), so without a cap this Map grew by one entry per row forever.
  // Eviction is FIFO (oldest row first); a forgotten height falls back to
  // DEFAULT_ROW_HEIGHT, which only perturbs deep scrollback estimates.
  const HEIGHTS_CACHE_MAX = 5000
  const heightsRef = React.useRef(new Map<number, number>())
  const localRefs = React.useRef(new Map<number, DOMElement>())
  /** Content-space offset of visibleRows[0] (header + dividers), measured. */
  const baseRef = React.useRef<number | null>(null)
  const [, setMeasureTick] = React.useState(0)
  const [, setScrollTick] = React.useState(0)

  // A width change reflows every row — all measurements are stale.
  const lastColumns = React.useRef(columns)
  if (lastColumns.current !== columns) {
    lastColumns.current = columns
    heightsRef.current.clear()
    baseRef.current = null
  }

  // Scrolling bypasses React (imperative DOM scrollTop): subscribe so the
  // window follows the viewport.
  React.useEffect(() => {
    if (!scrollHandle) return
    const tick = (): void =>{  setScrollTick(t => t + 1) }
    return scrollHandle.subscribe(tick)
  }, [scrollHandle])

  const heightOf = (row: ChatRow): number =>
    heightsRef.current.get(row.id) ?? DEFAULT_ROW_HEIGHT
  const offsets: number[] = new Array<number>(visibleRows.length)
  let total = 0
  for (let i = 0; i < visibleRows.length; i++) {
    offsets[i] = total
    total += heightOf(visibleRows[i])
  }

  const scrollTop = scrollHandle?.getScrollTop() ?? 0
  const pending = scrollHandle?.getPendingDelta() ?? 0
  const viewport = scrollHandle?.getViewportHeight() ?? 24
  const sticky = scrollHandle?.isSticky() ?? true
  const base = baseRef.current ?? DEFAULT_HEADER_LINES

  // Mount the union of the committed position and any in-flight pending
  // delta, plus overscan; when sticky, always reach the tail (streaming row).
  const relTop = Math.min(scrollTop, scrollTop + pending) - OVERSCAN_LINES - base
  const relBottom = Math.max(scrollTop, scrollTop + pending) + viewport + OVERSCAN_LINES - base
  let start = 0
  while (start < visibleRows.length && offsets[start] + heightOf(visibleRows[start]) <= relTop) start++
  let end = start
  while (end < visibleRows.length && offsets[end] < relBottom) end++
  if (sticky || !scrollHandle) end = visibleRows.length
  // Pinned to bottom: the tail row must stay mounted EVERY pass. The
  // streaming row's measured height only lands in heightsRef when it
  // survives mounted across two consecutive commits (useLayoutEffect reads
  // the previous Yoga pass). If an underestimated `total` ever lets relTop
  // overshoot it, start=len unmounts everything → content collapses to the
  // header → follow yanks scrollTop to 0 → next pass remounts all → follow
  // back to the real bottom: a self-sustaining ping-pong that blanks the
  // transcript mid-stream.
  if (sticky && visibleRows.length > 0) {
    start = Math.min(start, visibleRows.length - 1)
  }
  if (forceMountRowId !== undefined && forceMountRowId !== null) {
    const idx = visibleRows.findIndex(row => row.id === forceMountRowId)
    if (idx !== -1) {
      start = Math.min(start, idx)
      end = Math.max(end, idx + 1)
    }
  }
  const topPad = offsets[start] ?? 0
  const mountedBottom = end < visibleRows.length ? offsets[end] : total
  const bottomPad = total - mountedBottom

  // New-messages pill count: rows past the seen-anchor whose top edge is
  // still below the viewport bottom. Same rows-space math as the window
  // (offsets are rows-space, scrollTop content-space — subtract the header
  // base). Decrements as the user scrolls down through the new rows; 0 once
  // every new row has appeared on screen. Reported post-commit (parent
  // setState with an unchanged value is a React no-op, so the per-render
  // effect only re-renders on actual count changes).
  let unseenCount = 0
  if (newSinceRowId !== null && newSinceRowId !== undefined) {
    const firstNew = visibleRows.findIndex(row => row.id > newSinceRowId)
    if (firstNew !== -1) {
      const seenBottom = scrollTop + viewport - base
      for (let i = firstNew; i < visibleRows.length; i++) {
        if (offsets[i]! >= seenBottom) unseenCount++
      }
    }
  }
  React.useEffect(() => {
    onUnseenCount?.(unseenCount)
  })

  // Post-commit: measure mounted rows, derive the content-space base from
  // the first mounted row's Yoga top, and clamp render-time scrollTop to the
  // mounted coverage so burst scrolls never show blank spacer.
  React.useLayoutEffect(() => {
    let changed = false
    for (const [id, el] of localRefs.current) {
      const h = el.yogaNode?.getComputedHeight()
      if (h !== undefined && h > 0 && heightsRef.current.get(id) !== h) {
        if (heightsRef.current.size >= HEIGHTS_CACHE_MAX) {
          const oldest = heightsRef.current.keys().next().value
          if (oldest !== undefined) heightsRef.current.delete(oldest)
        }
        heightsRef.current.set(id, h)
        changed = true
      }
    }
    const firstMounted = visibleRows[start]
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: empty list window
    const firstEl = firstMounted ? localRefs.current.get(firstMounted.id) : undefined
    const top = firstEl?.yogaNode?.getComputedTop()
    if (top !== undefined) {
      const measured = top - (offsets[start] ?? 0)
      if (baseRef.current !== measured) {
        baseRef.current = measured
        changed = true
      }
    }
    if (scrollHandle) {
      if (sticky || (start === 0 && end >= visibleRows.length)) {
        scrollHandle.setClampBounds(undefined, undefined)
      } else {
        const min = Math.max(0, base + topPad - viewport)
        scrollHandle.setClampBounds(min, Math.max(min, base + mountedBottom - viewport))
      }
    }
    if (changed) setMeasureTick(t => t + 1)
  })

  // useCallback: the reference feeds MemoRow's shallow compare; a fresh
  // closure per render would defeat every row's memo.
  const setRowRef = React.useCallback((rowId: number, el: DOMElement | null): void => {
    if (el) localRefs.current.set(rowId, el)
    else localRefs.current.delete(rowId)
    registerRowRef?.(rowId, el)
  }, [registerRowRef])

  // Second-resolution clock for the running tool card's live elapsed time.
  // Computed per render (cheap) but only forwarded to running rows, so
  // settled rows never see a changing prop.
  const nowSec = Math.floor(Date.now() / 1000)

  return (
    <>
      {rows.some(row => row.folded) && (
        <Box marginTop={1} onClick={onLoadOlder}>
          <Divider title={t('load-earlier')} />
        </Box>
      )}
      {!showAll && hiddenCount > 0 && (
        <Box marginTop={1} onClick={onToggleAll}>
          <Divider title={` ctrl+e to show ${hiddenCount} previous messages `} />
        </Box>
      )}
      {topPad > 0 && <Box height={topPad} flexShrink={0} />}
      {visibleRows
        .slice(start, end)
        .map((row) => {
        // CC addMargin: pre-pass result keeps windowed rows at full-mount
        // spacing; only the very first row of the whole list has none.
          const addMargin = margins.get(row.id) === true
          const tool = row.tool
          return (
            <MemoRow
              key={row.id}
              rowId={row.id}
              kind={row.kind}
              text={row.text}
              streaming={row.streaming === true}
              durationMs={row.durationMs}
              time={row.time}
              addMargin={addMargin}
              isSelected={selectedId === row.id}
              isExpanded={expandedRows.has(row.id)}
              expanded={expanded}
              model={model}
              background={rowBackground(row.id)}
              toolCallId={tool?.callId}
              toolName={tool?.name}
              toolArgsText={tool?.argsText}
              toolArgsFull={tool?.argsFull}
              toolStatus={tool?.status}
              toolResultText={tool?.resultText}
              toolResultFull={tool?.resultFull}
              toolErrorText={tool?.errorText}
              toolCallView={tool?.callView}
              toolResultView={tool?.resultView}
              toolStartedAt={tool?.startedAt}
              toolDurationMs={tool?.durationMs}
              nowSec={tool?.status === 'running' ? nowSec : undefined}
              onToggleRow={onToggleRow}
              setRowRef={setRowRef}
            />
          )
        })}
      {bottomPad > 0 && <Box height={bottomPad} flexShrink={0} />}
    </>
  )
}

// --- per-row memoization ---------------------------------------------------
// channel.ts mutates rows in place (`text += chunk`, `tool.status = ...`),
// so row-object identity can never detect an update. MemoRow flattens every
// rendered field into primitive props: React.memo's default shallow compare
// then sees each mutation as a changed string/number, while an untouched
// row compares equal in O(1) and skips render + reconciler diff entirely.
// Before this, every streamed chunk re-rendered every mounted row (~30-40
// in the virtualization window) and re-ran each row's markdown pipeline —
// the dominant long-session jank source.
type MemoRowProps = {
  rowId: number
  kind: ChatRow['kind']
  text: string
  streaming: boolean
  durationMs: number | undefined
  time: number | undefined
  addMargin: boolean
  isSelected: boolean
  isExpanded: boolean
  expanded: boolean
  model: string
  background: 'messageActionsBackground' | 'userMessageBackgroundHover' | undefined
  // ToolRow, flattened: the channel writes status/result fields in place,
  // so passing the object itself would make mutations invisible to memo.
  toolCallId: string | undefined
  toolName: string | undefined
  toolArgsText: string | undefined
  toolArgsFull: string | undefined
  toolStatus: ToolRow['status'] | undefined
  toolResultText: string | undefined
  toolResultFull: string | undefined
  toolErrorText: string | undefined
  /** Presentation views are set-once stable refs (creation / settle), so a
   *  plain ref compare stays correct under the in-place mutation model. */
  toolCallView: ToolCallView | undefined
  toolResultView: ToolResultView | undefined
  toolStartedAt: number | undefined
  toolDurationMs: number | undefined
  /** Second-resolution clock, forwarded only while the tool runs so the
   *  live elapsed label ticks; settled rows never receive a changing prop. */
  nowSec: number | undefined
  onToggleRow: (rowId: number) => void
  setRowRef: (rowId: number, el: DOMElement | null) => void
}

function TranscriptRow({
  rowId,
  kind,
  text,
  streaming,
  durationMs,
  time,
  addMargin,
  isSelected,
  isExpanded,
  expanded,
  model,
  background,
  toolCallId,
  toolName,
  toolArgsText,
  toolArgsFull,
  toolStatus,
  toolResultText,
  toolResultFull,
  toolErrorText,
  toolCallView,
  toolResultView,
  toolStartedAt,
  toolDurationMs,
  onToggleRow,
  setRowRef,
}: MemoRowProps): React.ReactNode {
  const ref = React.useCallback(
    (el: DOMElement | null): void => {
      setRowRef(rowId, el)
    },
    [setRowRef, rowId],
  )
  const onClick = React.useCallback((): void => {
    onToggleRow(rowId)
  }, [onToggleRow, rowId])

  switch (kind) {
    case 'user':
      return (
        <Box flexDirection="column" ref={ref}>
          <UserPromptMessage
            text={text}
            addMargin={addMargin}
            isSelected={isSelected}
            isExpanded={isExpanded}
            onClick={onClick}
          />
        </Box>
      )
    case 'assistant':
      return streaming ? (
        <Box
          alignItems="flex-start"
          flexDirection="row"
          marginTop={addMargin ? 1 : 0}
          width="100%"
          backgroundColor={background}
        >
          <Box minWidth={2}>
            <Text color="text">●</Text>
          </Box>
          <Box flexDirection="column">
            {/* The ⏵ self-narration line (working-activity narrate contract)
              is stripped here: the live working line on the status bar
              already shows it. */}
            <StreamingMarkdown>{stripNarration(text)}</StreamingMarkdown>
          </Box>
        </Box>
      ) : (
        <Box
          width="100%"
          flexDirection="column"
          backgroundColor={background}
          ref={ref}
        >
          {expanded && (
            <Box
              flexDirection="row"
              justifyContent="flex-end"
              gap={1}
              marginTop={1}
            >
              <MessageMetadata timestamp={time} model={model} />
            </Box>
          )}
          <AssistantTextMessage
            text={stripNarration(text)}
            addMargin={addMargin}
            isSelected={isSelected}
            isExpanded={isExpanded}
            onClick={onClick}
          />
        </Box>
      )
    case 'reasoning':
      return (
        <Box flexDirection="column" ref={ref}>
          <AssistantThinkingMessage
            thinking={text}
            addMargin={addMargin}
            // Streaming reasoning shows expanded live, then folds
            // automatically once the turn settles (unless Ctrl+O or a
            // single-row expansion keeps it open).
            verbose={isExpanded || expanded || streaming}
            durationMs={durationMs}
            isSelected={isSelected}
            onClick={onClick}
          />
        </Box>
      )
    case 'tool': {
      if (
        toolCallId === undefined ||
        toolName === undefined ||
        toolArgsText === undefined ||
        toolStatus === undefined ||
        toolStartedAt === undefined
      ) {
        return null
      }
      // Rebuilt per render from the flattened props — cheap object literal,
      // and AssistantToolUseMessage is only reached when memo let us through.
      const tool: ToolRow = {
        callId: toolCallId,
        name: toolName,
        argsText: toolArgsText,
        argsFull: toolArgsFull,
        status: toolStatus,
        resultText: toolResultText,
        resultFull: toolResultFull,
        errorText: toolErrorText,
        callView: toolCallView,
        resultView: toolResultView,
        startedAt: toolStartedAt,
        durationMs: toolDurationMs,
      }
      return (
        <Box flexDirection="column" ref={ref}>
          <AssistantToolUseMessage
            tool={tool}
            addMargin={addMargin}
            verbose={isExpanded || expanded}
            isSelected={isSelected}
            isExpanded={isExpanded}
          />
        </Box>
      )
    }
    case 'notice':
      return (
        <Box marginTop={1} ref={ref}>
          <Divider title={` ${text} `} />
        </Box>
      )
    case 'interrupt':
      return (
        <Box marginTop={1} ref={ref}>
          <InterruptedByUser />
        </Box>
      )
    case 'local':
    // `!` mode command echo, like CC's UserBashInputMessage.
      return (
        <Box marginTop={1} backgroundColor={background} ref={ref}>
          <Text color="bashBorder">! {text}</Text>
        </Box>
      )
    case 'local-output':
      return (
        <Box paddingLeft={2} backgroundColor={background} ref={ref}>
          <Text dimColor>{text}</Text>
        </Box>
      )
    case 'compact':
      // The post-compaction summary defaults to a folded one-liner with a
      // text preview; Ctrl+O (global) or message-selection Enter reveals
      // the full summary.
      return (
        <Box
          marginTop={addMargin ? 1 : 0}
          paddingLeft={2}
          backgroundColor={background}
          ref={ref}
          onClick={onClick}
        >
          {expanded || isExpanded ? (
            <Text dimColor>{text}</Text>
          ) : (
            <Text dimColor italic>
              ∴ {t('compact-summary-folded')} · {compactPreview(text)}{' '}
              <KeyboardShortcutHint shortcut="ctrl+o" action="expand" parens />
            </Text>
          )}
        </Box>
      )
  }
}

/** Folded compact-summary preview: whitespace flattened, capped with an
 *  ellipsis so the fold line never wraps. `limit` is terminal cells, so
 *  CJK wide chars count double and never split mid-glyph. */
function compactPreview(text: string, limit = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return stringWidth(flat) <= limit ? flat : `${truncateToWidth(flat, limit - 1)}…`
}

const MemoRow = React.memo(TranscriptRow)

/**
 * The header block pinned above the transcript: the DeepSeek pixel whale
 * with the wordmark, tagline, model/effort and cwd (`LogoV2`), plus the
 * welcome line. It scrolls away with the transcript once the conversation
 * fills the viewport (Claude Code shows its ✦ logo in the same slot).
 */
export function LogoHeader({
  model,
  effort,
  cwd,
}: {
  model: string
  effort?: string | undefined
  cwd: string
}): React.ReactNode {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <LogoV2 model={model} effort={effort} cwd={cwd} />
    </Box>
  )
}
