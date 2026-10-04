/**
 * Typed-decoration helpers shared by the text measure path (dom.ts) and
 * the text paint path (render-node-to-output.ts). See Styles.decoration.
 *
 * Both paths must wrap through wrapDecoratedLine with the same inputs, or
 * the measured height drifts from the painted rows.
 */
import { stringWidth } from './stringWidth.js'
import type { TextDecoration } from './styles.js'

/** The blockquote gutter glyphs the markdown formatter bakes per level. */
const BAR_CHARS = new Set(['▎', '▏'])

/** A parsed leading-structure run: its width and which columns are bars. */
export type HangInfo = {
  readonly width: number
  readonly bars: readonly boolean[]
}

/** End index (exclusive) of the escape sequence starting at i. */
function escapeEnd(s: string, i: number): number {
  const c = s[i + 1]
  if (c === '[') {
    // CSI: parameter/intermediate bytes, then a final letter.
    let j = i + 2
    while (j < s.length && !/[A-Za-z]/.test(s[j]!)) j++
    return Math.min(s.length, j + 1)
  }
  if (c === ']') {
    // OSC, BEL-terminated (the form createHyperlink emits).
    let j = i + 2
    while (j < s.length && s[j] !== '\u0007') j++
    return Math.min(s.length, j + 1)
  }
  return i + 2
}

/**
 * The line's plain characters (escape sequences removed). Structure
 * glyphs are single-cell, so the array index is the display column.
 */
function plainView(line: string): string[] {
  const chars: string[] = []
  let i = 0
  while (i < line.length) {
    const c = line[i]!
    if (c === '\u001b') {
      i = escapeEnd(line, i)
      continue
    }
    chars.push(c)
    i++
  }
  return chars
}

/**
 * Length of the list marker starting at chars[k], or 0 when there is
 * none: `- ` / `* ` bullets and `N. ` / `a. ` / `iv. ` ordered markers.
 * The dot only counts with a space behind it, so `3.5 GHz` or `e.g. foo`
 * do not match. `vs. something` does, and hangs its wrap a few columns
 * in; harmless.
 */
function markerLengthAt(chars: readonly string[], k: number): number {
  const c = chars[k]!
  if (c === '-' || c === '*') {
    return chars[k + 1] === ' ' ? 2 : 0
  }
  if (!/[0-9A-Za-z]/.test(c)) return 0
  let j = k
  while (j < chars.length && /[0-9A-Za-z]/.test(chars[j]!)) j++
  if (j > k && chars[j] === '.' && chars[j + 1] === ' ') return j + 2 - k
  return 0
}

/** Length of the task checkbox at chars[k] (`[x] ` / `[ ] `), else 0. */
function checkboxLengthAt(chars: readonly string[], k: number): number {
  const rest = chars.slice(k, k + 4).join('')
  return rest === '[x] ' || rest === '[ ] ' ? 4 : 0
}

/**
 * Parse a line's leading structure: the quote rails, indentation, list
 * marker and checkbox the markdown formatter bakes into every hard row.
 * ANSI escapes are skipped. Returns undefined when the line has no
 * structure or nothing after it (a bare rail row has nothing to hang).
 * `bars[n]` says whether column n is a rail glyph; every other structure
 * column is rebuilt as a space.
 */
export function deriveHang(line: string): HangInfo | undefined {
  if (line.length === 0) return undefined
  const chars = plainView(line)
  if (chars.length === 0) return undefined
  const bars: boolean[] = []
  let k = 0
  let sawStructure = false
  // Spaces and rails in any order the formatter composes them
  // (`▎ ▎ `, `  ▎ `, `    `); content starts after the whole run.
  while (k < chars.length) {
    const c = chars[k]!
    if (c === ' ' || BAR_CHARS.has(c)) {
      bars.push(BAR_CHARS.has(c))
      sawStructure = true
      k++
      continue
    }
    break
  }
  const marker = markerLengthAt(chars, k)
  if (marker > 0) {
    for (let n = 0; n < marker; n++) bars.push(false)
    k += marker
    sawStructure = true
  }
  const checkbox = checkboxLengthAt(chars, k)
  if (checkbox > 0) {
    for (let n = 0; n < checkbox; n++) bars.push(false)
    k += checkbox
  }
  if (!sawStructure || bars.length === 0 || k >= chars.length) return undefined
  return { width: bars.length, bars }
}

/**
 * Hang width of a source line at `maxWidth`: its leading-structure width,
 * or 0 when it has none or when the prefix would leave fewer than two
 * columns for content (a wide glyph needs two). With 0 the line wraps
 * and paints exactly like undecorated text.
 */
