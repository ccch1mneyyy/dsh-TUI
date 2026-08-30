/**
 * verify-wheel-selection — regression test for issue #438.
 *
 * 选中文字后滚轮滚动，选区必须跟随内容平移而不是钉在屏幕行上；
 * 滚出视口的行经 captureScrolledRows 进入累加器，复制结果仍完整。
 *
 * Exercises the pure selection primitives the wheel-drain translate path
 * drives (render-node-to-output.ts records a SIGNED followScroll delta for
 * pendingScrollDelta drains; ink.tsx consumes it):
 *   - captureScrolledRows + shiftSelectionForFollow with delta > 0
 *     (content up: wheel-down / streaming follow) and delta < 0
 *     (content down: wheel-up — capture window mirrors to the bottom edge)
 *   - virtual-row accumulation across multi-frame drains
 *   - symmetric auto-clear when BOTH ends fully exit the viewport
 *   - partial straddle must NOT clear
 *
 * The direction math below mirrors the ink.tsx consumeFollowScroll block
 * (firstRow/lastRow/side/shift). If that block changes, update here.
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
  captureScrolledRows,
  getSelectedText,
  hasSelection,
  pickFollowForSelection,
  shiftSelectionForFollow,
  type SelectionState,
} from '../src/ink/selection.js'

const W = 20
const H = 12
const VIEWPORT_TOP = 2
const VIEWPORT_BOTTOM = 11

let failures = 0

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

function rowText(row: number): string {
  return `row-${String(row).padStart(2, '0')} content`
}

function buildScreen(): Screen {
  const styles = new StylePool()
  const screen = createScreen(W, H, styles, new CharPool(), new HyperlinkPool())
  for (let row = 0; row < H; row++) {
    const text = rowText(row).padEnd(W, ' ')
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

function makeSelection(
  anchor: { col: number; row: number },
  focus: { col: number; row: number },
): SelectionState {
  // Post-drag released state: anchor+focus set, isDragging false.
  return {
    anchor: { ...anchor },
    focus: { ...focus },
    isDragging: false,
    anchorSpan: null,
    scrolledOffAbove: [],
    scrolledOffBelow: [],
    scrolledOffAboveSW: [],
    scrolledOffBelowSW: [],
    lastPressHadAlt: false,
  }
}

/** One frame of the ink.tsx consumeFollowScroll translation. */
function applyScroll(
  sel: SelectionState,
  screen: Screen,
  delta: number,
): boolean {
  const rows = Math.abs(delta)
  const up = delta > 0
  const firstRow = up ? VIEWPORT_TOP : VIEWPORT_BOTTOM - rows + 1
  const lastRow = up ? VIEWPORT_TOP + rows - 1 : VIEWPORT_BOTTOM
  const side: 'above' | 'below' = up ? 'above' : 'below'
  const shift = up ? -rows : rows
  if (hasSelection(sel)) {
    captureScrolledRows(sel, screen, firstRow, lastRow, side)
  }
  return shiftSelectionForFollow(sel, shift, VIEWPORT_TOP, VIEWPORT_BOTTOM)
}

// ── Test 1: wheel-down (delta > 0) — capture top rows, shift up ──
{
  const screen = buildScreen()
  const sel = makeSelection({ col: 1, row: 4 }, { col: 6, row: 8 })
  const cleared = applyScroll(sel, screen, +3)
  check('T1 not cleared', cleared, false)
  check('T1 anchor clamped to viewport top, col reset by capture', sel.anchor, {
    col: 0,
    row: 2,
  })
  check('T1 virtual anchor row tracks pre-clamp position', sel.virtualAnchorRow, 1)
  check('T1 focus shifted up', sel.focus, { col: 6, row: 5 })
  check('T1 scrolledOffAbove captured anchor row (col-constrained)', sel.scrolledOffAbove, [
    'ow-04 content',
  ])
  check(
    'T1 copy includes captured row + on-screen rows',
    getSelectedText(sel, screen),
    [
      'ow-04 content',
      'row-02 content',
      'row-03 content',
      'row-04 content',
      'row-05',
    ].join('\n'),
  )
}

