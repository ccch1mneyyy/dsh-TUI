/**
 * Token/byte display formatters, ported from the leaked Claude Code source
 * (src/utils/format.ts) minus the app-level formatter registry.
 */

function numberFormatter(compact: boolean): Intl.NumberFormat {
  return new Intl.NumberFormat('en', {
    notation: compact ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  })
}

/**
 * Format a number for display, switching to compact notation at 1000.
 * @param number - The value to format.
 * @returns The formatted number, lowercased (e.g. `1.2k`).
 */
export function formatNumber(number: number): string {
  const compact = number >= 1000
  return numberFormatter(compact).format(number).toLowerCase()
}

/**
 * Format a token count, dropping a trailing `.0` from compact values.
 * @param count - The token count to format.
 * @returns The formatted count (e.g. `988`, `3.4k`).
 */
export function formatTokens(count: number): string {
  return formatNumber(count).replace('.0', '')
}

/**
 * Compact duration like `12s`, `3m 4s`, `1h 2m` (ported from the leak).
 * @param durationMs - Duration in milliseconds; negative values clamp to zero.
 * @param options - Formatting options; `mostSignificantOnly` stops after the first non-zero unit.
 * @returns The space-joined duration string with `h`/`m`/`s` units.
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
  if (hours > 0) {
    parts.push(`${hours}h`)
    if (mostSignificantOnly) return parts.join(' ')
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`)
    if (mostSignificantOnly && hours === 0) return parts.join(' ')
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`)
  }
  return parts.join(' ')
}
