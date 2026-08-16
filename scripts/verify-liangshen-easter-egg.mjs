/** Regression check: Liangshen easter-egg frame layout and toggle prefs.
 * Run against compiled output (lib/types), same as the other verify scripts. */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildEasterEggLines, revealSchedule } from '../lib/types/components/LiangshenEasterEgg.js'
import { stringWidth } from '../lib/types/ink/stringWidth.js'
import {
  parseEasterEggPref,
  readEasterEggPref,
  writeEasterEggPref,
  resolveEasterEgg,
  shouldPlayEasterEgg,
} from '../lib/types/easterEggPrefs.js'

// --- frame layout ---------------------------------------------------------

const COLS = 60
const ROWS = 20

const frame0 = buildEasterEggLines(COLS, ROWS, 0)
assert.equal(frame0.length, ROWS, 'frame height must equal terminal rows')

// Every row is exactly `cols` display columns wide (wide chars count 2).
for (const line of frame0) {
  assert.equal(stringWidth(line.text), COLS, `row width must be ${COLS}, got ${stringWidth(line.text)}`)
  assert.match(line.color, /^rgb\(\d+,\d+,\d+\)$/, `color must be rgb(...), got ${line.color}`)
}

// Chant rows carry the mantra; the seq-0 row (0 % 7 === 0) is a praise row.
assert.ok(frame0[0].text.includes('梁神'), 'first row is a praise row and must mention 梁神')
assert.ok(frame0[1].text.includes('✋😭🤚'), 'chant row must carry the full ✋😭🤚 hands')

// The words between two ✋😭🤚 units come from the draw list.
const EASY_WORDS = ['梁神', '恩情', '梁文峰牛逼', '吊打肥波5']
for (let seq = 0; seq < 120; seq++) {
  if (seq % 7 === 0) continue // praise rows
  const frame = buildEasterEggLines(COLS, 1, seq)
  const text = frame[0].text
  const m = /✋😭🤚([^✋]+)/.exec(text)
  assert.ok(m, `chant row must be ✋😭🤚word…, got ${text.slice(0, 20)}`)
  assert.ok(EASY_WORDS.includes(m[1]), `drawn word ${m[1]} must be in the draw list`)
}
// The draw actually varies: more than one distinct word across a few rows.
const drawn = new Set(Array.from({ length: 30 }, (_, seq) => {
  if (seq % 7 === 0) return null
  const frame = buildEasterEggLines(COLS, 1, seq)
  return /✋😭🤚([^✋]+)/.exec(frame[0].text)?.[1]
}).filter(Boolean))
assert.ok(drawn.size >= 2, `draw must vary, only saw ${drawn.size} distinct word(s)`)

// Praise rows interleave every PRAISE_EVERY global lines: seq 7, 14, …
for (const seq of [7, 14, 21]) {
  const frame = buildEasterEggLines(COLS, ROWS, seq - 1)
  const row = frame[1]
  assert.ok(
    row.text.includes('牛逼') || row.text.includes('yyds'),
    `praise row at seq ${seq} must carry a praise, got ${row.text.slice(0, 30)}`,
  )
}

// Scrolling: frame at offset+1 starts with the frame at offset's second row.
const frame1 = buildEasterEggLines(COLS, ROWS, 1)
assert.equal(frame1[0].text, frame0[1].text, 'offset+1 must scroll content up by one row')
assert.equal(frame1[0].color, frame0[1].color, 'colors scroll with the rows')

