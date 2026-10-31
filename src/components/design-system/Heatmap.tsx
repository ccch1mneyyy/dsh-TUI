import React from 'react'
import { chartColorKey, seriesColor } from './chartColor.js'
import { cellCount, chartValue, MAX_CHART_CELLS, MAX_CHART_ITEMS, quantize } from './chartGeometry.js'
import { ChartRows, pushRun, type ChartRun } from './chartRows.js'
import type { TuiHeatmapProps } from './chartTypes.js'

/** Intensity ladder: zero, then four steps. Reads without color (16-color terminals, CVD). */
const LADDER = ['·', '░', '▒', '▓', '█'] as const
/** Most grid rows a heatmap will build. */
const MAX_GRID_ROWS = 200

/**
 * Lay out a grid of intensities: one row per input row, each `cell` (1 or 2,
 * default 2) cells per grid cell, every row padded to the widest one.
 *
 * `null` (no data) is blank, zero is a `·` in `subtle`, and a positive value
 * climbs `░▒▓█` in the series color over `levels` equal steps of `(0, max]`
 * (`levels` above four share the four glyphs). The selected cell keeps its
 * glyph but swaps to `text` on `selectionBg`, which stays visible even on a
 * full `█`. The whole grid reads at most {@link MAX_CHART_ITEMS} values: rows
 * past that budget (at the grid's width) are left out.
 */
export function layoutHeatmap(props: TuiHeatmapProps): ChartRun[][] {
  const cell = props.cell === 1 ? 1 : 2
  const rows = (Array.isArray(props.rows) ? props.rows : []).slice(0, MAX_GRID_ROWS)
  const perRow = Math.floor(MAX_CHART_CELLS / cell)
  let columns = 0
  for (const row of rows) columns = Math.max(columns, Math.min(perRow, Array.isArray(row) ? row.length : 0))
  if (rows.length === 0 || columns === 0) return []
  // One budget for the grid, as for every chart's data: not the full width
  // again for every row.
  const grid = rows.slice(0, Math.max(1, Math.floor(MAX_CHART_ITEMS / columns))).map(row => (Array.isArray(row) ? row : []).slice(0, columns))

  let scale = 0
  // An explicit ceiling is a chart number like any other (non-finite → 0).
  if (typeof props.max === 'number') scale = chartValue(props.max)
  else for (const row of grid) for (const value of row) scale = Math.max(scale, chartValue(value))
  const levels = Math.max(1, cellCount(props.levels ?? 4))
  const color = chartColorKey(props.color, seriesColor(0))
  const selectedRow = props.selected?.row
  const selectedCol = props.selected?.col

  return grid.map((row, y) => {
    const out: ChartRun[] = []
    for (let x = 0; x < columns; x += 1) {
      const value = row[x]
      let glyph = ' '
      let tone = color
      if (value !== null && value !== undefined) {
        const level = quantize(chartValue(value), scale, levels)
        glyph = LADDER[level === 0 ? 0 : Math.max(1, Math.ceil((level * 4) / levels))]!
        if (level === 0) tone = 'subtle'
      }
      const selected = y === selectedRow && x === selectedCol
      pushRun(out, glyph.repeat(cell), cell, selected
        ? { color: 'text', backgroundColor: 'selectionBg' }
        : { color: glyph === ' ' ? undefined : tone })
    }
    return out
  })
}

/** Intensity grid (`ui.Heatmap`). */
export const Heatmap = React.memo(function Heatmap(props: TuiHeatmapProps): React.ReactNode {
  return <ChartRows rows={layoutHeatmap(props)} />
})
