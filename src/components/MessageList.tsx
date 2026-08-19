import React from 'react'
import { t } from '../i18n.js'
import { Box, Text, useTerminalSize, type ScrollBoxHandle } from '../ui.js'
import type { ChatRow, ToolRow, ToolCallView, ToolResultView } from '../dsh-adapter/channel.js'
import type { DOMElement } from '../ink/dom.js'
import { Divider } from './design-system/Divider.js'
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
  diffLayout = 'auto',
  thinkingFold = 'preview',
  showAll,
  onToggleAll,
  onLoadOlder,
  thinkingVisible = true,
  registerRowRef,
  scrollHandle,
  forceMountRowId,
  newSinceRowId,
  onUnseenCount,
  failureHintRowId,
  failureHint,
}: {
  rows: readonly ChatRow[]
  expanded: boolean
  expandedRows: ReadonlySet<number>
  selectedId: number | null
  onToggleRow: (rowId: number) => void
  model: string
  /** Edit/Write diff presentation preference (forwarded to tool cards). */
  diffLayout?: 'auto' | 'split' | 'unified'
  /** Thinking-block display mode from channel (`preview`/`full`). */
  thinkingFold?: 'preview' | 'full'
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
  /**
   * Row id that should carry the trajectory footnote — the newest unseen
   * failure, or null. Exactly one row ever carries it: repeating the pointer
   * under every historical failure is the clutter this design avoids.
   */
  failureHintRowId?: number | null
  /** Footnote text, e.g. `ctrl+t for the full trajectory`. */
  failureHint?: string
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
  const { columns, rows: termRows } = useTerminalSize()
  // Measured row heights, remembered after a row unmounts so virtualization
  // can compute total content height. Bounded: row ids grow monotonically
  // and rows are never removed from the transcript (foldRows keeps the
  // row), so without a cap this Map grew by one entry per row forever.
  // Eviction is FIFO (oldest row first); a forgotten height falls back to
  // DEFAULT_ROW_HEIGHT, which only perturbs deep scrollback estimates.
  const HEIGHTS_CACHE_MAX = 5000
  const heightsRef = React.useRef(new Map<number, number>())
  const localRefs = React.useRef(new Map<number, DOMElement>())
  /** Row ids that have been mounted (and therefore painted into the
   *  terminal) at least once. The sticky window may skip a row ONLY after
   *  this: an unpainted row above the window has no scrollback copy, so
   *  skipping it would erase it from the user's history entirely — preset
   *  history at boot (session resume) landed exactly there. Cleared when
   *  the list head changes identity (rewind / new session / loadOlder
   *  prepends restored rows that must paint again). */
  const paintedOnceRef = React.useRef<Set<number>>(new Set())
  const paintedBaseRef = React.useRef<number | undefined>(undefined)
  /** Window-expansion hold: after the window WIDENS (new rows mounted),
   *  refuse to tighten for a short hold so the mounted rows actually reach
   *  the terminal. React commits within one ink frame coalesce — a render
   *  that mounts rows followed by the measure-tick re-render that drops
   *  them paints only the DROPPED layout, and never-mounted rows have no
   *  scrollback copy (preset history at boot vanished — CI
   *  repro-inline-scrollback). After the hold, tightening is visually
   *  free: those rows sit in scrollback and the diff skips them. */
  const lastStartRef = React.useRef<number>(-1)
  const holdUntilRef = React.useRef<number>(0)
  const listHeadId = visibleRows[0]?.id
  if (listHeadId !== undefined && paintedBaseRef.current !== undefined && listHeadId !== paintedBaseRef.current) {
    paintedOnceRef.current = new Set()
  }
  if (listHeadId !== undefined) paintedBaseRef.current = listHeadId
  /** Content-space offset of visibleRows[0] (header + dividers), measured. */
  const baseRef = React.useRef<number | null>(null)
  const measureQueuedRef = React.useRef(false)
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
    // Sticky (follow-bottom): the viewport shows the TAIL of the content —
    // mount exactly the tail window the floor walk covers, not everything
    // from the scrollTop scan. Main-screen ScrollBox reports its viewport
    // as the CONTENT height (the terminal itself is the scroller), so both
    // the scan and an unclamped floor walk mount EVERY row in long
    // sessions — and React's commit traverses every fiber of every mounted
    // row per frame (measured as the dominant long-session stall). The
    // user only ever sees terminal rows: clamp the walk-back coverage to
    // the TERMINAL viewport plus overscan.
    start = Math.min(start, visibleRows.length - 1)
    // Blank-band guard: sticky scrollTop tracks the renderer's FRESH Yoga
    // scrollHeight, while these offsets use per-row heights measured one to
    // two commits late. During fast streaming the accurate scrollTop scans
    // deeper through the underestimated offsets than the real viewport does,
    // unmounting rows that are still on screen (visible spacer band). Walk
    // backwards from the tail with the known heights and mount at least one
    // terminal viewport plus overscan of content above it, so the window
    // can never open a gap inside what the user is looking at.
    let covered = Math.min(viewport, termRows) + OVERSCAN_LINES
    let floor = visibleRows.length - 1
    while (floor > 0 && covered > 0) {
      covered -= heightOf(visibleRows[floor])
      floor--
    }
    // The walk exhausted the whole list: every row is within coverage —
    // floor+1 here would drop row 0 (its content then has no terminal copy
    // anywhere; preset history lost its head — CI repro-inline-scrollback).
    start = floor === 0 && covered > 0 ? 0 : floor + 1
    // Paint-at-least-once: extend the window over any row that has never
    // been mounted. A row the window skips keeps only its terminal/scrollback
    // copy — a row that was never painted has NO copy anywhere, so preset
    // history (session resume, repro-inline-scrollback's #39 family) would
    // vanish from the user's scrollback. Extending mounts everything above
    // on the first frame (topPad 0, full paint), then the set fills and the
    // window tightens to the tail.
    const paintedOnce = paintedOnceRef.current
    for (let i = 0; i < start; i++) {
      if (!paintedOnce.has(visibleRows[i]!.id)) {
        start = i
        break
      }
    }
    // Expansion hold — AFTER the extension so it tracks the FINAL window:
    // never tighten within the hold window after a widen. React commits
    // inside one ink frame coalesce; a mount followed by the measure-tick
    // re-render that drops the row paints only the DROPPED layout, and the
    // row's painted-once mark (set at the first commit) is a lie.
    if (lastStartRef.current >= 0 && start > lastStartRef.current && performance.now() < holdUntilRef.current) {
      start = lastStartRef.current
    }
    if (lastStartRef.current < 0 || start < lastStartRef.current) {
      holdUntilRef.current = performance.now() + 120
    }
    lastStartRef.current = start
  }
  if (forceMountRowId !== undefined && forceMountRowId !== null) {
    const idx = visibleRows.findIndex(row => row.id === forceMountRowId)
    if (idx !== -1) {
      start = Math.min(start, idx)
      end = Math.max(end, idx + 1)
    }
  }
  // The newest failed tool call carries the trajectory footnote
  // (failureHint). Virtualization must not unmount it: before the window
  // clamp the row was always mounted, now keep mounting it explicitly while
  // the hint is live (verify-trace-scene's footnote check).
  if (failureHintRowId !== undefined && failureHintRowId !== null) {
    const idx = visibleRows.findIndex(row => row.id === failureHintRowId)
    if (idx !== -1) start = Math.min(start, idx)
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
  const lastUnseenReportRef = React.useRef(-1)
  React.useEffect(() => {
    if (unseenCount !== lastUnseenReportRef.current) {
      lastUnseenReportRef.current = unseenCount
      onUnseenCount?.(unseenCount)
    }
  })

  // Post-commit: measure mounted rows, derive the content-space base from
  // the first mounted row's Yoga top, and clamp render-time scrollTop to the
  // mounted coverage so burst scrolls never show blank spacer.
  React.useLayoutEffect(() => {
    let changed = false
    // Mounted ⇒ painted: record rows eligible for window skipping.
    const paintedOnce = paintedOnceRef.current
    for (const id of localRefs.current.keys()) {
      if (!paintedOnce.has(id)) paintedOnce.add(id)
    }
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
        // Sticky still needs the MIN clamp: the first wheel-up breaks sticky
        // on the DOM (ScrollBox.scrollBy) several frames before React
        // commits a new mount window, and the drain frames in between paint
        // unmounted spacer rows as a blank band. Clamping to the currently
        // mounted top shows the edge content until React catches up - same
        // behavior as the steady-state scroll path. The MAX clamp stays
        // disabled: sticky follow pushes scrollTop to each frame's new
        // maxScroll, which a stale mounted max would clamp away.
        const min = start > 0 ? Math.max(0, base + topPad - viewport) : undefined
        scrollHandle.setClampBounds(min, undefined)
      } else {
        const min = Math.max(0, base + topPad - viewport)
        scrollHandle.setClampBounds(min, Math.max(min, base + mountedBottom - viewport))
      }
    }
    if (changed && !measureQueuedRef.current) {
      // Layout corrections can cascade for many rows. Yield between commits
      // so React does not count the valid convergence as nested updates.
      measureQueuedRef.current = true
      queueMicrotask(() => {
        measureQueuedRef.current = false
        setMeasureTick(t => t + 1)
      })
    }
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
          <Divider title={t('show-previous-messages', { n: hiddenCount })} />
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
              executionTarget={row.executionTarget}
              streaming={row.streaming === true}
              durationMs={row.durationMs}
              time={row.time}
              addMargin={addMargin}
              isSelected={selectedId === row.id}
              isExpanded={expandedRows.has(row.id)}
              expanded={expanded}
              model={model}
              diffLayout={diffLayout}
              thinkingFold={thinkingFold}
              background={rowBackground(row.id)}
              toolCallId={tool?.callId}
              toolName={tool?.name}
              toolArgsText={tool?.argsText}
              toolArgsFull={tool?.argsFull}
              toolStatus={tool?.status}
              toolResultText={tool?.resultText}
              toolResultFull={tool?.resultFull}
              toolErrorText={tool?.errorText}
              toolFootnote={failureHintRowId === row.id ? failureHint : undefined}
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
  executionTarget: string | undefined
  streaming: boolean
  durationMs: number | undefined
  time: number | undefined
  addMargin: boolean
  isSelected: boolean
  isExpanded: boolean
  expanded: boolean
  model: string
  /** Edit/Write diff presentation preference (forwarded to tool cards). */
  diffLayout: 'auto' | 'split' | 'unified'
  thinkingFold: 'preview' | 'full'
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
  /** Trajectory footnote, present on at most one row (the newest failure). */
  toolFootnote: string | undefined
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
  executionTarget,
  streaming,
  durationMs,
  time,
  addMargin,
  isSelected,
  isExpanded,
  expanded,
  model,
  diffLayout,
  thinkingFold,
  background,
  toolCallId,
  toolName,
  toolArgsText,
  toolArgsFull,
  toolStatus,
  toolResultText,
  toolResultFull,
  toolErrorText,
  toolFootnote,
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
            preview={
              streaming &&
              thinkingFold === 'preview' &&
              !expanded &&
              !isExpanded
            }
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
            footnote={toolFootnote}
            diffLayout={diffLayout}
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
          <Text color="bashBorder">!{executionTarget ? ` [${executionTarget}]` : ''} {text}</Text>
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
              {t('hint-expand-ctrl-o')}
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
