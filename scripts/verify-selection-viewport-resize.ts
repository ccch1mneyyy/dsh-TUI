/**
 * verify-selection-viewport-resize — regression for fullscreen-selection
 * vs ScrollBox VIEWPORT RESIZE (chrome mount/unmount with no scroll delta).
 *
 * Bug being pinned: during a bottom-to-top drag with wheel-up, the first
 * wheel-up flips stickyScroll off → the "↓ 回到底部" pill (2 rows) + sticky
 * prompt header (1 row) mount and SHRINK the ScrollBox viewport with no
 * followScroll event. The anchor (pressed at the old viewport-bottom row)
 * strands exactly ON the pill text row; pickFollowForSelection then rejects
 * every follow event (anchor outside the viewport), wheel tracking dies,
 * and copy-on-select captures the chrome row itself while the rows that
 * scrolled under the dead highlight never reach the scrolledOff
 * accumulators.
 *
 * Exercises the REAL primitives the ink.tsx consume block drives
 * (shiftSelectionForViewportResize + captureScrolledRows + shiftSelection +
 * pickFollowForSelection). Only the unchanged follow-drain block is
 * mirrored here (same convention as verify-wheel-selection.ts) — if the
 * ink.tsx consume block changes its direction math, update the mirror.
 *
 * Screen labeling: PRE frame rows are `O{row}` (the frontFrame the band is
 * captured from), POST frame rows are `N{row}` (what the viewport shows
 * after the mount + drain). Chrome rows (pill/prompt) carry their text so
 * leaking into the copy is detectable.
 *
 * Run: node --import tsx/esm scripts/verify-selection-viewport-resize.ts
 */
import {
  CellWidth,
  CharPool,
  HyperlinkPool,
  StylePool,
  createScreen,
  setCellAt,
  type Screen,
} from '../src/ink/screen.js'
import {
  classifyViewportChange,
} from '../src/ink/render-node-to-output.js'
import {
  captureScrolledRows,
  createSelectionState,
  getSelectedText,
  hasSelection,
  pickFollowForSelection,
  shiftAnchor,
  shiftSelectionForViewportResize,
  shiftSelectionForViewportTranslation,
  updateSelection,
  type ScrollEvent,
  type SelectionState,
} from '../src/ink/selection.js'

const W = 24
const H = 14
const PILL_TEXT = '   ↓ 回到底部（Enter/End） '

let failures = 0

/** JSON-compare assertion that counts failures and prints both sides on mismatch. */
function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    failures++
    console.error(`FAIL ${name}`)
    console.error(`      expected: ${e}`)
    console.error(`      actual:   ${a}`)
  } else {
    console.log(`ok   ${name}`)
  }
}

/** One synthetic transcript line tagged `O{row}` (pre frame) / `N{row}` (post frame). */
function rowText(tag: string): string {
  return `${tag} transcript`
}

/**
 * Build a W×H screen buffer with the given text per row (unlisted rows
 * blank), cells all narrow/empty-style — enough fidelity for extractRowText.
 */
function buildScreen(rows: Record<number, string>): Screen {
  const styles = new StylePool()
  const screen = createScreen(W, H, styles, new CharPool(), new HyperlinkPool())
  for (let row = 0; row < H; row++) {
    const text = (rows[row] ?? '').padEnd(W, ' ').slice(0, W)
    for (let col = 0; col < W; col++) {
      setCellAt(screen, col, row, {
        char: text[col]!,
        styleId: screen.emptyStyleId,
        width: CellWidth.Narrow,
        hyperlink: undefined,
      })
    }
  }
  return screen
}

/** A selection state with the given endpoints; null focus models a bare press. */
function makeSelection(
  anchor: { col: number; row: number },
  focus: { col: number; row: number } | null,
  isDragging: boolean,
): SelectionState {
  const sel = createSelectionState()
  sel.anchor = { ...anchor }
  sel.focus = focus ? { ...focus } : null
  sel.isDragging = isDragging
  return sel
}

