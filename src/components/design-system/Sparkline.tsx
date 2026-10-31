import React from 'react'
import { chartColorKey, seriesColor } from './chartColor.js'
import { cellCount, chartValue, MAX_CHART_ITEMS, quantize, resample, VERTICAL_EIGHTHS } from './chartGeometry.js'
import { ChartLine, pushRun, type ChartRun } from './chartRows.js'
import type { TuiSparklineProps } from './chartTypes.js'

/**
 * Lay out a one-row trend: exactly `width` cells, newest value on the right.
 *
 * Each value maps onto the `▁…█` ladder over `[min, max]` (min defaults to 0,
 * max to the largest value); any value above the floor gets at least `▁` in
 * the series color, a value at or below it a `▁` baseline in `subtle`, so
 * "zero" and "a little" stay apart. Fewer values than cells pad empty on the
 * left; more are resampled by `fit` (bucket peaks by default).
 */
export function layoutSparkline(props: TuiSparklineProps): ChartRun[] {
  const width = cellCount(props.width)
  if (width === 0) return []
  // Only the newest MAX_CHART_ITEMS values take part (the right edge is now).
  const values = Array.isArray(props.values) ? props.values : []
  const recent = values.length > MAX_CHART_ITEMS ? values.slice(values.length - MAX_CHART_ITEMS) : values
  const series = resample(recent, width, props.fit === 'tail' ? 'tail' : 'bucket')
  const floor = chartValue(props.min)
  let ceiling = 0
  // An explicit ceiling is a chart number like any other (non-finite → 0).
  if (typeof props.max === 'number') ceiling = chartValue(props.max)
  else for (const value of series) ceiling = Math.max(ceiling, value)
  const span = ceiling - floor
  const color = chartColorKey(props.color, seriesColor(0))
  const row: ChartRun[] = []
  pushRun(row, ' '.repeat(width - series.length), width - series.length)
  for (const value of series) {
    const above = value - floor
    const level = span > 0 ? quantize(above, span, 8) : (above > 0 ? 8 : 0)
    if (level === 0) pushRun(row, VERTICAL_EIGHTHS[1]!, 1, { color: 'subtle' })
    else pushRun(row, VERTICAL_EIGHTHS[level]!, 1, { color })
  }
  return row
}

/** One-row trend line (`ui.Sparkline`). */
export const Sparkline = React.memo(function Sparkline(props: TuiSparklineProps): React.ReactNode {
  return <ChartLine row={layoutSparkline(props)} />
})
