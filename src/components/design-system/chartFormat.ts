/**
 * Caption formatting and cell-width text fitting for the chart kit.
 *
 * `chartFormat` is the plugin-facing `TuiChartFormat` (`ui.format`). The
 * token count and the duration are the host's own formatters
 * (terminal-utils/format.ts) — tokens on the width-bounded ladder the
 * footer's context bar prints (`12k`, `1.0M`), durations as the spinner and
 * tool rows print them (`3m 4s`) — so a plugin caption and the host never
 * disagree; the other helpers are compact and locale-neutral. Every helper
 * treats non-finite and negative numbers as 0 and never throws.
 *
 * The text helpers below are what the primitives use for labels and cells:
 * plugin text is folded to one sanitized line (no escape sequences reach the
 * screen) and measured/cut by grapheme in terminal cells, so CJK, emoji and
 * variation selectors never split or overflow a cell budget.
 */

import { stringWidth } from '../../ink/stringWidth.js'
import { cleanRenderText } from '../../channel/sanitize.js'
import { formatDuration, formatTokens } from '../../terminal-utils/format.js'
import { getGraphemeSegmenter } from '../../utils/intl.js'
import { cellCount, chartValue } from './chartGeometry.js'
import type { TuiChartFormat } from './chartTypes.js'

const ELLIPSIS = '…'

/**
 * Plugin text → one display-safe line: ANSI/OSC sequences removed, control
 * characters and whitespace runs folded to single spaces. Finite numbers
 * print plainly; anything else (non-finite numbers, objects) is empty.
 */
export function chartText(value: unknown): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value !== 'string') return ''
  return cleanRenderText(value, Number.POSITIVE_INFINITY)
}

/** The longest grapheme prefix of `text` that fits in `cells`, with its width. */
function sliceCells(text: string, cells: number): { readonly text: string; readonly width: number } {
  let out = ''
  let width = 0
  for (const { segment } of getGraphemeSegmenter().segment(text)) {
    const next = stringWidth(segment)
    if (width + next > cells) break
    out += segment
    width += next
  }
  return { text: out, width }
}

/**
 * Cut already-sanitized text to at most `cells` display cells, ending in `…`
 * when anything was dropped. A wide glyph that would straddle the edge is
 * dropped whole, so the result may be one cell short — {@link padCells}
 * fills that cell.
 */
export function fitCells(text: string, cells: number): string {
  const budget = cellCount(cells)
  if (budget === 0) return ''
  if (stringWidth(text) <= budget) return text
  return sliceCells(text, budget - 1).text + ELLIPSIS
}

/** Fit then pad sanitized text to exactly `cells` display cells. */
export function padCells(text: string, cells: number, align: 'left' | 'right' = 'left'): string {
  const budget = cellCount(cells)
  const fitted = fitCells(text, budget)
  const pad = ' '.repeat(Math.max(0, budget - stringWidth(fitted)))
  return align === 'right' ? pad + fitted : fitted + pad
}

/** The first grapheme of `text` when it is exactly one cell wide, else ''. */
export function singleCell(text: unknown): string {
  const clean = chartText(text)
  if (clean === '') return ''
  const first = getGraphemeSegmenter().segment(clean)[Symbol.iterator]().next()
  if (first.done === true) return ''
  return stringWidth(first.value.segment) === 1 ? first.value.segment : ''
}

/** The `ui.format` helpers. */
export const chartFormat: TuiChartFormat = Object.freeze({
  tokens(count: number): string {
    // The footer's context-bar ladder, character for character: a caption
    // quoting a count the bar quotes prints the same string.
    return formatTokens(chartValue(count), { style: 'short' })
  },
  duration(ms: number): string {
    // The host's own duration (spinner timer, tool and turn rows), character
    // for character, from one second up. The host never shows a sub-second
    // span, so there a plugin caption (time to first token, one fast tool
    // call) keeps its milliseconds instead of collapsing to `0s`.
    const value = chartValue(ms)
    return value > 0 && value < 1000 ? `${Math.max(1, Math.floor(value))}ms` : formatDuration(value)
  },
  percent(ratio: number, digits?: number): string {
    return `${(chartValue(ratio) * 100).toFixed(Math.min(3, cellCount(digits)))}%`
  },
  relativeTime(at: number, now?: number): string {
    if (typeof at !== 'number' || !Number.isFinite(at)) return 'now'
    const end = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
    const seconds = Math.floor((end - at) / 1000)
    if (!(seconds >= 1)) return 'now'
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h`
    return `${Math.floor(hours / 24)}d`
  },
  cells(text: string): number {
    return typeof text === 'string' ? stringWidth(text) : 0
  },
  truncate(text: string, cells: number): string {
    return fitCells(chartText(text), cells)
  },
})
