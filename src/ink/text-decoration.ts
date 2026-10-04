/**
 * Typed-decoration helpers shared by the text measure path (dom.ts) and
 * the text paint path (render-node-to-output.ts). See Styles.decoration.
 */
import { stringWidth } from './stringWidth.js'

/**
 * The hang derivation reads a source line's LEADING STRUCTURE — the run
 * of quote rails, list markers, checkboxes and indentation the markdown
 * formatter bakes into every hard row — and turns it into the width (and
 * bar mask) a terminal-wrapped continuation needs to stay aligned with
 * that row's content column. Input may carry ANSI escape codes (the
 * formatter bakes styling into the same string, e.g. a tinted marker is
 * `SGR - RESET space`); escapes are zero-width and transparent to the
 * parse. Both call sites feed the same raw text so measurement and
 * paint agree row for row.
 */

/** The blockquote gutter glyphs the markdown formatter bakes per level. */
const BAR_CHARS = new Set(['\u258e', '\u258f'])

/** A parsed leading-structure run: its width and which columns are bars. */
export type HangInfo = {
  readonly width: number
  readonly bars: readonly boolean[]
}

/** End index (exclusive) of the escape sequence starting at i. */
function escapeEnd(s: string, i: number): number {
  const c = s[i + 1]
  if (c === '[') {
    // CSI: parameters/middle bytes then a final letter.
    let j = i + 2
    while (j < s.length && !/[A-Za-z]/.test(s[j]!)) j++
    return Math.min(s.length, j + 1)
  }
  if (c === ']') {
    // OSC: BEL-terminated (our OSC 8 emitter's form) or ST-terminated.
    let j = i + 2
    while (j < s.length && s[j] !== '\u0007') j++
    return Math.min(s.length, j + 1)
  }
  return i + 2
}

/**
 * The line's plain characters (escape sequences removed). Structure
 * glyphs are single-cell, so the array index IS the display column of
 * the run this module parses.
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
 * none. Recognizes the shapes renderListItem emits: `- ` / `* ` bullets
 * and `N. ` / `a. ` / `iv. ` ordered markers (digits, letters or roman
 * numerals followed by a dot and a space). The dot only counts with the
 * space behind it, so prose like `3.5 GHz` or `e.g. foo` does not match;
 * an abbreviation like `vs. something` does and hangs its wrap a few
 * columns in — cosmetic, deterministic, and still aligned to where that
 * line's content starts.
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
 * Parse one source line's leading structure. Returns undefined when the
 * line has none (content at column 0) or nothing after it (a bare rail
 * row has nothing to hang). `bars[n]` says whether display column n of
 * the run is a quote rail glyph; markers, checkboxes and indentation
 * columns are false and rebuild as spaces.
 */
export function deriveHang(line: string): HangInfo | undefined {
  if (line.length === 0) return undefined
  const chars = plainView(line)
  if (chars.length === 0) return undefined
  const bars: boolean[] = []
  let k = 0
  let sawStructure = false
  // Indentation spaces and quote rails, in any order the formatter
  // composes them: `▎ ▎ `, `  ▎ `, `    `. Consuming the whole
  // space run is intentional: the content column is where content
  // starts, which is exactly where the continuation should align.
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
  // One optional list marker, then one optional task checkbox — the
  // shapes renderListItem emits between structure and content.
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
 * Wrap one source line for hang decoration. The FIRST row keeps the
 * legacy break points exactly (wrapped at `maxWidth`, byte-identical
 * with the undecorated renderer whenever the line fits or breaks the
 * way it always did); only continuation pieces that would overflow once
 * the hang prefix is prepended are re-wrapped at `maxWidth - hangWidth`.
 * A line that fits `maxWidth` in one piece is returned unwrapped — the
 * budget never pushes a just-fitting line over the edge (inline
 * scrollback repros lock the exact row shapes of just-fitting list
 * items). A trailing separator space that alone overflows the budget
 * moves to the next piece's front instead of re-breaking, so no
 * whitespace-only ghost row appears and the copy joins it back.
 *
 * `wrap` wraps one string at one width (wrapText). Both the measure
 * path and the paint path must call this exact function so their row
 * counts agree.
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
    let piece = pieces[i]!
    const trimmed = stripTrailingSpaces(piece)
    if (trimmed.moved !== '') {
      if (i + 1 < pieces.length && stringWidth(trimmed.rest) <= budget) {
        pieces[i + 1] = trimmed.moved + pieces[i + 1]!
        piece = trimmed.rest
      } else if (i + 1 === pieces.length) {
        piece = trimmed.rest
      }
    }
    if (stringWidth(piece) <= budget || budget < 2) {
      if (piece !== '' || i + 1 < pieces.length) out.push(piece)
      continue
    }
    out.push(...wrap(piece, budget).split('\n'))
  }
  return out
}
/** Visual reset so a prefix's open SGR cannot bleed into the row body. */
const ANSI_RESET = '\u001b[0m'

/**
 * Rebuild the hang prefix as a styled string: ANSI sequences from the
 * line's own first visual row pass through (quote rails keep their
 * color), every plain structure column that is not a bar becomes a
 * space (markers and checkboxes must not repeat as glyphs), and a reset
 * closes any open SGR so the row body after the prefix starts clean.
 * Escape-free prefixes (pure indentation) append nothing.
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
    // Structure columns are single-cell glyphs (rails, spaces, markers);
    // a wide char cannot be part of the parsed run.
    out += hang.bars[col] === true ? c : ' '
    col++
    i++
  }
  return sawEscape ? out + ANSI_RESET : out
}
