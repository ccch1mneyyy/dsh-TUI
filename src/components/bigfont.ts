import { interpolateColor } from './Spinner/spinnerUtils.js'

/**
 * A 5-row block font for the header tagline, painted with a horizontal
 * color gradient plus a moving highlight window (the same sweep cadence as
 * the wordmark shimmer — see the `stepMs` parameter). Glyphs are 5 columns wide so curves
 * and diagonals stay legible; only the letters the tagline needs are
 * defined, and unknown characters fall back to a hollow box so a typo
 * fails visibly instead of crashing the splash.
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

/** Glyph rows are 5 columns wide; `·` is a transparent cell. */
const GLYPHS: Record<string, readonly [string, string, string, string, string]> = {
  D: ['████·', '█···█', '█···█', '█···█', '████·'],
  E: ['█████', '█····', '████·', '█····', '█████'],
  P: ['████·', '█···█', '████·', '█····', '█····'],
  S: ['·████', '█····', '·███·', '····█', '████·'],
  K: ['█···█', '█··█·', '███··', '█··█·', '█···█'],
  H: ['█···█', '█···█', '█████', '█···█', '█···█'],
  A: ['·███·', '█···█', '█████', '█···█', '█···█'],
  R: ['████·', '█···█', '████·', '█··█·', '█···█'],
  N: ['█···█', '██··█', '█·█·█', '█··██', '█···█'],
}

const FALLBACK: readonly [string, string, string, string, string] = [
  '▄▄▄▄▄',
  '█···█',
  '█···█',
  '█···█',
  '▀▀▀▀▀',
]

/**
 * Four-column variants of the letters the `DEEP SLEEP` wordmark narrows
 * (`LEEP`), from the art study in `design/whale-wordmarks`: one column
 * tighter than the 5-column set, so the wordmark reads as one word while
 * still aligning with the row below.
 */
const NARROW_GLYPHS: Record<string, readonly [string, string, string, string, string]> = {
  L: ['█···', '█···', '█···', '█···', '████'],
  E: ['████', '█···', '███·', '█···', '████'],
  P: ['███·', '█··█', '███·', '█···', '█···'],
}

/** Two clear cells between letters keep their silhouettes separate. */
const LETTER_GAP = 2
/** Space between words. */
const WORD_GAP = 2
/** Sweep highlight window width, in terminal columns. */
const SWEEP_WINDOW = 8

const esc = (rgb: Rgb): string => `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m`
const RESET = '\x1b[39m'

/** Exact display width, including word/letter gaps but no trailing padding. */
export function bigTextWidth(text: string): number {
  const characters = Array.from(text)
  return characters.reduce((width, ch, index) =>
    width + (ch === ' ' ? WORD_GAP : 5)
      + (index > 0 && ch !== ' ' && characters[index - 1] !== ' ' ? LETTER_GAP : 0), 0)
}

/**
 * One run of block-font text inside a line: a word, or half a word when a
 * wordmark splits its coloring (the `DEEPS` / `LEEP` halves of `DEEP SLEEP`).
 */
export interface BigTextSegment {
  readonly text: string
  /** Gradient start color at the segment's first column. */
  readonly from: Rgb
  /** Gradient end color at the segment's last column. */
  readonly to: Rgb
  /** Use the 4-column narrow glyphs (falls back to the hollow box if undefined). */
  readonly narrow?: boolean
  /** Cells between letters; defaults to `LETTER_GAP`. */
  readonly gap?: number
  /** Blank columns inserted before this segment. */
  readonly separator?: number
}

function glyphColumns(segment: BigTextSegment): number {
  return segment.narrow === true ? 4 : 5
}

/** Display width of one segment, without any leading separator. */
function segmentWidth(segment: BigTextSegment): number {
  const characters = Array.from(segment.text)
  return characters.reduce((width, ch, index) => {
    if (ch === ' ') return width + WORD_GAP
    const gap = index > 0 && characters[index - 1] !== ' ' ? (segment.gap ?? LETTER_GAP) : 0
    return width + gap + glyphColumns(segment)
  }, 0)
}

