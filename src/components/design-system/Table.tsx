import React from 'react'
import type { Theme } from '../../theme.js'
import { chartColorKey } from './chartColor.js'
import { allocateCells, cellCount, chartValue } from './chartGeometry.js'
import { chartText, padCells } from './chartFormat.js'
import { ChartRows, fitRow, pushRun, type ChartRun } from './chartRows.js'
import type { TuiTableCell, TuiTableColumn, TuiTableProps } from './chartTypes.js'

/** Cells between two columns. */
const COLUMN_GAP = 1
/** Most data rows a table will build (a caller shows a window of a longer list). */
const MAX_TABLE_ROWS = 1000

/**
 * Column widths for a table `width` cells wide: fixed `width` columns first,
 * then the rest (minus one-cell gaps) split by `grow` (default 1; 0 takes
 * only `minWidth`). A growing column never drops below its `minWidth`: the
 * short ones are pinned there and the remainder is re-split among the others.
 * The sum can exceed the budget when fixed and minimum widths do not fit —
 * the row is clipped at the right edge then.
 */
export function tableColumnWidths(columns: readonly TuiTableColumn[], width: number): number[] {
  const budget = cellCount(width)
  const widths = columns.map(column => (column?.width === undefined ? -1 : cellCount(column.width)))
  let flexBudget = budget - Math.max(0, columns.length - 1) * COLUMN_GAP
  for (const fixed of widths) if (fixed >= 0) flexBudget -= fixed
  const flexible = widths.flatMap((fixed, index) => (fixed < 0 ? [index] : []))
  const minimum = (index: number): number => cellCount(columns[index]?.minWidth)
  const grow = (index: number): number => {
    const value = columns[index]?.grow
    return typeof value === 'number' ? chartValue(value) : 1
  }
  let free = flexible
  let room = Math.max(0, flexBudget)
  for (;;) {
    const split = allocateCells(free.map(grow), room)
    const short = free.filter((index, at) => split[at]! < minimum(index))
    if (short.length === 0) {
      free.forEach((index, at) => { widths[index] = split[at]! })
      break
    }
    for (const index of short) {
      widths[index] = minimum(index)
      room = Math.max(0, room - minimum(index))
    }
    free = free.filter(index => !short.includes(index))
  }
  return widths
}

function cellParts(cell: TuiTableCell | undefined): { text: string; color?: unknown; bold?: boolean } {
  if (typeof cell === 'object' && cell !== null) return { text: chartText(cell.text), color: cell.color, bold: cell.bold === true }
  return { text: chartText(cell) }
}

/**
 * Lay out a table: an optional header row (bold `inactive` titles; on by
 * default when any column has a title), then one row per entry, every row
 * exactly `width` cells. Cells are folded to one sanitized line and cut with
 * `…` by display cells (CJK/emoji safe), aligned per column. A cell object's
 * color/bold win over the column's color. The selected row is drawn on
 * `selectionBg` edge to edge.
 */
export function layoutTable(props: TuiTableProps): ChartRun[][] {
  const width = cellCount(props.width)
  // Column i starts at cell i·COLUMN_GAP or later, so past this many every
  // column is clipped whole. Dropping them changes no width (their gaps alone
  // already exhaust the flexible budget) and bounds the work for a huge
  // generated column list.
  const columns = (Array.isArray(props.columns) ? props.columns : []).slice(0, Math.floor(width / COLUMN_GAP) + 1)
  if (width === 0 || columns.length === 0) return []
  const widths = tableColumnWidths(columns, width)
  const showHeader = props.header ?? columns.some(column => chartText(column?.title) !== '')

  const line = (
    cell: (column: TuiTableColumn, index: number) => { text: string; color?: unknown; bold?: boolean },
    base: { color?: keyof Theme; bold?: boolean },
    band: keyof Theme | undefined,
  ): ChartRun[] => {
    const out: ChartRun[] = []
    columns.forEach((column, index) => {
      if (index > 0) pushRun(out, ' '.repeat(COLUMN_GAP), COLUMN_GAP, { backgroundColor: band })
      const parts = cell(column, index)
      const color = chartColorKey(parts.color, base.color ?? chartColorKey(column?.color))
      const text = padCells(parts.text, widths[index]!, column?.align === 'right' ? 'right' : 'left')
      pushRun(out, text, widths[index]!, { color, backgroundColor: band, bold: parts.bold === true || base.bold === true || undefined })
    })
    return fitRow(out, width, { backgroundColor: band })
  }

  const rows: ChartRun[][] = []
  if (showHeader) rows.push(line(column => ({ text: chartText(column?.title) }), { color: 'inactive', bold: true }, undefined))
  const entries = (Array.isArray(props.rows) ? props.rows : []).slice(0, MAX_TABLE_ROWS)
  entries.forEach((entry, at) => {
    const record: Readonly<Record<string, TuiTableCell | undefined>> = typeof entry === 'object' && entry !== null ? entry : {}
    const band = at === props.selected ? 'selectionBg' as const : undefined
    rows.push(line(column => cellParts(Object.hasOwn(record, column?.key) ? record[column.key] : undefined), {}, band))
  })
  return rows
}

/** Fixed/flexible-column table (`ui.Table`). */
export const Table = React.memo(function Table(props: TuiTableProps): React.ReactNode {
  return <ChartRows rows={layoutTable(props)} />
})
