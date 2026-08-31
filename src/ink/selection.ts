/**
 * Text selection state for fullscreen mode.
 *
 * Tracks a linear selection in screen-buffer coordinates (0-indexed col/row).
 * Selection is line-based: cells from (startCol, startRow) through
 * (endCol, endRow) inclusive, wrapping across line boundaries. This matches
 * terminal-native selection behavior (not rectangular/block).
 *
 * The selection is stored as ANCHOR (where the drag started) + FOCUS (where
 * the cursor is now). The rendered highlight normalizes to start ≤ end.
 */

import { clamp } from './layout/geometry.js'
import type { Screen, StylePool } from './screen.js'
import { CellWidth, cellAt, cellAtIndex, setCellStyleId } from './screen.js'

type Point = { col: number; row: number }

/**
 * Selection state for fullscreen mode: the anchor/focus cell pair plus
 * the off-screen row accumulators captured during drag-to-scroll.
 */
export type SelectionState = {
  /** Where the mouse-down occurred. Null when no selection. */
  anchor: Point | null
  /** Current drag position (updated on mouse-move while dragging). */
  focus: Point | null
  /** True between mouse-down and mouse-up. */
  isDragging: boolean
  /** For word/line mode: the initial word/line bounds from the first
   *  multi-click. Drag extends from this span to the word/line at the
   *  current mouse position so the original word/line stays selected
   *  even when dragging backward past it. Null ⇔ char mode. The kind
   *  tells extendSelection whether to snap to word or line boundaries. */
  anchorSpan: { lo: Point; hi: Point; kind: 'word' | 'line' } | null
  /** Text from rows that scrolled out ABOVE the viewport during
   *  drag-to-scroll. The screen buffer only holds the current viewport,
   *  so without this accumulator, dragging down past the bottom edge
   *  loses the top of the selection once the anchor clamps. Prepended
   *  to the on-screen text by getSelectedText. Reset on start/clear. */
  scrolledOffAbove: string[]
  /** Symmetric: rows scrolled out BELOW when dragging up. Appended. */
  scrolledOffBelow: string[]
  /** Soft-wrap bits parallel to scrolledOffAbove — true means the row
   *  is a continuation of the one before it (the `\n` was inserted by
   *  word-wrap, not in the source). Captured alongside the text at
   *  scroll time since the screen's softWrap bitmap shifts with content.
   *  getSelectedText uses these to join wrapped rows back into logical
   *  lines. */
  scrolledOffAboveSW: boolean[]
  /** Parallel to scrolledOffBelow. */
  scrolledOffBelowSW: boolean[]
  /** Pre-clamp anchor row. Set when shiftSelection clamps anchor so a
   *  reverse scroll can restore the true position and pop accumulators.
   *  Without this, PgDn (clamps anchor) → PgUp leaves anchor at the wrong
   *  row AND scrolledOffAbove stale — highlight ≠ copy. Undefined when
   *  anchor is in-bounds (no clamp debt). Cleared on start/clear. */
  virtualAnchorRow?: number
  /** Same for focus. */
  virtualFocusRow?: number
  /** Viewport bounds recorded by the LAST in-drag follow shift. During an
   *  active drag a wheel that pushes both ends off the same edge CLAMPS
   *  instead of clearing (the gesture must survive); finishSelection then
   *  re-checks these bounds and drops the selection if it is still fully
   *  off-edge at commit time — the ghost-highlight guard is deferred, not
   *  removed. Undefined while no drag shift has run. */
  dragBounds?: { top: number; bottom: number }
  /** True if the mouse-down that started this selection had the alt
   *  modifier set (SGR button bit 0x08). On macOS xterm.js this is a
   *  signal that VS Code's macOptionClickForcesSelection is OFF — if it
   *  were on, xterm.js would have consumed the event for native selection
   *  and we'd never receive it. Used by the footer to show the right hint. */
  lastPressHadAlt: boolean
}

/**
 * Create a new selection state with no active selection.
 * @returns the empty selection state.
 */
export function createSelectionState(): SelectionState {
  return {
    anchor: null,
    focus: null,
    isDragging: false,
    anchorSpan: null,
    scrolledOffAbove: [],
    scrolledOffBelow: [],
    scrolledOffAboveSW: [],
    scrolledOffBelowSW: [],
    lastPressHadAlt: false,
  }
}

/**
 * Begin a new drag selection at (col, row): set the anchor, mark the
 * state as dragging, and clear every accumulator. Focus stays null until
 * the first drag motion, so a bare click never highlights a cell.
 * @param s - the selection state to mutate.
 * @param col - anchor column in screen-buffer coordinates.
 * @param row - anchor row in screen-buffer coordinates.
 */
export function startSelection(
  s: SelectionState,
  col: number,
  row: number,
): void {
  s.anchor = { col, row }
  // Focus is not set until the first drag motion. A click-release with no
  // drag leaves focus null → hasSelection/selectionBounds return false/null
  // via the `!s.focus` check, so a bare click never highlights a cell.
  s.focus = null
  s.isDragging = true
  s.anchorSpan = null
  s.scrolledOffAbove = []
  s.scrolledOffBelow = []
  s.scrolledOffAboveSW = []
  s.scrolledOffBelowSW = []
  s.virtualAnchorRow = undefined
  s.virtualFocusRow = undefined
  s.dragBounds = undefined
  s.lastPressHadAlt = false
}

/**
 * Track the drag position: update focus to (col, row). No-op while not
 * dragging, and the first motion at the anchor cell is ignored so a bare
 * click never becomes a one-cell selection.
 * @param s - the selection state to mutate.
 * @param col - current mouse column.
 * @param row - current mouse row.
 */
export function updateSelection(
  s: SelectionState,
  col: number,
  row: number,
): void {
  if (!s.isDragging) return
  // First motion at the same cell as anchor is a no-op. Terminals in mode
  // 1002 can fire a drag event at the anchor cell (sub-pixel tremor, or a
  // motion-release pair). Setting focus here would turn a bare click into
  // a 1-cell selection and clobber the clipboard via useCopyOnSelect. Once
  // focus is set (real drag), we track normally including back to anchor.
  if (!s.focus && s.anchor && s.anchor.col === col && s.anchor.row === row)
    return
  s.focus = { col, row }
  // Fresh mouse position supersedes any virtual focus a resize clamp left
  // behind (shiftSelection clamps focus when the chrome covered its row) —
  // the same reset moveFocus does. Without this, the next shift computes
  // rawFocus from a stale pre-motion row.
  s.virtualFocusRow = undefined
}

