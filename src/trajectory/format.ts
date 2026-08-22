/**
 * Trajectory formatting — durations, clocks, badges and heat.
 *
 * Presentation only, and deliberately in the UI layer rather than beside the
 * projection: these decisions are about a terminal's width and palette, not
 * about what the session log means.
 */

import { visibleWidth } from '../tui/public.js'
import type { Theme } from '../theme.js'
import type { TrajKind } from '../dsh-adapter/types.js'

/**
 * Truncate to a terminal DISPLAY width, CJK-aware (a wide char costs two
 * columns). Used where the caller must control the cut precisely: a generic
 * renderer's truncate mode may append its ellipsis as soon as the content is
 * as wide as its box rather than wider, silently eating the last character of
 * a right-aligned group that was laid out at exactly its natural width.
 *
 * @param text - Plain text (no ANSI).
 * @param maxWidth - Column budget, ellipsis included.
 * @returns `text` unchanged when it fits, otherwise a cut ending in `…`.
 */
export function truncateWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (visibleWidth(text) <= maxWidth) return text
  let width = 0
  let out = ''
  for (const char of text) {
    const charWidth = visibleWidth(char)
    if (width + charWidth > maxWidth - 1) break
    width += charWidth
    out += char
  }
  return `${out}…`
}

/** `HH:MM:SS` local wall-clock of an epoch-ms timestamp. */
export function formatClock(time: number): string {
  const date = new Date(time)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Compact duration: `82ms` / `1.4s` / `2m05s` / `1h04m`.
 *
 * Every form is at most six columns wide, so the ledger's duration column
 * never reflows when a fast call is followed by a slow one.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) {
    const minutes = Math.floor(ms / 60_000)
    return `${minutes}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`
  }
  const hours = Math.floor(ms / 3_600_000)
  return `${hours}h${String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0')}m`
}

/** Compact token count: `840` / `12.4k` / `1.1M`. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(Math.round(count))
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

/**
 * Heat colour for a duration cell.
 *
 * The point of the ledger is usually to find the slow thing, so the duration
 * column encodes magnitude as colour: anything under a second recedes, tens
 * of seconds warn, minutes shout. Reading a column of numbers is work; seeing
 * one red cell is not.
 */
export function heatColor(ms: number | undefined): keyof Theme {
  if (ms === undefined) return 'subtle'
  if (ms >= 60_000) return 'error'
  if (ms >= 10_000) return 'warning'
  if (ms >= 1000) return 'inactiveShimmer'
  return 'subtle'
}

/**
 * Cost glyph for a row's own duration — an ABSOLUTE, learnable scale.
 *
 * A relative scale (tallest row in view = full block) would re-teach itself on
 * every scroll; fixed thresholds mean `█` always says "over a minute" and `▁`
 * always says "instant", so after one session the column is read without
 * looking at the number beside it. Each step is roughly half an order of
 * magnitude, which is the resolution a human actually acts on.
 */
export function costGlyph(ms: number | undefined): string {
  if (ms === undefined) return ' '
  if (ms >= 60_000) return '█'
  if (ms >= 30_000) return '▇'
  if (ms >= 10_000) return '▆'
  if (ms >= 3_000) return '▅'
  if (ms >= 1_000) return '▄'
  if (ms >= 300) return '▃'
  if (ms >= 100) return '▂'
  return '▁'
}

/**
 * Fixed-width badge text per row kind — six columns, including one cell of
 * padding on each side.
 *
 * The padding is what turns a coloured word into a pill. Background colour
 * flush against the glyphs reads as a highlighter smudge; a cell of ground on
 * either side reads as a chip, and chips are what let the eye group forty rows
 * by kind without reading any of them.
 */
export const KIND_BADGE: Record<TrajKind, string> = {
  turn: ' TURN ',
  step: ' STEP ',
  user: ' USR  ',
  assistant: ' AST  ',
  thinking: ' THK  ',
  tool: ' TOOL ',
  subtool: ' SUB  ',
  retry: ' RTY  ',
  approval: ' APR  ',
  compaction: ' CMP  ',
  system: ' SYS  ',
  context: ' CTX  ',
  todo: ' TODO ',
}

/** One-character badge for the narrowest layout tier. */
export const KIND_GLYPH: Record<TrajKind, string> = {
  turn: '▶',
  step: '·',
  user: '❯',
  assistant: '✦',
  thinking: '✻',
  tool: '⏺',
  subtool: '⏵',
  retry: '↻',
  approval: '⚑',
  compaction: '⊟',
  system: '⚙',
  context: '⊕',
  todo: '✓',
}

/**
 * Badge foreground per kind. Backgrounds come from {@link KIND_BADGE_BG} — the
 * pair reads as a pill, which carries far better in a dense ledger than
 * coloured text alone.
 */
export const KIND_FG: Record<TrajKind, keyof Theme> = {
  turn: 'text',
  step: 'subtle',
  user: 'suggestion',
  assistant: 'claude',
  // Reasoning is ambient: it is the most numerous row kind and the least
  // often the thing you came to find, so it recedes rather than competing
  // with tool names for the eye.
  thinking: 'inactive',
  tool: 'chromeYellow',
  subtool: 'autoAccept',
  retry: 'error',
  approval: 'warning',
  compaction: 'planMode',
  system: 'planMode',
  context: 'success',
  todo: 'planMode',
}

/**
 * Badge background per kind, or `undefined` for kinds that read better
 * unfilled (structural rows, which should recede behind the work rows).
 */
export const KIND_BADGE_BG: Partial<Record<TrajKind, keyof Theme>> = {
  user: 'userMessageBackground',
  assistant: 'userMessageBackground',
  tool: 'bashMessageBackgroundColor',
  subtool: 'bashMessageBackgroundColor',
  retry: 'diffRemoved',
  approval: 'diffRemovedDimmed',
  compaction: 'diffAddedDimmed',
  system: 'diffAddedDimmed',
  context: 'diffAdded',
  todo: 'diffAdded',
}

/**
 * Ledger column budget at a given terminal width.
 *
 * Columns are dropped whole rather than letting a row wrap: a wrapped ledger
 * row destroys the alignment that makes the whole view scannable, so at every
 * tier the row is still exactly one line.
 */
export interface LedgerLayout {
  /** Width of the badge column: 6 (padded pill), 1 (bare glyph). */
  readonly badge: 6 | 1
  /** Show the `#N` index column. */
  readonly index: boolean
  /** Show the `→ result` preview. */
  readonly outcome: boolean
  /** Characters available to the label + detail preview. */
  readonly detail: number
}

/**
 * Resolve the column budget for one terminal width.
 *
 * @param columns - Terminal width in cells.
 * @returns The tier's budget; `detail` is never below 12 so the label itself
 *   survives even on a pathologically narrow terminal.
 */
export function ledgerLayout(columns: number): LedgerLayout {
  // Fixed costs: spine (2) + clock (8) + pill (6) + cost (1) + duration (7),
  // plus one cell of gap between each.
  if (columns >= 110) return { badge: 6, index: true, outcome: true, detail: Math.max(12, columns - 72) }
  if (columns >= 90) return { badge: 6, index: true, outcome: true, detail: Math.max(12, columns - 64) }
  if (columns >= 70) return { badge: 6, index: false, outcome: false, detail: Math.max(12, columns - 26) }
  return { badge: 1, index: false, outcome: false, detail: Math.max(12, columns - 16) }
}
