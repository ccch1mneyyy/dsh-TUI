/**
 * Shared row model and renderer for the chart kit primitives.
 *
 * Each primitive lays itself out as rows of styled runs (pure, headlessly
 * testable: a run carries its own cell width), then hands the rows to
 * `ChartRows`. Adjacent runs with the same style are merged at build time, so
 * a 60-column chart is a handful of Text nodes per row, not one per cell.
 */

import React from 'react'
import Box from './ThemedBox.js'
import Text from './ThemedText.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { getGraphemeSegmenter } from '../../utils/intl.js'
import type { Theme } from '../../theme.js'

/** One styled stretch of a chart row. Colors are already-resolved theme keys. */
export interface ChartRun {
  readonly text: string
  /** Display cells of `text`. */
  readonly width: number
  readonly color?: keyof Theme
  readonly backgroundColor?: keyof Theme
  readonly bold?: boolean
}

export type ChartRow = readonly ChartRun[]

type RunStyle = Pick<ChartRun, 'color' | 'backgroundColor' | 'bold'>

/** Append a run, merging it into the previous one when the style matches. */
export function pushRun(row: ChartRun[], text: string, width: number, style: RunStyle = {}): void {
  if (text === '' || width <= 0) return
  const last = row[row.length - 1]
  if (
    last !== undefined
    && last.color === style.color
    && last.backgroundColor === style.backgroundColor
    && last.bold === style.bold
  ) {
    row[row.length - 1] = { ...last, text: last.text + text, width: last.width + width }
    return
  }
  row.push({ text, width, color: style.color, backgroundColor: style.backgroundColor, bold: style.bold })
}

/** Total display cells of a row. */
export function rowWidth(row: ChartRow): number {
  let width = 0
  for (const run of row) width += run.width
  return width
}

/**
 * Clip a row to exactly `width` cells: runs past the edge are cut by grapheme
 * (a wide glyph that would straddle it becomes a space), a short row is padded
 * with unstyled spaces — or with `padStyle`, so a selected row's band reaches
 * the edge.
 */
export function fitRow(row: ChartRow, width: number, padStyle: RunStyle = {}): ChartRun[] {
  const out: ChartRun[] = []
  let used = 0
  for (const run of row) {
    if (used >= width) break
    if (used + run.width <= width) {
      pushRun(out, run.text, run.width, run)
      used += run.width
      continue
    }
    let text = ''
    let cut = 0
    for (const { segment } of getGraphemeSegmenter().segment(run.text)) {
      const next = stringWidth(segment)
      if (used + cut + next > width) break
      text += segment
      cut += next
    }
    pushRun(out, text, cut, run)
    used += cut
    break
  }
  if (used < width) pushRun(out, ' '.repeat(width - used), width - used, padStyle)
  return out
}

/** One row as a single Text line (nestable inside a caller's Text). */
export function ChartLine({ row }: { readonly row: ChartRow }): React.ReactNode {
  if (row.length === 0) return null
  return (
    <Text wrap="truncate-end">
      {row.map((run, index) => (
        <Text key={index} color={run.color} backgroundColor={run.backgroundColor} bold={run.bold}>
          {run.text}
        </Text>
      ))}
    </Text>
  )
}

/** Rows stacked top to bottom. */
export function ChartRows({ rows }: { readonly rows: readonly ChartRow[] }): React.ReactNode {
  if (rows.length === 0) return null
  return (
    <Box flexDirection="column">
      {rows.map((row, index) => (
        <ChartLine key={index} row={row} />
      ))}
    </Box>
  )
}