/**
 * End a drag: clear the dragging flag while keeping anchor/focus so the
 * highlight stays visible and the text can be copied. Call
 * clearSelection to drop the selection after copy or on Esc.
 *
 * Deferred ghost guard: a drag that scrolled both ends fully off the same
 * viewport edge (wheeled away while the button was held) is dropped HERE,
 * at commit time, instead of during the drag — the in-flight gesture must
 * survive the wheel, but a committed selection left entirely off-screen
 * would linger as an invisible ghost (see shiftSelectionForFollow).
 * @param s - the selection state to mutate.
 */
export function finishSelection(s: SelectionState): void {
  s.isDragging = false
  if (s.dragBounds !== undefined) {
    const { top, bottom } = s.dragBounds
    s.dragBounds = undefined
    if (selectionFullyOffEdge(s, top, bottom)) {
      clearSelection(s)
    }
  }
  // Otherwise keep anchor/focus so highlight stays visible and text can be
  // copied. Clear via clearSelection() on Esc or after copy.
}

/**
 * Reset the selection to the empty state: no anchor, focus, span, or
 * scrolled-off accumulators.
 * @param s - the selection state to mutate.
 */
export function clearSelection(s: SelectionState): void {
  s.anchor = null
  s.focus = null
  s.isDragging = false
  s.anchorSpan = null
  s.scrolledOffAbove = []
  s.scrolledOffBelow = []
  s.scrolledOffAboveSW = []
  s.scrolledOffBelowSW = []
  s.virtualAnchorRow = undefined
  s.virtualFocusRow = undefined
  s.dragBounds = undefined
  s.lastPressHadAlt = false
}

// Unicode-aware word character matcher: letters (any script), digits,
// and the punctuation set iTerm2 treats as word-part by default.
// Matching iTerm2's default means double-clicking a path like
// `/usr/bin/bash` or `~/.claude/config.json` selects the whole thing,
// which is the muscle memory most macOS terminal users have.
// iTerm2 default "characters considered part of a word": /-+\~_.
const WORD_CHAR = /[\p{L}\p{N}_/.\-+~\\]/u

/**
 * Character class for double-click word-expansion. Cells with the same
 * class as the clicked cell are included in the selection; a class change
 * is a boundary. Matches typical terminal-emulator behavior (iTerm2 etc.):
 * double-click on `foo` selects `foo`, on `->` selects `->`, on spaces
 * selects the whitespace run.
 */
function charClass(c: string): 0 | 1 | 2 {
  if (c === ' ' || c === '') return 0
  if (WORD_CHAR.test(c)) return 1
  return 2
}

/**
 * Find the bounds of the same-class character run at (col, row). Returns
 * null if the click is out of bounds or lands on a noSelect cell. Used by
 * selectWordAt (initial double-click) and extendWordSelection (drag).
 */
function wordBoundsAt(
  screen: Screen,
  col: number,
  row: number,
): { lo: number; hi: number } | null {
  if (row < 0 || row >= screen.height) return null
  const width = screen.width
  const noSelect = screen.noSelect
  const rowOff = row * width

  // If the click landed on the spacer tail of a wide char, step back to
  // the head so the class check sees the actual grapheme.
  let c = col
  if (c > 0) {
    const cell = cellAt(screen, c, row)
    if (cell && cell.width === CellWidth.SpacerTail) c -= 1
  }
  if (c < 0 || c >= width || noSelect[rowOff + c] === 1) return null

  const startCell = cellAt(screen, c, row)
  if (!startCell) return null
  const cls = charClass(startCell.char)

  // Expand left: include cells of the same class, stop at noSelect or
  // class change. SpacerTail cells are stepped over (the wide-char head
  // at the preceding column determines the class).
  let lo = c
  while (lo > 0) {
    const prev = lo - 1
    if (noSelect[rowOff + prev] === 1) break
    const pc = cellAt(screen, prev, row)
    if (!pc) break
    if (pc.width === CellWidth.SpacerTail) {
      // Step over the spacer to the wide-char head
      if (prev === 0 || noSelect[rowOff + prev - 1] === 1) break
      const head = cellAt(screen, prev - 1, row)
      if (!head || charClass(head.char) !== cls) break
      lo = prev - 1
      continue
    }
    if (charClass(pc.char) !== cls) break
    lo = prev
  }

  // Expand right: same logic, skipping spacer tails.
  let hi = c
  while (hi < width - 1) {
    const next = hi + 1
    if (noSelect[rowOff + next] === 1) break
    const nc = cellAt(screen, next, row)
    if (!nc) break
    if (nc.width === CellWidth.SpacerTail) {
      // Include the spacer tail in the selection range (it belongs to
      // the wide char at hi) and continue past it.
      hi = next
      continue
    }
    if (charClass(nc.char) !== cls) break
    hi = next
  }

  return { lo, hi }
}

/** -1 if a < b, 1 if a > b, 0 if equal (reading order: row then col). */
function comparePoints(a: Point, b: Point): number {
  if (a.row !== b.row) return a.row < b.row ? -1 : 1
  if (a.col !== b.col) return a.col < b.col ? -1 : 1
  return 0
}

/**
 * Select the word at (col, row) by scanning the screen buffer for the
 * bounds of the same-class character run. Mutates the selection in place.
 * No-op if the click is out of bounds or lands on a noSelect cell.
 * Sets isDragging=true and anchorSpan so a subsequent drag extends the
 * selection word-by-word (native macOS behavior).
 * @param s - the selection state to mutate.
 * @param screen - the screen buffer to scan for word bounds.
 * @param col - click column.
 * @param row - click row.
 */
export function selectWordAt(
  s: SelectionState,
  screen: Screen,
  col: number,
  row: number,
): void {
  const b = wordBoundsAt(screen, col, row)
  if (!b) return
  const lo = { col: b.lo, row }
  const hi = { col: b.hi, row }
  s.anchor = lo
  s.focus = hi
  s.isDragging = true
  s.anchorSpan = { lo, hi, kind: 'word' }
}

// Printable ASCII minus terminal URL delimiters. Restricting to single-
// codeunit ASCII keeps cell-count === string-index, so the column-span
// check below is exact (no wide-char/grapheme drift).
const URL_BOUNDARY = new Set([...'<>"\'` '])
function isUrlChar(c: string): boolean {
  if (c.length !== 1) return false
  const code = c.charCodeAt(0)
  return code >= 0x21 && code <= 0x7e && !URL_BOUNDARY.has(c)
}

/**
 * Scan the screen buffer for a plain-text URL at (col, row). Mirrors the
 * terminal's native Cmd+Click URL detection, which fullscreen mode's mouse
 * tracking intercepts. Called from getHyperlinkAt as a fallback when the
 * cell has no OSC 8 hyperlink.
 * @param screen - the screen buffer to scan.
 * @param col - click column.
 * @param row - click row.
 * @returns the URL at the click position, or undefined when the cell is
 *   not part of a plain-text URL.
 */
