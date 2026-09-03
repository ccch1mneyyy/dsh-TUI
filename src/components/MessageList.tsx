import React, { useState } from 'react'
import { t } from '../i18n.js'
import { Box, Text, useTerminalSize, type ScrollBoxHandle } from '../ui.js'
import type { ClickEvent } from '../ink/events/click-event.js'
import type { ChatRow, ToolRow, ToolCallView, ToolResultView, SubagentRow, JobRow } from '../dsh-adapter/channel.js'
import type { DOMElement } from '../ink/dom.js'
import { Divider } from './design-system/Divider.js'
import { UserPromptMessage } from './messages/UserPromptMessage.js'
import { AssistantTextMessage } from './messages/AssistantTextMessage.js'
import { AssistantThinkingMessage } from './messages/AssistantThinkingMessage.js'
import { AssistantToolUseMessage } from './messages/AssistantToolUseMessage.js'
import { SubagentMessage } from './Chat/SubagentMessage.js'
import { JobCard } from './Chat/JobCard.js'
import { isMinimalMode } from '../minimalMode.js'
import { noteFrameCause, noteListGeometry } from '../ink/geometry-trace.js'
import { getTerminalFlushTick } from '../ink/flush-tick.js'
import { InterruptedByUser } from './InterruptedByUser.js'
import { LogoV2 } from './LogoV2.js'
import { StreamingMarkdown } from './StreamingMarkdown.js'
import { MessageMetadata } from './messages/MessageMetadata.js'
import { stripNarration } from '../utils/narration.js'
import { stringWidth } from '../ink/stringWidth.js'
import { truncateToWidth } from '../ink/truncateToWidth.js'
import { clipPreview, type TimelineSnapshot, type TimelineTurn } from '../ink/timeline-rail.js'
import type { ToolBackground } from '../tuiDisplayPrefs.js'
import { getRevealVersion, revealLengthOf, revealTextOf } from './smoothReveal.js'
import { useRevealVersion } from '../hooks/useRevealVersion.js'

/**
 * Transcript rows rendered in the Claude Code visual language: user prompts
 * on a grey bubble with a `❯` pointer, assistant text with a `●` bullet and
 * markdown, thinking as a live three-line/full toggle then a settled
 * `⚓ Thinking (ctrl+o to expand)` row, and tool calls as status-dot cards.
 * `expanded` (Ctrl+O) shows full reasoning + full tool
 * args/results; `expandedRows` (message-selection mode, Enter) expands single
 * rows; `selectedId` highlights the selected row.
 */
/** Render cap for very long sessions (CC's MAX_MESSAGES_WITHOUT_VIRTUALIZATION
 *  equivalent): older rows fold behind a Divider until Ctrl+E expands them.
 *  120 (was 300): opening a long session paints the whole cap into the
 *  main-screen scrollback (historyPaint), and each row's first markdown
 *  lex + wrap costs ~2-5ms — 300 rows saturated the main thread for ~6s
 *  on open (measured, 800-row inline session). 120 rows ≈ 4-5 screens of
 *  paint (<1s) with the rest behind the show-previous divider (CC parity:
 *  the transcript is a viewport, not a printout; load-earlier restores). */
const MAX_RENDERED_ROWS = 120

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
/** Stable fallbacks for the stream-view toggle props: verify/repro harnesses
 *  and embedders render MessageList with prop sets that predate them, and the
 *  render must not throw (same rule as Chat's stubbed channel APIs). Module
 *  scope keeps the identities stable so MemoRow's shallow compare and the
 *  toggle callback's deps never churn. */
const NO_STREAM_VIEW_TOGGLED: ReadonlySet<number> = new Set()
const NOOP_TOGGLE_STREAM_VIEW = (_rowId: number): void => {}

// --- smooth-streaming display text -----------------------------------------
// Render-phase reads of the shared reveal cursors (see smoothReveal.ts for
// why the cursors live outside React). `active` gates cursor CREATION to
// live-arrived content (streaming rows, live-settled rows marked `fresh`,
// replayed history paints complete); once created, a cursor keeps revealing
// until it catches up — settling mid-reveal must not snap (that is the
// "non-streaming delivery becomes a smooth flow" contract).

function assistantRevealText(row: ChatRow, enabled: boolean): string {
  const stripped = stripNarration(row.text)
  return revealTextOf(`a${row.id}`, stripped, {
    enabled,
    active: row.streaming === true || row.fresh === true,
  })
}

function reasoningRevealText(row: ChatRow, enabled: boolean): string {
  return revealTextOf(`r${row.id}`, row.text, { enabled, active: row.streaming === true })
}

/** Display length only (layout signature; no slice allocation). */
function revealDisplayLen(row: ChatRow, enabled: boolean): number {
  if (row.kind === 'assistant') {
    const stripped = stripNarration(row.text)
    return revealLengthOf(`a${row.id}`, stripped, {
      enabled,
      active: row.streaming === true || row.fresh === true,
    })
  }
  if (row.kind === 'reasoning') {
    return revealLengthOf(`r${row.id}`, row.text, { enabled, active: row.streaming === true })
  }
  return row.text.length
}

/**
 * Per-kind layout signature PARTS: the O(1) identity of every input that
 * decides a row's rendered HEIGHT (see sigRef in MessageList). Fields are
 * scoped to the row's own renderer — a global flat signature
 * over-invalidates (a diffLayout switch must not drop user-message
 * heights). Text uses length as the proxy: full-text hashing per row per
 * frame would defeat virtualization's budget, and a same-length miss only
 * degrades to the previous behavior.
 *
 * Returns a PARTS VECTOR instead of a joined string: the caller compares
 * slot-by-slot against the cached vector (all primitives), allocating only
 * when a row's inputs actually changed. Building a joined string per row
 * per render was O(rows) allocation churn on every scroll tick — the GC
 * share of the long-session scroll profile.
 *
 * The vector is a MODULE-LEVEL SCRATCH BUFFER: single-threaded synchronous
 * render makes reuse safe, and the unchanged case (the overwhelming
 * majority) allocates nothing. Callers that retain the vector must copy
 * (parts.slice()).
 */
