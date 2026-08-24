/**
 * Renderer-neutral timeline model (docs/pi-tui-ui-rewrite-research.md §3.2).
 *
 * Pure geometry/ownership semantics behind the fullscreen transcript's turn
 * navigator (timeline rail), sticky prompt header, and back-to-bottom pill.
 * Ported from the source main's Ink implementation (`src/ink/timeline-rail.ts`
 * plus the MessageList snapshot scan and Chat's unseen-anchor state machine)
 * with all renderer coupling removed: this module never touches Channel,
 * ScrollView, or the component tree — it consumes plain turn lists and
 * viewport integers and returns frozen, hit-testable structures, so what is
 * drawn is always what can be clicked ("看得到但点不中" impossible by
 * construction).
 *
 * Display widths go through pi's `visibleWidth` (grapheme-based, ANSI/OSC
 * aware) via the `src/tui/public.ts` facade — the Ink `stringWidth`
 * per-char assumptions are NOT carried over.
 */

import { visibleWidth } from './public.js'
import { normalizeScrollGutter } from '../tuiDisplayPrefs.js'

// The gutter preference's canonical home is the import-free prefs module
// (the channel consumes it); re-exported here for renderer consumers.
export { normalizeScrollGutter }
export type { ScrollGutterMode } from '../tuiDisplayPrefs.js'

/** Columns the rail reserves (widest tick glyph). */
export const RAIL_WIDTH = 2

/** Terminals narrower than this hide the rail (transcript needs the cols). */
export const RAIL_MIN_TERMINAL_WIDTH = 60

/** Fewer turns than this and the rail is noise. */
export const RAIL_MIN_TURNS = 2

/** Viewports shorter than this have no room for ▲ + tick + ▼. */
export const RAIL_MIN_VIEWPORT_ROWS = 3

/** Stored preview cap (chars). Render paths re-truncate to card width. */
export const PREVIEW_MAX_CHARS = 120

/** Scroll-gutter preference (settings `dsh-tui.scrollGutter`): the timeline
 *  rail (default), the proportional scrollbar, or nothing. Re-exported from
 *  the canonical prefs module — see the top of this file. */

/** One user turn, as the rail sees it. Identity is the row id — never an
 *  array index (deletion / rewind / loadOlder would mis-target it). */
export interface TimelineTurn {
  /** ChatRow id of the user message (jump/preview target). */
  id: number
  /** Content-space top of the prompt TEXT (scrollTo(target) pins it to
   *  the viewport top); −1 while the turn is folded. */
  top: number
  /** First non-empty prompt line, char-capped (see clipPreview). */
  preview: string
  /**
   * True while the row sits BEFORE the fold window (older than the most
   * recent rendered rows): its top is unknown (`top` carries −1) and
   * clicking the tick must first reveal the folded history (showAll /
   * loadOlder + seek in the same layout frame) rather than scrollTo(−1).
   * Rendering a tick for it is still correct — the turn EXISTS and is
   * navigable, it is just folded away right now.
   */
  folded?: boolean
}

/** The per-layout snapshot the transcript reports and the rail + sticky
 *  header + pill consume — one source so the three can never disagree. */
export interface TimelineSnapshot {
  /** Turns in conversation order. */
  turns: ReadonlyArray<TimelineTurn>
  /** Turn owning the viewport top row; first turn while pre-turn content
   *  owns the top; null only when there are no turns. */
  activeId: number | null
  /** ▲ target (strictly above the top), null at the first turn. */
  upId: number | null
  /** ▼ target (below the top and reachable), null at the end. */
  downId: number | null
}

/** Per-render rail geometry: where the ticks and chevrons landed. */
export interface RailGeometry {
  /** Turn-index window shown as ticks: [windowStart, windowEnd). */
  windowStart: number
  windowEnd: number
  /** Row of the ▲ chevron (block-local, within the rail column). */
  upRow: number
  /** Row of the first tick. */
  tickTop: number
  /** Row of the ▼ chevron. */
  downRow: number
}

/** What a rail row is. */
export type RailHit =
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'tick'; index: number }

/** How a turn navigation resolves: folded turns must be revealed first
 *  (never scrollTo(−1)); measured turns jump by content coordinate. */
export type TimelineJump =
  | { kind: 'scroll'; top: number }
  | { kind: 'reveal'; id: number }

/** Single eligibility policy: scrollability, terminal width, turn count,
 *  and geometric feasibility in one place. */
