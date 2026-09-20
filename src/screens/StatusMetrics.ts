/**
 * Status-line metric renderers, ported from two pi extensions:
 *  - `pi-nano-context`: segmented context progress bar (morandi pastel
 *    segments by content type, free space right-aligned with the usage
 *    readout, largest-remainder column allocation).
 *  - `pi-tps-meter`: live 1/8-cell gauge while streaming and a min-max
 *    normalized sparkline after each completed turn; colors green ≥ 50 tps,
 *    yellow ≥ 20, red below.
 */
import type { Color } from '../ink/styles.js'
import { stringWidth } from '../ink/stringWidth.js'

/** Context bar segments — DeepSeek blue family (dark-theme friendly: deep
 *  navy → brand blue, neutral grey free segment).
 *
 *  The bar draws NO text inside a used segment: the fill color is the whole
 *  signal (community feedback — the old `s`/`p`/`t` letters read as noise on
 *  a row that is already decorative). `labels` therefore belongs to the hover
 *  breakdown only: index 0 is the readable name, index 1 the short form the
 *  supplemental row falls back to on a narrow terminal. Exported for the
 *  hoverable JSX bar (ContextBarView), which re-derives the same column split
 *  this module's ANSI path renders. */
export const USED_SEGMENTS = [
  { key: 'system', color: '#22305F', labels: ['system', 'sys'] }, // deep navy
  { key: 'prompt', color: '#2B3D78', labels: ['prompt', 'pr'] }, // navy
  { key: 'assistant', color: '#344A92', labels: ['assistant', 'ast'] }, // indigo
  { key: 'thinking', color: '#4D6BFE', labels: ['thinking', 'th'] }, // DeepSeek brand blue
  { key: 'tools', color: '#5A7CFF', labels: ['tools', 'tl'] }, // lighter blue
] as const

/** Used tokens per context content type (system, prompt, assistant, thinking, tools). */
export type ContextSegments = Record<(typeof USED_SEGMENTS)[number]['key'], number>

/** Free-segment colors: light grey fill, dark grey readout. Exported so the
 *  JSX bar (ContextBarView) and the hover chip paint the same free color the
 *  ANSI path does instead of re-declaring the hex. */
export const FREE_SEGMENT_FILL = '#E8E8E8'
export const FREE_SEGMENT_TEXT = '#4A4A4A'

