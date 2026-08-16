/**
 * Liangshen easter egg: a full-screen scrolling celebration that plays when
 * the user switches to the `liangshen` preset with the easter egg enabled.
 *
 * Layout/copy is pure (`buildEasterEggLines`) so a headless verify script can
 * assert the frame contract without a terminal; the component only owns the
 * clock, the full-screen overlay, and the exit paths (Esc / timeout).
 */

import React from 'react'
import { Box, Text, useAnimationFrame, useInput, useTerminalSize } from '../ui.js'
import { stringWidth } from '../ink/stringWidth.js'
import type { RGBColor } from '../ink/styles.js'

/** Words drawn between the ✋🤚 hands, picked pseudo-randomly per row. */
const EASY_WORDS: readonly string[] = ['梁神', '恩情', '梁文峰牛逼', '吊打肥波5']

/** Praise lines interleaved between chant rows. */
const PRAISES: readonly string[] = [
  '梁神牛逼！！',
  '梁文峰牛逼！！',
  'DeepSeek 牛逼！！',
  '梁神 yyds！！',
]

/** How many rows of chant between two praise rows. */
const PRAISE_EVERY = 7

/** Milliseconds per scroll step (one row up). */
const STEP_MS = 110

/** Milliseconds of one row's left-to-right slide-in. */
const ROW_SLIDE_MS = 520

/** Stagger between consecutive rows (row n starts n × ROW_DELAY_MS later). */
const ROW_DELAY_MS = 80

/** Milliseconds before the egg closes itself. */
const DURATION_MS = 9000

export interface EasterEggLine {
  /** Row text, padded/truncated to exactly `cols` display columns. */
  text: string
  /** ANSI rgb color for the row, e.g. `rgb(255,0,0)`. */
  color: RGBColor
}

/**
 * Repeat `tile` until the display width reaches exactly `cols` (wide chars
 * count as 2), truncating the final tile by display width.
 */
function repeatToWidth(tile: string, cols: number): string {
  if (cols <= 0) return ''
  let out = ''
  let width = 0
  while (width < cols) {
    const next = out + tile
    const nextWidth = stringWidth(next)
    if (nextWidth > cols) {
      // Drop trailing chars from the last tile by display width.
      let drop = tile
      while (drop.length > 0 && width + stringWidth(drop) > cols) {
        drop = drop.slice(0, -1)
      }
      return out + drop
    }
    out = next
    width = nextWidth
  }
  return out
}

/** Pad `text` (display width < cols) with spaces centered to `cols`. */
function centerPad(text: string, cols: number): string {
  const gap = cols - stringWidth(text)
  if (gap <= 0) return text
  const left = Math.floor(gap / 2)
  return ' '.repeat(left) + text + ' '.repeat(gap - left)
}

/** Deterministic pseudo-random word for a scroll sequence index (golden-ratio
 *  hash: adjacent rows differ, all words cycle over a short span). */
function wordFor(seq: number): string {
  const n = EASY_WORDS.length
  const index = Math.floor(((seq * 0.618033988749895) % 1) * n) % n
  return EASY_WORDS[Math.abs(index) % n] ?? EASY_WORDS[0]!
}

/** One chant unit: the full ✋😭🤚 hands followed by a drawn word — the word
 *  sits between two ✋😭🤚 units when the row is repeated. */
function tileFor(seq: number): string {
  return `✋😭🤚${wordFor(seq)}`
}

