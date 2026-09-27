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
  const width = bigTextWidth(text)
  const cycle = width + SWEEP_WINDOW * 2
  const sweepStart = (Math.floor(time / stepMs) % cycle) - SWEEP_WINDOW
  const pulse = (Math.sin(time / (stepMs * 2)) + 1) / 2

  const rows: string[] = []
  for (let row = 0; row < 5; row++) {
    let out = ''
    let current = ''
    let x = 0
    const emit = (ch: string): void => {
      if (ch === ' ' || ch === '·') {
        if (current !== '') {
          out += RESET
          current = ''
        }
        out += ' '
        x += 1
        return
      }
      const t = width <= 1 ? 0 : x / (width - 1)
      let color = interpolateColor(from, to, t)
      if (x >= sweepStart && x < sweepStart + SWEEP_WINDOW) {
        color = interpolateColor(color, flash, pulse)
      }
      const seq = esc(color)
      if (seq !== current) {
        out += seq
        current = seq
      }
      out += ch
      x += 1
    }
    let previous = ' '
    for (const ch of text) {
      if (ch === ' ') {
        for (let i = 0; i < WORD_GAP; i++) emit(' ')
        previous = ch
        continue
      }
      if (previous !== ' ') {
        for (let i = 0; i < LETTER_GAP; i++) emit(' ')
      }
      const glyph = GLYPHS[ch] ?? FALLBACK
      for (const cell of glyph[row]) emit(cell)
      previous = ch
    }
    if (current !== '') out += RESET
    rows.push(out)
  }
  return rows
}