export function findPlainTextUrlAt(
  screen: Screen,
  col: number,
  row: number,
): string | undefined {
  if (row < 0 || row >= screen.height) return undefined
  const width = screen.width
  const noSelect = screen.noSelect
  const rowOff = row * width

  let c = col
  if (c > 0) {
    const cell = cellAt(screen, c, row)
    if (cell && cell.width === CellWidth.SpacerTail) c -= 1
  }
  if (c < 0 || c >= width || noSelect[rowOff + c] === 1) return undefined

  const startCell = cellAt(screen, c, row)
  if (!startCell || !isUrlChar(startCell.char)) return undefined

  // Expand left/right to the bounds of the URL-char run. URLs are ASCII
  // (CellWidth.Narrow, 1 codeunit), so hitting a non-ASCII/wide/spacer
  // cell is a boundary — no need to step over spacers like wordBoundsAt.
  let lo = c
  while (lo > 0) {
    const prev = lo - 1
    if (noSelect[rowOff + prev] === 1) break
    const pc = cellAt(screen, prev, row)
    if (!pc || pc.width !== CellWidth.Narrow || !isUrlChar(pc.char)) break
    lo = prev
  }
  let hi = c
  while (hi < width - 1) {
    const next = hi + 1
    if (noSelect[rowOff + next] === 1) break
    const nc = cellAt(screen, next, row)
    if (!nc || nc.width !== CellWidth.Narrow || !isUrlChar(nc.char)) break
    hi = next
  }

  let token = ''
  for (let i = lo; i <= hi; i++) token += cellAt(screen, i, row)!.char

  // 1 cell = 1 char across [lo, hi] (ASCII-only run), so string index =
  // column offset. Find the last scheme anchor at or before the click —
  // a run like `https://a.com,https://b.com` has two, and clicking the
  // second should return the second URL, not the greedy match of both.
  const clickIdx = c - lo
  const schemeRe = /(?:https?|file):\/\//g
  let urlStart = -1
  let urlEnd = token.length
  for (let m; (m = schemeRe.exec(token)); ) {
    if (m.index > clickIdx) {
      urlEnd = m.index
      break
    }
    urlStart = m.index
  }
  if (urlStart < 0) return undefined
  let url = token.slice(urlStart, urlEnd)

  // Strip trailing sentence punctuation. For closers () ] }, only strip
  // if unbalanced — `/wiki/Foo_(bar)` keeps `)`, `/arr[0]` keeps `]`.
  const OPENER: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
  while (url.length > 0) {
    const last = url.at(-1)!
    if ('.,;:!?'.includes(last)) {
      url = url.slice(0, -1)
      continue
    }
    const opener = OPENER[last]
    if (!opener) break
    let opens = 0
    let closes = 0
    for (let i = 0; i < url.length; i++) {
      const ch = url.charAt(i)
      if (ch === opener) opens++
      else if (ch === last) closes++
    }
    if (closes > opens) url = url.slice(0, -1)
    else break
  }

  // urlStart already guarantees click >= URL start; check right edge.
  if (clickIdx >= urlStart + url.length) return undefined

  return url
}

/**
 * Select the entire row. Sets isDragging=true and anchorSpan so a
 * subsequent drag extends the selection line-by-line. The anchor/focus
 * span from col 0 to width-1; getSelectedText handles noSelect skipping
 * and trailing-whitespace trimming so the copied text is just the visible
 * line content.
 * @param s - the selection state to mutate.
 * @param screen - the screen buffer providing the row width.
 * @param row - the row to select.
 */
export function selectLineAt(
  s: SelectionState,
  screen: Screen,
  row: number,
): void {
  if (row < 0 || row >= screen.height) return
  const lo = { col: 0, row }
  const hi = { col: screen.width - 1, row }
  s.anchor = lo
  s.focus = hi
  s.isDragging = true
  s.anchorSpan = { lo, hi, kind: 'line' }
}

/**
 * Extend a word/line-mode selection to the word/line at (col, row). The
 * anchor span (the original multi-clicked word/line) stays selected; the
 * selection grows from that span to the word/line at the current mouse
 * position. Word mode falls back to the raw cell when the mouse is over a
 * noSelect cell or out of bounds, so dragging into gutters still extends.
 * @param s - the selection state to mutate.
 * @param screen - the screen buffer to scan for word bounds.
 * @param col - current mouse column.
 * @param row - current mouse row.
 */
export function extendSelection(
  s: SelectionState,
  screen: Screen,
  col: number,
  row: number,
): void {
  if (!s.isDragging || !s.anchorSpan) return
  const span = s.anchorSpan
  s.virtualFocusRow = undefined
  let mLo: Point
  let mHi: Point
  if (span.kind === 'word') {
    const b = wordBoundsAt(screen, col, row)
    mLo = { col: b ? b.lo : col, row }
    mHi = { col: b ? b.hi : col, row }
  } else {
    const r = clamp(row, 0, screen.height - 1)
    mLo = { col: 0, row: r }
    mHi = { col: screen.width - 1, row: r }
  }
  if (comparePoints(mHi, span.lo) < 0) {
    // Mouse target ends before anchor span: extend backward.
    s.anchor = span.hi
    s.focus = mLo
  } else if (comparePoints(mLo, span.hi) > 0) {
    // Mouse target starts after anchor span: extend forward.
    s.anchor = span.lo
    s.focus = mHi
  } else {
    // Mouse overlaps the anchor span: just select the anchor span.
    s.anchor = span.lo
    s.focus = span.hi
  }
}

/** Semantic keyboard focus moves. See moveSelectionFocus in ink.tsx for
 *  how screen bounds + row-wrap are applied. */
export type FocusMove =
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'lineStart'
  | 'lineEnd'

/**
 * Set focus to (col, row) for keyboard selection extension (shift+arrow).
 * Anchor stays fixed; selection grows or shrinks depending on where focus
 * moves relative to anchor. Drops to char mode (clears anchorSpan) —
 * native macOS does this too: shift+arrow after a double-click word-select
 * extends char-by-char from the word edge, not word-by-word. Scrolled-off
 * accumulators are preserved: keyboard-extending a drag-scrolled selection
 * keeps the off-screen rows. Caller supplies coords already clamped/wrapped.
 * @param s - the selection state to mutate.
 * @param col - focus column.
 * @param row - focus row.
 */
export function moveFocus(s: SelectionState, col: number, row: number): void {
  if (!s.focus) return
  s.anchorSpan = null
  s.focus = { col, row }
  // Explicit user repositioning — any stale virtual focus (from a prior
  // shiftSelection clamp) no longer reflects intent. Anchor stays put so
  // virtualAnchorRow is still valid for its own round-trip.
  s.virtualFocusRow = undefined
}