const ANSI_RE = /\x1b\[[0-9;]*m/g
const stripAnsi = (text: string): string => text.replace(ANSI_RE, '')
const plainWidth = (text: string): number => Array.from(stripAnsi(text)).length

function ansiColor(mode: 38 | 48, hex: string, text: string): string {
  const value = Number.parseInt(hex.replace(/^#/, ''), 16)
  const red = (value >> 16) & 0xff
  const green = (value >> 8) & 0xff
  const blue = value & 0xff
  return `\x1b[${mode};2;${red};${green};${blue}m${text}\x1b[${mode === 38 ? 39 : 49}m`
}

const foreground = (hex: string, text: string): string => ansiColor(38, hex, text)
const background = (hex: string, text: string): string => ansiColor(48, hex, text)

/** Compact token count like pi's: `988`, `3.4k`, `12k`, `1.0M`.
 * @param count - The raw token count; negative values clamp to zero.
 * @returns The compact count string.
 */
export function formatTokens(count: number): string {
  const value = Math.max(0, Math.round(count))
  if (value < 1000) return String(value)
  if (value < 10000) return `${(value / 1000).toFixed(1)}k`
  if (value < 1000000) return `${Math.round(value / 1000)}k`
  if (value < 10000000) return `${(value / 1000000).toFixed(1)}M`
  return `${Math.round(value / 1000000)}M`
}

/** Context-pressure thresholds, shared by the bar readout's tint, the ctx
 *  field's hover gauge, and contextPressurePct's amber/red footer convention
 *  (amber ≥ 80%, red ≥ 95%). */
const PRESSURE_WARN = 80
const PRESSURE_DANGER = 95

/** Which pressure step a context occupancy falls in: undefined while the
 *  context is comfortable, then the shared `warning` / `error` theme colors.
 * @param pct - Context occupancy percent (0–100+).
 * @returns The theme color key, or undefined below the amber threshold.
 */
export function contextPressureStep(pct: number): 'warning' | 'error' | undefined {
  if (pct >= PRESSURE_DANGER) return 'error'
  if (pct >= PRESSURE_WARN) return 'warning'
  return undefined
}

// --- Context bar (pi-nano-context) ---

/**
 * The bar's right-aligned usage readout, longest form first: token counts and
 * percent (`13k/64k 19.5%`), then the percent alone once the free segment is
 * too narrow to carry the counts.
 * @param usedTokens - Total context tokens in use.
 * @param contextWindow - The context window size in tokens.
 * @returns The readout ladder, widest option first.
 */
export function contextBarReadout(
  usedTokens: number,
  contextWindow: number,
): readonly string[] {
  const percent = `${((usedTokens / contextWindow) * 100).toFixed(1)}%`
  return [`${formatTokens(usedTokens)}/${formatTokens(contextWindow)} ${percent}`, percent]
}

// --- Context bar (pi-nano-context) ---

/**
 * Blank-pad to `width` cells and right-align the first readout option that
 * fits. Shared by the ANSI string path (renderContextBar) and the hoverable
 * JSX bar (ContextBarView) so both render identical readouts.
 */
export function rightAlignBarText(
  options: readonly string[],
  width: number,
): string {
  if (width <= 0) return ''
  const content = Array.from({ length: width }, () => ' ')
  for (const option of options) {
    const start = width - plainWidth(option)
    if (start < 0) continue
    for (const [offset, char] of Array.from(option).entries()) {
      content[start + offset] = char
    }
    break
  }
  return content.join('')
}

/** A used segment's fill: background color only, no text. Letters inside the
 *  bar read as noise (community feedback) and never fit the narrow segments
 *  anyway — the pointer names a color now (contextBarBreakdown). */
function renderUsedSegment(color: string, width: number): string {
  if (width <= 0) return ''
  return background(color, ' '.repeat(width))
}

function renderFreeSegment(
  options: readonly string[],
  width: number,
  fill: string,
  style: (text: string) => string,
): string {
  if (width <= 0) return ''
  return background(fill, style(rightAlignBarText(options, width)))
}

/** One entry of the context bar's hover breakdown: the fill color, the name
 *  to put next to a swatch of it, and the token count already folded into
 *  `label` (`system 1.2k`). */
export type ContextBarBreakdownEntry = {
  /** `system` … `tools`, or `free`. */
  key: string
  /** The chip label, e.g. `thinking 5.0k`. */
  label: string
  /** The segment's fill color — the hover chip paints with it, which is what
   *  ties each number back to a slice of the bar. */
  color: Color
}

/** Separator between breakdown entries, chosen by the width ladder below. */
export type ContextBarBreakdown = {
  readonly entries: readonly ContextBarBreakdownEntry[]
  readonly separator: string
}

/**
 * The context bar's hover breakdown — the legend the bar no longer carries
 * itself. One entry per segment the bar actually paints (a zero-token content
 * type gets no columns, so it gets no entry either), in bar order, free last.
 *
 * `columns` picks the label form: readable names with a ` · ` separator while
 * the line fits, then the short forms, then a bare space separator (the color
 * chip already separates the entries). The caller renders each entry as
 * `chip + space + label`, which is what the fit test measures.
 *
 * @param segments - Used tokens per content type.
 * @param usedTokens - Total used tokens; the remainder is the free entry.
 * @param contextWindow - The context window size in tokens.
 * @param columns - Terminal width; the footer's own padding is subtracted here.
 * @param freeFill - The free segment's fill color (callers pass a theme override).
 * @returns The breakdown entries and the separator to join them with.
 */
export function contextBarBreakdown(
  segments: ContextSegments,
  usedTokens: number,
  contextWindow: number,
  columns: number,
  freeFill: Color = FREE_SEGMENT_FILL,
): ContextBarBreakdown {
  if (contextWindow <= 0) return { entries: [], separator: ' · ' }
  const freeTokens = Math.max(0, contextWindow - usedTokens)
  const raw: { key: string; tokens: number; color: Color; labels: readonly string[] }[] = []
  for (const segment of USED_SEGMENTS) {
    const tokens = segments[segment.key]
    if (tokens > 0) {
      raw.push({ key: segment.key, tokens, color: segment.color, labels: segment.labels })
    }
  }
  if (freeTokens > 0) raw.push({ key: 'free', tokens: freeTokens, color: freeFill, labels: ['free'] })
  if (raw.length === 0) return { entries: [], separator: ' · ' }
  // Footer padding (1 cell each side) plus slack for the trajectory wake that
  // shares this row: a breakdown one cell too long would truncate its tail.
  const budget = columns - 6
  // Widest form first; the last rung wins when nothing fits (the row then
  // truncates like every other hover detail).
  const rungs = [
    { separator: ' · ', labelIndex: 0 },
    { separator: ' ', labelIndex: 0 },
    { separator: ' ', labelIndex: 1 },
  ] as const
  let rung: { separator: string; labelIndex: number } = { separator: ' ', labelIndex: 1 }
  for (const candidate of rungs) {
    rung = candidate
    const labels = raw.map(entry => breakdownLabel(entry, candidate.labelIndex))
    // One chip cell per entry prefixes each label on the supplemental row.
    // Measured in terminal cells with the renderer's own helper, not UTF-16
    // units: the ` · ` separator is East-Asian ambiguous, and the label set is
    // free to gain non-ASCII names later.
    const rendered =
      labels.reduce((sum, label) => sum + stringWidth(label), 0)
      + labels.length
      + stringWidth(candidate.separator) * (labels.length - 1)
    if (rendered <= budget) break
  }
  return {
    entries: raw.map(entry => ({
      key: entry.key,
      color: entry.color,
      label: breakdownLabel(entry, rung.labelIndex),
    })),
    separator: rung.separator,
  }
}

function breakdownLabel(
  entry: { key: string; tokens: number; labels: readonly string[] },
  labelIndex: number,
): string {
  const name = entry.labels[labelIndex] ?? entry.labels[0] ?? entry.key
  return `${name} ${formatTokens(entry.tokens)}`
}

/** Largest-remainder column allocation (pi-nano-context). */
function allocateProportionally(values: readonly number[], columns: number): number[] {
  if (columns <= 0) return values.map(() => 0)
  const total = values.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return values.map(() => 0)
  const rawColumns = values.map(value => (value / total) * columns)
  const allocatedColumns = rawColumns.map(Math.floor)
  let remaining = columns - allocatedColumns.reduce((sum, value) => sum + value, 0)
  const largestRemainders = rawColumns
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((left, right) => right.remainder - left.remainder)
  for (const slot of largestRemainders) {
    if (remaining <= 0) break
    allocatedColumns[slot.index] = (allocatedColumns[slot.index] ?? 0) + 1
    remaining--
  }
  return allocatedColumns
}

/** Give every visible used segment at least one column before sharing the
 *  rest. Exported for ContextBarView (hoverable JSX twin of the bar). */
export function allocateBarColumns(values: readonly number[], width: number): number[] {
  const visibleUsedSegments = USED_SEGMENTS
    .map((_, index) => index)
    .filter(index => (values[index] ?? 0) > 0)
  if (visibleUsedSegments.length === 0 || visibleUsedSegments.length >= width) {
    return allocateProportionally(values, width)
  }
  const minimumColumns = Array.from({ length: values.length }, () => 0)
  for (const index of visibleUsedSegments) {
    minimumColumns[index] = 1
  }
  const remainingColumns = allocateProportionally(
    values,
    width - visibleUsedSegments.length,
  )
  return minimumColumns.map(
    (minimum, index) => minimum + (remainingColumns[index] ?? 0),
  )
}

/**
 * The segmented context bar: used segments by content type, then the
 * remainder as a light free segment whose right edge carries the usage
 * readout (`13k/64k 19.5%`). No other text — the bar is read by color, and
 * the pointer supplies the names and numbers (contextBarBreakdown). The
 * readout tints amber / red as the context fills (contextPressureStep).
 * @param segments - Used tokens per content type.
 * @param usedTokens - Total used tokens, driving the usage readout.
 * @param contextWindow - The context window size in tokens.
 * @param width - Total bar width in terminal columns.
 * @returns The ANSI-styled segmented bar, or '' when `width` or `contextWindow` is non-positive.
 */
export function renderContextBar(
  segments: ContextSegments,
  usedTokens: number,
  contextWindow: number,
  width: number,
  colors?: { freeFill: string; freeText: string },
): string {
  if (width <= 0 || contextWindow <= 0) return ''
  const freeTokens = Math.max(0, contextWindow - usedTokens)
  const values = [...USED_SEGMENTS.map(segment => segments[segment.key]), freeTokens]
  const columns = allocateBarColumns(values, width)
  const used = USED_SEGMENTS.map((segment, index) =>
    renderUsedSegment(segment.color, columns[index] ?? 0),
  ).join('')
  const freeWidth = columns[USED_SEGMENTS.length] ?? 0
  const pct = (usedTokens / contextWindow) * 100
  const step = contextPressureStep(pct)
  // Same two-path convention as the free-segment colors: the JSX bar tints
  // through the theme key, this string path through the raw ANSI twin.
  const style = step === undefined
    ? (text: string) => foreground(colors?.freeText ?? FREE_SEGMENT_TEXT, text)
    : (text: string) => pressureColor(pct, text)
  return `${used}${renderFreeSegment(
    contextBarReadout(usedTokens, contextWindow),
    freeWidth,
    colors?.freeFill ?? FREE_SEGMENT_FILL,
    style,
  )}`
}

// --- Mini context bar (footer ctx-field hover) ---

/** Pressure-colored text: green below 80%, amber ≥ 80, red ≥ 95.
 * @param pct - Context occupancy percent (0–100+).
 * @param text - Text to color.
 * @returns The ANSI 24-bit color-wrapped text.
 */
export function pressureColor(pct: number, text: string): string {
  const key = contextPressureStep(pct) ?? 'success'
  return `\x1b[38;2;${colorHex(key)}m${text}\x1b[39m`
}

/** Compact 1/8-cell context gauge for the footer's ctx field on hover:
 *  `▕██████▋···▏`, fill proportional to context occupancy, colored by the
 *  amber/red pressure thresholds. Same block ramp as the TPS gauge.
 * @param usedTokens - Total context tokens in use.
 * @param contextWindow - Context window size in tokens.
 * @param width - Gauge width in terminal columns (fill cells, brackets excluded).
 * @returns The ANSI gauge string, or '' for a non-positive window.
 */
export function renderMiniContextBar(
  usedTokens: number,
  contextWindow: number,
  width = 10,
): string {
  if (contextWindow <= 0 || width <= 0) return ''
  const pct = Math.min(100, Math.max(0, (usedTokens / contextWindow) * 100))
  const frac = pct / 100
  const eighths = Math.round(frac * width * 8)
  const full = Math.floor(eighths / 8)
  const rem = eighths % 8
  let fill = '█'.repeat(Math.min(full, width))
  if (full < width && rem > 0) {
    fill += HBLOCKS[rem]
  }
  const track = TRACK.repeat(Math.max(0, width - fill.length))
  return `▕${pressureColor(pct, fill)}${`\x1b[2m${track}\x1b[22m`}▏`
}

// --- TPS gauge + sparkline (pi-tps-meter) ---

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
const HBLOCKS = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
const GAUGE_LEN = 11
const GAUGE_FLOOR = 40
const TRACK = '·'
const FAST = 50
const MED = 20

/** Speed color: green ≥ 50, yellow ≥ 20, red below (pi-tps-meter).
 * @param tps - Tokens per second; selects the color threshold.
 * @param text - Text to color.
 * @returns The ANSI 24-bit color-wrapped text.
 */
export function speedColor(tps: number, text: string): string {
  const color = tps >= FAST ? 'success' : tps >= MED ? 'warning' : 'error'
  return `\x1b[38;2;${colorHex(color)}m${text}\x1b[39m`
}

function colorHex(key: 'success' | 'warning' | 'error'): string {
  // dsh-tui dark theme values (theme.ts), semicolon-separated for raw ANSI.
  const palette: Record<string, string> = {
    success: '78;186;101',
    warning: '202;138;4',
    error: '255;107;128',
  }
  return palette[key] ?? '255;255;255'
}

/** Live 1/8-cell horizontal gauge: `▕███████▋···▏`.
 * @param tps - Current tokens per second.
 * @param peak - Scaling peak; values below 40 scale against the floor instead.
 * @returns The ANSI gauge string.
 */
export function renderTpsGauge(tps: number, peak: number): string {
  const scale = Math.max(peak, GAUGE_FLOOR)
  const frac = Math.min(1, Math.max(0, scale > 0 ? tps / scale : 0))
  const eighths = Math.round(frac * GAUGE_LEN * 8)
  const full = Math.floor(eighths / 8)
  const rem = eighths % 8
  let fill = '█'.repeat(full)
  if (full < GAUGE_LEN && rem > 0) {
    fill += HBLOCKS[rem]
  }
  const track = TRACK.repeat(Math.max(0, GAUGE_LEN - fill.length))
  return `▕${speedColor(tps, fill)}${`\x1b[2m${track}\x1b[22m`}▏`
}

/** Min-max normalized 12-sample sparkline: `▁▄▇▅▂▁▇█▅▃▆▇`.
 * @param samples - Turn TPS samples; only the last 12 are rendered.
 * @returns The ANSI sparkline string.
 */
export function renderTpsSparkline(samples: readonly { tps: number }[]): string {
  const vals = samples.slice(-12)
  if (vals.length === 0) return '\x1b[2m' + TRACK.repeat(12) + '\x1b[22m'
  let min = Infinity
  let max = 0
  for (const { tps } of vals) {
    if (tps < min) min = tps
    if (tps > max) max = tps
  }
  const range = max - min
  return vals
    .map(({ tps }) => {
      const norm =
        range < 1e-6
          ? max > 0
            ? 4
            : 0
          : Math.min(7, Math.max(0, Math.round(((tps - min) / range) * 7)))
      return speedColor(tps, BLOCKS[norm] ?? '▁')
    })
    .join('')
}

/** Rolling stats: 60s average, all-time mean and p95.
 * @param samples - Turn TPS samples with their timestamps in milliseconds.
 * @param nowMs - Current time in milliseconds; the 60s rolling window keeps samples with `nowMs - at <= 60_000`.
 * @returns The 60s average, all-time mean, and all-time p95 (all zero for an empty sample list).
 */
export function tpsStats(samples: readonly { tps: number; at: number }[], nowMs: number): {
  avg: number
  mean: number
  p95: number
} {
  if (samples.length === 0) return { avg: 0, mean: 0, p95: 0 }
  const window = samples.filter(sample => nowMs - sample.at <= 60_000)
  const avg = window.length > 0
    ? window.reduce((sum, sample) => sum + sample.tps, 0) / window.length
    : 0
  const mean = samples.reduce((sum, sample) => sum + sample.tps, 0) / samples.length
  const sorted = [...samples].map(sample => sample.tps).sort((a, b) => a - b)
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0
  return { avg, mean, p95 }
}