const signatureScratch: Array<string | number | boolean> = []
function signatureParts(
  row: ChatRow,
  columns: number,
  expanded: boolean,
  expandedRows: ReadonlySet<number>,
  streamViewToggledRows: ReadonlySet<number>,
  thinkingVisible: boolean,
  thinkingFold: string,
  diffLayout: string,
  foldTerminalCommand: boolean,
  model: string,
  failureHintRowId: number | null | undefined,
  failureHint: string | undefined,
  displayTextLen: number,
): Array<string | number | boolean> {
  signatureScratch.length = 0
  // Universal height inputs: width reflows every row; kind switches height
  // semantics wholesale; text length drives wrapping. `displayTextLen` is the
  // REVEALED length while smooth streaming is painting (the height follows
  // what is on screen, not what has arrived).
  signatureScratch.push(columns, row.kind, displayTextLen)
  switch (row.kind) {
    case 'assistant':
      // Streaming vs settled swaps renderers; Ctrl+O/per-row expand adds the
      // metadata row (model only renders expanded — keeps an idle /model
      // switch from touching settled rows).
      signatureScratch.push(row.streaming === true, expanded, expandedRows.has(row.id), expanded ? model : '')
      break
    case 'reasoning':
      // thinkingFold (preview vs full), its per-row live override, and the
      // visibility filter all change the card's height.
      signatureScratch.push(row.streaming === true, expanded, expandedRows.has(row.id), streamViewToggledRows.has(row.id), thinkingVisible, thinkingFold)
      break
    case 'tool': {
      const tool = row.tool
      signatureScratch.push(
        expanded,
        expandedRows.has(row.id),
        diffLayout,
        // Terminal header folding changes the header's height the same way
        // diffLayout changes the body's — without it, a /settings toggle
        // leaves already-mounted tool cards at their stale cached height.
        foldTerminalCommand,
        tool?.status ?? '',
        tool?.resultText?.length ?? 0,
        tool?.resultFull?.length ?? 0,
        tool?.errorText?.length ?? 0,
        row.id === failureHintRowId ? failureHint ?? '' : '',
      )
      break
    }
    case 'subagent':
      // 卡片高度输入：running→settled 折叠 waterfall+tool 行（5→1 行），
      // failed 增加 error 行。缺这些字段的话 offscreen 结算后 cached
      // height 永不过期 → 滚回 blank band / 滚不到底。
      signatureScratch.push(
        row.subagent?.status ?? '',
        row.subagent?.toolCalls.length ?? 0,
        row.subagent?.outputLines.length ?? 0,
        row.subagent?.error?.length ?? 0,
      )
      break
    case 'compact':
      // Folded one-liner vs full summary text.
      signatureScratch.push(expanded, expandedRows.has(row.id))
      break
    default:
      // user / notice / interrupt / local / local-output: height follows
      // text + columns alone (selection/background never change height).
      break
  }
  return signatureScratch
}

