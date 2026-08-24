/**
 * Timeline model tests (docs/pi-tui-ui-rewrite-research.md §3.2/§3.3/§3.5).
 *
 * Guards the renderer-neutral port of the source main's timeline semantics
 * (`src/ink/timeline-rail.ts` + MessageList's snapshot scan + Chat's unseen
 * anchor): eligibility gates, tick window geometry, hit-testing, preview
 * clip/wrap (display-width, grapheme-safe), active/up/down ownership with
 * folded turns, jump-target resolution, gutter-mode normalization, and the
 * stable row-ID unseen counter.
 *
 * Bare Node test runner (`node --import tsx/esm --test`).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  clipPreview,
  computeRailGeometry,
  computeTimelineSnapshot,
  countUnseenRows,
  jumpTargetForTurn,
  normalizeScrollGutter,
  PREVIEW_MAX_CHARS,
  RAIL_MIN_TERMINAL_WIDTH,
  RAIL_MIN_TURNS,
  railEligible,
  railHit,
  wrapPreviewLines,
  nextUnseenAnchor,
  type TimelineTurn,
} from '../../src/tui/timeline-model.js'

function turn(id: number, top: number, folded = false): TimelineTurn {
  return folded ? { id, top: -1, preview: `p${id}`, folded: true } : { id, top, preview: `p${id}` }
}

test('railEligible gates on scrollability, turns, width, and viewport', () => {
  const base = { turnCount: RAIL_MIN_TURNS, terminalWidth: RAIL_MIN_TERMINAL_WIDTH, viewportRows: 3, scrollable: true }
  assert.equal(railEligible(base), true)
  assert.equal(railEligible({ ...base, scrollable: false }), false)
  assert.equal(railEligible({ ...base, turnCount: RAIL_MIN_TURNS - 1 }), false)
  assert.equal(railEligible({ ...base, terminalWidth: RAIL_MIN_TERMINAL_WIDTH - 1 }), false)
  assert.equal(railEligible({ ...base, viewportRows: 2 }), false)
})

test('computeRailGeometry refuses too few turns or too short a viewport', () => {
  assert.equal(computeRailGeometry(1, 10, 0, false), null)
  assert.equal(computeRailGeometry(5, 2, 0, false), null)
})

test('computeRailGeometry centers the chevron+ticks block when all turns fit', () => {
  const geo = computeRailGeometry(3, 10, 1, false)!
  assert.ok(geo)
  assert.equal(geo.windowStart, 0)
  assert.equal(geo.windowEnd, 3)
  // blockTop = floor((10 - (3 + 2)) / 2) = 2
  assert.equal(geo.upRow, 2)
  assert.equal(geo.tickTop, 3)
  assert.equal(geo.downRow, 6)
})

test('computeRailGeometry slides the window around the active turn', () => {
  // 20 turns, 8 tick rows (10 - 2 chevrons): window centers on active.
  const geo = computeRailGeometry(20, 10, 10, false)!
  assert.equal(geo.windowEnd - geo.windowStart, 8)
  assert.ok(geo.windowStart <= 10 && 10 < geo.windowEnd, 'active turn stays inside the window')
  assert.equal(geo.windowStart, 6)
  // Clamped at the head: active near the start never produces a negative window.
  const head = computeRailGeometry(20, 10, 0, false)!
  assert.equal(head.windowStart, 0)
  // Clamped at the tail.
  const tail = computeRailGeometry(20, 10, 19, false)!
  assert.equal(tail.windowEnd, 20)
})

test('computeRailGeometry pins the tail window at the bottom without excluding active', () => {
  // At the bottom prefer the tail so the newest ticks stay visible…
  const atBottom = computeRailGeometry(20, 10, null, true)!
  assert.equal(atBottom.windowStart, 12)
  assert.equal(atBottom.windowEnd, 20)
  // …but never exclude the active turn.
  const activeOutsideTail = computeRailGeometry(20, 10, 2, true)!
  assert.equal(activeOutsideTail.windowStart, 2)
  assert.ok(activeOutsideTail.windowStart <= 2 && 2 < activeOutsideTail.windowEnd)
})

test('railHit maps rows to up/down/tick and nothing else', () => {
  const geo = computeRailGeometry(3, 10, 1, false)!
  assert.deepEqual(railHit(geo, geo.upRow), { kind: 'up' })
  assert.deepEqual(railHit(geo, geo.downRow), { kind: 'down' })
  assert.deepEqual(railHit(geo, geo.tickTop), { kind: 'tick', index: 0 })
  assert.deepEqual(railHit(geo, geo.tickTop + 2), { kind: 'tick', index: 2 })
  // The last tick and ▼ are adjacent (downRow = tickTop + shown): the row
  // right after the final tick IS the ▼ chevron, never a dead row.
  assert.deepEqual(railHit(geo, geo.tickTop + 3), { kind: 'down' })
  // Above ▲: no target.
  assert.equal(railHit(geo, geo.upRow - 1), null)
  // Fewer ticks than the viewport: the centered block leaves genuinely
  // empty rows below ▼ (and above ▲).
  const sparse = computeRailGeometry(2, 20, 0, false)!
  assert.equal(railHit(sparse, sparse.downRow + 1), null)
  assert.equal(railHit(sparse, sparse.upRow - 1), null)
})

test('computeTimelineSnapshot: active is the last prompt at-or-above the viewport top', () => {
  const turns = [turn(1, 10), turn(2, 30), turn(3, 50)]
  // Mid turn 2: turn 2 owns the top row, and ▲ first aligns turn 2's own
  // prompt — the last turn STRICTLY above the viewport top is turn 2
  // itself (top 30 < 35), so upId is 2, not 1.
  let snap = computeTimelineSnapshot(turns, 35, 100)
  assert.equal(snap.activeId, 2)
  assert.equal(snap.upId, 2)
  assert.equal(snap.downId, 3)
  // Exactly on a prompt top: that turn is active (at-or-above), previous is up.
  snap = computeTimelineSnapshot(turns, 30, 100)
  assert.equal(snap.activeId, 2)
  assert.equal(snap.upId, 1)
  assert.equal(snap.downId, 3)
})

test('computeTimelineSnapshot: first turn stands in while pre-turn content owns the top', () => {
  const turns = [turn(1, 10), turn(2, 30)]
  const snap = computeTimelineSnapshot(turns, 0, 100)
  assert.equal(snap.activeId, 1)
  assert.equal(snap.upId, null)
  assert.equal(snap.downId, 1)
})

test('computeTimelineSnapshot: down target must be reachable (top ≤ maxScroll)', () => {
  const turns = [turn(1, 10), turn(2, 30), turn(3, 50)]
  // A trailing prompt below maxScroll could never own the top row —
  // naming it would make ▼ repeat forever (the stuck-▼ bug).
  const snap = computeTimelineSnapshot(turns, 35, 40)
  assert.equal(snap.downId, null)
  assert.equal(snap.activeId, 2)
})

test('computeTimelineSnapshot: folded turns are up targets, never measured active or down', () => {
  const turns = [turn(1, -1, true), turn(2, -1, true), turn(3, 20), turn(4, 40)]
  const snap = computeTimelineSnapshot(turns, 25, 100)
  assert.equal(snap.activeId, 3)
  // The last turn strictly above the viewport top — folded turns qualify,
  // then turn 3 (top 20 < 25) overwrites them.
  assert.equal(snap.upId, 3)
  assert.equal(snap.downId, 4)

  const topSnap = computeTimelineSnapshot(turns, 0, 100)
  assert.equal(topSnap.upId, 2)
  // No measured top is at-or-above 0, so active falls back to turns[0] —
  // the source fallback does not skip folded turns.
  assert.equal(topSnap.activeId, 1)
  // First measured turn below the top and reachable: turn 3 (top 20).
  assert.equal(topSnap.downId, 3)
})

test('computeTimelineSnapshot: empty turns yield null targets', () => {
  const snap = computeTimelineSnapshot([], 0, 0)
  assert.equal(snap.activeId, null)
  assert.equal(snap.upId, null)
  assert.equal(snap.downId, null)
})

test('jumpTargetForTurn: folded turns reveal, measured turns scroll by content coordinate', () => {
  assert.deepEqual(jumpTargetForTurn(turn(7, -1, true)), { kind: 'reveal', id: 7 })
  assert.deepEqual(jumpTargetForTurn(turn(7, 42)), { kind: 'scroll', top: 42 })
})

test('normalizeScrollGutter passes known modes through and defaults the rest', () => {
  assert.equal(normalizeScrollGutter('timeline'), 'timeline')
  assert.equal(normalizeScrollGutter('scrollbar'), 'scrollbar')
  assert.equal(normalizeScrollGutter('hidden'), 'hidden')
  assert.equal(normalizeScrollGutter('nonsense'), 'timeline')
  assert.equal(normalizeScrollGutter(undefined), 'timeline')
  assert.equal(normalizeScrollGutter(42), 'timeline')
})

test('clipPreview picks the first non-empty line, trimmed', () => {
  assert.equal(clipPreview('\n\n  hello world  \nsecond line\n'), 'hello world')
  assert.equal(clipPreview('single'), 'single')
  assert.equal(clipPreview('\n \n'), '')
})

test('clipPreview caps by code points including the ellipsis, surrogate-safe', () => {
  const long = 'x'.repeat(PREVIEW_MAX_CHARS + 50)
  const clipped = clipPreview(long)
  assert.equal([...clipped].length, PREVIEW_MAX_CHARS)
  assert.ok(clipped.endsWith('…'))

  // A string of emoji (surrogate pairs) must not split mid-pair.
  const emojis = '🙂'.repeat(PREVIEW_MAX_CHARS + 10)
  const clippedEmoji = clipPreview(emojis)
  assert.equal([...clippedEmoji].length, PREVIEW_MAX_CHARS)
  assert.ok(clippedEmoji.endsWith('…'))
  // Walk UTF-16 code units: every lead surrogate must be paired.
  for (let i = 0; i < clippedEmoji.length; i++) {
    const cu = clippedEmoji.charCodeAt(i)
    if (cu >= 0xd800 && cu <= 0xdbff) {
      const trail = clippedEmoji.charCodeAt(i + 1)
      assert.ok(trail >= 0xdc00 && trail <= 0xdfff, 'lead surrogate followed by trail')
      i++
    } else {
      assert.ok(cu < 0xdc00 || cu > 0xdfff, 'no lone trail surrogate')
    }
  }

  // Exactly at the cap: no ellipsis.
  const exact = 'y'.repeat(PREVIEW_MAX_CHARS)
  assert.equal(clipPreview(exact), exact)
})

test('wrapPreviewLines wraps by display width and ellipsizes the second line', () => {
  assert.deepEqual(wrapPreviewLines('hello world foo', 6), ['hello ', 'world…'])
  // Short text stays one line.
  assert.deepEqual(wrapPreviewLines('short', 20), ['short'])
  assert.deepEqual(wrapPreviewLines('', 20), [''])
})

test('wrapPreviewLines is CJK-aware (display columns, not chars)', () => {
  // 4 CJK chars = 8 columns; width 4 wraps after two chars.
  assert.deepEqual(wrapPreviewLines('你好世界', 4), ['你好', '世界'])
  // Remaining content ellipsizes within the column budget ('…' included).
  assert.deepEqual(wrapPreviewLines('你好世界人们', 4), ['你好', '世…'])
})

test('wrapPreviewLines keeps combining sequences and emoji clusters intact', () => {
  // 'e' + combining acute (U+0301) is one grapheme of width 1.
  const combining = 'e\u0301x'
  assert.deepEqual(wrapPreviewLines(combining, 1), ['e\u0301', 'x'])
  // ZWJ emoji cluster counts as one width-2 unit and is never split.
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'
  const wrapped = wrapPreviewLines(`${family}${family}`, 2)
  assert.equal(wrapped[0], family)
})

test('unseen anchor: set on leaving the bottom, kept while away, cleared at the bottom', () => {
  // Leaving the bottom pins the last seen row id.
  assert.equal(nextUnseenAnchor(null, false, 5), 5)
  // While away the anchor is stable (new rows do not move it).
  assert.equal(nextUnseenAnchor(5, false, 8), 5)
  // At the bottom the anchor clears (from either state).
  assert.equal(nextUnseenAnchor(5, true, 8), null)
  assert.equal(nextUnseenAnchor(null, true, 8), null)
  // Empty transcript: nothing to anchor.
  assert.equal(nextUnseenAnchor(null, false, null), null)
})

test('countUnseenRows counts anchored rows whose top is still below the viewport', () => {
  const rows = [
    { id: 10, top: 80 },
    { id: 11, top: 90 },
    { id: 12, top: 100 },
    { id: 13, top: 150 },
  ]
  // Anchor at row 10, viewport bottom at content row 100: row 11's top is
  // already on screen (seen), rows 12+ are still below.
  assert.equal(countUnseenRows(rows, 10, 100), 2)
  // Scrolling down reveals row tops and decrements the count.
  assert.equal(countUnseenRows(rows, 10, 150), 1)
  assert.equal(countUnseenRows(rows, 10, 200), 0)
  // No anchor (at the bottom): nothing is unseen.
  assert.equal(countUnseenRows(rows, null, 100), 0)
  // Rows at-or-before the anchor never count, even if below the viewport.
  assert.equal(countUnseenRows([{ id: 9, top: 500 }, { id: 10, top: 600 }], 10, 100), 0)
})
