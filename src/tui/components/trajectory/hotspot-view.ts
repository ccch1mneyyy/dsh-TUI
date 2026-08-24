/**
 * The hotspot view — the session ranked by cost instead of ordered by time —
 * ported from the Ink `HotspotView.tsx` to a pure string renderer for pi-tui.
 *
 * Chronology is the wrong order for "where did my half hour go": the answer
 * is a ranking, and a ranking is what this shows — cost per tool, per model
 * phase (decode vs. waiting for the first token vs. retry backoff), per turn.
 *
 * The three sections are flattened into ONE windowed row list rather than
 * laid out as three independent columns. A long session easily produces more
 * rows than the viewport has lines, and three self-sizing sections in a
 * fixed-height box overlap each other when they overflow — a flat window
 * scrolls instead, and the cursor can reach every row.
 *
 * The reveal is a staggered brightening rather than a growing bar. A bar
 * that grew would change its glyph count every frame, which is a layout
 * change, and layout changes are the one thing the motion rules forbid.
 * Sweeping colour across already-final bars reads the same and costs style
 * bytes.
 */

import { formatDuration, formatTokens, truncateWidth } from '../../../trajectory/format.js'
import { mix, reproject } from '../../../trajectory/motion.js'
import { t } from '../../../i18n.js'
import type { HotspotRow, HotspotSort, TrajAggregate } from '../../../dsh-adapter/types.js'
import { activeTheme, clip, fg, fgValue, padEnd, padStart } from './paint.js'

/** Bar cells; a half block gives one extra step of resolution for free. */
const FULL = '█'
const HALF = '▌'

function bar(value: number, max: number, width: number): string {
  if (max <= 0 || width <= 0) return ''
  const exact = (value / max) * width
  const full = Math.max(0, Math.min(width, Math.floor(exact)))
  return FULL.repeat(full) + (exact - full >= 0.5 && full < width ? HALF : '')
}

/** A section heading or one ranked row, in display order. */
type Entry =
  | { readonly kind: 'title'; readonly text: string }
  | {
      readonly kind: 'row'
      readonly row: HotspotRow
      /** Index into the flattened row list the cursor walks. */
      readonly cursorIndex: number
      /** Largest value in this row's own section, for bar scaling. */
      readonly max: number
      readonly colorKey: 'chromeYellow' | 'autoAccept' | 'professionalBlue'
    }

/** Flatten the three sections into the single list the cursor walks. */
export function hotspotRows(agg: TrajAggregate): HotspotRow[] {
  return [...agg.tools, ...agg.model, ...agg.turns]
}

/** The flat title/row list in display order (one list entry per line). */
function buildEntries(agg: TrajAggregate, sort: HotspotSort): Entry[] {
  const entries: Entry[] = []
  let cursorIndex = 0
  for (const [title, rows, colorKey] of [
    [t('traj-hot-tools'), agg.tools, 'chromeYellow'],
    [t('traj-hot-model'), agg.model, 'autoAccept'],
    [t('traj-hot-turns'), agg.turns, 'professionalBlue'],
  ] as const) {
    if (rows.length === 0) continue
    entries.push({ kind: 'title', text: title })
    const max = Math.max(...rows.map((row) => valueOf(row, sort)), 1)
    for (const row of rows) {
      entries.push({ kind: 'row', row, cursorIndex, max, colorKey })
      cursorIndex += 1
    }
  }
  return entries
}

/** First visible entry index: the window centers the cursor's entry. */
function windowStart(entries: readonly Entry[], height: number, cursor: number): number {
  const focusEntry = entries.findIndex((entry) => entry.kind === 'row' && entry.cursorIndex === cursor)
  return Math.max(0, Math.min(focusEntry - Math.floor(height / 2), entries.length - height))
}

/**
 * The pointer mapping for one rendered hotspot frame (research §4.3): the
 * clickable `HotspotRow` per visible line offset, `undefined` for section
 * titles and the padding tail. Computed with the same entries/window the
 * renderer uses, so a click always resolves against what is on screen.
 */
export function hotspotPointerRows(
  agg: TrajAggregate,
  sort: HotspotSort,
  height: number,
  cursor: number,
): (HotspotRow | undefined)[] {
  const entries = buildEntries(agg, sort)
  const start = windowStart(entries, height, cursor)
  const visible = entries.slice(Math.max(0, start), Math.max(0, start) + height)
  const rows: (HotspotRow | undefined)[] = visible.map((entry) =>
    entry.kind === 'row' ? entry.row : undefined,
  )
  while (rows.length < height) rows.push(undefined)
  return rows
}

/** Value a row is ranked by under the active sort. */
function valueOf(row: HotspotRow, sort: HotspotSort): number {
  return sort === 'count' ? row.count : sort === 'tokens' ? row.tokens : row.totalMs
}

export interface HotspotViewProps {
  agg: TrajAggregate
  sort: HotspotSort
  width: number
  /** Visible row count; the output is always exactly this many lines. */
  height: number
  cursor: number
  tick: number
  switchTick: number
}

export function renderHotspotView({ agg, sort, width, height, cursor, tick, switchTick }: HotspotViewProps): string[] {
  const theme = activeTheme()

  const labelWidth = Math.min(18, Math.max(10, Math.floor(width * 0.16)))
  const barWidth = Math.max(6, Math.min(30, width - labelWidth - 34))

  const entries = buildEntries(agg, sort)
  // Window around the cursor's entry so ↑/↓ can reach every section.
  const start = windowStart(entries, height, cursor)
  const visible = entries.slice(Math.max(0, start), Math.max(0, start) + height)

  const lines: string[] = []
  for (let offset = 0; offset < visible.length; offset++) {
    const entry = visible[offset]!
    if (entry.kind === 'title') {
      lines.push(fg('subtle', entry.text))
      continue
    }
    const { row, max, colorKey } = entry
    const focused = entry.cursorIndex === cursor
    // Stagger the settle by row so a section reads top-down on switch.
    const dim = reproject(tick - offset, switchTick)
    const base = row.error === true ? theme.error : theme[colorKey]
    const stats =
      `${row.count}×` +
      (row.tokens > 0 ? ` · ${formatTokens(row.tokens)}` : '') +
      (row.count > 0 && row.totalMs > 0 ? ` · ⌀${formatDuration(row.totalMs / row.count)}` : '')

    const segments = [
      padEnd(fg('suggestion', focused ? '▸' : ' '), 2),
      padEnd(
        clip(fg(focused ? 'suggestion' : row.error === true ? 'error' : undefined, truncateWidth(row.label, labelWidth)), labelWidth),
        labelWidth,
      ),
      padEnd(fgValue(mix(base as string, theme.background as string, dim) as string, bar(valueOf(row, sort), max, barWidth)), barWidth),
      fg(row.error === true ? 'error' : undefined, padStart(formatDuration(row.totalMs), 8), { bold: true }),
      fg('subtle', truncateWidth(stats, Math.max(4, width - labelWidth - barWidth - 16))),
    ]
    lines.push(clip(segments.join(' '), width))
  }
  while (lines.length < height) lines.push(' ')
  return lines
}