export function railEligible(opts: {
  turnCount: number
  terminalWidth: number
  viewportRows: number
  /** False when the content fits the viewport (inline mode / fresh
   *  session): nothing to navigate, the terminal's own scrollback owns
   *  the wheel. */
  scrollable: boolean
}): boolean {
  return (
    opts.scrollable &&
    opts.turnCount >= RAIL_MIN_TURNS &&
    opts.terminalWidth >= RAIL_MIN_TERMINAL_WIDTH &&
    opts.viewportRows >= RAIL_MIN_VIEWPORT_ROWS
  )
}

/**
 * Compute rail geometry, or null when the rail must not render.
 *
 * Windowing: when turns outnumber tick rows (viewport − 2 chevrons), slide
 * a window around the ACTIVE turn; at the bottom prefer the tail so the
 * newest ticks stay visible — but never exclude the active turn, or no
 * tick would highlight. The chevron+tick block is vertically centered in
 * the rail column.
 */
export function computeRailGeometry(
  turnCount: number,
  viewportRows: number,
  activeIndex: number | null,
  atBottom: boolean,
): RailGeometry | null {
  if (turnCount < RAIL_MIN_TURNS) return null
  const maxTicks = viewportRows - 2
  if (maxTicks < 1) return null

  let start = 0
  if (turnCount > maxTicks) {
    const tailStart = turnCount - maxTicks
    const anchor = activeIndex ?? turnCount - 1
    start = atBottom
      ? Math.min(anchor, tailStart)
      : Math.min(Math.max(0, anchor - Math.floor(maxTicks / 2)), tailStart)
  }
  const shown = Math.min(turnCount, maxTicks)
  // Vertically center the ▲ + ticks + ▼ stack.
  const blockTop = Math.max(0, Math.floor((viewportRows - (shown + 2)) / 2))
  return {
    windowStart: start,
    windowEnd: start + shown,
    upRow: blockTop,
    tickTop: blockTop + 1,
    downRow: blockTop + 1 + shown,
  }
}

/**
 * Which rail interaction a block-local row lands on. The whole rail width
 * is the hit target (no pixel-hunting the glyph).
 */
export function railHit(geo: RailGeometry, row: number): RailHit | null {
  if (row === geo.upRow) return { kind: 'up' }
  if (row === geo.downRow) return { kind: 'down' }
  if (row >= geo.tickTop) {
    const rel = row - geo.tickTop
    if (rel < geo.windowEnd - geo.windowStart) {
      return { kind: 'tick', index: geo.windowStart + rel }
    }
  }
  return null
}

/**
 * Viewport-derived turn ownership (top-anchored semantics):
 *
 *  - active: the LAST turn whose prompt top is at-or-above the viewport
 *    top (the turn whose content owns the top row — "the turn being
 *    read"). When pre-turn content (logo / loaded-context panel) owns the
 *    top, the FIRST turn stands in. Never the newest-turn clamp: its
 *    one-step-off-bottom highlight leap is exactly what this rule avoids.
 *  - up target: the last turn STRICTLY above the viewport top. From
 *    mid-turn it first aligns the current turn's own prompt, and it can
 *    never name a trailing turn no scroll could bring to the top (the
 *    stuck-▲ bug).
 *  - down target: the FIRST turn whose prompt top is strictly below the
 *    viewport top AND reachable (top ≤ maxScroll — the renderer clamps
 *    scrollTop to maxScroll, so a turn below it could never own the top
 *    row; naming it would make ▼ repeat itself forever).
 *
 * Folded turns (all above the fold window, hence above the viewport) are
 * legal ▲ targets but never active or ▼ targets. Pure integer comparisons
 * over the turn list — safe to run per frame.
 */
export function computeTimelineSnapshot(
  turns: ReadonlyArray<TimelineTurn>,
  /** Projected viewport top in content coordinates (scrollTop). */
  viewTop: number,
  /** Maximum scrollTop the renderer can reach (contentHeight − viewport). */
  maxScroll: number,
): TimelineSnapshot {
  let activeIndex: number | null = null
  let upIndex: number | null = null
  let downIndex: number | null = null
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!
    if (t.folded === true) {
      // Above the fold ⇒ strictly above the viewport: a legal ▲ target.
      upIndex = i
      continue
    }
    if (t.top <= viewTop) activeIndex = i
    if (t.top < viewTop) upIndex = i
    if (downIndex === null && t.top > viewTop && t.top <= maxScroll) {
      downIndex = i
    }
  }
  if (turns.length > 0 && activeIndex === null) activeIndex = 0
  return {
    turns,
    activeId: activeIndex === null ? null : turns[activeIndex]!.id,
    upId: upIndex === null ? null : turns[upIndex]!.id,
    downId: downIndex === null ? null : turns[downIndex]!.id,
  }
}

