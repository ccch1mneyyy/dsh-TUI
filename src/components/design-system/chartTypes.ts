/**
 * Plugin-facing contract of the chart kit (docs/plugin-ui-kit-design.md §1).
 *
 * Every member is a NEW narrowed wrapper surface, not a pass-through of a host
 * component's props: the host's own components may change freely underneath.
 * The same kit object is mounted on every plugin surface — scenes (via the
 * `src/ui.ts` exports), side panels (`TuiPanelUi`) and, for the single-row
 * subset, rich status views (`TuiStatusViewUi`).
 *
 * All primitives are controlled and stateless: selection and expansion come in
 * through props, and none of them reads the keyboard — a panel routes keys via
 * `host.onKey`, a scene via `useInput`, a status view has the pointer only.
 * Widths are terminal cells, never string lengths. Non-finite and negative
 * values render as 0; nothing here throws on bad numbers.
 *
 * Experimental: the shape may still move before it is declared stable.
 */

import type React from 'react'
import type { Theme } from '../../theme.js'

/**
 * A categorical palette slot (an integer, cycling over `chart1`…`chart8`) or a
 * semantic theme key. Literal colors are deliberately not accepted: a chart must
 * follow the theme (light, dark and ANSI palettes alike).
 */
export type TuiChartColor = number | keyof Theme

export interface TuiStackedBarSegment {
  readonly value: number
  readonly color: TuiChartColor
  /** Draw this segment hatched (a reserve/forecast span) instead of solid. */
  readonly hatch?: boolean
}

/** One-row proportional bar: composition, occupancy, budget. */
export interface TuiStackedBarProps {
  readonly segments: readonly TuiStackedBarSegment[]
  /** Total bar width in cells. */
  readonly width: number
  /**
   * When set, the filled span is `sum(segments) / capacity` of the width and
   * the rest is empty track (occupancy mode). When omitted the segments share
   * the whole width (composition mode).
   */
  readonly capacity?: number
  /** Color of the empty track in occupancy mode. */
  readonly emptyColor?: keyof Theme
  /** Give every non-zero segment at least one cell when the width allows. */
  readonly keepVisible?: boolean
}

/** One-row trend line drawn with the `▁▂▃▄▅▆▇█` ladder. */
export interface TuiSparklineProps {
  readonly values: readonly number[]
  readonly width: number
  readonly color?: TuiChartColor
  /** Scale floor; defaults to 0. */
  readonly min?: number
  /** Scale ceiling; defaults to the largest value. */
  readonly max?: number
  /** More values than cells: `bucket` keeps each bucket's peak (default), `tail` keeps the newest. */
  readonly fit?: 'bucket' | 'tail'
}

/** A one-ratio bar (the public name of the design-system `ProgressBar`). */
export interface TuiMeterProps {
  /** 0…1; clamped. */
  readonly ratio: number
  readonly width: number
  readonly fillColor?: TuiChartColor
  readonly emptyColor?: keyof Theme
}

export interface TuiColumnChartSegment {
  readonly value: number
  readonly color: TuiChartColor
}

export interface TuiColumnChartColumn {
  /** Stacked bottom-up in array order. */
  readonly segments: readonly TuiColumnChartSegment[]
  /** One display cell drawn on the marker row above the column (e.g. `✂`); anything wider is dropped. */
  readonly marker?: string
  readonly markerColor?: TuiChartColor
}

/** Vertical bars, optionally stacked, with eighth-block precision at the top. */
export interface TuiColumnChartProps {
  readonly columns: readonly TuiColumnChartColumn[]
  /**
   * Plot height in rows. The marker row comes on top of this whenever any
   * column has a marker or `selected` is a number, so the chart is
   * `height + 1` rows then and `height` rows otherwise.
   */
  readonly height: number
  /** Cells per column; defaults to 1. */
  readonly columnWidth?: number
  /** Cells between columns; defaults to 0. */
  readonly gap?: number
  /** Scale ceiling; defaults to the tallest column. */
  readonly max?: number
  /**
   * Index of a highlighted column: a selection band behind it and a `▾` on
   * the marker row. Any number reserves the marker row, so a selectable
   * chart passes `-1` for "nothing selected" (an index past the columns
   * behaves the same) and never changes height as the selection moves or
   * clears; leave it `undefined` only for a chart that never selects.
   */
  readonly selected?: number
}

