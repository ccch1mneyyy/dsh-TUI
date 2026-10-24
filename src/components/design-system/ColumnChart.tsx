import React from 'react'
import type { Theme } from '../../theme.js'
import { chartColorKey, seriesColor } from './chartColor.js'
import { cellCount, chartValue, eighthsOf, MAX_CHART_CELLS, VERTICAL_EIGHTHS } from './chartGeometry.js'
import { singleCell } from './chartFormat.js'
import { ChartRows, pushRun, type ChartRun } from './chartRows.js'
import type { TuiColumnChartProps } from './chartTypes.js'

/** Tallest plot a column chart will build, in rows. */
const MAX_PLOT_ROWS = 200
/** Points at the selected column on the marker row when it has no marker of its own. */
const SELECTED_POINTER = '▾'

interface ColumnStack {
  /** Cumulative segment tops in eighths, bottom-up (`tops[k]` ends segment k). */
  readonly tops: readonly number[]
  readonly colors: readonly (keyof Theme | undefined)[]
}

/** One plot cell: a glyph with its foreground and optional background. */
interface PlotCell {
  readonly glyph: string
  readonly color?: keyof Theme
  readonly backgroundColor?: keyof Theme
}

/**
 * The cell covering eighths `[base, base + 8)` of a stacked column. A segment
 * boundary inside a fully covered cell is drawn exactly: the lower-eighth
 * glyph in the lower segment's color over the upper segment's color as the
 * background. The column's own top inside a cell takes the dominant segment
 * there (a background would overstate the height). Three segments meeting in
 * one cell keep the lowest boundary exact and give the rest of the cell to the
 * largest of the others.
 */
function plotCell(stack: ColumnStack, base: number, band: keyof Theme | undefined): PlotCell {
  const { tops, colors } = stack
  const top = tops.length === 0 ? 0 : tops[tops.length - 1]!
  if (top <= base) return { glyph: ' ', backgroundColor: band }
  const parts: { index: number; size: number }[] = []
  let bottom = 0
  for (let index = 0; index < tops.length; index += 1) {
    const lo = Math.max(bottom, base)
    const hi = Math.min(tops[index]!, base + 8)
    if (hi > lo) parts.push({ index, size: hi - lo })
    bottom = tops[index]!
  }
  const largest = (from: number): number => {
    let pick = from
    for (let at = from + 1; at < parts.length; at += 1) {
      if (parts[at]!.size > parts[pick]!.size) pick = at
    }
    return parts[pick]!.index
  }
  if (top < base + 8) {
    return { glyph: VERTICAL_EIGHTHS[top - base]!, color: colors[largest(0)], backgroundColor: band }
  }
  if (parts.length === 1) return { glyph: VERTICAL_EIGHTHS[8]!, color: colors[parts[0]!.index] }
  return {
    glyph: VERTICAL_EIGHTHS[parts[0]!.size]!,
    color: colors[parts[0]!.index],
    backgroundColor: colors[largest(1)],
  }
}

/**
 * Lay out vertical (optionally stacked) columns: `height` plot rows, plus a
 * marker row on top when any column has a marker or `selected` is a number
 * (any number: `-1` reserves the row without highlighting anything).
 * Every row is `n·columnWidth + (n−1)·gap` cells. Values scale to `max`
 * (default: the tallest column) with eighth-cell precision; any non-zero
 * column shows at least one eighth. The selected column gets a
 * `selectionBg` band behind its unfilled cells and on the marker row, where
 * it also carries a `▾` pointer unless it has its own marker.
 */