/** Left-side slice of `text` to `cols` display columns (for the reveal). */
function sliceLeft(text: string, cols: number): string {
  if (cols <= 0) return ''
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

/** Rainbow color for a scroll sequence index (30° hue steps). */
function rainbow(seq: number): RGBColor {
  const hue = (seq * 30) % 360
  const sat = 100
  const light = 55
  const c = (1 - Math.abs(2 * light / 100 - 1)) * sat / 100
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = light / 100 - c / 2
  const [r1, g1, b1] =
    hue < 60 ? [c, x, 0]
    : hue < 120 ? [x, c, 0]
    : hue < 180 ? [0, c, x]
    : hue < 240 ? [0, x, c]
    : hue < 300 ? [x, 0, c]
    : [c, 0, x]
  const to255 = (v: number) => Math.round((v + m) * 255)
  return `rgb(${to255(r1)},${to255(g1)},${to255(b1)})`
}

/** One praise row: chant around a centered praise, filling `cols`. */
function praiseRow(index: number, cols: number): string {
  const praise = PRAISES[Math.abs(index) % PRAISES.length] ?? PRAISES[0]!
  const half = repeatToWidth(tileFor(index * 3), Math.floor(cols / 2))
  const rest = cols - stringWidth(half)
  const row = half + centerPad(praise, Math.max(rest, 0))
  return row.slice(0, cols)
}

/**
 * Per-row entry schedule: row 0 starts sliding in at t=0, each next row
 * `ROW_DELAY_MS` later, each row taking `ROW_SLIDE_MS` to go 0→1 (ease-out
 * cubic). Rows enter one after another, left-to-right, top to bottom.
 * @param row - Row index (0 = top).
 * @param time - Elapsed animation time in ms.
 * @returns Reveal progress 0..1 for that row at that time.
 */
export function revealSchedule(row: number, time: number): number {
  const t = (time - row * ROW_DELAY_MS) / ROW_SLIDE_MS
  if (t <= 0) return 0
  if (t >= 1) return 1
  return 1 - Math.pow(1 - t, 3)
}

/**
 * Build the scrolling frame at sequence offset `offset`: `rows` lines, each
 * exactly `cols` display columns wide, every `PRAISE_EVERY`th global line a
 * praise row. Increasing `offset` moves the content up one row per step.
 * @param cols - Terminal columns.
 * @param rows - Terminal rows.
 * @param offset - Scroll sequence index (row 0 = sequence `offset`).
 * @param reveal - Entry progress; a number applies the same 0..1 to every row,
 *   a function gets each row's own progress (see {@link revealSchedule}).
 * @returns One entry per visible row, top to bottom.
 */
export function buildEasterEggLines(
  cols: number,
  rows: number,
  offset: number,
  reveal: number | ((row: number) => number) = 1,
): EasterEggLine[] {
  const lines: EasterEggLine[] = []
  for (let r = 0; r < rows; r++) {
    const seq = offset + r
    const progress = typeof reveal === 'function' ? reveal(r) : reveal
    const visible = Math.round(cols * Math.min(Math.max(progress, 0), 1))
    let text = seq % PRAISE_EVERY === 0
      ? praiseRow(seq / PRAISE_EVERY, cols)
      : repeatToWidth(tileFor(seq), cols)
    if (visible < cols) text = sliceLeft(text, visible)
    lines.push({ text, color: rainbow(seq) })
  }
  return lines
}

/**
 * Full-screen Liangshen celebration: a column of `rows` lines filling the
 * terminal, scrolling one row per `STEP_MS`. Hosts mount it as a tree
 * replacement (SessionBrowser pattern) so it owns the whole screen; it
 * closes itself after `DURATION_MS` or on Esc.
 */
export function LiangshenEasterEgg({
  onDone,
}: {
  /** Called when the animation ends (timeout or Esc). */
  onDone: () => void
}): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const [ref, time] = useAnimationFrame(STEP_MS)

  // The animation clock is shared app-wide, so `time` is an ABSOLUTE clock
  // value that may already be huge when this component mounts (the working
  // spinner and friends have been ticking since launch). The entry stagger
  // and the scroll offset must run on a per-mount clock: capture the mount
  // instant once and measure elapsed from it. `useRef(time)` initializes
  // exactly once, on first render.
  const mountTimeRef = React.useRef(time)
  const elapsed = Math.max(time - mountTimeRef.current, 0)

  // Esc closes the egg early; every other key is swallowed by the Chat gate.
  useInput((_input, key) => {
    if (key.escape) onDone()
  })

  // Hard stop so a long session never strands the overlay.
  React.useEffect(() => {
    const timer = setTimeout(onDone, DURATION_MS)
    return () => clearTimeout(timer)
  }, [onDone])

  // Row-by-row left-to-right entry: each row slides in `ROW_DELAY_MS` after
  // the one above it; scrolling starts once every row is in. Runs on the
  // per-mount elapsed clock (see mountTimeRef above).
  const enterEnd = (rows - 1) * ROW_DELAY_MS + ROW_SLIDE_MS
  const offset = elapsed >= enterEnd ? Math.floor((elapsed - enterEnd) / STEP_MS) : 0
  const lines = buildEasterEggLines(columns, rows, offset, row => revealSchedule(row, elapsed))

  return (
    <Box
      ref={ref}
      height={rows}
      flexDirection="column"
      overflow="hidden"
      backgroundColor="background"
    >
      {lines.map((line, index) => (
        <Text key={index} color={line.color} wrap="truncate-end">
          {line.text}
        </Text>
      ))}
    </Box>
  )
}

export default LiangshenEasterEgg