/**
 * Shift anchor AND focus by dRow, clamped to [minRow, maxRow]. Used for
 * keyboard scroll (PgUp/PgDn/ctrl+u/d/b/f): the whole selection must track
 * the content, unlike drag-to-scroll where focus stays at the mouse. Any
 * point that hits a clamp bound gets its col reset to the full-width edge —
 * its original content scrolled off-screen and was captured by
 * captureScrolledRows, so the col constraint was already consumed. Keeping
 * it would truncate the NEW content now at that screen row. Clamp col is 0
 * for dRow<0 (scrolling down, top leaves, 'above' semantics) or width-1 for
 * dRow>0 (scrolling up, bottom leaves, 'below' semantics).
 *
 * If both ends overshoot the SAME viewport edge (select text → Home/End/g/G
 * jumps far enough that both are out of view), clear — otherwise both clamp
 * to the same corner cell and a ghost 1-cell highlight lingers, and
 * getSelectedText returns one unrelated char from that corner. Symmetric
 * with shiftSelectionForFollow's top-edge check, but bidirectional: keyboard
 * scroll can jump either way.
 * @param s - the selection state to mutate.
 * @param dRow - signed row offset to shift by.
 * @param minRow - lowest allowed row (viewport top).
 * @param maxRow - highest allowed row (viewport bottom).
 * @param width - screen width, used for the clamp-edge column.
 */
export function shiftSelection(
  s: SelectionState,
  dRow: number,
  minRow: number,
  maxRow: number,
  width: number,
): void {
  if (!s.anchor || !s.focus) return
  // Virtual rows track pre-clamp positions so reverse scrolls restore
  // correctly. Without this, clamp(5→0) + shift(+10) = 10, not the true 5,
  // and scrolledOffAbove stays stale (highlight ≠ copy).
  const vAnchor = (s.virtualAnchorRow ?? s.anchor.row) + dRow
  const vFocus = (s.virtualFocusRow ?? s.focus.row) + dRow
  if (
    (vAnchor < minRow && vFocus < minRow) ||
    (vAnchor > maxRow && vFocus > maxRow)
  ) {
    clearSelection(s)
    return
  }
  // Debt = how far the nearer endpoint overshoots each edge. When debt
  // shrinks (reverse scroll), those rows are back on-screen — pop from
  // the accumulator so getSelectedText doesn't double-count them.
  const oldMin = Math.min(
    s.virtualAnchorRow ?? s.anchor.row,
    s.virtualFocusRow ?? s.focus.row,
  )
  const oldMax = Math.max(
    s.virtualAnchorRow ?? s.anchor.row,
    s.virtualFocusRow ?? s.focus.row,
  )
  const oldAboveDebt = Math.max(0, minRow - oldMin)
  const oldBelowDebt = Math.max(0, oldMax - maxRow)
  const newAboveDebt = Math.max(0, minRow - Math.min(vAnchor, vFocus))
  const newBelowDebt = Math.max(0, Math.max(vAnchor, vFocus) - maxRow)
  if (newAboveDebt < oldAboveDebt) {
    // scrolledOffAbove pushes newest at the end (closest to on-screen).
    const drop = oldAboveDebt - newAboveDebt
    s.scrolledOffAbove.length -= drop
    s.scrolledOffAboveSW.length = s.scrolledOffAbove.length
  }
  if (newBelowDebt < oldBelowDebt) {
    // scrolledOffBelow unshifts newest at the front (closest to on-screen).
    const drop = oldBelowDebt - newBelowDebt
    s.scrolledOffBelow.splice(0, drop)
    s.scrolledOffBelowSW.splice(0, drop)
  }
  // Invariant: accumulator length ≤ debt. If the accumulator exceeds debt,
  // the excess is stale — e.g., moveFocus cleared virtualFocusRow without
  // trimming the accumulator, orphaning entries the pop above can never
  // reach because oldDebt was ALREADY 0. Truncate to debt (keeping the
  // newest = closest-to-on-screen entries). Check newDebt (not oldDebt):
  // captureScrolledRows runs BEFORE this shift in the real flow (ink.tsx),
  // so at entry the accumulator is populated but oldDebt is still 0 —
  // that's the normal establish-debt path, not stale.
  if (s.scrolledOffAbove.length > newAboveDebt) {
    // Above pushes newest at END → keep END.
    s.scrolledOffAbove =
      newAboveDebt > 0 ? s.scrolledOffAbove.slice(-newAboveDebt) : []
    s.scrolledOffAboveSW =
      newAboveDebt > 0 ? s.scrolledOffAboveSW.slice(-newAboveDebt) : []
  }
  if (s.scrolledOffBelow.length > newBelowDebt) {
    // Below unshifts newest at FRONT → keep FRONT.
    s.scrolledOffBelow = s.scrolledOffBelow.slice(0, newBelowDebt)
    s.scrolledOffBelowSW = s.scrolledOffBelowSW.slice(0, newBelowDebt)
  }
  // Clamp col depends on which EDGE (not dRow direction): virtual tracking
  // means a top-clamped point can stay top-clamped during a dRow>0 reverse
  // shift — dRow-based clampCol would give it the bottom col.
  const shift = (p: Point, vRow: number): Point => {
    if (vRow < minRow) return { col: 0, row: minRow }
    if (vRow > maxRow) return { col: width - 1, row: maxRow }
    return { col: p.col, row: vRow }
  }
  s.anchor = shift(s.anchor, vAnchor)
  s.focus = shift(s.focus, vFocus)
  s.virtualAnchorRow =
    vAnchor < minRow || vAnchor > maxRow ? vAnchor : undefined
  s.virtualFocusRow = vFocus < minRow || vFocus > maxRow ? vFocus : undefined
  // anchorSpan not virtual-tracked: it's for word/line extend-on-drag,
  // irrelevant to the keyboard-scroll round-trip case.
  if (s.anchorSpan) {
    const sp = (p: Point): Point => {
      const r = p.row + dRow
      if (r < minRow) return { col: 0, row: minRow }
      if (r > maxRow) return { col: width - 1, row: maxRow }
      return { col: p.col, row: r }
    }
    s.anchorSpan = {
      lo: sp(s.anchorSpan.lo),
      hi: sp(s.anchorSpan.hi),
      kind: s.anchorSpan.kind,
    }
  }
}

/**
 * Shift the anchor row by dRow, clamped to [minRow, maxRow]. Used during
 * drag-to-scroll: when the ScrollBox scrolls by N rows, the content that
 * was under the anchor is now at a different viewport row, so the anchor
 * must follow it. Focus is left unchanged (it stays at the mouse position).
 * @param s - the selection state to mutate.
 * @param dRow - signed row offset to shift by.
 * @param minRow - lowest allowed row (viewport top).
 * @param maxRow - highest allowed row (viewport bottom).
 */
