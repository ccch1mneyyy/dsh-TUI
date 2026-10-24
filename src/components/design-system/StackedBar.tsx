import React from 'react'
import { chartColorKey, seriesColor } from './chartColor.js'
import { allocateCells, cellCount, chartValue, eighthsOf, HORIZONTAL_EIGHTHS } from './chartGeometry.js'
import { ChartLine, pushRun, type ChartRun } from './chartRows.js'
import type { TuiStackedBarProps } from './chartTypes.js'

/** Fill glyph of a hatched (reserve/forecast) segment. */
const HATCH = '╱'
/** The empty track of occupancy mode: a recessive rule, not a fill. */
const TRACK = '─'

/**
 * Lay out a one-row proportional bar: exactly `width` cells.
 *
 * Composition mode (no `capacity`): the segments share the whole width by
 * largest remainder; an all-zero bar is pure track. Occupancy mode: the filled
 * span is `sum / capacity` of the width with eighth-cell precision at its end
 * (the partial cell takes the last non-zero segment's color), the rest is
 * track in `emptyColor`. Any non-zero occupancy shows at least one eighth.
 */
export function layoutStackedBar(props: TuiStackedBarProps): ChartRun[] {
  const width = cellCount(props.width)
  if (width === 0) return []
  const segments = Array.isArray(props.segments) ? props.segments : []
  const values = segments.map(segment => chartValue(segment?.value))
  let total = 0
  for (const value of values) total += value

  let filled = total > 0 ? width : 0
  let partial = 0
  if (typeof props.capacity === 'number') {
    const capacity = chartValue(props.capacity)
    // A zero capacity with anything in it is simply full, and so is a sum
    // of finite values that overflowed: it exceeds any finite capacity.
    const eighths = capacity === 0 || total === Number.POSITIVE_INFINITY
      ? (total > 0 ? width * 8 : 0)
      : eighthsOf(total, capacity, width)
    filled = Math.floor(eighths / 8)
    partial = eighths % 8
    if (total > 0 && eighths === 0) partial = 1
  }

  const cells = allocateCells(values, filled, { keepVisible: props.keepVisible === true })
  const colors = segments.map((segment, index) => chartColorKey(segment?.color, seriesColor(index)))
  const row: ChartRun[] = []
  let lastFilled = -1
  for (let index = 0; index < segments.length; index += 1) {
    if (values[index]! > 0) lastFilled = index
    const count = cells[index]!
    if (count === 0) continue
    pushRun(row, (segments[index]?.hatch === true ? HATCH : '█').repeat(count), count, { color: colors[index] })
  }
  if (partial > 0) pushRun(row, HORIZONTAL_EIGHTHS[partial]!, 1, { color: colors[lastFilled] })
  const empty = width - filled - (partial > 0 ? 1 : 0)
  pushRun(row, TRACK.repeat(empty), empty, { color: chartColorKey(props.emptyColor, 'subtle') })
  return row
}

/** One-row composition/occupancy bar (`ui.StackedBar`). */
export const StackedBar = React.memo(function StackedBar(props: TuiStackedBarProps): React.ReactNode {
  return <ChartLine row={layoutStackedBar(props)} />
})