/**
 * One frame of the ink.tsx follow-drain block (UNCHANGED code — mirrored):
 * capture the viewport-edge band about to scroll out, then shift the
 * drag-phase anchor by the same delta.
 */
function applyFollowDrain(
  sel: SelectionState,
  screen: Screen,
  delta: number,
  viewportTop: number,
  viewportBottom: number,
  screenRowOffset = 0,
): void {
  if (delta === 0) return
  const rows = Math.abs(delta)
  const up = delta > 0
  const firstRow = up ? viewportTop : viewportBottom - rows + 1
  const lastRow = up ? viewportTop + rows - 1 : viewportBottom
  const side: 'above' | 'below' = up ? 'above' : 'below'
  const shift = up ? -rows : rows
  if (hasSelection(sel)) {
    captureScrolledRows(sel, screen, firstRow, lastRow, side, screenRowOffset)
  }
  shiftAnchor(sel, shift, viewportTop, viewportBottom)
}

// ── Case 1: the reported bug — pill mounts UNDER the anchor during a
//    bottom-to-top drag, same frame also drains the first wheel tick ──
{
  // PRE frame (frontFrame at the mount frame): transcript fills rows 0..11,
  // prompt chrome below. The pill is NOT rendered yet — chrome mounts into
  // the NEXT paint.
  const pre = buildScreen(
    Object.fromEntries(
      Array.from({ length: 12 }, (_, r) => [r, rowText(`O${String(r).padStart(2, '0')}`)]),
    ),
  )
  // POST frame: sticky header took row 0, transcript now rows 1..9 (drained
  // down 2), pill pad row 10, pill text row 11, prompt chrome 12..13.
  const post = buildScreen({
    ...Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [i + 1, rowText(`N${String(i + 1).padStart(2, '0')}`)]),
    ),
    10: '',
    11: PILL_TEXT,
    12: '❯ prompt input',
    13: 'status line',
  })

  const sel = makeSelection({ col: W - 1, row: 11 }, { col: 0, row: 6 }, true)

  // Pre-fix demo (for the PR narrative): the old flow only knew follow
  // events — the anchor at row 11 is outside the shrunken viewport, so the
  // pick returns null and NOTHING translates. Log, don't assert.
  {
    const broken = makeSelection({ col: W - 1, row: 11 }, { col: 0, row: 6 }, true)
    const follow = pickFollowForSelection(
      [{ delta: -2, viewportTop: 1, viewportBottom: 9 }],
      broken.anchor!.row,
    )
    if (follow === null) {
      const leaked = getSelectedText(broken, post)
      console.log('—— pre-fix copy (documented failure, not asserted) ——')
      console.log(leaked.split('\n').map(l => `  |${l}|`).join('\n'))
      if (!leaked.includes('回到底部')) {
        console.error('FAIL pre-fix demo: expected the pill text leak to reproduce')
        failures++
      }
    } else {
      console.error('FAIL pre-fix demo: anchor unexpectedly in viewport')
      failures++
    }
  }

  // Fixed flow — the resize lands BEFORE the follow pick (ink.tsx order):
  shiftSelectionForViewportResize(sel, pre, 0, 11, 1, 9)
  check('C1 anchor clamped back into the shrunken viewport', sel.anchor, {
    col: W - 1,
    row: 9,
  })
  check('C1 virtual anchor tracks the pre-clamp row', sel.virtualAnchorRow, 11)
  check('C1 bottom band (pill rows) captured from the PRE frame', sel.scrolledOffBelow, [
    rowText('O10'),
    rowText('O11'),
  ])

  // Same frame's wheel drain — anchor is in-viewport again, follow resumes:
  applyFollowDrain(sel, pre, -2, 1, 9)
  check('C1 drain captured the bottom edge band', sel.scrolledOffBelow, [
    rowText('O08'),
    rowText('O09'),
    rowText('O10'),
    rowText('O11'),
  ])
  check('C1 drain shift debt accumulated on the virtual row', sel.virtualAnchorRow, 13)
  check('C1 focus stayed at the mouse', sel.focus, { col: 0, row: 6 })

  const copied = getSelectedText(sel, post)
  check(
    'C1 copy = on-screen span + captured bands, in reading order, NO chrome text',
    copied,
    [
      rowText('N06'),
      rowText('N07'),
      rowText('N08'),
      rowText('N09'),
      rowText('O08'),
      rowText('O09'),
      rowText('O10'),
      rowText('O11'),
    ].join('\n'),
  )
  check('C1 copy does not contain the pill text', copied.includes('回到底部'), false)
}