/** Grid of intensities (calendar heatmap, matrix). Readable without color via a glyph ladder. */
export interface TuiHeatmapProps {
  /** Row-major cells; `null` = no data (drawn differently from zero). */
  readonly rows: readonly (readonly (number | null)[])[]
  readonly color?: TuiChartColor
  /** Intensity levels above zero; defaults to 4. */
  readonly levels?: number
  /** Cells per grid cell; defaults to 2 (square-ish). */
  readonly cell?: 1 | 2
  /** Scale ceiling; defaults to the largest value. */
  readonly max?: number
  readonly selected?: { readonly row: number; readonly col: number }
}

export interface TuiLegendItem {
  readonly color: TuiChartColor
  readonly label: string
  readonly value?: string
}

/** Color swatch + label (+ value) chips, wrapped to the width. */
export interface TuiLegendProps {
  readonly items: readonly TuiLegendItem[]
  readonly width: number
  /** Rows to use at most; the rest collapses into a `+N` chip. */
  readonly maxRows?: number
}

/** A table cell: plain text/number, or text with its own color. */
export type TuiTableCell = string | number | { readonly text: string; readonly color?: TuiChartColor; readonly bold?: boolean }

export interface TuiTableColumn {
  readonly key: string
  readonly title?: string
  /** Fixed width in cells. */
  readonly width?: number
  /** Share of the remaining width (columns without `width` default to grow 1). */
  readonly grow?: number
  /** A growing column never shrinks below this. */
  readonly minWidth?: number
  readonly align?: 'left' | 'right'
  readonly color?: TuiChartColor
}

/** Fixed/flexible columns, cell-width truncation with an ellipsis, optional selection. */
export interface TuiTableProps {
  readonly columns: readonly TuiTableColumn[]
  readonly rows: readonly Readonly<Record<string, TuiTableCell | undefined>>[]
  readonly width: number
  readonly selected?: number
  /** Draw the header row; defaults to true when any column has a title. */
  readonly header?: boolean
}

/** Number/text helpers every chart caption needs; locale-neutral and compact. */
export interface TuiChartFormat {
  /**
   * `988`, `3.4k`, `12k`, `1.0M`, `12M` — one decimal below ten of a unit,
   * whole units above: exactly what the footer's context bar prints for the
   * same count, so a caption never disagrees with it. Non-finite and negative
   * counts print `0`.
   */
  tokens(count: number): string
  /**
   * `12s`, `3m 4s`, `2h 10m`, `1h 2m 3s` — whole seconds, zero units left
   * out: exactly what the host prints for the same duration (spinner timer,
   * tool and turn rows). A span under a second keeps its milliseconds
   * (`850ms`; the host never shows one); zero, non-finite and negative print
   * `0s`.
   */
  duration(ms: number): string
  /** `ratio` 0…1 → `42%` (`digits` decimals, default 0). */
  percent(ratio: number, digits?: number): string
  /** `now`, `45s`, `3m`, `2h`, `5d` — elapsed since `at` (epoch ms). */
  relativeTime(at: number, now?: number): string
  /** Display width in terminal cells (ANSI, CJK and emoji aware). */
  cells(text: string): number
  /** Truncate to `cells` display cells, ending in `…` when cut. */
  truncate(text: string, cells: number): string
}

/** The single-row subset: safe inside rich status views. */
export interface TuiChartRowKit {
  readonly StackedBar: React.ComponentType<TuiStackedBarProps>
  readonly Sparkline: React.ComponentType<TuiSparklineProps>
  readonly Meter: React.ComponentType<TuiMeterProps>
  readonly format: TuiChartFormat
  /** Palette slot → theme key: `chart{(index mod 8) + 1}`. */
  seriesColor(index: number): keyof Theme
  /** Stable palette slot for an open-ended name (tool, skill, agent). */
  hashSeries(key: string): number
}

/** The full kit: side panels and scenes. */
export interface TuiChartKit extends TuiChartRowKit {
  readonly ColumnChart: React.ComponentType<TuiColumnChartProps>
  readonly Heatmap: React.ComponentType<TuiHeatmapProps>
  readonly Legend: React.ComponentType<TuiLegendProps>
  readonly Table: React.ComponentType<TuiTableProps>
}