export function MessageList({
  rows,
  expanded,
  expandedRows,
  selectedId,
  onToggleRow,
  streamViewToggledRows = NO_STREAM_VIEW_TOGGLED,
  onToggleStreamView = NOOP_TOGGLE_STREAM_VIEW,
  model,
  diffLayout = 'auto',
  thinkingFold = 'preview',
  toolBackground = 'none',
  foldTerminalCommand = false,
  smoothStreaming = false,
  activityFrames,
  showAll,
  onToggleAll,
  onLoadOlder,
  thinkingVisible = true,
  historyPaintEnabled = true,
  registerRowRef,
  scrollHandle,
  forceMountRowId,
  newSinceRowId,
  onUnseenCount,
  onTimeline,
  failureHintRowId,
  failureHint,
  onOpenSubagent,
  onOpenJobs,
  onOpenFile,
}: {
  rows: readonly ChatRow[]
  expanded: boolean
  expandedRows: ReadonlySet<number>
  selectedId: number | null
  onToggleRow: (rowId: number) => void
  /** 流式 reasoning 行相对 thinkingFold 默认视图的逐行切换。 */
  streamViewToggledRows?: ReadonlySet<number>
  onToggleStreamView?: (rowId: number) => void
  model: string
  /** Edit/Write diff presentation preference (forwarded to tool cards). */
  diffLayout?: 'auto' | 'split' | 'unified'
  /** Thinking-block display mode from channel (`preview`/`full`). */
  thinkingFold?: 'preview' | 'full'
  /** Tool-card background treatment from the live channel settings. */
  toolBackground?: ToolBackground
  /** Terminal-card header folding from the live channel settings. */
  foldTerminalCommand?: boolean
  /** Smooth streaming reveal from the live channel settings (default off at
   *  this layer — embedders and verify harnesses keep exact-paint behavior;
   *  Chat passes the channel's `dsh-tui.smoothStreaming` value). */
  smoothStreaming?: boolean
  /** Working-activity preset name from the channel; drives the subagent
   *  card's running glyph so both indicators follow one setting. */
  activityFrames?: string
  showAll: boolean
  onToggleAll: () => void
  /** Restore folded-away older rows from the session log (CC-style "load
   *  earlier messages" affordance; shown only when rows were folded). */
  onLoadOlder?: () => void
  thinkingVisible?: boolean
  /**
   * Whether rows outside the virtualization window must still be painted
   * once (main-screen mode: unpainted rows leave NO copy in the terminal
   * scrollback, so preset history would vanish). The alt-screen has no
   * scrollback — passing false skips the mount-everything-on-open
   * expansion there (a 300-row fold window of markdown otherwise costs
   * seconds of lex/highlight/layout before first paint).
   */
  historyPaintEnabled?: boolean
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
   * Reports the conversation timeline snapshot for the sticky prompt
   * header AND the transcript's turn rail: one entry per user turn
   * (stable row id + content-space text top + preview line), plus the
   * viewport-derived navigation targets, all computed from the same
   * offsets[]/base geometry the mount window uses:
   *
   *  - active: the LAST turn whose prompt top is at-or-above the viewport
   *    top (the turn whose content owns the top row — the one being
   *    read); the FIRST turn stands in while pre-turn content (logo /
   *    loaded-context) owns the top. Never null while any turn exists.
   *    Top-anchored on purpose (Grok timeline semantics), not
   *    "topmost visible prompt": the highlight moves only when a turn
   *    boundary crosses the viewport top, so it never leaps when nudging
   *    off the bottom, and the header/rail can never disagree.
   *  - upId: nearest turn STRICTLY above the viewport top (▲ target).
   *  - downId: nearest turn below the top whose top ≤ maxScroll — turns
   *    past maxScroll can never own the top row (the renderer clamps
   *    there), so naming them would make ▼ repeat itself forever.
   *
   * Reported post-commit, only when the signature changes.
   */
  onTimeline?: (state: TimelineSnapshot) => void
  /**
   * Row id that should carry the trajectory footnote — the newest unseen
   * failure, or null. Exactly one row ever carries it: repeating the pointer
   * under every historical failure is the clutter this design avoids.
   */
  failureHintRowId?: number | null
  /** Footnote text, e.g. `ctrl+t for the full trajectory`. */
  failureHint?: string
  /** 打开子代理详情场景（transcript 内点击子代理卡）。 */
  onOpenSubagent?: (agentId: string) => void
  /** 打开 /jobs 后台任务面板（transcript 内点击任务卡）。 */
  onOpenJobs?: () => void
  /** 点击工具卡内的文件路径（打开文件操作菜单）。 */
  onOpenFile?: (path: string) => void
}) {
  const hiddenCount = rows.length - MAX_RENDERED_ROWS
  // The thinking filter runs BEFORE virtualization so window indices line up.
  //
  // Fingerprint memo: every scroll tick re-rendered this pipeline even when
  // nothing changed — slice + filter allocate a fresh rows-length array and
  // the margins pre-pass allocates a Map with one entry per row (3200-row
  // session ⇒ ~200KB churn per 16ms tick, the GC share of the scroll
  // profile). The inputs are all identity-stable across ticks: channel.rows
  // is a live in-place array (identity changes only on rewind/new session),
  // showAll/thinkingVisible are React state. Rows APPENDED in place keep the
  // identity — the cache must key on rows.length too (streaming appends).
  const visibleRowsCacheRef = React.useRef<{
    rows: readonly ChatRow[]
    rowsLength: number
    showAll: boolean
    thinkingVisible: boolean
    out: readonly ChatRow[]
    margins: ReadonlyMap<number, boolean>
    /** Per-row `streaming === true` bits. The settle flip (streaming cleared
     * in place, rows identity/length unchanged) changes empty-assistant
     * filtering below, so the cache must rebuild on any bit change. */
    streamBits: Uint8Array
  } | null>(null)
  /** Generation counter for the visibleRows cache (timeline memo key). */
  const visGenRef = React.useRef(0)
  const visibleCache = visibleRowsCacheRef.current
  // Streaming-bit fingerprint: in-place `streaming = false` writes (turn
  // settle) are invisible to the rows-identity/length key above, but an
  // assistant row that settles with EMPTY text crosses the empty-assistant
  // filter boundary (visible-while-streaming → filtered-when-settled).
  // Allocation-free scan; rebuild only when a bit actually flipped.
  let streamBitsSame = visibleCache !== null && visibleCache.streamBits.length === rows.length
  if (streamBitsSame) {
    const bits = visibleCache!.streamBits
    for (let i = 0; i < rows.length; i++) {
      if (bits[i] !== (rows[i]!.streaming === true ? 1 : 0)) { streamBitsSame = false; break }
    }
  }
  if (
    visibleCache === null ||
    visibleCache.rows !== rows ||
    visibleCache.rowsLength !== rows.length ||
    visibleCache.showAll !== (showAll || hiddenCount <= 0) ||
    visibleCache.thinkingVisible !== thinkingVisible ||
    !streamBitsSame
  ) {
    const sliced = showAll || hiddenCount <= 0
      ? rows
      : rows.slice(hiddenCount)
    // Empty settled assistant rows (PR #383's duplicate-dot bug): when the
    // model calls a tool without producing text, the assistant/message event
    // carries empty text — rendered as a lone `●` bullet dangling above the
    // tool card. Filter them BEFORE virtualization (not by rendering null in
    // TranscriptRow): a null row never mounts, never enters paintedOnce, and
    // would stall the main-screen history-paint batch loop forever. A row
    // that is STILL STREAMING keeps its place even with empty text — the
    // live dot is the "model is answering" affordance and content may yet
    // arrive.
    // The emptiness test must match what RENDERING shows: the `⏵`
    // self-narration line (dsh-working-activity narrate contract) is
    // stripped at render (stripNarration below), so a narration-only step —
    // thinking, `⏵ …` line, straight to a tool call — has non-empty raw
    // text but RENDERS as that same lone `●`. Test the stripped text, or
    // the raw-text check lets the dot through forever.
    const rendersEmptyAssistant = (row: ChatRow): boolean =>
      row.kind === 'assistant' && row.streaming !== true && stripNarration(row.text ?? '').trim() === ''
    let hasEmptyAssistant = false
    for (const row of sliced) {
      if (rendersEmptyAssistant(row)) {
        hasEmptyAssistant = true
        break
      }
    }
    const out = hasEmptyAssistant
      ? sliced.filter(row =>
          !rendersEmptyAssistant(row) &&
          (thinkingVisible || row.kind !== 'reasoning'),
        )
      : thinkingVisible
        ? sliced
        : sliced.filter(row => row.kind !== 'reasoning')
    // CC addMargin: every rendered block gets a 1-row top margin except the
    // first. Pre-pass over the FULL list so a windowed row keeps the exact
    // spacing it would have in a fully-mounted list.
    const margins = new Map<number, boolean>()
    {
      let prev: ChatRow['kind'] | undefined
      for (const row of out) {
        margins.set(row.id, prev !== undefined)
        prev = row.kind
      }
    }
    const streamBits = new Uint8Array(rows.length)
    for (let i = 0; i < rows.length; i++) streamBits[i] = rows[i]!.streaming === true ? 1 : 0
    visibleRowsCacheRef.current = {
      rows,
      rowsLength: rows.length,
      showAll: showAll || hiddenCount <= 0,
      thinkingVisible,
      out,
      margins,
      streamBits,
    }
    visGenRef.current++
  }
  const visibleRows = visibleRowsCacheRef.current!.out
  const margins = visibleRowsCacheRef.current!.margins
  // Selection keeps its highlight; expanded rows render with no fill (the
  // diff line tints inside cards are the only backgrounds in the transcript).
  const rowBackground = (rowId: number) => {
    const isSelected = selectedId === rowId
    if (isSelected) return 'messageActionsBackground'
    return undefined
  }

  // --- layout virtualization ---------------------------------------------
  const { columns, rows: termRows } = useTerminalSize()
  // Smooth-reveal wakeups: the scheduler's tick bumps this hook, re-running
  // MessageList so the revealed `text`/line-count reads below feed fresh
  // values through the same MemoRow-prop pipeline an arriving chunk uses —
  // memo miss → re-render → post-commit height re-measure. Without this
  // subscription a reveal living in child state would change row heights
  // invisibly to the virtualization (stale cached heights → blank bands).
  // DefaultLane on purpose (useRevealVersion): a useSyncExternalStore wakeup
  // would force a SyncLane render per 33ms tick, and each such commit ending
  // with streaming work still pending feeds React's nested-update counter
  // until error #185 kills the process (beta.3).
  useRevealVersion()
  // Measured row heights, remembered after a row unmounts so virtualization
  // can compute total content height. Bounded: row ids grow monotonically
  // and rows are never removed from the transcript (foldRows keeps the
  // row), so without a cap this Map grew by one entry per row forever.
  // Eviction is FIFO (oldest row first); a forgotten height falls back to
  // DEFAULT_ROW_HEIGHT, which only perturbs deep scrollback estimates.
  const HEIGHTS_CACHE_MAX = 5000
  const heightsRef = React.useRef(new Map<number, number>())
  /** Geometry version: bumped at EVERY heightsRef mutation so downstream
   *  memos (timeline tops) can key on it instead of re-deriving offsets. */
  const heightsVersionRef = React.useRef(0)
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
   *  refuse to tighten until a frame containing that layout has actually
   *  been FLUSHED to the terminal (flush-tick based, issue #574). React
   *  commits and terminal writes are decoupled — the throttled deferred
   *  leading edge lets a later commit supersede the wide one inside the
   *  same task, so a wall-clock hold (the old 120ms timer) expires during
   *  long cold-cache layout work (~190ms on the repro) and the measure-tick
   *  re-render still drops the rows before a single byte of them was
   *  written; never-mounted rows have no scrollback copy and preset history
   *  vanishes. Once flushed, tightening is visually free: those rows sit in
   *  scrollback and the diff skips them. */
  const lastStartRef = React.useRef<number>(-1)
  const holdFlushTickRef = React.useRef<number>(-1)
  /** True when frame-budgeted history painting still has batches left
   *  (main-screen open): the layout effect schedules the next slice. */
  const paintPendingRef = React.useRef(false)
  const paintTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Persistent history-paint edge: how far batched painting has advanced
   *  (index into visibleRows). -1 = not painting / reset (list head change:
   *  rewind, new session, loadOlder — must repaint from scratch). */
  const paintEdgeRef = React.useRef(-1)
  const listHeadId = visibleRows[0]?.id
  if (listHeadId !== undefined && paintedBaseRef.current !== undefined && listHeadId !== paintedBaseRef.current) {
    paintedOnceRef.current = new Set()
    // History repaints from scratch after a head change too (rewind /
    // loadOlder prepends rows that must paint again).
    paintEdgeRef.current = -1
  }
  if (listHeadId !== undefined) paintedBaseRef.current = listHeadId
  /** Content-space offset of visibleRows[0] (header + dividers), measured. */
  const baseRef = React.useRef<number | null>(null)
  const measureTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const [, setMeasureTick] = React.useState(0)
  const [, setScrollTick] = React.useState(0)
  React.useEffect(() => () => {
    if (measureTimerRef.current !== null) {
      clearTimeout(measureTimerRef.current)
      measureTimerRef.current = null
    }
    if (paintTimerRef.current !== null) {
      clearTimeout(paintTimerRef.current)
      paintTimerRef.current = null
    }
  }, [])

  // A width change reflows every row — all measurements are stale.
  const lastColumns = React.useRef(columns)
  if (lastColumns.current !== columns) {
    lastColumns.current = columns
    heightsRef.current.clear()
    heightsVersionRef.current++
    baseRef.current = null
  }

  // --- layout signature: stale-height invalidation ------------------------
  // heightsRef entries outlive the commits that measured them, but many
  // state changes rewrite a row's height WITHOUT a columns change: Ctrl+O
  // (expanded), single-row expand (expandedRows), reasoning stream→fold,
  // a tool result/error/footnote arriving, diff layout switch, assistant
  // text growth, thinking visibility. A cached height from before such a
  // change feeds topPad/bottomPad spacers, the offsets scan, and the
  // ScrollBox clamps with geometry that no longer exists — blank bands,
  // overlapping rows, wrong scrollTop after toggles (the audit's stale
  // height cache). Track the inputs that decide each row's height; when
  // one changes, drop the cached height. The window extension further
  // down remounts invalidated rows so useLayoutEffect re-measures them.
  // Text identity uses length as an O(1) proxy — per-frame full-text
  // hashing over every row would defeat virtualization's budget, and a
  // same-length miss only degrades to the previous behavior.
  //
  // VECTORS, not strings: the cache stores the parts VECTOR and the
  // comparison is slot-by-slot — the unchanged case (every settled row on
  // every scroll tick) allocates nothing. A joined string per row per
  // render was O(rows) garbage per tick (3200-row session ⇒ several MB/s
  // into minor GC; the GC share of the scroll profile).
  const sigRef = React.useRef(new Map<number, Array<string | number | boolean>>())
  {
    const sigs = sigRef.current
    for (let i = 0; i < visibleRows.length; i++) {
      const row = visibleRows[i]!
      // Per-kind signature: only the inputs that row's OWN renderer consumes.
      // A global flat array (every field × every row) over-invalidates — a
      // /settings diffLayout switch used to drop every user/assistant/
      // reasoning height at once, remounting the widened window over rows
      // whose rendering never changed (Yoga spike + measure churn for
      // nothing). Base parts cover the universal height inputs.
      const parts = signatureParts(
        row,
        columns,
        expanded,
        expandedRows,
        streamViewToggledRows,
        thinkingVisible,
        thinkingFold,
        diffLayout,
        foldTerminalCommand,
        model,
        failureHintRowId,
        failureHint,
        revealDisplayLen(row, smoothStreaming),
      )
      const cachedParts = sigs.get(row.id)
      let same = false
      if (cachedParts !== undefined && cachedParts.length === parts.length) {
        same = true
        for (let s = 0; s < parts.length; s++) {
          if (parts[s] !== cachedParts[s]) { same = false; break }
        }
      }
      if (same) continue
      if (sigs.size >= HEIGHTS_CACHE_MAX) {
        const oldest = sigs.keys().next().value
        if (oldest !== undefined) sigs.delete(oldest)
      }
      // Copy out of the module-level scratch buffer — the next row reuses it.
      sigs.set(row.id, parts.slice())
      heightsRef.current.delete(row.id)
      heightsVersionRef.current++
    }
  }

  // Scrolling bypasses React (imperative DOM scrollTop): subscribe so the
  // window follows the viewport.
  React.useEffect(() => {
    if (!scrollHandle) return
    const tick = (): void =>{  setScrollTick(t => t + 1) }
    return scrollHandle.subscribe(tick)
  }, [scrollHandle])

  // Cached rail/header preview per user row (see the timeline block for why
  // the length guard exists alongside the id key).
  const previewCacheRef = React.useRef(new Map<number, { len: number; preview: string }>())

  const heightOf = (row: ChatRow): number =>
    heightsRef.current.get(row.id) ?? DEFAULT_ROW_HEIGHT
  // Reused offsets buffer: the prefix-scan itself must run every render
  // (heightsRef mutates in the measure effect), but the ARRAY need not be
  // fresh — offsets never escapes this render scope. A new 3200-slot array
  // per scroll tick was pure GC fodder.
  const offsetsBufRef = React.useRef<number[]>([])
  const offsets: number[] = offsetsBufRef.current
  offsets.length = visibleRows.length
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
    // MAIN-SCREEN ONLY (historyPaintEnabled): the alt-screen has no
    // scrollback — a row outside the window has no "copy" to preserve, and
    // mounting the whole fold window on open lexed/highlighted/laid out
    // hundreds of markdown rows the user never sees (measured: 4.3s of
    // saturated main thread before first paint on a 960-row session; the
    // virtualization window re-mounts rows on demand as they scroll in).
    // FRAME-BUDGETED: mounting the whole window in ONE commit saturated the
    // main thread for seconds (measured 6s wall with ZERO frames in the
    // first second on an 800-row inline open — every input queued behind
    // the React render). Extend in batches of ~2 viewports of measured
    // height per commit instead; the pending-batch effect schedules the
    // next slice, so the app paints, drains input, and stays interactive
    // while history streams in above the fold (opencode-style progressive
    // transcript hydration; the terminal accepts rows whenever they land).
    const paintedOnce = paintedOnceRef.current
    let paintPending = false
    if (historyPaintEnabled) {
      // Persistent batch edge: the sticky floor-walk RESETS start to the
      // tail every frame, so a per-frame budget walk from `start` re-spends
      // its whole budget on already-painted rows and never reaches deeper
      // unpainted ones (measured: an infinite 0.3ms/frame batch loop).
      // Remember how far painting has advanced; each batch extends THAT
      // edge upward by the budget.
      if (paintEdgeRef.current < 0) paintEdgeRef.current = start
      let firstUnpainted = -1
      for (let i = 0; i < paintEdgeRef.current; i++) {
        if (!paintedOnce.has(visibleRows[i]!.id)) {
          firstUnpainted = i
          break
        }
      }
      if (firstUnpainted !== -1) {
        // Budget: extend the paint edge upward by ~half a viewport of
        // measured content per commit (height estimates; unknown rows fall
        // back to DEFAULT_ROW_HEIGHT and over-mount slightly — harmless).
        // Measured: larger batches (2 viewports) put 50ms+ of first-wrap
        // yoga into one frame; half a viewport keeps batches near the
        // 16ms frame budget while still finishing an 800-row open in
        // well under two seconds of background batches.
        let budget = Math.min(viewport, termRows) / 2 + OVERSCAN_LINES
        let j = paintEdgeRef.current
        while (j > firstUnpainted && budget > 0) {
          j--
          budget -= heightOf(visibleRows[j]!)
        }
        paintEdgeRef.current = j
        start = Math.min(start, j)
        paintPending = j > 0
      }
    } else {
      paintEdgeRef.current = -1
    }
    paintPendingRef.current = paintPending
    // Unknown-height extension (layout signature, see sigRef): a row whose
    // cached height was just INVALIDATED must remount to re-measure even
    // when it sits outside the window — its spacer otherwise falls back to
    // DEFAULT_ROW_HEIGHT until the row scrolls back into view, leaving the
    // content geometry wrong for exactly that long (blank band after
    // Ctrl+O, unreachable scroll bottom after a tool result lands). One
    // remount per change; the measure tick + hold then tighten again.
    // Guard 1: only rows that have actually MOUNTED here once qualify
    // (paintedOnce fills from localRefs post-commit) — a brand-new
    // streaming row has never been measured, and extending over it would
    // mount everything below the window every frame while the user reads
    // scrolled-up (virtualization defeated, per-frame full mount = the
    // long-session stall). New rows keep the original path: their height
    // lands once the window reaches them.
    // Guard 2: rows actively STREAMING are skipped too. A streaming row's
    // signature invalidates EVERY chunk (text length grows), so a painted
    // streaming row below/above the window remounted per chunk — full
    // markdown re-lex + wrap of the whole growing text, invisible to the
    // user reading history (measured: 3s of streaming while scrolled up
    // burned 2.5s of yoga and +84MB heap). Its height is in flux anyway;
    // the final settle invalidates once more and remounts exactly once.
    for (let i = 0; i < start; i++) {
      if (visibleRows[i]!.streaming === true) continue
      const rowId = visibleRows[i]!.id
      if (!heightsRef.current.has(rowId) && paintedOnceRef.current.has(rowId)) {
        start = i
        break
      }
    }
    // Expansion hold — AFTER the extension so it tracks the FINAL window:
    // never tighten past a widen until a frame with that layout has been
    // flushed (getTerminalFlushTick advanced since the widen). A mount
    // followed by the measure-tick re-render that drops the row paints only
    // the DROPPED layout, and the row's painted-once mark (set at the first
    // commit) is a lie; holding until the flush makes the mark real.
    if (
      lastStartRef.current >= 0 &&
      start > lastStartRef.current &&
      getTerminalFlushTick() === holdFlushTickRef.current
    ) {
      start = lastStartRef.current
    }
    if (lastStartRef.current < 0 || start < lastStartRef.current) {
      holdFlushTickRef.current = getTerminalFlushTick()
    }
    lastStartRef.current = start
  }
  // Tail-side invalidated-height extension (see the start-side loop above
  // for the rationale and both guards): rows BELOW the window whose height
  // was just invalidated remount to re-measure, so bottomPad keeps real
  // geometry while the user reads scrolled-up content and the tail streams.
  // Runs for non-sticky views; sticky mounts the tail anyway. Streaming
  // rows are skipped — THIS loop is the measured hot path of the
  // read-while-streaming stall (the streaming tail row sits below the
  // window and invalidated per chunk).
  for (let i = end; i < visibleRows.length; i++) {
    if (visibleRows[i]!.streaming === true) continue
    const rowId = visibleRows[i]!.id
    if (!heightsRef.current.has(rowId) && paintedOnceRef.current.has(rowId)) end = i + 1
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
  noteListGeometry({
    start,
    end,
    topPad,
    bottomPad,
    total,
    base,
    sticky,
    pending,
    viewport,
    termRows,
    columns,
    rowCount: visibleRows.length,
  })

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

  // Conversation timeline snapshot: one entry per user turn (stable id +
  // content-space text top + preview), plus the viewport-derived targets
  // consumed by BOTH the sticky prompt header (active) and the transcript
  // turn rail (active highlight, ▲/▼). Top-anchored semantics (Grok
  // timeline): active = the LAST turn whose prompt top is at-or-above the
  // viewport top — the turn whose content owns the top row, "the turn
  // being read" — with the first turn standing in while pre-turn content
  // (logo / loaded-context) owns the top. The highlight moves only when a
  // turn boundary crosses the viewport top, never when a later prompt
  // merely becomes visible lower on screen, so it cannot leap when
  // nudging off the bottom and the header/rail can never disagree. The
  // projected top (scrollTop + pending) is used so boundary crossings
  // register during wheel bursts, not one drain frame late. Same
  // rows-space math as the mount window (offsets are rows-space,
  // scrollTop content-space — add the header base). downId additionally
  // requires the turn's top ≤ maxScroll: the renderer clamps scrollTop
  // there, so a turn past it could never own the top row, and naming it
  // would make ▼ repeat itself forever (the stuck-▼ bug). Reported
  // post-commit, only when the signature changes.
  let timelineTurns: TimelineTurn[] = []
  let activeTurnIndex: number | null = null
  let upTurnIndex: number | null = null
  let downTurnIndex: number | null = null
  const timelineMemoRef = React.useRef<{ key: string; turns: TimelineTurn[] } | null>(null)
  {
    // Split into (a) a GEOMETRY-memoized turns list and (b) a per-frame
    // allocation-free target scan. Before the split this block rebuilt on
    // EVERY scroll tick: an 800-object turns array, an 800-entry
    // measuredTops Map, and the report effect's turns.map().join('|')
    // signature — several hundred KB of churn per second of scrolling on a
    // tool-heavy session.
    //
    // (a) turns/tops/folded change ONLY when geometry changes: row heights
    // (heightsVersion — bumped at every heightsRef mutation), the visible
    // window's content (visGen — bumped when the visibleRows cache
    // rebuilds), the measured header base, or the rows array growing. Key
    // on those; previews stay in their own id-keyed cache.
    const memo = timelineMemoRef.current
    const memoKey = `${visGenRef.current}:${heightsVersionRef.current}:${base}:${rows.length}:${columns}`
    if (memo === null || memo.key !== memoKey) {
      const previewCache = previewCacheRef.current
      if (previewCache.size > 2000) previewCache.clear()
      // Measured tops for turns INSIDE the fold window (user rows are never
      // filtered by the thinking toggle, so a user row absent from
      // visibleRows is exactly a folded one).
      const measuredTops = new Map<number, number>()
      for (let i = 0; i < visibleRows.length; i++) {
        const row = visibleRows[i]!
        if (row.kind !== 'user') continue
        measuredTops.set(row.id, base + offsets[i]! + (margins.get(row.id) === true ? 1 : 0))
      }
      // Walk ALL rows (not the fold window): the rail must cover the whole
      // conversation — a tool-heavy session packs 300 rows into a handful
      // of turns, and window-only turns made the rail show "2-3 nodes".
      // Folded turns carry folded:true + top:-1; their tops are unknown
      // until revealed (they are all ABOVE the viewport, so active/down
      // over measured turns is unaffected; ▲ may name a folded turn — its
      // click goes through the reveal path, not scrollTo).
      const turns: TimelineTurn[] = []
      for (const row of rows) {
        if (row.kind !== 'user') continue
        let cached = previewCache.get(row.id)
        if (cached === undefined || cached.len !== row.text.length) {
          cached = { len: row.text.length, preview: clipPreview(row.text) }
          previewCache.set(row.id, cached)
        }
        const textTop = measuredTops.get(row.id)
        if (textTop !== undefined) {
          turns.push({ id: row.id, top: textTop, preview: cached.preview })
        } else {
          turns.push({ id: row.id, top: -1, preview: cached.preview, folded: true })
        }
      }
      timelineMemoRef.current = { key: memoKey, turns }
    }
    timelineTurns = timelineMemoRef.current!.turns
    // (b) per-frame target scan — pure integer comparisons over the
    // memoized list; viewTop is projected (scrollTop + pending) so
    // boundary crossings register during wheel bursts, not one drain
    // frame late. downId additionally requires top ≤ maxScroll: the
    // renderer clamps scrollTop there, so a turn past it could never own
    // the top row, and naming it would make ▼ repeat itself forever.
    const viewTop = scrollTop + pending
    const maxScroll = Math.max(0, (scrollHandle?.getScrollHeight() ?? 0) - viewport)
    for (let i = 0; i < timelineTurns.length; i++) {
      const t = timelineTurns[i]!
      if (t.folded === true) {
        // Above the fold ⇒ strictly above the viewport: a legal ▲ target.
        upTurnIndex = i
        continue
      }
      if (t.top <= viewTop) activeTurnIndex = i
      if (t.top < viewTop) upTurnIndex = i
      if (downTurnIndex === null && t.top > viewTop && t.top <= maxScroll) {
        downTurnIndex = i
      }
    }
    if (timelineTurns.length > 0 && activeTurnIndex === null) activeTurnIndex = 0
  }
  const timeline: TimelineSnapshot = {
    turns: timelineTurns,
    activeId: activeTurnIndex === null ? null : timelineTurns[activeTurnIndex]!.id,
    upId: upTurnIndex === null ? null : timelineTurns[upTurnIndex]!.id,
    downId: downTurnIndex === null ? null : timelineTurns[downTurnIndex]!.id,
  }
  const lastTimelineReportRef = React.useRef<TimelineSnapshot | null>(null)
  React.useEffect(() => {
    // Value-level dedup, not geometry-key-level: the memo key pins to
    // heightsVersion, which a GROWING streamed row bumps on every commit,
    // so a key-pinned signature re-reports an identical snapshot every
    // commit of a long stream. Each report is a setState dispatched into
    // Chat from this passive effect; it lands as pending residue at commit
    // end, keeping the commit dirty and feeding React's nested-update
    // counter (50 consecutive dirty commits → error #185, the beta.3
    // crash). The O(turns) compare below is integer/string-reference
    // compares only — cheap next to the joined-string signature the memo
    // key replaced, and it fires exactly when the snapshot content changes.
    const prev = lastTimelineReportRef.current
    if (
      prev !== null &&
      prev.activeId === timeline.activeId &&
      prev.upId === timeline.upId &&
      prev.downId === timeline.downId &&
      prev.turns.length === timeline.turns.length &&
      prev.turns.every((t, i) => {
        const n = timeline.turns[i]!
        return t.id === n.id && t.top === n.top && t.folded === n.folded && t.preview === n.preview
      })
    ) return
    lastTimelineReportRef.current = timeline
    onTimeline?.(timeline)
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
        heightsVersionRef.current++
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
        // Upper clamp only while unmounted content remains below the window
        // (bottomPad spacer): it exists to pin the paint to the mounted edge
        // during burst scrolls that outrun React's window re-render. Once the
        // tail is fully mounted (bottomPad 0) there IS no unmounted gap — the
        // estimated `mountedBottom` can sit a line short of the real Yoga
        // extent (engine flex-basis cache vs final child layout drift, see
        // render-node-to-output's scrollHeight floor), and an estimated clamp
        // would then cull the last line at every non-sticky paint — the
        // scrolled-away-and-back tail loss. Leave the max open; the renderer
        // still caps at the frame's real maxScroll.
        scrollHandle.setClampBounds(
          min,
          bottomPad <= 0 ? undefined : Math.max(min, base + mountedBottom - viewport),
        )
      }
    }
    if (changed && measureTimerRef.current === null) {
      // Layout corrections can cascade for many rows. Yield to the next
      // macrotask so React does not count the valid convergence as nested
      // updates when a streaming/reveal commit is already in flight.
      measureTimerRef.current = setTimeout(() => {
        measureTimerRef.current = null
        noteFrameCause('measure')
        setMeasureTick(t => t + 1)
      }, 0)
    }
    // History-paint continuation (main-screen open): more never-painted
    // batches remain — schedule the next slice on the macrotask queue so
    // pending input events (wheel, keys) drain between batches and the app
    // stays interactive while preset history streams in. A timeout of 0 is
    // enough: each batch's mount+measure work is bounded (~2 viewports),
    // unlike the previous single-commit full mount that saturated the main
    // thread for seconds.
    if (paintPendingRef.current && paintTimerRef.current === null) {
      paintTimerRef.current = setTimeout(() => {
        paintTimerRef.current = null
        if (!paintPendingRef.current) return
        noteFrameCause('measure')
        setMeasureTick(t => t + 1)
      }, 0)
    }
  })

  // useCallback: the reference feeds MemoRow's shallow compare; a fresh
  // closure per render would defeat every row's memo.
  const setRowRef = React.useCallback((rowId: number, el: DOMElement | null): void => {
    if (el) localRefs.current.set(rowId, el)
    else localRefs.current.delete(rowId)
    registerRowRef?.(rowId, el)
  }, [registerRowRef])

  return (
    <>
      {rows.some(row => row.folded) && (
        <ClickableDivider title={t('load-earlier')} onClick={onLoadOlder} />
      )}
      {!showAll && hiddenCount > 0 && (
        <ClickableDivider title={t('show-previous-messages', { n: hiddenCount })} onClick={onToggleAll} />
      )}
      {topPad > 0 && <Box height={topPad} flexShrink={0} />}
      {visibleRows
        .slice(start, end)
        .map((row) => {
        // CC addMargin: pre-pass result keeps windowed rows at full-mount
        // spacing; only the very first row of the whole list has none.
          const addMargin = margins.get(row.id) === true
          const tool = row.tool
          const subagent = row.kind === 'subagent' ? row.subagent : undefined
          const job = row.kind === 'job' ? row.job : undefined
          const revealVersion = smoothStreaming && row.kind === 'tool' && row.fresh === true &&
            row.tool?.status === 'running' && row.tool.resultView === undefined
            ? getRevealVersion()
            : 0
          // Smooth reveal feeds the SAME flattened text prop a chunk feeds,
          // and keeps the streaming layout alive until the reveal catches up
          // (settling mid-reveal must not snap — a one-shot non-streaming
          // delivery still paints as a flow).
          let displayText = row.text
          let displayStreaming = row.streaming === true
          if (row.kind === 'assistant' && smoothStreaming) {
            const stripped = stripNarration(row.text)
            displayText = revealTextOf(`a${row.id}`, stripped, {
              enabled: true,
              active: displayStreaming || row.fresh === true,
            })
            displayStreaming = displayStreaming || displayText.length !== stripped.length
          } else if (row.kind === 'assistant') {
            displayText = stripNarration(row.text)
          } else if (row.kind === 'reasoning' && smoothStreaming) {
            displayText = revealTextOf(`r${row.id}`, row.text, { enabled: true, active: displayStreaming })
          }
          return (
            <MemoRow
              key={row.id}
              rowId={row.id}
              kind={row.kind}
              text={displayText}
              textFull={row.kind === 'reasoning' ? row.text : undefined}
              executionTarget={row.executionTarget}
              streaming={displayStreaming}
              durationMs={row.durationMs}
              time={row.time}
              addMargin={addMargin}
              isSelected={selectedId === row.id}
              isExpanded={expandedRows.has(row.id)}
              expanded={expanded}
              model={model}
              diffLayout={diffLayout}
              thinkingFold={thinkingFold}
              toolBackground={toolBackground}
              foldTerminalCommand={foldTerminalCommand}
              smoothStreaming={smoothStreaming}
              fresh={row.fresh === true}
              revealVersion={revealVersion}
              activityFrames={activityFrames}
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
              subagent={subagent}
              job={job}
              onToggleRow={onToggleRow}
              onToggleStreamView={onToggleStreamView}
              streamViewToggled={streamViewToggledRows.has(row.id)}
              onOpenSubagent={onOpenSubagent}
              onOpenJobs={onOpenJobs}
              onOpenFile={onOpenFile}
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
  /** Reasoning rows: the FULL un-revealed text — the live three-line preview
   *  ticker follows the newest arrived content (never the reveal), while the
   *  expanded body shows the revealed slice in `text`. */
  textFull?: string
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
  /** Smooth streaming reveal (forwarded to thinking/tool renderers). */
  smoothStreaming: boolean
  /** Live-arrived row flag (drives tool-card reveal participation). */
  fresh: boolean
  /** Version tick for active tool reveal; 0 keeps settled rows memoized. */
  revealVersion: number
  thinkingFold: 'preview' | 'full'
  toolBackground: ToolBackground
  /** Terminal-card header folding (forwarded to tool cards). */
  foldTerminalCommand: boolean
  /** Working-activity preset name; drives the subagent card's running glyph. */
  activityFrames: string | undefined
  background: 'messageActionsBackground' | undefined
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
  // SubagentRow, stable ref (subagent lifecycle events update the store, not
  // the row ref itself, so a plain ref compare stays correct).
  subagent: SubagentRow | undefined
  // JobRow, same update contract as SubagentRow (replaced per job commit).
  job: JobRow | undefined
  onToggleRow: (rowId: number) => void
  /** 流式 reasoning 行在三行预览/全文间切换；落定行用 onToggleRow。 */
  onToggleStreamView: (rowId: number) => void
  /** 是否反转该流式行的 thinkingFold 默认视图。 */
  streamViewToggled: boolean
  onOpenSubagent: ((agentId: string) => void) | undefined
  onOpenJobs: (() => void) | undefined
  onOpenFile: ((path: string) => void) | undefined
  setRowRef: (rowId: number, el: DOMElement | null) => void
}

/** Load-earlier / show-previous divider row with a mouse hover tint — the
 *  clickability is otherwise invisible (audit C-04). */
function ClickableDivider({ title, onClick }: { title: string; onClick?: () => void }): React.ReactNode {
  const [hovered, setHovered] = useState(false)
  return (
    <Box
      marginTop={1}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      backgroundColor={hovered ? 'userMessageBackgroundHover' : undefined}
    >
      <Divider title={title} />
    </Box>
  )
}

function TranscriptRow({
  rowId,
  kind,
  text,
  textFull,
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
  smoothStreaming,
  fresh,
  revealVersion,
  thinkingFold,
  toolBackground,
  foldTerminalCommand,
  activityFrames,
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
  subagent,
  job,
  onToggleRow,
  onToggleStreamView,
  streamViewToggled,
  onOpenSubagent,
  onOpenJobs,
  onOpenFile,
  setRowRef,
}: MemoRowProps): React.ReactNode {
  const ref = React.useCallback(
    (el: DOMElement | null): void => {
      setRowRef(rowId, el)
    },
    [setRowRef, rowId],
  )
  // 可折叠行（工具卡/思考/compact 摘要）共用：点击切换展开，全宽行右侧
  // 空白（屏幕缓冲未写入单元格）不触发——点击空白想选字/拖拽时不再误触
  // 展开/收起（审计 C-03/cellIsBlank 零消费）。纯文本行（user/assistant）
  // 保持不可点：转录是阅读区（用户反馈），折叠语义留给带视觉指示的行。
  const foldOnClick = React.useCallback((event: ClickEvent): void => {
    if (event.cellIsBlank) return
    onToggleRow(rowId)
  }, [onToggleRow, rowId])
  // 流式 reasoning 行：点击在三行预览/全文间切换。它反转 thinkingFold
  // 的默认值，落定后语义自动回到 foldOnClick。
  const streamViewOnClick = React.useCallback((event: ClickEvent): void => {
    if (event.cellIsBlank) return
    onToggleStreamView(rowId)
  }, [onToggleStreamView, rowId])
  // 子代理卡：点击打开详情场景（不是折叠）。
  const openSubagent = React.useCallback(() => {
    if (subagent !== undefined) onOpenSubagent?.(subagent.agentId)
  }, [onOpenSubagent, subagent])
  // compact 摘要折叠行 hover 轻指示（∴ 提亮，不刷背景）。
  const [compactHovered, setCompactHovered] = useState(false)

  switch (kind) {
    case 'user':
      return (
        <Box flexDirection="column" ref={ref}>
          <UserPromptMessage
            text={text}
            addMargin={addMargin}
            isSelected={isSelected}
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
          ref={ref}
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
          />
        </Box>
      )
    case 'reasoning': {
      // The setting chooses the live default; a row click reverses it. Global
      // or per-row transcript expansion always wins and shows the full text.
      const streamPreview = streaming && !expanded && !isExpanded &&
        (streamViewToggled ? thinkingFold === 'full' : thinkingFold === 'preview')
      return (
        <Box flexDirection="column" ref={ref}>
          <AssistantThinkingMessage
            thinking={text}
            textFull={textFull}
            addMargin={addMargin}
            streaming={streaming}
            preview={streamPreview}
            // Settled rows keep the fold-on-settle default and expand via
            // expandedRows/Ctrl+O; a live row is always preview or full.
            verbose={isExpanded || expanded || (streaming && !streamPreview)}
            durationMs={durationMs}
            isSelected={isSelected}
            onClick={streaming ? streamViewOnClick : foldOnClick}
          />
        </Box>
      )
    }
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
            toolBackground={toolBackground}
            smoothReveal={smoothStreaming}
            fresh={fresh}
            revealVersion={revealVersion}
            foldTerminalCommand={foldTerminalCommand}
            onClick={foldOnClick}
            onOpenFile={onOpenFile}
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
      // text preview; Ctrl+O (global), message-selection Enter, or a click
      // reveals the full summary.
      return (
        <Box
          marginTop={addMargin ? 1 : 0}
          paddingLeft={2}
          backgroundColor={background}
          ref={ref}
          onClick={foldOnClick}
          onMouseEnter={() => setCompactHovered(true)}
          onMouseLeave={() => setCompactHovered(false)}
        >
          {expanded || isExpanded ? (
            <Text dimColor>{text}</Text>
          ) : (
            <Text dimColor italic color={compactHovered ? 'text' : undefined}>
              <Text color={compactHovered ? 'text' : undefined}>∴</Text>
              {' '}{t('compact-summary-folded')} · {compactPreview(text)}{' '}
              {t('hint-expand-ctrl-o')}
            </Text>
          )}
        </Box>
      )
    case 'subagent':
      if (!subagent) return null
      return (
        <Box flexDirection="column" ref={ref}>
          <SubagentMessage
            subagent={subagent}
            addMargin={addMargin}
            activityFrames={activityFrames}
            isExpanded={isExpanded}
            onClick={openSubagent}
          />
        </Box>
      )
    case 'job':
      if (!job) return null
      return (
        <Box flexDirection="column" ref={ref}>
          <JobCard
            job={job}
            addMargin={addMargin}
            onClick={onOpenJobs}
          />
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
  whale = true,
  whaleIdle = false,
  working = false,
  skipIntro = false,
}: {
  model: string
  effort?: string | undefined
  cwd: string
  whale?: boolean
  /** Idle whale behaviors + working signal (passed through to LogoV2). */
  whaleIdle?: boolean
  working?: boolean
  /** Jump straight to the settled header (long-session resume: the ~3.4s
   *  opening animation competes with transcript mount batches). */
  skipIntro?: boolean
}): React.ReactNode {
  // Minimal mode drops the whole splash (whale art AND wordmark) — only the
  // transcript and a bare status bar remain.
  if (isMinimalMode()) return null
  return (
    <Box flexDirection="column" marginBottom={1}>
      <LogoV2 model={model} effort={effort} cwd={cwd} whale={whale} whaleIdle={whaleIdle} working={working} skipIntro={skipIntro} />
    </Box>
  )
}
