/**
 * Chart colors: categorical palette slots and `TuiChartColor` resolution.
 *
 * A chart color is a palette slot (an integer, cycling over `chart1`…`chart8`)
 * or a semantic theme key. Literal colors (`#ff0000`, `rgb(…)`, `ansi:red`)
 * are refused on purpose — a chart must follow the active palette — and fall
 * back instead of reaching the renderer.
 */

import { DEPRECATED_THEME_KEY_ALIASES, getTheme, normalizeThemeKey, type Theme } from '../../theme.js'

/** The categorical slots, in series order. */
export const CHART_SERIES_KEYS = Object.freeze([
  'chart1',
  'chart2',
  'chart3',
  'chart4',
  'chart5',
  'chart6',
  'chart7',
  'chart8',
] as const)

export type ChartSeriesKey = (typeof CHART_SERIES_KEYS)[number]

/** Palette slot → theme key: `chart{(index mod 8) + 1}`. Negative indices wrap; non-finite ones take `chart1`. */
export function seriesColor(index: number): ChartSeriesKey {
  const slot = typeof index === 'number' && Number.isFinite(index) ? Math.trunc(index) : 0
  const size = CHART_SERIES_KEYS.length
  return CHART_SERIES_KEYS[((slot % size) + size) % size]!
}

/** Code units {@link hashSeries} reads: far longer than any tool, skill or
 *  agent name, so a generated multi-megabyte key costs a bounded loop. */
const HASH_SERIES_UNITS = 256

/**
 * Stable palette slot (0…7) for an open-ended name — a tool, skill or agent
 * keeps its color in every view and session. 32-bit FNV-1a over the UTF-16
 * code units, so the answer never depends on process, locale or insertion
 * order. Only the first {@link HASH_SERIES_UNITS} code units are read: longer
 * names that share them share a slot.
 */
export function hashSeries(key: string): number {
  const text = typeof key === 'string' ? key : String(key)
  const end = Math.min(text.length, HASH_SERIES_UNITS)
  let hash = 0x811c9dc5
  for (let index = 0; index < end; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % CHART_SERIES_KEYS.length
}

/** The longest name a chart color can be (theme keys and legacy aliases): a
 *  longer string is no key and falls back unread. */
const MAX_COLOR_KEY_LENGTH = Math.max(
  ...[...Object.keys(getTheme('dark')), ...Object.keys(DEPRECATED_THEME_KEY_ALIASES)].map(key => key.length),
)

/**
 * Resolve a plugin-supplied `TuiChartColor` to a theme key: a number
 * picks a palette slot, a string must name a theme key (legacy aliases
 * normalize). Anything else — literal colors included — yields `fallback`.
 * Typed `unknown` because plugin JavaScript is not held to the contract.
 */
export function chartColorKey(color: unknown, fallback?: keyof Theme): keyof Theme | undefined {
  if (typeof color === 'number') return seriesColor(color)
  if (typeof color === 'string') return color.length <= MAX_COLOR_KEY_LENGTH ? normalizeThemeKey(color) ?? fallback : fallback
  return fallback
}
