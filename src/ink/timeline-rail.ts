/**
 * Timeline rail — the pure geometry model behind the fullscreen
 * transcript's turn navigator (a port of Grok Build's timeline sidebar
 * semantics onto the dsh Ink tree).
 *
 * The rail is a 2-column gutter REPLACING the classic scrollbar: one tick
 * per user turn, where tick position encodes CONVERSATION ORDER, not
 * scroll proportion. Geometry is computed into a single frozen structure
 * consumed by both the renderer and mouse hit-testing, so what you see is
 * always what you can click ("看得到但点不中" impossible by construction).
 *
 * Viewport semantics (all derived from the same turn-top list, mirroring
 * grok-pager's ScrollbackState):
 *
 *  - active: the LAST turn whose prompt top is at-or-above the viewport
 *    top (the turn whose content owns the top row — "the turn being
 *    read"). When pre-turn content (logo / loaded-context panel) owns the
 *    top, the FIRST turn stands in. Never the newest-turn clamp: its
 *    one-step-off-bottom highlight leap is exactly what this rule avoids.
 *  - up target: the last turn STRICTLY above the viewport top. From
 *    mid-turn it first aligns the current turn's own prompt, and it can
 *    never name a trailing turn no scroll could bring to the top
 *    (the stuck-▲ bug).
 *  - down target: the FIRST turn whose prompt top is strictly below the
 *    viewport top AND reachable (top ≤ maxScroll — the renderer clamps
 *    scrollTop to maxScroll, so a turn below it could never own the top
 *    row; naming it would make ▼ repeat itself forever).
 *
 * Not ported (deliberately): ratatui Buffer drawing and Rust state
 * organization — algorithms only, per the reference report.
 */

import { stringWidth } from './stringWidth.js'

/** Columns the rail reserves (widest tick glyph). */
export const RAIL_WIDTH = 2

/** Terminals narrower than this hide the rail (transcript needs the cols). */
export const RAIL_MIN_TERMINAL_WIDTH = 60

/** Fewer turns than this and the rail is noise. */
export const RAIL_MIN_TURNS = 2

/** Stored preview cap (chars). Render paths re-truncate to card width. */
export const PREVIEW_MAX_CHARS = 120

/** One user turn, as the rail sees it. Identity is the row id — never an
 *  array index (deletion / rewind / loadOlder would mis-target it). */
export interface TimelineTurn {
  /** ChatRow id of the user message (jump/preview target). */
  id: number
  /** Content-space top of the prompt TEXT (scrollTo(target) pins it to
   *  the viewport top). */
  top: number
  /** First non-empty prompt line, char-capped (see clipPreview). */
  preview: string
  /**
   * True while the row sits BEFORE the fold window (older than the most
   * recent MAX_RENDERED_ROWS rows): its top is unknown (unmounted since
   * before the fold; `top` carries −1) and clicking the tick must first
   * reveal the folded history (Chat: showAll + force-mount + seek) rather
   * than scrollTo(−1). Rendering a tick for it is still correct — the
   * turn EXISTS and is navigable, it is just folded away right now
   * (drawing only window turns read as "the rail covers just 2-3 nodes"
   * on tool-heavy sessions where 300 rows ≈ a handful of turns).
   */
  folded?: boolean
}

/** The per-commit snapshot MessageList reports and the rail + sticky
 *  header consume — one source so the two can never disagree. */
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

/** Single eligibility policy: setting, terminal width, turn count, and
 *  geometric feasibility in one place. */
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
    opts.viewportRows >= 3
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
  // Vertically center the ▲ + ticks + ▼ stack, like the web rail.
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
  // Keep the cap INCLUDING the ellipsis marker, like grok's preview. Slice
  // by CODE POINTS, not UTF-16 units — a surrogate pair split mid-pair
  // would emit a lone surrogate to the terminal.
  return `${[...line].slice(0, maxChars - 1).join('')}…`
}

/**
 * Wrap a preview to at most 2 lines by DISPLAY width (CJK-aware — a
 * terminal cell column budget, not a char count). The last line is
 * ellipsized when content remains. Char-by-char accumulation keeps
 * surrogate pairs and (best-effort) combining sequences intact by never
 * splitting below a low surrogate.
 */
export function wrapPreviewLines(preview: string, maxWidth: number): string[] {
  const widthOf = stringWidth
  const lines: string[] = []
  let current = ''
  let currentW = 0
  for (const ch of preview) {
    const w = widthOf(ch)
    if (w <= 0) {
      // Zero-width (combining marks, ZWJ): attach for free.
      current += ch
      continue
    }
    if (currentW + w > maxWidth) {
      if (lines.length === 1) {
        // Second line full → ellipsize in place and stop.
        return [lines[0]!, ellipsize(current, maxWidth)]
      }
      lines.push(current)
      current = ch
      currentW = w
      continue
    }
    current += ch
    currentW += w
  }
  if (current.length > 0 || lines.length === 0) lines.push(current)
  if (lines.length > 2) {
    // Cannot happen (we stop after the second), kept for exhaustiveness.
    return [lines[0]!, ellipsize(lines[1]!, maxWidth)]
  }
  return lines.slice(0, 2)
}

function ellipsize(line: string, maxWidth: number): string {
  // Make room for '…' (1 col) then hard-cut by display width.
  let out = ''
  let w = 0
  for (const ch of line) {
    const cw = stringWidth(ch)
    if (cw > 0 && w + cw > maxWidth - 1) break
    out += ch
    w += cw
  }
  return `${out}…`
}