export function shiftAnchor(
  s: SelectionState,
  dRow: number,
  minRow: number,
  maxRow: number,
): void {
  if (!s.anchor) return
  // Same virtual-row tracking as shiftSelection/shiftSelectionForFollow: the
  // drag→follow transition hands off to shiftSelectionForFollow, which reads
  // (virtualAnchorRow ?? anchor.row). Without this, drag-phase clamping
  // leaves virtual undefined → follow initializes from the already-clamped
  // row, under-counting total drift → shiftSelection's invariant-restore
  // prematurely clears valid drag-phase accumulator entries.
  const raw = (s.virtualAnchorRow ?? s.anchor.row) + dRow
  s.anchor = { col: s.anchor.col, row: clamp(raw, minRow, maxRow) }
  s.virtualAnchorRow = raw < minRow || raw > maxRow ? raw : undefined
  // anchorSpan not virtual-tracked (word/line extend, irrelevant to
  // keyboard-scroll round-trip) — plain clamp from current row.
  if (s.anchorSpan) {
    const shift = (p: Point): Point => ({
      col: p.col,
      row: clamp(p.row + dRow, minRow, maxRow),
    })
    s.anchorSpan = {
      lo: shift(s.anchorSpan.lo),
      hi: shift(s.anchorSpan.hi),
      kind: s.anchorSpan.kind,
    }
  }
}

/**
 * Whether both ends of the selection are strictly past the SAME edge of
 * [minRow, maxRow] — the fully-off-screen condition. Rows are read through
 * the virtual (pre-clamp) trackers so a clamped-then-reversed scroll
 * evaluates at the TRUE position. Shared by shiftSelectionForFollow's
 * immediate clear and finishSelection's deferred commit-time check.
 */
export function selectionFullyOffEdge(
  s: SelectionState,
  minRow: number,
  maxRow: number,
): boolean {
  const rawAnchor = s.virtualAnchorRow ?? s.anchor?.row
  const rawFocus = s.virtualFocusRow ?? s.focus?.row
  if (rawAnchor === undefined || rawFocus === undefined) return false
  return (
    (rawAnchor < minRow && rawFocus < minRow) ||
    (rawAnchor > maxRow && rawFocus > maxRow)
  )
}

/**
 * Shift the whole selection (anchor + focus + anchorSpan) by dRow, clamped
 * to [minRow, maxRow]. Used when sticky/auto-follow scrolls the ScrollBox
 * while a selection is active — native terminal behavior is for the
 * highlight to walk up the screen with the text (not stay at the same
 * screen position).
 *
 * Differs from shiftAnchor: during drag-to-scroll, focus tracks the live
 * mouse position and only anchor follows the text. During streaming-follow,
 * the selection is text-anchored at both ends — both must move. The
 * isDragging check in ink.tsx picks which shift to apply.
 *
 * If both ends would shift strictly BELOW minRow or strictly ABOVE maxRow
 * (unclamped), the selected text has scrolled entirely off the viewport —
 * off the top via streaming follow / wheel-down, off the bottom via
 * wheel-up. Clear it — otherwise a single inverted cell lingers at the
 * edge as a ghost (native terminals drop the selection when it leaves
 * scrollback). Landing AT the edge row is
 * still valid: that cell holds the correct text. Returns true if the
 * selection was cleared so the caller can notify React-land subscribers
 * (useHasSelection) — the caller is inside onRender so it can't use
 * notifySelectionChange (recursion), must fire listeners directly.
 *
 * `allowClear` is false for ACTIVE DRAGS: a wheel must never kill the
 * in-flight gesture, so both ends clamp to the edge instead; the clear is
 * deferred to finishSelection's commit-time check via the recorded
 * dragBounds. Released selections keep the immediate clear.
 * @param s - the selection state to mutate.
 * @param dRow - signed row offset to shift by.
 * @param minRow - lowest allowed row (viewport top).
 * @param maxRow - highest allowed row (viewport bottom).
 * @param allowClear - clear when both ends exit the same edge (default true).
 * @returns true when the selection was cleared because it scrolled
 *   entirely off the top, false otherwise.
 */
export function shiftSelectionForFollow(
  s: SelectionState,
  dRow: number,
  minRow: number,
  maxRow: number,
  allowClear = true,
): boolean {
  if (!s.anchor) return false
  // Mirror shiftSelection: compute raw (unclamped) positions from virtual
  // if set, else current. This handles BOTH the update path (virtual already
  // set from a prior keyboard scroll) AND the initialize path (first clamp
  // happens HERE via follow-scroll, no prior keyboard scroll). Without the
  // initialize path, follow-scroll-first leaves virtual undefined even
  // though the clamp below occurred → a later PgUp computes debt from the
  // clamped row instead of the true pre-clamp row and never pops the
  // accumulator — getSelectedText double-counts the off-screen rows.
  const rawAnchor = (s.virtualAnchorRow ?? s.anchor.row) + dRow
  const rawFocus = s.focus
    ? (s.virtualFocusRow ?? s.focus.row) + dRow
    : undefined
  // Both ends strictly past the same edge = selection fully scrolled off
  // (top: follow/wheel-down; bottom: wheel-up). Symmetric clear — a
  // clamped-to-edge pair would render as a 1-row ghost highlight. Skipped
  // during an active drag: the gesture survives (clamp below), and the
  // release-time check in finishSelection drops it if still off-edge.
  if (
    allowClear &&
    rawFocus !== undefined &&
    ((rawAnchor < minRow && rawFocus < minRow) ||
      (rawAnchor > maxRow && rawFocus > maxRow))
  ) {
    clearSelection(s)
    return true
  }
  // Clamp from raw, not p.row+dRow — so a virtual position coming back
  // in-bounds lands at the TRUE position, not the stale clamped one.
  s.anchor = { col: s.anchor.col, row: clamp(rawAnchor, minRow, maxRow) }
  if (s.focus && rawFocus !== undefined) {
    s.focus = { col: s.focus.col, row: clamp(rawFocus, minRow, maxRow) }
  }
  s.virtualAnchorRow =
    rawAnchor < minRow || rawAnchor > maxRow ? rawAnchor : undefined
  s.virtualFocusRow =
    rawFocus !== undefined && (rawFocus < minRow || rawFocus > maxRow)
      ? rawFocus
      : undefined
  // anchorSpan not virtual-tracked (word/line extend, irrelevant to
  // keyboard-scroll round-trip) — plain clamp from current row.
  if (s.anchorSpan) {
    const shift = (p: Point): Point => ({
      col: p.col,
      row: clamp(p.row + dRow, minRow, maxRow),
    })
    s.anchorSpan = {
      lo: shift(s.anchorSpan.lo),
      hi: shift(s.anchorSpan.hi),
      kind: s.anchorSpan.kind,
    }
  }
  return false
}

