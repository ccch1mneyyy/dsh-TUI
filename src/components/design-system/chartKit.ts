/**
 * The chart kit objects mounted on plugin surfaces
 * (docs/plugin-ui-kit-design.md §1): `tuiChartRowKit` for rich status views
 * (single-row primitives only), `tuiChartKit` for side panels and scenes.
 *
 * One implementation, several mounts: every surface gets these same frozen
 * objects, and scenes reach the same components through the `src/ui.ts`
 * exports. The members are the narrowed wrappers typed in `./chartTypes.js`,
 * so the host primitives underneath may change without moving the contract.
 */

import type { TuiChartKit, TuiChartRowKit } from './chartTypes.js'
import { hashSeries, seriesColor } from './chartColor.js'
import { chartFormat } from './chartFormat.js'
import { ColumnChart } from './ColumnChart.js'
import { Heatmap } from './Heatmap.js'
import { Legend } from './Legend.js'
import { Meter } from './Meter.js'
import { Sparkline } from './Sparkline.js'
import { StackedBar } from './StackedBar.js'
import { Table } from './Table.js'

export const tuiChartRowKit: TuiChartRowKit = Object.freeze({
  StackedBar,
  Sparkline,
  Meter,
  format: chartFormat,
  seriesColor,
  hashSeries,
})

export const tuiChartKit: TuiChartKit = Object.freeze({
  ...tuiChartRowKit,
  ColumnChart,
  Heatmap,
  Legend,
  Table,
})