/** Resolve a tick/header navigation request for one turn. Folded turns go
 *  through the reveal path (their top is unknown); measured turns jump by
 *  content coordinate. Callers must never pass `top: −1` to scrollTo. */
export function jumpTargetForTurn(turn: TimelineTurn): TimelineJump {
  if (turn.folded === true) return { kind: 'reveal', id: turn.id }
  return { kind: 'scroll', top: turn.top }
}

/**
 * First non-empty line, char-capped with a `…` marker. Bounded work: the
 * scan stops at the first non-empty line and slices at the cap, so a huge
 * one-line prompt costs O(cap), not O(line length). Char cap (not display
 * width) on purpose — this bounds the stored snapshot; the hover card
 * re-wraps to its own width (wrapPreviewLines).
 */
export function clipPreview(text: string, maxChars = PREVIEW_MAX_CHARS): string {
  let line = ''
  let rest = text
  while (rest.length > 0) {
    const nl = rest.indexOf('\n')
    const head = nl === -1 ? rest : rest.slice(0, nl)
    rest = nl === -1 ? '' : rest.slice(nl + 1)
    const trimmed = head.trim()
    if (trimmed.length > 0) {
      line = trimmed
      break
    }
  }
  if (line.length <= maxChars) return line
  // Keep the cap INCLUDING the ellipsis marker. Slice by CODE POINTS, not
  // UTF-16 units — a surrogate pair split mid-pair would emit a lone
  // surrogate to the terminal.
  return `${[...line].slice(0, maxChars - 1).join('')}…`
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * Wrap a preview to at most 2 lines by DISPLAY width (CJK-aware — a
 * terminal cell column budget, not a char count). The last line is
 * ellipsized when content remains. Grapheme-by-grapheme accumulation keeps
 * surrogate pairs, combining sequences, and emoji ZWJ clusters intact.
 */
export function wrapPreviewLines(preview: string, maxWidth: number): string[] {
  if (maxWidth < 1) return ['']
  const lines: string[] = []
  let current = ''
  let currentW = 0
  for (const { segment } of graphemeSegmenter.segment(preview)) {
    const w = visibleWidth(segment)
    if (w <= 0) {
      // Zero-width (combining marks, ZWJ): attach for free.
      current += segment
      continue
    }
    if (currentW + w > maxWidth) {
      if (lines.length === 1) {
        // Second line full → ellipsize in place and stop.
        return [lines[0]!, ellipsize(current, maxWidth)]
      }
      lines.push(current)
      current = segment
      currentW = w
      continue
    }
    current += segment
    currentW += w
  }
  if (current.length > 0 || lines.length === 0) lines.push(current)
  return lines.slice(0, 2)
}

function ellipsize(line: string, maxWidth: number): string {
  // Make room for '…' (1 col) then hard-cut by display width.
  let out = ''
  let w = 0
  for (const { segment } of graphemeSegmenter.segment(line)) {
    const cw = visibleWidth(segment)
    if (cw > 0 && w + cw > maxWidth - 1) break
    out += segment
    w += cw
  }
  return `${out}…`
}

/**
 * Back-to-bottom pill's unseen anchor (stable row-ID semantics, NOT a
 * "new rows since scroll" counter): while the viewport sits at the bottom
 * there is no anchor (null); the moment it leaves the bottom the anchor
 * pins the id of the last row the user had seen, and only rows with a
 * LARGER id are ever counted. Returning to the bottom clears it.
 */
export function nextUnseenAnchor(
  current: number | null,
  atBottom: boolean,
  /** Id of the newest row, null when the transcript is empty. */
  lastRowId: number | null,
): number | null {
  if (atBottom) return null
  if (current === null) return lastRowId
  return current
}

/**
 * Unseen count for the pill: rows past the anchor whose TOP edge is still
 * below the viewport bottom. The count DECREMENTS as the user scrolls down
 * through the new rows (a row stops being unseen once its top enters the
 * viewport) and reaches 0 once every new row has appeared on screen —
 * scrolling back up never re-increments it, because already-revealed rows
 * keep their ids below the comparison.
 */
export function countUnseenRows(
  /** Rendered rows in order: stable id + content-space top. */
  rows: ReadonlyArray<{ id: number; top: number }>,
  anchorRowId: number | null,
  /** Viewport bottom edge in the same content coordinate space as the
   *  row tops (scrollTop + viewportHeight). */
  viewportBottom: number,
): number {
  if (anchorRowId === null) return 0
  let count = 0
  for (const row of rows) {
    if (row.id > anchorRowId && row.top >= viewportBottom) count++
  }
  return count
}