/**
 * Translate selection screen coordinates when a ScrollBox moves without
 * changing height. This is layout movement, not content scrolling: existing
 * off-screen row accumulators remain untouched and both viewport edges move
 * by the same amount. During a drag only the text anchor moves; after release
 * both endpoints move when both are owned by the old viewport.
 * @param s - the selection state to mutate.
 * @param rowDelta - signed screen-row movement from the old viewport to the new one.
 * @param oldTop - viewport top before the layout move.
 * @param oldBottom - viewport bottom before the layout move.
 * @param newTop - viewport top after the layout move.
 * @param newBottom - viewport bottom after the layout move.
 * @returns true when the selection was cleared because it left the viewport.
 */
export function shiftSelectionForViewportTranslation(
  s: SelectionState,
  rowDelta: number,
  oldTop: number,
  oldBottom: number,
  newTop: number,
  newBottom: number,
): boolean {
  if (!s.anchor) return false
  if (newTop > newBottom) {
    clearSelection(s)
    return true
  }
  if (oldTop > oldBottom) return false
  if (
    rowDelta === 0 ||
    newBottom - oldBottom !== rowDelta ||
    newTop - oldTop !== rowDelta
  ) return false
  const dRow = rowDelta

  if (!s.focus || s.isDragging) {
    // During a live drag focus is screen-local (the mouse), so only the text
    // anchor follows the moved viewport. A bare press has no focus yet and
    // follows the same anchor-only rule.
    shiftAnchor(s, dRow, newTop, newBottom)
    return false
  }
  // A released selection that crosses into static chrome belongs partly to
  // that chrome. Keep it fixed rather than teleporting the static endpoint.
  if (
    s.anchor.row < oldTop ||
    s.anchor.row > oldBottom ||
    s.focus.row < oldTop ||
    s.focus.row > oldBottom
  ) {
    return false
  }

  const rawAnchor = (s.virtualAnchorRow ?? s.anchor.row) + dRow
  const rawFocus = (s.virtualFocusRow ?? s.focus.row) + dRow
  if (
    (rawAnchor < newTop && rawFocus < newTop) ||
    (rawAnchor > newBottom && rawFocus > newBottom)
  ) {
    clearSelection(s)
    return true
  }
  s.anchor = { col: s.anchor.col, row: clamp(rawAnchor, newTop, newBottom) }
  s.focus = { col: s.focus.col, row: clamp(rawFocus, newTop, newBottom) }
  s.virtualAnchorRow =
    rawAnchor < newTop || rawAnchor > newBottom ? rawAnchor : undefined
  s.virtualFocusRow =
    rawFocus < newTop || rawFocus > newBottom ? rawFocus : undefined
  if (s.anchorSpan) {
    const shift = (p: Point): Point => ({
      col: p.col,
      row: clamp(p.row + dRow, newTop, newBottom),
    })
    s.anchorSpan = {
      lo: shift(s.anchorSpan.lo),
      hi: shift(s.anchorSpan.hi),
      kind: s.anchorSpan.kind,
    }
  }
  return false
}

/**
 * Translate the selection for a SCROLLBOX VIEWPORT RESIZE: chrome mounting
 * or unmounting around a ScrollBox (the new-messages pill, the sticky
 * prompt header, the working spinner, prompt multi-line growth) moves the
 * viewport edges WITHOUT any scroll delta — no followScroll event fires, so
 * the follow path never runs and the endpoints keep pointing at stale screen
 * rows. The visible failure: the anchor strands BELOW the shrunken viewport
 * (exactly onto the pill text row when the pill mounts), pickFollowForSelection
 * then rejects every subsequent follow event (anchor outside the viewport),
 * wheel tracking silently dies, and copy-on-select spans whatever the
 * highlight happens to cover — including the chrome row itself ("↓ 回到底部"
 * leaking into bottom-to-top copies, and the rows that scrolled under the
 * dead highlight never reaching the scrolledOff accumulators).
 *
 * Each SHRINKING edge contributes a band of rows the chrome covered:
 *   - top band [oldTop, newTop-1] (chrome above — sticky prompt header)
 *   - bottom band [newBottom+1, oldBottom] (chrome below — pill/spinner)
 * captureScrolledRows preserves the band's text from the PREVIOUS frame's
 * screen (the caller passes frontFrame.screen — the swap hasn't happened)
 * before this frame's paint overwrites it with chrome cells. Growth edges
 * have no band to capture; the shift below just re-widens the clamp.
 *
 * shiftSelection(dRow=0) then re-derives the endpoints: clamps stragglers
 * into the new bounds (virtual-row tracked, so a later re-widening restores
 * the true position and pops the accumulator), pops captured rows whose
 * debt a re-widening returned to the viewport, and clears when BOTH ends
 * land under the same band (the whole selection is under chrome). Unlike
 * the follow path's shiftAnchor/shiftSelectionForFollow split, this uses
 * shiftSelection for BOTH drag and released states: with dRow=0 a live drag
 * focus stays at the mouse unless the chrome covered it too, and
 * shiftSelection is the only shift that pops debt on re-widening — the
 * follow path never re-widens, a resize does (pill unmount).
 *
 * Degenerate bounds are handled explicitly: a collapsed new viewport
 * (innerHeight 0 — chrome taller than the box) clears the selection, an
 * invalid old range is a no-op, and neither ever reaches clamp/shiftSelection
 * with min > max.
 * @param s - the selection state to mutate.
 * @param screen - the PREVIOUS frame's screen buffer providing the band
 *   text (and the width for clamp-edge columns).
 * @param oldTop - viewport top before this frame's layout.
 * @param oldBottom - viewport bottom before this frame's layout.
 * @param newTop - viewport top after this frame's layout.
 * @param newBottom - viewport bottom after this frame's layout.
 */
