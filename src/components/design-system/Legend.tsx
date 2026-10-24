import React from 'react'
import { stringWidth } from '../../ink/stringWidth.js'
import { chartColorKey, seriesColor } from './chartColor.js'
import { cellCount } from './chartGeometry.js'
import { chartText, fitCells } from './chartFormat.js'
import { ChartRows, fitRow, pushRun, rowWidth, type ChartRun } from './chartRows.js'
import type { TuiLegendItem, TuiLegendProps } from './chartTypes.js'

const SWATCH = '■'
/** Between two chips on a row. */
const CHIP_GAP = 2

/**
 * One chip — swatch, label, optional value — fitted to `width`: the value is
 * dropped when it would leave the label under four cells, the label is then
 * truncated with `…`, and below three cells only the swatch remains. Text wears text tokens (label `text`, value `inactive`);
 * only the swatch carries the series color.
 */
function chip(item: TuiLegendItem | undefined, index: number, width: number): ChartRun[] {
  const label = chartText(item?.label)
  const value = chartText(item?.value)
  const valueWidth = value === '' ? 0 : stringWidth(value)
  const runs: ChartRun[] = []
  pushRun(runs, SWATCH, 1, { color: chartColorKey(item?.color, seriesColor(index)) })
  if (width < 3) return runs
  // Keep the value only while the label still gets a readable stretch.
  const withValue = value !== '' && width - 2 - (valueWidth + 1) >= Math.min(stringWidth(label), 4)
  const shown = fitCells(label, width - 2 - (withValue ? valueWidth + 1 : 0))
  if (shown !== '') pushRun(runs, ' ' + shown, 1 + stringWidth(shown), { color: 'text' })
  if (withValue) pushRun(runs, ' ' + value, 1 + valueWidth, { color: 'inactive' })
  return runs
}

/**
 * Lay out legend chips left to right, wrapping by display cells; every row is
 * padded to exactly `width`. With `maxRows`, chips past the last row collapse
 * into a trailing `+N` chip (chips are pulled off that row until it fits).
 */
export function layoutLegend(props: TuiLegendProps): ChartRun[][] {
  const width = cellCount(props.width)
  const items = Array.isArray(props.items) ? props.items : []
  if (width === 0 || items.length === 0) return []
  const chips = items.map((item, index) => chip(item, index, width))
  const rows: ChartRun[][][] = [[]]
  let used = 0
  for (const runs of chips) {
    const size = rowWidth(runs)
    const current = rows[rows.length - 1]!
    if (current.length > 0 && used + CHIP_GAP + size > width) {
      rows.push([runs])
      used = size
    } else {
      used += (current.length > 0 ? CHIP_GAP : 0) + size
      current.push(runs)
    }
  }

  const maxRows = cellCount(props.maxRows)
  if (maxRows > 0 && rows.length > maxRows) {
    const kept = rows.slice(0, maxRows)
    let hidden = 0
    for (const row of rows.slice(maxRows)) hidden += row.length
    const last = kept[kept.length - 1]!
    const chipsWidth = (row: ChartRun[][]): number =>
      row.reduce((sum, runs, at) => sum + (at > 0 ? CHIP_GAP : 0) + rowWidth(runs), 0)
    let more = `+${hidden}`
    while (last.length > 0 && chipsWidth(last) + CHIP_GAP + stringWidth(more) > width) {
      last.pop()
      hidden += 1
      more = `+${hidden}`
    }
    const overflow: ChartRun[] = []
    const fitted = fitCells(more, width)
    pushRun(overflow, fitted, stringWidth(fitted), { color: 'inactive' })
    last.push(overflow)
    rows.length = 0
    rows.push(...kept)
  }

  return rows.map(row => {
    const out: ChartRun[] = []
    row.forEach((runs, at) => {
      if (at > 0) pushRun(out, ' '.repeat(CHIP_GAP), CHIP_GAP)
      for (const run of runs) pushRun(out, run.text, run.width, run)
    })
    return fitRow(out, width)
  })
}

/** Swatch + label (+ value) chips (`ui.Legend`). */
export const Legend = React.memo(function Legend(props: TuiLegendProps): React.ReactNode {
  return <ChartRows rows={layoutLegend(props)} />
})
