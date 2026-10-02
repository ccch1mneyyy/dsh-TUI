/**
 * Side-panel geometry regression (Phase 1, pure functions): locks the
 * split contract in src/components/sidePanel/dimensions.ts at the boundary
 * widths — canSplit at 92/93, resolveSplit clamp floors, ratio extremes,
 * zoom geometry with the CHAT_MIN floor, resolveSidePanelGeometry's
 * open/zoom switching, and nudgeRatio's ±4-column steps clamping at both
 * ends. Pure node:assert table, no terminal involved.
 * Run: node --import tsx/esm scripts/verify-side-panel-geometry.mjs
 */
import assert from 'node:assert/strict'
import {
  CHAT_MIN_COLUMNS,
  PANEL_MIN_COLUMNS,
  DIVIDER_COLUMNS,
  DEFAULT_RATIO,
  ZOOM_TARGET_RATIO,
  RESIZE_STEP_COLUMNS,
  canSplit,
  ratioRange,
  clampRatio,
  resolveSplit,
  resolveZoom,
  resolveSidePanelGeometry,
  nudgeRatio,
} from '../src/components/sidePanel/dimensions.ts'

let total = 0
function pass(name) {
  console.log('PASS: ' + name)
  total += 1
}

// --- Constants -----------------------------------------------------------
assert.equal(CHAT_MIN_COLUMNS, 64)
assert.equal(PANEL_MIN_COLUMNS, 28)
assert.equal(DIVIDER_COLUMNS, 1)
assert.equal(DEFAULT_RATIO, 0.68)
assert.equal(ZOOM_TARGET_RATIO, 0.20)
assert.equal(RESIZE_STEP_COLUMNS, 4)
pass('constants (64 / 28 / 1 / 0.68 / 0.20 / 4)')

// --- canSplit boundary ---------------------------------------------------
assert.equal(canSplit(92), false, '92 must not split')
pass('canSplit(92) === false')
assert.equal(canSplit(93), true, '93 is the minimum split width')
pass('canSplit(93) === true')
for (const cols of [94, 100, 120, 200, 500]) assert.equal(canSplit(cols), true)
pass('canSplit larger widths all true')

// --- resolveSplit anchor values -----------------------------------------
{
  const { chat, panel } = resolveSplit(120, 0.68)
  assert.equal(chat, 81)
  assert.equal(panel, 38)
  assert.equal(chat + panel + DIVIDER_COLUMNS, 120)
  pass('resolveSplit(120, 0.68) -> chat=81 panel=38')
}
{
  const { chat, panel } = resolveSplit(93, 0.68)
  assert.equal(chat, 64, 'clamp floor: chat never below CHAT_MIN')
  assert.equal(panel, 28, 'clamp floor: panel never below PANEL_MIN')
  assert.equal(chat + panel + DIVIDER_COLUMNS, 93)
  pass('resolveSplit(93, 0.68) -> chat=64 panel=28 (clamp lower bound)')
}

// --- ratio extremes clamp into the legal range at both widths -----------
for (const cols of [120, 93]) {
  for (const ratio of [0.01, 0.99, -1, 2]) {
    const { chat, panel } = resolveSplit(cols, ratio)
    assert.ok(chat >= CHAT_MIN_COLUMNS, 'chat >= 64')
    assert.ok(panel >= PANEL_MIN_COLUMNS, 'panel >= 28')
    assert.equal(chat + panel + DIVIDER_COLUMNS, cols)
    assert.ok(chat === Math.floor(cols * clampRatio(cols, ratio)) || chat === cols - PANEL_MIN_COLUMNS - DIVIDER_COLUMNS || chat === CHAT_MIN_COLUMNS)
  }
  const range = ratioRange(cols)
  assert.ok(range.min <= range.max)
  assert.ok(clampRatio(cols, 0.01) >= range.min - 1e-9)
  assert.ok(clampRatio(cols, 0.99) <= range.max + 1e-9)
}
pass('ratio extremes (0.01/0.99/-1/2) clamp at 120 and 93; chat+panel+1=columns')

// --- zoom geometry -------------------------------------------------------
{
  const { chat, panel } = resolveZoom(120)
  assert.equal(chat, 64, 'zoom asks 0.20 but CHAT_MIN keeps 64')
  assert.equal(panel, 55)
  assert.equal(chat + panel + DIVIDER_COLUMNS, 120)
  pass('resolveZoom(120) -> chat=64 (CHAT_MIN floor) panel=55')
}
{
  const { chat, panel } = resolveZoom(93)
  assert.equal(chat, 64)
  assert.equal(panel, 28)
  pass('resolveZoom(93) -> minimum split 64/28')
}