export function shiftSelectionForViewportResize(
  s: SelectionState,
  screen: Screen,
  oldTop: number,
  oldBottom: number,
  newTop: number,
  newBottom: number,
): void {
  if (!s.anchor) return
  // Degenerate ranges. A ScrollBox can fully collapse — chrome taller than
  // the box drives innerHeight to 0, making viewportBottom = top-1 — and
  // clamp/shiftSelection would then run with min > max and leave the
  // endpoints pointing at arbitrary rows. A collapsed NEW viewport holds no
  // selectable row at all: every selected row is under chrome, which is
  // exactly shiftSelection's both-ends-off-viewport case → clear. An
  // invalid OLD range means the selection could never have been tracked in
  // it → nothing to translate, leave the state untouched.
  if (newTop > newBottom) {
    clearSelection(s)
    return
  }
  if (oldTop > oldBottom) return
  // Re-widening edges (chrome unmounted): rows the chrome previously
  // covered return to the viewport. shiftSelection measures debt against
  // the NEW bounds only — correct for keyboard scroll, whose bounds stay
  // fixed across the shift, but a resize CHANGES the bounds, so the
  // returned rows are popped HERE by pure geometry: the g rows closest to
  // the viewport re-enter, i.e. the FRONT of scrolledOffBelow (newest
  // unshifted there) and the END of scrolledOffAbove (newest pushed there).
  if (newBottom > oldBottom && s.scrolledOffBelow.length > 0) {
    const drop = Math.min(newBottom - oldBottom, s.scrolledOffBelow.length)
    s.scrolledOffBelow.splice(0, drop)
    s.scrolledOffBelowSW.splice(0, drop)
  }
  if (newTop < oldTop && s.scrolledOffAbove.length > 0) {
    const drop = Math.min(oldTop - newTop, s.scrolledOffAbove.length)
    const keep = s.scrolledOffAbove.length - drop
    s.scrolledOffAbove.length = keep
    s.scrolledOffAboveSW.length = keep
  }
  if (newTop > oldTop) captureScrolledRows(s, screen, oldTop, newTop - 1, 'above')
  if (newBottom < oldBottom)
    captureScrolledRows(s, screen, newBottom + 1, oldBottom, 'below')
  if (!s.focus) {
    // Bare press (no drag motion yet, focus still null): shiftSelection
    // needs both ends — clamp the anchor alone so a chrome mount can't
    // strand it before the first motion sets focus.
    const raw = s.virtualAnchorRow ?? s.anchor.row
    s.anchor = { col: s.anchor.col, row: clamp(raw, newTop, newBottom) }
    s.virtualAnchorRow = raw < newTop || raw > newBottom ? raw : undefined
    return
  }
  shiftSelection(s, 0, newTop, newBottom, screen.width)
}

/** A scroll event reported by a ScrollBox this frame (follow or wheel
 *  drain): signed delta plus the box's viewport bounds. Structurally
 *  identical to FollowScroll in render-node-to-output. */
export type ScrollEvent = {
  delta: number
  viewportTop: number
  viewportBottom: number
  /** Current viewport rows map to PREVIOUS screen rows by this offset. */
  screenRowOffset?: number
}

/**
 * Pick which scroll event a selection belongs to when several ScrollBoxes
 * scrolled in the same frame (e.g., the transcript still draining a wheel
 * burst while an overlay panel's box scrolls). The selection follows the
 * INNERMOST viewport containing the anchor: overlay panels render on top
 * of the transcript, so a selection inside the overlap rows belongs to
 * the panel, not the covered transcript beneath it. A selection outside
 * every viewport (footer/prompt, static text) follows nothing — scrolling
 * doesn't move the content under it.
 * @param events - this frame's scroll events (signed deltas).
 * @param anchorRow - the selection anchor's screen row, or null when no
 *   selection is active.
 * @returns the event the selection should be translated by, or null.
 */
export function pickFollowForSelection<T extends ScrollEvent>(
  events: T[],
  anchorRow: number | null,
): T | null {
  if (anchorRow === null) return null
  let best: T | null = null
  let bestHeight = Infinity
  for (const e of events) {
    if (anchorRow < e.viewportTop || anchorRow > e.viewportBottom) continue
    const height = e.viewportBottom - e.viewportTop
    if (best === null || height < bestHeight) {
      best = e
      bestHeight = height
    }
  }
  return best
}

/**
 * True when a selection is active, meaning both anchor and focus are set.
 * @param s - the selection state to inspect.
 * @returns true when a selection is active.
 */
export function hasSelection(s: SelectionState): boolean {
  return s.anchor !== null && s.focus !== null
}

/**
 * Normalized selection bounds: start is always before end in reading order.
 * Returns null if no active selection.
 * @param s - the selection state to inspect.
 * @returns the normalized start/end cells, or null when there is no
 *   active selection.
 */
export function selectionBounds(s: SelectionState): {
  start: { col: number; row: number }
  end: { col: number; row: number }
} | null {
  if (!s.anchor || !s.focus) return null
  return comparePoints(s.anchor, s.focus) <= 0
    ? { start: s.anchor, end: s.focus }
    : { start: s.focus, end: s.anchor }
}

/**
 * Check if a cell at (col, row) is within the current selection range.
 * Used by the renderer to apply inverse style.
 * @param s - the selection state to inspect.
 * @param col - cell column.
 * @param row - cell row.
 * @returns true when the cell lies inside the selection range.
 */
export function isCellSelected(
  s: SelectionState,
  col: number,
  row: number,
): boolean {
  const b = selectionBounds(s)
  if (!b) return false
  const { start, end } = b
  if (row < start.row || row > end.row) return false
  if (row === start.row && col < start.col) return false
  if (row === end.row && col > end.col) return false
  return true
}

/** Extract text from one screen row. When the next row is a soft-wrap
 *  continuation (screen.softWrap[row+1]>0), clamp to that content-end
 *  column and skip the trailing trim so the word-separator space survives
 *  the join. See Screen.softWrap for why the clamp is necessary. */
function extractRowText(
  screen: Screen,
  row: number,
  colStart: number,
  colEnd: number,
): string {
  const noSelect = screen.noSelect
  const rowOff = row * screen.width
  const contentEnd = row + 1 < screen.height ? screen.softWrap[row + 1]! : 0
  const lastCol = contentEnd > 0 ? Math.min(colEnd, contentEnd - 1) : colEnd
  let line = ''
  for (let col = colStart; col <= lastCol; col++) {
    // Skip cells marked noSelect (gutters, line numbers, diff sigils).
    // Check before cellAt to avoid the decode cost for excluded cells.
    if (noSelect[rowOff + col] === 1) continue
    const cell = cellAt(screen, col, row)
    if (!cell) continue
    // Skip spacer tails (second half of wide chars) — the head already
    // contains the full grapheme. SpacerHead is a blank at line-end.
    if (
      cell.width === CellWidth.SpacerTail ||
      cell.width === CellWidth.SpacerHead
    ) {
      continue
    }
    line += cell.char
  }
  return contentEnd > 0 ? line : line.replace(/\s+$/, '')
}

/** Accumulator for selected text that merges soft-wrapped rows back
 *  into logical lines. push(text, sw) appends a newline before text
 *  only when sw=false (i.e. the row starts a new logical line). Rows
 *  with sw=true are concatenated onto the previous row. */
function joinRows(
  lines: string[],
  text: string,
  sw: boolean | undefined,
): void {
  if (sw && lines.length > 0) {
    lines[lines.length - 1] += text
  } else {
    lines.push(text)
  }
}

/**
 * Extract text from the screen buffer within the selection range.
 * Rows are joined with newlines unless the screen's softWrap bitmap
 * marks a row as a word-wrap continuation — those rows are concatenated
 * onto the previous row so the copied text matches the logical source
 * line, not the visual wrapped layout. Trailing whitespace on the last
 * fragment of each logical line is trimmed. Wide-char spacer cells are
 * skipped. Rows that scrolled out of the viewport during drag-to-scroll
 * are joined back in from the scrolledOffAbove/Below accumulators along
 * with their captured softWrap bits.
 * @param s - the selection state to read.
 * @param screen - the screen buffer to extract from.
 * @returns the selected text, or an empty string when no selection is
 *   active.
 */