// ── Case 2: pill unmount re-widens the viewport — debt must pop so the
//    re-revealed rows are read on-screen instead of double-counted ──
{
  // State carried over from case 1's end: anchor clamped at 9 with
  // virtualAnchorRow 13 (debt 4), below-acc holding 4 captured rows.
  const sel = makeSelection({ col: W - 1, row: 9 }, { col: 0, row: 6 }, true)
  sel.virtualAnchorRow = 13
  sel.scrolledOffBelow = [
    rowText('O08'),
    rowText('O09'),
    rowText('O10'),
    rowText('O11'),
  ]
  sel.scrolledOffBelowSW = [false, false, false, false]

  // Pill + header unmount: viewport re-widens [1..9] → [0..11], no scroll.
  const post = buildScreen({
    ...Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [i, rowText(`N${String(i).padStart(2, '0')}`)]),
    ),
    10: rowText('O08'),
    11: rowText('O09'),
  })
  shiftSelectionForViewportResize(sel, post, 1, 9, 0, 11)
  check('C2 re-widening popped the returned rows from the accumulator', sel.scrolledOffBelow, [
    rowText('O10'),
    rowText('O11'),
  ])
  check('C2 anchor tracked to the re-widened bottom edge', sel.anchor, {
    col: W - 1,
    row: 11,
  })
  check('C2 remaining debt kept on the virtual row', sel.virtualAnchorRow, 13)
  check(
    'C2 copy stays complete and duplicate-free after the round trip',
    getSelectedText(sel, post),
    [
      rowText('N06'),
      rowText('N07'),
      rowText('N08'),
      rowText('N09'),
      rowText('O08'),
      rowText('O09'),
      rowText('O10'),
      rowText('O11'),
    ].join('\n'),
  )
}

// ── Case 3: sticky prompt header mounts over a top-clamped selection —
//    symmetric top band capture ──
{
  const pre = buildScreen({ 0: rowText('O00') })
  const sel = makeSelection({ col: 0, row: 0 }, { col: 5, row: 4 }, true)
  sel.virtualAnchorRow = -2
  sel.scrolledOffAbove = [rowText('O-2'), rowText('O-1')]
  sel.scrolledOffAboveSW = [false, false]

  shiftSelectionForViewportResize(sel, pre, 0, 11, 1, 11)
  check('C3 top band captured above the debt', sel.scrolledOffAbove, [
    rowText('O-2'),
    rowText('O-1'),
    rowText('O00'),
  ])
  check('C3 anchor clamped to the new top edge', sel.anchor, { col: 0, row: 1 })
  check('C3 virtual anchor still carries the full debt', sel.virtualAnchorRow, -2)
}

// ── Case 4: released selection fully covered by the bottom band → clear
//    (the whole selection is under chrome; nothing copyable remains) ──
{
  const pre = buildScreen({ 10: rowText('O10'), 11: rowText('O11') })
  const sel = makeSelection({ col: 3, row: 10 }, { col: 6, row: 11 }, false)
  shiftSelectionForViewportResize(sel, pre, 0, 11, 0, 9)
  check('C4 selection cleared when both ends are under the band', hasSelection(sel), false)
  check('C4 accumulators discarded with the selection', sel.scrolledOffBelow, [])
}

