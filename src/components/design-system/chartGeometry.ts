/**
 * Pure geometry behind the chart kit (docs/plugin-ui-kit-design.md §1).
 *
 * Everything here is cells and integers: no React, no theme, no I/O, so the
 * invariants (allocations always sum to the budget, bad numbers render as 0)
 * are testable headlessly. Untrusted plugin numbers come through these
 * helpers first; none of them throws.
 */

/**
 * Upper bound on any cell or row count a chart will build. A plugin passing a
 * runaway finite width must not make a render allocate a gigabyte string; no
 * terminal is anywhere near this wide (a non-finite one counts as 0).
 */
export const MAX_CHART_CELLS = 2000

/**
 * Upper bound on the data items one chart reads: bar segments, sparkline
 * values, legend items, and a column chart's segments in total (split evenly
 * over its columns). A generated list past it must not make every render
 * map, sort and walk it whole; the rest is left out — a sparkline keeps its
 * newest values, a legend counts the rest into its `+N` chip. Far more than
 * a track of at most {@link MAX_CHART_CELLS} cells can tell apart.
 */
export const MAX_CHART_ITEMS = 10_000

/** Horizontal eighth-block ladder: index = filled eighths of the cell (0…8). */
export const HORIZONTAL_EIGHTHS: readonly string[] = Object.freeze([' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'])

/** Vertical (lower) eighth-block ladder: index = filled eighths from the bottom (0…8). */
export const VERTICAL_EIGHTHS: readonly string[] = Object.freeze([' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'])

/** A non-finite or negative chart value renders as 0. */
export function chartValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** A cell/row count: a non-negative integer, capped at {@link MAX_CHART_CELLS}.
 *  Like every chart number, a non-finite one (NaN, ±Infinity) counts as 0 —
 *  an invalid size draws nothing rather than the largest chart. */
export function cellCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.min(MAX_CHART_CELLS, Math.floor(value))
}

/**
 * Largest-remainder split of `cells` over `values` (ties go to the earlier
 * index): integers summing to exactly `cells`, or all zero when the values
 * sum to zero. The raw algorithm under {@link allocateCells}, for callers
 * that split something other than screen cells — the context bar attributes
 * a token total with it, which no cell cap may clip. `values` must already be
 * finite and non-negative (pass them through {@link chartValue}) and `cells`
 * a non-negative integer.
 */
export function largestRemainder(values: readonly number[], cells: number): number[] {
  const out = values.map(() => 0)
  if (cells <= 0) return out
  let total = 0
  for (const value of values) total += value
  // Finite values can still sum past Number.MAX_VALUE; every share would then
  // read as 0. Rescale by the largest value only in that case, so ordinary
  // inputs keep exactly the arithmetic (and tie-breaks) they always had.
  let scale = 1
  if (!Number.isFinite(total)) {
    scale = values.reduce((peak, value) => Math.max(peak, value), 0)
    total = values.reduce((sum, value) => sum + value / scale, 0)
  }
  if (total <= 0) return out
  const remainders: { index: number; remainder: number }[] = []
  let used = 0
  for (let index = 0; index < values.length; index += 1) {
    const exact = (values[index]! / scale / total) * cells
    const whole = Math.floor(exact)
    out[index] = whole
    used += whole
    remainders.push({ index, remainder: exact - whole })
  }
  // Array.prototype.sort is stable, so equal remainders keep index order.
  remainders.sort((left, right) => right.remainder - left.remainder)
  for (let slot = 0; slot < remainders.length && used < cells; slot += 1) {
    out[remainders[slot]!.index]! += 1
    used += 1
  }
  return out
}

/**
 * Share `cells` across `values` by the largest-remainder method. The result
 * always sums to exactly `cells`, or to 0 when every value is 0 (an empty bar
 * is the caller's empty track, not an arbitrary segment).
 *
 * `keepVisible` gives every non-zero value at least one cell when the budget
 * has room for all of them, then shares the rest proportionally. When it does
 * not, the budget goes one cell each to the largest values (earlier index on
 * ties) and the smallest are dropped.
 */
export function allocateCells(
  values: readonly number[],
  cells: number,
  options: { readonly keepVisible?: boolean } = {},
): number[] {
  const clean = values.map(chartValue)
  const budget = cellCount(cells)
  if (options.keepVisible !== true) return largestRemainder(clean, budget)
  const visible: number[] = []
  for (let index = 0; index < clean.length; index += 1) {
    if (clean[index]! > 0) visible.push(index)
  }
  if (visible.length === 0 || budget === 0) return clean.map(() => 0)
  if (budget < visible.length) {
    const out = clean.map(() => 0)
    const ranked = [...visible].sort((left, right) => clean[right]! - clean[left]!)
    for (const index of ranked.slice(0, budget)) out[index] = 1
    return out
  }
  const rest = largestRemainder(clean, budget - visible.length)
  for (const index of visible) rest[index]! += 1
  return rest
}

/**
 * Fit a series into `width` cells. Fewer values than cells come back as they
 * are (the caller pads); more are reduced: `bucket` splits them into `width`
 * contiguous buckets and keeps each bucket's peak (a spike never disappears),
 * `tail` keeps the newest `width`. Values are sanitized to non-negative.
 */
export function resample(
  values: readonly number[],
  width: number,
  fit: 'bucket' | 'tail' = 'bucket',
): number[] {
  const cells = cellCount(width)
  const clean = values.map(chartValue)
  if (clean.length <= cells) return clean
  if (cells === 0) return []
  if (fit === 'tail') return clean.slice(clean.length - cells)
  const out: number[] = []
  for (let bucket = 0; bucket < cells; bucket += 1) {
    const start = Math.floor((bucket * clean.length) / cells)
    const end = Math.floor(((bucket + 1) * clean.length) / cells)
    let peak = 0
    for (let index = start; index < end; index += 1) peak = Math.max(peak, clean[index]!)
    out.push(peak)
  }
  return out
}

/**
 * Bin a value into `levels` equal intervals over `(0, max]`: 0 for zero (or a
 * non-positive scale), otherwise 1…levels — any positive value is at least
 * level 1, and values above `max` clamp to the top.
 */
export function quantize(value: number, max: number, levels: number): number {
  const v = chartValue(value)
  const scale = chartValue(max)
  const steps = Math.max(1, cellCount(levels))
  if (v === 0 || scale === 0) return 0
  return Math.min(steps, Math.max(1, Math.ceil((v / scale) * steps)))
}

/**
 * Eighths of a `cells`-long track that `value` fills on a `0…max` scale,
 * rounded to the nearest eighth and clamped to the track.
 */
export function eighthsOf(value: number, max: number, cells: number): number {
  const scale = chartValue(max)
  const track = cellCount(cells) * 8
  if (scale === 0) return 0
  return Math.min(track, Math.max(0, Math.round((chartValue(value) / scale) * track)))
}