export function getSelectedText(s: SelectionState, screen: Screen): string {
  const b = selectionBounds(s)
  if (!b) return ''
  const { start, end } = b
  const sw = screen.softWrap
  const lines: string[] = []

  for (let i = 0; i < s.scrolledOffAbove.length; i++) {
    joinRows(lines, s.scrolledOffAbove[i]!, s.scrolledOffAboveSW[i])
  }

  for (let row = start.row; row <= end.row; row++) {
    const rowStart = row === start.row ? start.col : 0
    const rowEnd = row === end.row ? end.col : screen.width - 1
    joinRows(lines, extractRowText(screen, row, rowStart, rowEnd), sw[row]! > 0)
  }

  for (let i = 0; i < s.scrolledOffBelow.length; i++) {
    joinRows(lines, s.scrolledOffBelow[i]!, s.scrolledOffBelowSW[i])
  }

  return lines.join('\n')
}

/**
 * Capture text from rows about to scroll out of the viewport during
 * drag-to-scroll, BEFORE scrollBy overwrites them. Only the rows that
 * intersect the selection are captured, using the selection's col bounds
 * for the anchor-side boundary row. After capturing the anchor row, the
 * anchor.col AND anchorSpan cols are reset to the full-width boundary so
 * subsequent captures and the final getSelectedText don't re-apply a stale
 * col constraint to content that's no longer under the original anchor.
 * Both span cols are reset (not just the near side): after a blocked
 * reversal the drag can flip direction, and extendSelection then reads the
 * OPPOSITE span side — which would otherwise still hold the original word
 * boundary and truncate one subsequently-captured row.
 *
 * side='above': rows scrolling out the top (dragging down, anchor=start).
 * side='below': rows scrolling out the bottom (dragging up, anchor=end).
 * @param s - the selection state to update.
 * @param screen - the screen buffer to read rows from.
 * @param firstRow - first viewport row that is about to scroll out.
 * @param lastRow - last viewport row that is about to scroll out.
 * @param side - which viewport edge the rows scroll out of.
 */
export function captureScrolledRows(
  s: SelectionState,
  screen: Screen,
  firstRow: number,
  lastRow: number,
  side: 'above' | 'below',
  screenRowOffset = 0,
): void {
  const b = selectionBounds(s)
  if (!b || firstRow > lastRow) return
  const { start, end } = b
  // Intersect [firstRow, lastRow] with [start.row, end.row]. Rows outside
  // the selection aren't captured — they weren't selected.
  const lo = Math.max(firstRow, start.row)
  const hi = Math.min(lastRow, end.row)
  if (lo > hi) return

  const width = screen.width
  const sw = screen.softWrap
  const captured: string[] = []
  const capturedSW: boolean[] = []
  for (let row = lo; row <= hi; row++) {
    const colStart = row === start.row ? start.col : 0
    const colEnd = row === end.row ? end.col : width - 1
    const screenRow = row - screenRowOffset
    captured.push(extractRowText(screen, screenRow, colStart, colEnd))
    capturedSW.push(sw[screenRow]! > 0)
  }

  if (side === 'above') {
    // Newest rows go at the bottom of the above-accumulator (closest to
    // the on-screen content in reading order).
    s.scrolledOffAbove.push(...captured)
    s.scrolledOffAboveSW.push(...capturedSW)
    // We just captured the top of the selection. The anchor (=start when
    // dragging down) is now pointing at content that will scroll out; its
    // col constraint was applied to the captured row. Reset to col 0 so
    // the NEXT tick and the final getSelectedText read the full row.
    if (s.anchor && s.anchor.row === start.row && lo === start.row) {
      s.anchor = { col: 0, row: s.anchor.row }
      if (s.anchorSpan) {
        s.anchorSpan = {
          kind: s.anchorSpan.kind,
          lo: { col: 0, row: s.anchorSpan.lo.row },
          hi: { col: width - 1, row: s.anchorSpan.hi.row },
        }
      }
    }
  } else {
    // Newest rows go at the TOP of the below-accumulator — they're
    // closest to the on-screen content.
    s.scrolledOffBelow.unshift(...captured)
    s.scrolledOffBelowSW.unshift(...capturedSW)
    if (s.anchor && s.anchor.row === end.row && hi === end.row) {
      s.anchor = { col: width - 1, row: s.anchor.row }
      if (s.anchorSpan) {
        s.anchorSpan = {
          kind: s.anchorSpan.kind,
          lo: { col: 0, row: s.anchorSpan.lo.row },
          hi: { col: width - 1, row: s.anchorSpan.hi.row },
        }
      }
    }
  }
}

/**
 * Apply the selection overlay directly to the screen buffer by changing
 * the style of every cell in the selection range. Called after the
 * renderer produces the Frame but before the diff — the normal diffEach
 * then picks up the restyled cells as ordinary changes, so LogUpdate
 * stays a pure diff engine with no selection awareness.
 *
 * Uses a SOLID selection background (theme-provided via StylePool.
 * setSelectionBg) that REPLACES each cell's bg while PRESERVING its fg —
 * matches native terminal selection. Previously SGR-7 inverse (swapped
 * fg/bg per cell), which fragmented badly over syntax-highlighted text:
 * every distinct fg color became a different bg stripe.
 *
 * Uses StylePool caches so on drag the only work per cell is a Map
 * lookup + packed-int write.
 * @param screen - the screen buffer to restyle.
 * @param selection - the selection whose range to highlight.
 * @param stylePool - the style pool providing the selection background.
 */
export function applySelectionOverlay(
  screen: Screen,
  selection: SelectionState,
  stylePool: StylePool,
): void {
  const b = selectionBounds(selection)
  if (!b) return
  const { start, end } = b
  const width = screen.width
  const noSelect = screen.noSelect
  for (let row = start.row; row <= end.row && row < screen.height; row++) {
    const colStart = row === start.row ? start.col : 0
    const colEnd = row === end.row ? Math.min(end.col, width - 1) : width - 1
    const rowOff = row * width
    for (let col = colStart; col <= colEnd; col++) {
      const idx = rowOff + col
      // Skip noSelect cells — gutters stay visually unchanged so it's
      // clear they're not part of the copy. Surrounding selectable cells
      // still highlight so the selection extent remains visible.
      if (noSelect[idx] === 1) continue
      const cell = cellAtIndex(screen, idx)
      setCellStyleId(screen, col, row, stylePool.withSelectionBg(cell.styleId))
    }
  }
}
