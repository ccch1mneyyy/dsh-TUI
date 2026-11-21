/**
 * Number, token-count, and duration formatters shared by the status line,
 * message rows, the context bar, the trajectory views and the plugin chart
 * kit (`ui.format.tokens` / `ui.format.duration` print through these, so a
 * plugin caption never disagrees with the host).
 *
 * All number output uses the `en` locale with at most one fraction digit.
 * Values at or above 1000 switch to compact notation (e.g. `1.5K`), which
 * callers receive lowercased as `1.5k` for a calmer status-line look.
 */

/** The two notations, built once: constructing an Intl formatter per call is
 *  the expensive part, and the footer formats several numbers every frame. */
let compactFormat: Intl.NumberFormat | undefined
let standardFormat: Intl.NumberFormat | undefined

/** The formatter that emits either compact or standard notation. */
function numberFormat(compact: boolean): Intl.NumberFormat {
  if (compact) {
    compactFormat ??= new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
    return compactFormat
  }
  standardFormat ??= new Intl.NumberFormat('en', { notation: 'standard', maximumFractionDigits: 1 })
  return standardFormat
}

/**
 * Format a number for display, switching to compact notation at 1000.
 * @param number - The value to format.
 * @returns The formatted number, lowercased (e.g. `1.2k`, `1.5m`).
 */
export function formatNumber(number: number): string {
  return numberFormat(number >= 1000).format(number).toLowerCase()
}

/**
 * How a token count spends its cells:
 *
 * - `precise` (the default): up to one decimal at every magnitude, lowercase
 *   compact units — `988`, `3.4k`, `12.3k`, `123.5k`, `1.2m`. The status line's
 *   token/cache/cost fields and their hover details, the transcript's usage
 *   rows, `/cost`, and the trajectory views.
 * - `short`: a width-bounded ladder — one decimal below ten of a unit, whole
 *   units above, upper-case `M` — `988`, `3.4k`, `12k`, `1.0M`, `12M`. The
 *   context bar's readout and hover breakdown, and plugin chart captions
 *   (`ui.format.tokens`), where the number shares a row with a bar and must
 *   not grow it. Non-finite and negative counts print `0`.
 *
 * They agree on whole counts below 1000 and part above it (`1k`/`1.0k`,
 * `12.3k`/`12k`, `1.2m`/`1.2M`). Both stay because the footer prints both —
 * the token field one, the context bar the other — and folding either into
 * the other would change what the status line shows.
 */
export type TokenCountStyle = 'precise' | 'short'

/** The width-bounded ladder (see {@link TokenCountStyle}). */
function shortTokens(count: number): string {
  const value = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0
  // Each tier ends where its ROUNDED digits would reach the next one, so a
  // boundary count promotes (9,960 → `10k`, 999,600 → `1.0M`) instead of
  // printing `10.0k` / `1000k`.
  if (value < 1000) return String(value)
  if (value < 9_950) return `${(value / 1000).toFixed(1)}k`
  if (value < 999_500) return `${Math.round(value / 1000)}k`
  if (value < 9_950_000) return `${(value / 1_000_000).toFixed(1)}M`
  return `${Math.round(value / 1_000_000)}M`
}

/**
 * Format a token count for display. Both ladders live here so a surface picks
 * one by name instead of carrying its own copy.
 * @param count - The token count to format.
 * @param options - `style` picks the ladder; `precise` when omitted.
 * @returns The formatted count (e.g. `988`, `3.4k`, `12.3k` / `12k`).
 */
export function formatTokens(count: number, options?: { readonly style?: TokenCountStyle }): string {
  return options?.style === 'short' ? shortTokens(count) : formatNumber(count)
}

/**
 * Format a duration in milliseconds as a compact `h`/`m`/`s` string
 * (e.g. `12s`, `3m 4s`, `1h 2m`).
 * Negative durations are clamped to zero; a zero duration renders as `0s`.
 * @param durationMs - Duration in milliseconds.
 * @param options - `mostSignificantOnly` stops at the first non-zero unit
 *                  (e.g. `1h`, `3m`) instead of emitting every unit.
 * @returns The space-joined duration string.
 */
export function formatDuration(
  durationMs: number,
  options: { mostSignificantOnly?: boolean } = {},
): string {
  const { mostSignificantOnly = false } = options

  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  const parts: string[] = []
  let stopAfterFirst = false

  if (hours > 0) {
    parts.push(`${hours}h`)
    stopAfterFirst = mostSignificantOnly
  }
  if (!stopAfterFirst && minutes > 0) {
    parts.push(`${minutes}m`)
    stopAfterFirst = mostSignificantOnly && hours === 0
  }
  if (!stopAfterFirst && (seconds > 0 || parts.length === 0)) {
    parts.push(`${seconds}s`)
  }

  return parts.join(' ')
}
