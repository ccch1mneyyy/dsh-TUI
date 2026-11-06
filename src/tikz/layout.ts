/**
 * Terminal-cell geometry for a TikZ figure. Pure: no rasterization.
 *
 * dvisvgm reports the cropped figure in TeX points (1 pt = 1/72 in). Unlike
 * a formula there is no "ex" size to preserve, so the base scale is tied to
 * the terminal cell height: a 10 pt node label lands at roughly one cell
 * height, which reads at body-text weight. A figure shrinks uniformly only
 * when it would exceed the width or height it may occupy, and never below a
 * legibility floor (the caller keeps the source instead).
 *
 * The canvas is padded to whole cells and may be rendered at twice the
 * device resolution, exactly like the math-image path: the terminal places
 * the raster into the cell box and the extra pixels make thin TikZ strokes
 * survive the downscale.
 */
import type { TerminalCellSize } from '../ink/terminal-image.js'

/** Pixels per TeX point at the base scale, as a fraction of the cell height. */
export const TIKZ_BASE_CELL_HEIGHT_PER_POINT = 1 / 10
/**
 * Below this fraction of the base scale a figure's labels are no longer
 * readable in a terminal cell; the caller keeps the source block instead.
 */
export const TIKZ_MIN_CELL_HEIGHT_PER_POINT = 1 / 24

export interface TikzFigureSize {
  readonly widthPt: number
  readonly heightPt: number
}

export interface TikzLayoutConstraints {
  readonly cellSize: TerminalCellSize
  /** Largest cell box the figure may occupy. */
  readonly maxColumns: number
  readonly maxRows: number
  /** Transparent margin around the ink, in device-independent pixels. */
  readonly bleed: number
  readonly maxEdge: number
  readonly maxBytes: number
}

export interface TikzLayoutPlan {
  readonly columns: number
  readonly rows: number
  /** Canvas size in device pixels (cells × cell size × deviceScale). */
  readonly canvasWidth: number
  readonly canvasHeight: number
  /** Figure size in device pixels, centered in the canvas. */
  readonly contentWidth: number
  readonly contentHeight: number
  /** Base pixels per TeX point, before {@link deviceScale}. */
  readonly pixelsPerPt: number
  readonly deviceScale: 1 | 2
}

export type TikzLayoutFailure = 'invalid-dimensions' | 'too-small' | 'raster-limit'

export function planTikzLayout(
  size: TikzFigureSize,
  constraints: TikzLayoutConstraints,
): TikzLayoutPlan | TikzLayoutFailure {
  const { cellSize, maxColumns, maxRows, bleed } = constraints
  if (
    !(size.widthPt > 0) || !(size.heightPt > 0) ||
    !Number.isFinite(size.widthPt) || !Number.isFinite(size.heightPt) ||
    maxColumns < 1 || maxRows < 1 ||
    cellSize.width < 1 || cellSize.height < 1
  ) {
    return 'invalid-dimensions'
  }
  const basePixelsPerPt = cellSize.height * TIKZ_BASE_CELL_HEIGHT_PER_POINT
  const availableWidth = maxColumns * cellSize.width - bleed * 2
  const availableHeight = maxRows * cellSize.height - bleed * 2
  if (availableWidth <= 0 || availableHeight <= 0) return 'too-small'
  const pixelsPerPt = Math.min(
    basePixelsPerPt,
    availableWidth / size.widthPt,
    availableHeight / size.heightPt,
  )
  if (pixelsPerPt < cellSize.height * TIKZ_MIN_CELL_HEIGHT_PER_POINT) return 'too-small'

  const contentWidth = size.widthPt * pixelsPerPt
  const contentHeight = size.heightPt * pixelsPerPt
  const columns = Math.min(maxColumns, Math.ceil((contentWidth + bleed * 2) / cellSize.width))
  const rows = Math.min(maxRows, Math.ceil((contentHeight + bleed * 2) / cellSize.height))
  if (columns < 1 || rows < 1) return 'too-small'

  const fits = (scale: number): boolean => {
    const width = columns * cellSize.width * scale
    const height = rows * cellSize.height * scale
    return width <= constraints.maxEdge && height <= constraints.maxEdge &&
      width * height * 4 <= constraints.maxBytes
  }
  const deviceScale = fits(2) ? 2 : fits(1) ? 1 : undefined
  if (deviceScale === undefined) return 'raster-limit'
  return {
    columns,
    rows,
    canvasWidth: columns * cellSize.width * deviceScale,
    canvasHeight: rows * cellSize.height * deviceScale,
    contentWidth: contentWidth * deviceScale,
    contentHeight: contentHeight * deviceScale,
    pixelsPerPt,
    deviceScale,
  }
}
