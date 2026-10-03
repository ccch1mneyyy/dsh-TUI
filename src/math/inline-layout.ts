/**
 * Line layout for a paragraph whose inline formulas are terminal images.
 *
 * Each formula is stood in for by a run of placeholder characters as wide as
 * its image (one private-use code point per formula, so neighbouring
 * formulas stay distinguishable), and the formatted paragraph is wrapped by
 * the same `wrapText` that <Text> uses. A run holds no spaces, so it wraps
 * as one unbreakable word: a formula never splits across rows. The display
 * helper hides separators moved past a full row without changing row count. Each
 * wrapped row is then cut into ANSI-balanced text pieces (sliceAnsi re-opens
 * the styles and links a cut crosses) and the image slots between them.
 * Pure: no React, no terminal.
 */
import stripAnsi from 'strip-ansi'
import { stringWidth } from '../ink/stringWidth.js'
import { wrapTextLines } from '../ink/wrap-text.js'
import sliceAnsi from '../utils/sliceAnsi.js'

/** First placeholder code point (Private Use Area, width 1). */
const PLACEHOLDER_BASE = 0xe000
/** Formulas one paragraph may lay out as images; the rest keep Unicode. */
export const INLINE_MEDIA_MAX = 0x1000

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export type InlinePiece =
  | { readonly kind: 'text'; readonly text: string; readonly width: number }
  | { readonly kind: 'media'; readonly index: number; readonly columns: number }

export type InlineRow = {
  readonly pieces: readonly InlinePiece[]
  /** Columns the row's content spans. */
  readonly width: number
  /** The row continues the previous one (a wrap, not a source newline). */
  readonly continuation: boolean
  /** A separator omitted at a full row boundary; restore it on copy. */
  readonly gap: boolean
}

/** The placeholder run standing in for formula `index`, `columns` cells wide. */
export function inlineMediaPlaceholder(index: number, columns: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= INLINE_MEDIA_MAX) {
    throw new RangeError(`inline media index out of range: ${index}`)
  }
  return String.fromCodePoint(PLACEHOLDER_BASE + index).repeat(Math.max(1, columns))
}

/**
 * Wrap `formatted` (ANSI text containing placeholder runs for `columns.length`
 * formulas) to `width` and split every row into text and media pieces.
 * Returns undefined when a formula could not be kept whole on one row — its
 * run was split by a hard wrap (wider than the row) or appears more than once
 * — so the caller keeps the plain text rendering instead.
 */
export function layoutInlineMedia(
  formatted: string,
  width: number,
  columns: readonly number[],
): InlineRow[] | undefined {
  if (width < 1) return undefined
  const seen = new Set<number>()
  const rows: InlineRow[] = []
  for (const { text: line, continuation, gap } of wrapTextLines(formatted, width)) {
    const pieces: InlinePiece[] = []
    const plain = stripAnsi(line)
    let column = 0
    let textStart = 0
    let run: { index: number; start: number } | undefined
    const flushText = (end: number): void => {
      if (end <= textStart) return
      const text = sliceAnsi(line, textStart, end)
      pieces.push({ kind: 'text', text, width: end - textStart })
    }
    const closeRun = (): boolean => {
      if (run === undefined) return true
      const length = column - run.start
      if (seen.has(run.index) || length !== columns[run.index]) return false
      seen.add(run.index)
      pieces.push({ kind: 'media', index: run.index, columns: length })
      textStart = column
      run = undefined
      return true
    }
    for (const { segment: char } of graphemes.segment(plain)) {
      const code = char.codePointAt(0)!
      const index = code - PLACEHOLDER_BASE
      const isMedia = index >= 0 && index < columns.length
      if (run !== undefined && (!isMedia || index !== run.index) && !closeRun()) return undefined
      if (isMedia && run === undefined) {
        flushText(column)
        run = { index, start: column }
      }
      column += isMedia ? 1 : stringWidth(char)
    }
    if (!closeRun()) return undefined
    flushText(column)
    rows.push({ pieces, width: column, continuation, gap })
  }
  return seen.size === columns.length ? rows : undefined
}