// --- resolveSidePanelGeometry switching ---------------------------------
assert.equal(resolveSidePanelGeometry({ columns: 120, open: false, zoom: false, ratio: 0.68 }), null)
pass('resolveSidePanelGeometry open=false -> null')
assert.equal(resolveSidePanelGeometry({ columns: 92, open: true, zoom: false, ratio: 0.68 }), null)
pass('resolveSidePanelGeometry columns=92 open=true -> null (!canSplit)')
assert.deepEqual(
  resolveSidePanelGeometry({ columns: 120, open: true, zoom: false, ratio: 0.68 }),
  { chat: 81, panel: 38 },
)
pass('resolveSidePanelGeometry open split -> {81,38}')
assert.deepEqual(
  resolveSidePanelGeometry({ columns: 120, open: true, zoom: true, ratio: 0.68 }),
  resolveZoom(120),
)
pass('resolveSidePanelGeometry zoom=true -> resolveZoom')
assert.deepEqual(
  resolveSidePanelGeometry({ columns: 100, open: true, zoom: true, ratio: 0.99 }),
  resolveZoom(100),
)
pass('zoom wins over stored ratio')
assert.equal(resolveSidePanelGeometry({ columns: 93, open: true, zoom: false, ratio: 0.5 }).panel, 28)
pass('minimum width 93 resolves to the 64/28 split')

// --- nudgeRatio: ±4 columns of chat per step, clamped at both ends -------
{
  const wider = resolveSplit(120, nudgeRatio(120, DEFAULT_RATIO, +RESIZE_STEP_COLUMNS)).chat
  const narrower = resolveSplit(120, nudgeRatio(120, DEFAULT_RATIO, -RESIZE_STEP_COLUMNS)).chat
  assert.equal(wider, 81 + 4, '+4 columns step widens chat by 4')
  assert.equal(narrower, 81 - 4, '-4 columns step narrows chat by 4')
  pass('nudgeRatio(120, 0.68, ±4) moves chat ∓4 columns (85 / 77)')
}
{
  // Walk to the lower bound: repeated -4 steps must stop at chat=64.
  let ratio = DEFAULT_RATIO
  let chat = resolveSplit(120, ratio).chat
  let steps = 0
  while (steps < 50) {
    const nextRatio = nudgeRatio(120, ratio, -RESIZE_STEP_COLUMNS)
    const nextChat = resolveSplit(120, nextRatio).chat
    if (nextChat === chat) break
    assert.ok(nextChat >= chat - RESIZE_STEP_COLUMNS)
    assert.ok(nextChat >= CHAT_MIN_COLUMNS)
    ratio = nextRatio
    chat = nextChat
    steps += 1
  }
  assert.equal(chat, CHAT_MIN_COLUMNS, 'lower clamp reached at chat=64')
  assert.equal(nudgeRatio(120, ratio, -RESIZE_STEP_COLUMNS), ratio, 'no further change at the clamp')
  pass('nudgeRatio clamps at chat=64 and stops changing')
}
{
  // Upper bound: chat tops out at columns - PANEL_MIN - DIVIDER.
  let ratio = DEFAULT_RATIO
  let chat = resolveSplit(120, ratio).chat
  for (let i = 0; i < 50 && chat < 120 - PANEL_MIN_COLUMNS - DIVIDER_COLUMNS; i += 1) {
    ratio = nudgeRatio(120, ratio, +RESIZE_STEP_COLUMNS)
    chat = resolveSplit(120, ratio).chat
  }
  assert.equal(chat, 120 - PANEL_MIN_COLUMNS - DIVIDER_COLUMNS, 'upper clamp reached at chat=91')
  assert.equal(nudgeRatio(120, ratio, +RESIZE_STEP_COLUMNS), ratio, 'no further change at the clamp')
  pass('nudgeRatio clamps at chat=91 (panel=28) and stops changing')
}
{
  // Monotonic + no drift: 8 alternating ±4 steps return to the start ratio.
  let ratio = DEFAULT_RATIO
  for (let i = 0; i < 4; i += 1) {
    ratio = nudgeRatio(120, ratio, +RESIZE_STEP_COLUMNS)
    ratio = nudgeRatio(120, ratio, -RESIZE_STEP_COLUMNS)
  }
  assert.ok(Math.abs(ratio - DEFAULT_RATIO) < 1e-9)
  pass('nudgeRatio alternating steps return to the start ratio')
}

console.log('OK: side-panel geometry ' + total + ' checks passed.')
process.exit(0)