// Left-to-right reveal: reveal=0 is empty, 0<reveal<1 is a left slice, and
// the slice grows with reveal.
const empty = buildEasterEggLines(COLS, ROWS, 0, 0)
for (const line of empty) assert.equal(stringWidth(line.text), 0, 'reveal=0 must render nothing')
const half = buildEasterEggLines(COLS, ROWS, 0, 0.5)
for (const line of half) {
  const w = stringWidth(line.text)
  assert.ok(w > 0 && w <= Math.ceil(COLS / 2), `reveal=0.5 must be a left slice ≤ ${COLS / 2}, got ${w}`)
}
const reveal1 = buildEasterEggLines(COLS, ROWS, 0, 1)
const reveal2 = buildEasterEggLines(COLS, ROWS, 0, 0.7)
assert.ok(
  stringWidth(reveal1[1].text) > stringWidth(reveal2[1].text),
  'larger reveal must expose more columns',
)
// The revealed slice is the left prefix of the full row (reveal order stable).
assert.ok(reveal2[1].text === sliceLeftOf(reveal1[1].text, Math.round(COLS * 0.7)), 'reveal must show the left prefix')

// Row-by-row stagger: mid-entry, the top row is far ahead of the bottom rows
// (each row starts `ROW_DELAY_MS` later, so widths differ by row).
const mid = buildEasterEggLines(COLS, ROWS, 0, row => revealSchedule(row, 900))
const widthsMid = mid.map(line => stringWidth(line.text))
assert.ok(
  widthsMid[0] >= widthsMid[1] && widthsMid[1] >= widthsMid[2],
  'top rows must be wider than lower rows mid-entry',
)
assert.ok(widthsMid[0] > widthsMid[ROWS - 1], 'entry must be staggered: row 0 wider than the last row')
const late = buildEasterEggLines(COLS, ROWS, 0, row => revealSchedule(row, 2400))
for (const line of late) assert.equal(stringWidth(line.text), COLS, 'after the full stagger every row is full width')

/** Left prefix of `text` to `cols` display columns (mirror of the impl). */
function sliceLeftOf(text, cols) {
  let out = ''
  let width = 0
  for (const ch of text) {
    const w = stringWidth(ch)
    if (width + w > cols) break
    out += ch
    width += w
  }
  return out
}

// Degenerate sizes never throw and never overflow.
for (const [cols, rows] of [[0, 0], [1, 1], [10, 3], [200, 60]]) {
  const frame = buildEasterEggLines(cols, rows, 123)
  assert.equal(frame.length, rows)
  for (const line of frame) assert.ok(stringWidth(line.text) <= Math.max(cols, 0))
}

// --- toggle prefs ----------------------------------------------------------

assert.equal(parseEasterEggPref(''), undefined)
assert.equal(parseEasterEggPref('not json'), undefined)
assert.equal(parseEasterEggPref('{}'), undefined)
assert.equal(parseEasterEggPref('{"easterEgg":"yes"}'), undefined)
assert.equal(parseEasterEggPref('{"easterEgg":true}'), true)
assert.equal(parseEasterEggPref('{"easterEgg":false}'), false)

const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-easter-egg-'))
try {
  // Nothing persisted yet → off.
  assert.equal(resolveEasterEgg(undefined, dir), false)
  // Configured (cordis.yml) wins over the persisted choice.
  assert.equal(writeEasterEggPref(true, dir), true)
  assert.equal(readEasterEggPref(dir), true)
  assert.equal(resolveEasterEgg(undefined, dir), true)
  assert.equal(resolveEasterEgg(false, dir), false)
  assert.equal(resolveEasterEgg(true, dir), true)
  // Roundtrip off.
  assert.equal(writeEasterEggPref(false, dir), true)
  assert.equal(resolveEasterEgg(undefined, dir), false)
} finally {
  await rm(dir, { recursive: true, force: true })
}

// --- trigger predicate -----------------------------------------------------

assert.equal(shouldPlayEasterEgg('liangshen', true, true), true)
assert.equal(shouldPlayEasterEgg('liangshen', false, true), false, 'failed switch must not play')
assert.equal(shouldPlayEasterEgg('liangshen', true, false), false, 'disabled toggle must not play')
assert.equal(shouldPlayEasterEgg('standard', true, true), false, 'non-liangshen preset must not play')

console.log('liangshen easter-egg layout + toggle verified')
