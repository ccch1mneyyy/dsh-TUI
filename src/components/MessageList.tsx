import React from 'react'
import { Box, Text, useTerminalSize, type ScrollBoxHandle } from '../ui.js'
import type { ChatRow } from '../channel.js'
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
}: {
  rows: readonly ChatRow[]
  expanded: boolean
  expandedRows: ReadonlySet<number>
  selectedId: number | null
  onToggleRow(rowId: number): void
  model: string
  showAll: boolean
  onToggleAll(): void
  /** Restore folded-away older rows from the session log (CC-style "load
   *  earlier messages" affordance; shown only when rows were folded). */
  onLoadOlder?(): void
  thinkingVisible?: boolean
  /** Transcript search: register each row's DOM element for scroll-to-match. */
  registerRowRef?(rowId: number, el: DOMElement | null): void
  /** Scroll viewport the list virtualizes against. */
  scrollHandle?: ScrollBoxHandle | null
  /** Row that must be mounted this pass (seek target for scrollToElement). */
  forceMountRowId?: number | null
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
    const tick = (): void => setScrollTick(t => t + 1)
    return scrollHandle.subscribe(tick)
  }, [scrollHandle])

  const heightOf = (row: ChatRow): number =>
    heightsRef.current.get(row.id) ?? DEFAULT_ROW_HEIGHT
  const offsets: number[] = new Array<number>(visibleRows.length)
  let total = 0
  for (let i = 0; i < visibleRows.length; i++) {
    offsets[i] = total
    total += heightOf(visibleRows[i]!)
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
  while (start < visibleRows.length && offsets[start]! + heightOf(visibleRows[start]!) <= relTop) start++
  let end = start
  while (end < visibleRows.length && offsets[end]! < relBottom) end++
  if (sticky || !scrollHandle) end = visibleRows.length
  if (forceMountRowId !== undefined && forceMountRowId !== null) {
    const idx = visibleRows.findIndex(row => row.id === forceMountRowId)
    if (idx !== -1) {
      start = Math.min(start, idx)
      end = Math.max(end, idx + 1)
    }
  }
  const topPad = offsets[start] ?? 0
  const mountedBottom = end < visibleRows.length ? offsets[end]! : total
  const bottomPad = total - mountedBottom

  // Post-commit: measure mounted rows, derive the content-space base from
  // the first mounted row's Yoga top, and clamp render-time scrollTop to the
  // mounted coverage so burst scrolls never show blank spacer.
  React.useLayoutEffect(() => {
    let changed = false
    for (const [id, el] of localRefs.current) {
      const h = el.yogaNode?.getComputedHeight()
      if (h !== undefined && h > 0 && heightsRef.current.get(id) !== h) {
        heightsRef.current.set(id, h)
        changed = true
      }
    }
    const firstMounted = visibleRows[start]
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

  const setRowRef = (rowId: number, el: DOMElement | null): void => {
    if (el) localRefs.current.set(rowId, el)
    else localRefs.current.delete(rowId)
    registerRowRef?.(rowId, el)
  }

  return (
    <>
      {rows.some(row => row.folded) && (
        <Box marginTop={1} onClick={onLoadOlder}>
          <Divider title={' ↑ 加载更早消息（会话日志完整，/export 导出全文） '} />
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
          const isSelected = selectedId === row.id
          const isExpanded = expanded || expandedRows.has(row.id)

          switch (row.kind) {
            case 'user':
              return (
                <Box key={row.id} flexDirection="column" ref={el => setRowRef(row.id, el)}>
                  <UserPromptMessage
                    text={row.text}
                    addMargin={addMargin}
                    isSelected={isSelected}
                    isExpanded={expandedRows.has(row.id)}
                    onClick={() =>{  onToggleRow(row.id); }}
                  />
                </Box>
              )
            case 'assistant':
              return row.streaming ? (
                <Box
                  key={row.id}
                  alignItems="flex-start"
                  flexDirection="row"
                  marginTop={addMargin ? 1 : 0}
                  width="100%"
                  backgroundColor={rowBackground(row.id)}
                >
                  <Box minWidth={2}>
                    <Text color="text">●</Text>
                  </Box>
                  <Box flexDirection="column">
                    {/* The ⏵ self-narration line (working-activity narrate
                      contract) is stripped here: the live working line on
                      the status bar already shows it. */}
                    <StreamingMarkdown>{stripNarration(row.text)}</StreamingMarkdown>
                  </Box>
                </Box>
              ) : (
                <Box
                  key={row.id}
                  width="100%"
                  flexDirection="column"
                  backgroundColor={rowBackground(row.id)}
                  ref={el => setRowRef(row.id, el)}
                >
                  {expanded && (
                    <Box
                      flexDirection="row"
                      justifyContent="flex-end"
                      gap={1}
                      marginTop={1}
                    >
                      <MessageMetadata timestamp={row.time} model={model} />
                    </Box>
                  )}
                  <AssistantTextMessage
                    text={stripNarration(row.text)}
                    addMargin={addMargin}
                    isSelected={isSelected}
                    isExpanded={expandedRows.has(row.id)}
                    onClick={() =>{  onToggleRow(row.id); }}
                  />
                </Box>
              )
            case 'reasoning':
              return (
                <Box key={row.id} flexDirection="column" ref={el => setRowRef(row.id, el)}>
                  <AssistantThinkingMessage
                    thinking={row.text}
                    addMargin={addMargin}
                    // Streaming reasoning shows expanded live, then folds
                    // automatically once the turn settles (unless Ctrl+O or a
                    // single-row expansion keeps it open).
                    verbose={isExpanded || row.streaming === true}
                    durationMs={row.durationMs}
                    isSelected={isSelected}
                    onClick={() =>{  onToggleRow(row.id); }}
                  />
                </Box>
              )
            case 'tool':
              return row.tool ? (
                <Box key={row.id} flexDirection="column" ref={el => setRowRef(row.id, el)}>
                  <AssistantToolUseMessage
                    tool={row.tool}
                    addMargin={addMargin}
                    verbose={isExpanded}
                    isSelected={isSelected}
                    isExpanded={expandedRows.has(row.id)}
                  />
                </Box>
              ) : null
            case 'notice':
              return (
                <Box key={row.id} marginTop={1} ref={el => setRowRef(row.id, el)}>
                  <Divider title={` ${row.text} `} />
                </Box>
              )
            case 'interrupt':
              return (
                <Box key={row.id} marginTop={1} ref={el => setRowRef(row.id, el)}>
                  <InterruptedByUser />
                </Box>
              )
            case 'local':
            // `!` mode command echo, like CC's UserBashInputMessage.
              return (
                <Box key={row.id} marginTop={1} backgroundColor={rowBackground(row.id)} ref={el => setRowRef(row.id, el)}>
                  <Text color="bashBorder">! {row.text}</Text>
                </Box>
              )
            case 'local-output':
              return (
                <Box key={row.id} paddingLeft={2} backgroundColor={rowBackground(row.id)} ref={el => setRowRef(row.id, el)}>
                  <Text dimColor>{row.text}</Text>
                </Box>
              )
          }
        })}
      {bottomPad > 0 && <Box height={bottomPad} flexShrink={0} />}
    </>
  )
}

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