// ── Case 5: bare press (no drag motion yet, focus null) + pill mounts —
//    the anchor must not strand before the first motion sets focus ──
{
  const pre = buildScreen({})
  const sel = makeSelection({ col: 4, row: 11 }, null, true)
  shiftSelectionForViewportResize(sel, pre, 0, 11, 1, 9)
  check('C5 anchor clamped with focus still null', sel.anchor, { col: 4, row: 9 })
  check('C5 virtual anchor tracks the pre-clamp row', sel.virtualAnchorRow, 11)
  check('C5 focus untouched', sel.focus, null)
}

// ── Case 6: attribution — the REAL picker matches the resize by the
//    PREVIOUS bounds; a footer-anchored selection follows nothing ──
{
  const resize: ScrollEvent = { delta: 0, viewportTop: 0, viewportBottom: 11 }
  check('C6 transcript anchor picks the resize', pickFollowForSelection([resize], 5), resize)
  check('C6 footer anchor follows nothing', pickFollowForSelection([resize], 12), null)
}

// ── Case 7: drag motion after a resize clamp must drop the stale virtual
//    focus (updateSelection mirrors moveFocus's reset) ──
{
  const sel = makeSelection({ col: 4, row: 9 }, { col: 2, row: 9 }, true)
  sel.virtualFocusRow = 11
  updateSelection(sel, 3, 5)
  check('C7 focus moved to the mouse', sel.focus, { col: 3, row: 5 })
  check('C7 stale virtual focus dropped', sel.virtualFocusRow, undefined)
}

// ── Case 8: ScrollBox fully collapsed (chrome taller than the box —
//    innerHeight 0 makes viewportBottom = top-1). clamp/shiftSelection
//    with min > max would corrupt the state; the guard must CLEAR instead ──
{
  const pre = buildScreen({ 5: rowText('O05'), 6: rowText('O06') })
  const sel = makeSelection({ col: 3, row: 5 }, { col: 6, row: 6 }, false)
  sel.scrolledOffBelow = [rowText('O07')]
  sel.scrolledOffBelowSW = [false]
  // new viewport [12..11]: height 0, top > bottom.
  shiftSelectionForViewportResize(sel, pre, 0, 11, 12, 11)
  check('C8 selection cleared on collapsed new viewport', hasSelection(sel), false)
  check('C8 accumulators discarded with the selection', sel.scrolledOffBelow, [])
  check('C8 endpoints nulled', sel.anchor, null)
}

// ── Case 9: invalid OLD range (selection could never have been tracked in
//    it) — the translate must be a safe no-op, leaving state untouched ──
{
  const pre = buildScreen({})
  const sel = makeSelection({ col: 3, row: 5 }, { col: 6, row: 6 }, false)
  sel.virtualAnchorRow = 7
  // old viewport [12..11] is degenerate; new viewport is healthy.
  shiftSelectionForViewportResize(sel, pre, 12, 11, 0, 9)
  check('C9 no-op keeps the endpoints', sel.anchor, { col: 3, row: 5 })
  check('C9 no-op keeps the focus', sel.focus, { col: 6, row: 6 })
  check('C9 no-op keeps virtual debt', sel.virtualAnchorRow, 7)
  check('C9 no-op keeps the selection active', hasSelection(sel), true)
}

// ── Case 10: equal edge movement is a viewport translation, not a resize ──
{
  check('C10 classify positive equal translation', classifyViewportChange(0, 9, 1, 10), 'translate')
  check('C10 classify negative equal translation', classifyViewportChange(1, 10, 0, 9), 'translate')
  check('C10 classify bottom-only shrink as edge resize', classifyViewportChange(0, 9, 0, 8), 'edge-resize')
  check('C10 classify mixed edge movement as edge resize', classifyViewportChange(0, 9, 1, 9), 'edge-resize')
  check('C10 classify collapsed new range as edge resize', classifyViewportChange(0, 9, 10, 9), 'edge-resize')
}