/** Exact display width of a whole line, separators included. */
export function bigLineWidth(segments: readonly BigTextSegment[]): number {
  return segments.reduce((width, segment) => width + (segment.separator ?? 0) + segmentWidth(segment), 0)
}

/**
 * Render one block-font line from colored segments. Every segment carries its
 * own gradient (`from` → `to` across that segment's own columns), while the
 * SWEEP_WINDOW-wide highlight mixed toward `flash` travels left to right over
 * the whole line (one column per `stepMs`, the wordmark shimmer's cadence).
 * Returns 5 ANSI rows.
 */
export function renderBigLine(
  segments: readonly BigTextSegment[],
  time: number,
  flash: Rgb,
  stepMs = 60,
): string[] {
  const width = bigLineWidth(segments)
  const starts: number[] = []
  let cursor = 0
  for (const segment of segments) {
    cursor += segment.separator ?? 0
    starts.push(cursor)
    cursor += segmentWidth(segment)
  }
  const cycle = width + SWEEP_WINDOW * 2
  const sweepStart = (Math.floor(time / stepMs) % cycle) - SWEEP_WINDOW
  const pulse = (Math.sin(time / (stepMs * 2)) + 1) / 2

  const rows: string[] = []
  for (let row = 0; row < 5; row++) {
    let out = ''
    let current = ''
    let x = 0
    const emit = (ch: string, color?: Rgb): void => {
      if (ch === ' ' || ch === '·') {
        if (current !== '') {
          out += RESET
          current = ''
        }
        out += ' '
        x += 1
        return
      }
      let painted = color ?? flash
      if (x >= sweepStart && x < sweepStart + SWEEP_WINDOW) {
        painted = interpolateColor(painted, flash, pulse)
      }
      const seq = esc(painted)
      if (seq !== current) {
        out += seq
        current = seq
      }
      out += ch
      x += 1
    }
    segments.forEach((segment, index) => {
      const start = starts[index] ?? 0
      for (let i = 0; i < (segment.separator ?? 0); i++) emit(' ')
      const span = Math.max(1, segmentWidth(segment) - 1)
      const glyphs = segment.narrow === true ? NARROW_GLYPHS : GLYPHS
      const characters = Array.from(segment.text)
      let previous = ' '
      for (const ch of characters) {
        if (ch === ' ') {
          for (let i = 0; i < WORD_GAP; i++) emit(' ')
          previous = ch
          continue
        }
        if (previous !== ' ') {
          for (let i = 0; i < (segment.gap ?? LETTER_GAP); i++) emit(' ')
        }
        const glyph = glyphs[ch] ?? FALLBACK
        for (const cell of glyph[row]) {
          const clamped = Math.min(1, Math.max(0, (x - start) / span))
          emit(cell, interpolateColor(segment.from, segment.to, clamped))
        }
        previous = ch
      }
    })
    if (current !== '') out += RESET
    rows.push(out)
  }
  return rows
}

/**
 * Render `text` in the 5-row block font. The gradient runs `from` → `to`
 * across the full line width; a SWEEP_WINDOW-wide highlight mixed toward
 * `flash` travels left to right (one column per `stepMs`, matching the
 * wordmark shimmer's cadence). Returns 5 ANSI rows.
 * @param text - Text to render; only D, E, P, S, K, H, A, R, N have glyphs, unknown letters fall back to a hollow box.
 * @param time - Elapsed time in milliseconds; drives the sweep position and the brightness pulse.
 * @param from - Gradient start color at the left edge.
 * @param to - Gradient end color at the right edge.
 * @param flash - Highlight color mixed into the moving sweep window.
 * @param stepMs - Milliseconds per column of sweep advance (default 60).
 * @returns Five ANSI rows, one per block-font line.
 */
export function renderBigText(
  text: string,
  time: number,
  from: Rgb,
  to: Rgb,
  flash: Rgb,
  stepMs = 60,
): string[] {
  return renderBigLine([{ text, from, to }], time, flash, stepMs)
}