export function layoutColumnChart(props: TuiColumnChartProps): ChartRun[][] {
  const height = Math.min(MAX_PLOT_ROWS, cellCount(props.height))
  const columnWidth = Math.max(1, cellCount(props.columnWidth ?? 1))
  const gap = cellCount(props.gap ?? 0)
  const fits = Math.floor((MAX_CHART_CELLS + gap) / (columnWidth + gap))
  const columns = (Array.isArray(props.columns) ? props.columns : []).slice(0, fits)
  if (height === 0 || columns.length === 0) return []

  // Finite segment values can still sum past Number.MAX_VALUE; every ratio
  // would then read as 0. Only then, divide every value (and the ceiling) by
  // the largest segment: the ratios stay, and ordinary inputs keep exactly
  // the arithmetic they always had.
  let factor = 1
  const sumOf = (column: (typeof columns)[number]): number => {
    let total = 0
    for (const segment of Array.isArray(column?.segments) ? column.segments : []) total += chartValue(segment?.value) / factor
    return total
  }
  let totals = columns.map(sumOf)
  if (totals.some(total => !Number.isFinite(total))) {
    for (const column of columns) {
      for (const segment of Array.isArray(column?.segments) ? column.segments : []) factor = Math.max(factor, chartValue(segment?.value))
    }
    totals = columns.map(sumOf)
  }
  let scale = 0
  if (typeof props.max === 'number' && Number.isFinite(props.max)) scale = chartValue(props.max) / factor
  else for (const total of totals) scale = Math.max(scale, total)

  const stacks: ColumnStack[] = columns.map((column, at) => {
    const segments = Array.isArray(column?.segments) ? column.segments : []
    const tops: number[] = []
    let sum = 0
    for (const segment of segments) {
      sum += chartValue(segment?.value) / factor
      // Rounding the cumulative boundary (not each segment) keeps the stack's
      // top exactly where the column total puts it.
      tops.push(eighthsOf(sum, scale, height))
    }
    if (totals[at]! > 0 && tops[tops.length - 1] === 0) {
      // Below one eighth: lift the last non-zero segment to a single eighth.
      let last = segments.length - 1
      while (last > 0 && chartValue(segments[last]?.value) === 0) last -= 1
      for (let index = last; index < tops.length; index += 1) tops[index] = 1
    }
    return { tops, colors: segments.map((segment, index) => chartColorKey(segment?.color, seriesColor(index))) }
  })

  const selected = typeof props.selected === 'number' && Number.isInteger(props.selected)
    && props.selected >= 0 && props.selected < columns.length
    ? props.selected
    : -1
  const markers = columns.map(column => singleCell(column?.marker))
  const rows: ChartRun[][] = []
  const lead = Math.floor((columnWidth - 1) / 2)

  // Any numeric `selected` reserves the marker row — `-1` (or an index the
  // columns no longer reach) highlights nothing but keeps the row — so moving
  // or clearing a selection never shifts the plot by a row.
  if (typeof props.selected === 'number' || markers.some(marker => marker !== '')) {
    const row: ChartRun[] = []
    columns.forEach((column, at) => {
      if (at > 0) pushRun(row, ' '.repeat(gap), gap)
      const band = at === selected ? 'selectionBg' as const : undefined
      const own = markers[at]!
      const glyph = own !== '' ? own : at === selected ? SELECTED_POINTER : ' '
      const color = own !== '' ? chartColorKey(column?.markerColor, 'inactive') : 'text'
      pushRun(row, ' '.repeat(lead), lead, { backgroundColor: band })
      pushRun(row, glyph, 1, { color, backgroundColor: band })
      pushRun(row, ' '.repeat(columnWidth - lead - 1), columnWidth - lead - 1, { backgroundColor: band })
    })
    rows.push(row)
  }

  for (let level = height - 1; level >= 0; level -= 1) {
    const row: ChartRun[] = []
    stacks.forEach((stack, at) => {
      if (at > 0) pushRun(row, ' '.repeat(gap), gap)
      const cell = plotCell(stack, level * 8, at === selected ? 'selectionBg' : undefined)
      pushRun(row, cell.glyph.repeat(columnWidth), columnWidth, { color: cell.color, backgroundColor: cell.backgroundColor })
    })
    rows.push(row)
  }
  return rows
}

/** Vertical bars, optionally stacked (`ui.ColumnChart`). */
export const ColumnChart = React.memo(function ColumnChart(props: TuiColumnChartProps): React.ReactNode {
  return <ChartRows rows={layoutColumnChart(props)} />
})