// ── Test 2: wheel-up (delta < 0) — capture bottom rows, shift down,
//    round-trip restores the pre-scroll positions ──
{
  const screen = buildScreen()
  const sel = makeSelection({ col: 1, row: 4 }, { col: 6, row: 8 })
  applyScroll(sel, screen, +3)
  const cleared = applyScroll(sel, screen, -3)
  check('T2 not cleared', cleared, false)
  check('T2 anchor restored (virtual debt popped)', sel.anchor, { col: 0, row: 4 })
  check('T2 virtual anchor cleared', sel.virtualAnchorRow, undefined)
  check('T2 focus restored', sel.focus, { col: 6, row: 8 })
  check('T2 below accumulator empty (selection never reached bottom edge)', sel.scrolledOffBelow, [])
}

// ── Test 3: multi-frame drain (2 frames of +2) accumulates like one +4 ──
{
  const screen = buildScreen()
  const sel = makeSelection({ col: 1, row: 4 }, { col: 6, row: 8 })
  applyScroll(sel, screen, +2)
  const cleared = applyScroll(sel, screen, +2)
  check('T3 not cleared', cleared, false)
  check('T3 anchor', sel.anchor, { col: 0, row: 2 })
  check('T3 virtual anchor', sel.virtualAnchorRow, 0)
  check('T3 focus', sel.focus, { col: 6, row: 4 })
  check('T3 captured rows 2-3 across drain frames', sel.scrolledOffAbove, [
    'ow-02 content',
    'row-03 content',
  ])
}

// ── Test 4: wheel-up scrolls selection fully off the bottom → clear ──
{
  const screen = buildScreen()
  const sel = makeSelection({ col: 0, row: 9 }, { col: 3, row: 11 })
  const cleared = applyScroll(sel, screen, -4)
  check('T4 cleared when both ends exit bottom', cleared, true)
  check('T4 anchor nulled', sel.anchor, null)
  check('T4 no selection after clear', hasSelection(sel), false)
}

// ── Test 5: wheel-down scrolls selection fully off the top → clear
//    (pre-existing follow behavior — regression guard) ──
{
  const screen = buildScreen()
  const sel = makeSelection({ col: 1, row: 2 }, { col: 3, row: 4 })
  const cleared = applyScroll(sel, screen, +4)
  check('T5 cleared when both ends exit top', cleared, true)
  check('T5 anchor nulled', sel.anchor, null)
}

// ── Test 6: partial straddle (one end clamps, other stays) → NO clear ──
{
  const screen = buildScreen()
  const sel = makeSelection({ col: 1, row: 3 }, { col: 2, row: 6 })
  const cleared = applyScroll(sel, screen, +4)
  check('T6 not cleared on partial exit', cleared, false)
  check('T6 anchor clamped with virtual debt', [sel.anchor, sel.virtualAnchorRow], [
    { col: 0, row: 2 },
    -1,
  ])
  check('T6 focus still in viewport', sel.focus, { col: 2, row: 2 })
  check('T6 copy still has full text via accumulator', getSelectedText(sel, screen), [
    'ow-03 content',
    'row-04 content',
    'row-05 content',
    'row',
  ].join('\n'))
}

// ── Test 7: multi-box attribution — innermost viewport containing the
//    anchor wins; a selection outside every viewport follows nothing ──
{
  const transcript = { delta: 3, viewportTop: 0, viewportBottom: 29 }
  const panel = { delta: -2, viewportTop: 10, viewportBottom: 18 }
  check(
    'T7 anchor in overlap rows picks the panel (innermost viewport)',
    pickFollowForSelection([transcript, panel], 12),
    panel,
  )
  check(
    'T7 anchor above the panel picks the transcript',
    pickFollowForSelection([transcript, panel], 5),
    transcript,
  )
  check(
    'T7 order-independent: same pick with events swapped',
    pickFollowForSelection([panel, transcript], 12),
    panel,
  )
  check(
    'T7 anchor outside every viewport follows nothing',
    pickFollowForSelection([transcript, panel], 31),
    null,
  )
  check('T7 no events -> null', pickFollowForSelection([], 5), null)
  check('T7 null anchor -> null', pickFollowForSelection([transcript], null), null)
}

if (failures > 0) {
  console.error(`\nverify-wheel-selection: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\nverify-wheel-selection: all checks passed')
