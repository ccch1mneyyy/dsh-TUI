import { t } from '../i18n.js'

/**
 * Per-line character budget for transcript text.
 *
 * A single source line longer than this is clipped BEFORE it reaches the
 * layout engine. Wrapping is what costs: one minified-JS line, a 300k-char
 * pasted log line, or a file written through a tool call turns into
 * thousands of visual rows, and the per-frame wrap + measure over that text
 * (not the row count) is what stalls the transcript. Clipping at the source
 * keeps the rendered line count — and therefore the layout work — bounded
 * no matter what the model, the user, or a tool pastes in.
 *
 * 1000 characters is roughly ten terminal rows at a common width: long
 * enough that ordinary prose, commands and URLs never notice, short enough
 * that the pathological single line cannot dominate a frame. The exact
 * threshold is a display choice, not a contract — `Ctrl+O` (global
 * transcript expansion) always paints the raw text.
 */
export const LONG_LINE_MAX_CHARS = 1000

export type LongLineFold = {
  /** Text to render. Identity-equal to the input when nothing was folded. */
  readonly text: string
  /** Characters elided across every folded line (0 → nothing folded). */
  readonly hiddenChars: number
  /** Number of lines that were clipped. */
  readonly foldedLines: number
}

/** Compact count for the fold marker: exact below 10k, `12.3k`/`1.2m`
 *  above (the status bar's own token/char presentation). */
function formatCount(value: number): string {
  if (value < 10_000) return String(value)
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 100_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}m`
}

/**
 * Clip every line of `text` longer than `max` characters, appending an
 * inline `… +N chars (ctrl+o to expand)` marker to the clipped line.
 *
 * Line boundaries are preserved (never re-flowed, never merged), so the
 * result stays valid input for the markdown renderer and for diff-style
 * line pairing. The caller decides WHEN to fold (e.g. not while the global
 * expansion is on); this function is a pure, allocation-free fast path when
 * no line exceeds the budget.
 */
export function foldLongLines(text: string, max: number = LONG_LINE_MAX_CHARS): LongLineFold {
  if (text === '' || max <= 0) return { text, hiddenChars: 0, foldedLines: 0 }
  // Common case (an ordinary message): no line can exceed the budget, so the
  // whole scan is skipped. This is the path every short row takes.
  if (text.length <= max) return { text, hiddenChars: 0, foldedLines: 0 }

  let out: string[] | undefined
  let lineStart = 0
  let hiddenChars = 0
  let foldedLines = 0

  for (;;) {
    const newline = text.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? text.length : newline
    const folded = lineEnd - lineStart > max

    if (folded) {
      // First fold: everything before this line is untouched, so it is
      // copied over in one slice and every later line is appended in order.
      if (out === undefined) {
        out = []
        if (lineStart > 0) out.push(text.slice(0, lineStart))
      }
    }
    if (out !== undefined) {
      if (folded) {
        let end = lineStart + max
        // Never split a surrogate pair: an astral character (emoji, rare CJK)
        // is two UTF-16 code units, and half of one renders as U+FFFD.
        const lead = text.charCodeAt(end - 1)
        const trail = text.charCodeAt(end)
        if (lead >= 0xD800 && lead <= 0xDBFF && trail >= 0xDC00 && trail <= 0xDFFF) end--
        const hidden = lineEnd - end
        hiddenChars += hidden
        foldedLines++
        out.push(text.slice(lineStart, end))
        out.push(` ${t('long-line-folded', { n: formatCount(hidden) })}`)
      } else {
        out.push(text.slice(lineStart, lineEnd))
      }
      if (newline !== -1) out.push('\n')
    }
    if (newline === -1) break
    lineStart = newline + 1
  }

  if (out === undefined) return { text, hiddenChars: 0, foldedLines: 0 }
  return { text: out.join(''), hiddenChars, foldedLines }
}