export function hangWidthAt(rawLine: string, maxWidth: number): number {
  const width = deriveHang(rawLine)?.width ?? 0
  return width > 0 && maxWidth - width >= 2 ? width : 0
}

/**
 * Split trailing plain spaces (kept inside the piece's trailing SGR
 * tail) off a wrapped piece: `rest` is the piece without them (its SGR
 * codes re-attached), `moved` the whitespace to carry elsewhere.
 */
function stripTrailingSpaces(piece: string): { rest: string; moved: string } {
  const m = piece.match(/ +(?=(?:\u001b\[[0-9;]*m)*$)/)
  if (m === null || m.index === undefined) return { rest: piece, moved: '' }
  const head = piece.slice(0, m.index)
  const tail = piece.slice(m.index + m[0].length)
  return { rest: head + tail, moved: m[0] }
}

/**
 * Wrap one source line for hang decoration. The first row keeps the
 * undecorated break points, and a line that fits `maxWidth` stays one
 * row. Only continuation pieces that would overflow once the
 * `hangWidth` prefix is prepended are re-wrapped at the narrower budget.
 * When a trailing separator space is all that overflows, it moves to the
 * front of the next piece (or is dropped on the last one) instead of
 * forcing a whitespace-only row; copy joins it back identically.
 */
export function wrapHangLine(
  line: string,
  maxWidth: number,
  hangWidth: number,
  wrap: (text: string, width: number) => string,
): string[] {
  const pieces = wrap(line, maxWidth).split('\n')
  if (pieces.length === 1) return pieces
  const out: string[] = [pieces[0]!]
  const budget = Math.max(1, maxWidth - hangWidth)
  for (let i = 1; i < pieces.length; i++) {
    const piece = pieces[i]!
    if (stringWidth(piece) <= budget || budget < 2) {
      // Pieces that fit stay byte-identical: moving whitespace off them
      // could push the next piece over the budget and add a row.
      out.push(piece)
      continue
    }
    const trimmed = stripTrailingSpaces(piece)
    if (trimmed.moved !== '' && stringWidth(trimmed.rest) <= budget) {
      if (i + 1 < pieces.length) pieces[i + 1] = trimmed.moved + pieces[i + 1]!
      out.push(trimmed.rest)
      continue
    }
    out.push(...wrap(piece, budget).split('\n'))
  }
  return out
}

/** Wrap budget for a decorated line: a prefix eats into every row. */
export function decoratedWrapBudget(decoration: TextDecoration, maxWidth: number): number {
  const prefixWidth = decoration.prefix?.width ?? 0
  return prefixWidth > 0 ? Math.max(1, maxWidth - prefixWidth) : maxWidth
}

/**
 * The rows one source line of a decorated text wraps to. Measure and
 * paint both call this so their row counts agree. `line` is what gets
 * wrapped; `rawLine` is the same line before tab expansion, which both
 * sides parse the hang from.
 */
export function wrapDecoratedLine(
  line: string,
  rawLine: string,
  maxWidth: number,
  decoration: TextDecoration,
  wrap: (text: string, width: number) => string,
): string[] {
  if ((decoration.prefix?.width ?? 0) <= 0 && decoration.hang === true) {
    const hangWidth = hangWidthAt(rawLine, maxWidth)
    if (hangWidth > 0) return wrapHangLine(line, maxWidth, hangWidth, wrap)
  }
  return wrap(line, decoratedWrapBudget(decoration, maxWidth)).split('\n')
}

/** Visual reset so a prefix's open SGR cannot bleed into the row body. */
const ANSI_RESET = '\u001b[0m'

/**
 * Build the hang prefix for a continuation row from its source line's
 * first row: escapes pass through (rails keep their color), rail columns
 * keep their glyph, every other structure column becomes a space, and a
 * reset closes any open SGR. Escape-free prefixes get no reset.
 */
export function rebuildHangPrefix(styledFirstRow: string, hang: HangInfo): string {
  let out = ''
  let col = 0
  let i = 0
  let sawEscape = false
  while (i < styledFirstRow.length && col < hang.width) {
    const c = styledFirstRow[i]!
    if (c === '\u001b') {
      const end = escapeEnd(styledFirstRow, i)
      out += styledFirstRow.slice(i, end)
      sawEscape = true
      i = end
      continue
    }
    // Structure glyphs are single-cell, so one char is one column.
    out += hang.bars[col] === true ? c : ' '
    col++
    i++
  }
  return sawEscape ? out + ANSI_RESET : out
}