// ── Case 11: released selection follows a positive viewport translation ──
{
  const sel = makeSelection({ col: 2, row: 3 }, { col: 8, row: 6 }, false)
  sel.scrolledOffAbove = [rowText('A-1')]
  sel.scrolledOffAboveSW = [false]
  sel.scrolledOffBelow = [rowText('B10')]
  sel.scrolledOffBelowSW = [false]
  const beforeAbove = [...sel.scrolledOffAbove]
  const beforeBelow = [...sel.scrolledOffBelow]
  const cleared = shiftSelectionForViewportTranslation(sel, 2, 0, 9, 2, 11)
  check('C11 released anchor follows translation', sel.anchor, { col: 2, row: 5 })
  check('C11 released focus follows translation', sel.focus, { col: 8, row: 8 })
  check('C11 translation preserves above accumulator', sel.scrolledOffAbove, beforeAbove)
  check('C11 translation preserves below accumulator', sel.scrolledOffBelow, beforeBelow)
  check('C11 translation does not clear active selection', cleared, false)
}

// ── Case 12: dragging translation moves only the text anchor ──
{
  const sel = makeSelection({ col: 4, row: 8 }, { col: 1, row: 5 }, true)
  const cleared = shiftSelectionForViewportTranslation(sel, -1, 2, 11, 1, 10)
  check('C12 dragging anchor follows negative translation', sel.anchor, { col: 4, row: 7 })
  check('C12 dragging focus stays at mouse row', sel.focus, { col: 1, row: 5 })
  check('C12 dragging translation does not clear', cleared, false)
}

// ── Case 13: bare press translation keeps focus null and clamps anchor ──
{
  const sel = makeSelection({ col: 3, row: 2 }, null, true)
  const cleared = shiftSelectionForViewportTranslation(sel, 2, 0, 9, 2, 11)
  check('C13 bare anchor follows translation', sel.anchor, { col: 3, row: 4 })
  check('C13 bare focus remains null', sel.focus, null)
  check('C13 bare translation does not clear', cleared, false)
}

// ── Case 14: a released selection touching static chrome is not teleported ──
{
  const sel = makeSelection({ col: 2, row: 4 }, { col: 7, row: 12 }, false)
  const cleared = shiftSelectionForViewportTranslation(sel, 1, 0, 9, 1, 10)
  check('C14 straddling selection keeps anchor', sel.anchor, { col: 2, row: 4 })
  check('C14 straddling selection keeps static focus', sel.focus, { col: 7, row: 12 })
  check('C14 straddling selection does not clear', cleared, false)
}

// ── Case 15: translation is applied before same-frame wheel drain ──
{
  const screen = buildScreen(
    Object.fromEntries(
      Array.from({ length: 12 }, (_, row) => [row, rowText(`O${String(row).padStart(2, '0')}`)]),
    ),
  )
  // The anchor reaches new row 10 after the +1 viewport translation, so the
  // same-frame wheel capture must read the corresponding PRE rows 8..9.
  const sel = makeSelection({ col: W - 1, row: 9 }, { col: 0, row: 5 }, true)
  const translated = shiftSelectionForViewportTranslation(sel, 1, 0, 9, 1, 10)
  check('C15 translation succeeds before wheel drain', translated, false)
  check('C15 translated anchor is inside the new viewport', sel.anchor, { col: W - 1, row: 10 })
  applyFollowDrain(sel, screen, -2, 1, 10, 1)
  check('C15 wheel drain continues from the translated anchor', sel.virtualAnchorRow, 12)
  check('C15 wheel drain maps capture rows to the PRE frame', sel.scrolledOffBelow, [
    rowText('O08'),
    rowText('O09'),
  ])
  check('C15 wheel drain does not capture the adjacent PRE row', sel.scrolledOffBelow.includes(rowText('O10')), false)
  check('C15 focus remains at the mouse after both changes', sel.focus, { col: 0, row: 5 })
}

if (failures > 0) {
  console.error(`\nverify-selection-viewport-resize: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\nverify-selection-viewport-resize: all checks passed')
