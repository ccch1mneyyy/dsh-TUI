/**
 * Terminal-cell geometry for a typeset formula. Pure: no rasterization.
 *
 * MathJax reports a formula's size in ex. A formula starts at one base scale
 * tied to the terminal's physical cell height (so every formula reads at the
 * same size, like text), shrinks uniformly only when it would exceed the
 * width or height it may occupy, and is never enlarged. The canvas is padded,
 * never stretched, to a whole number of cells.
 */
import type { TerminalCellSize } from '../ink/terminal-image.js'

/** Pixels per ex at the base scale, as a fraction of the cell height. */
export const BASE_EX_TO_CELL_HEIGHT = 0.5
/**
 * Display formulas set larger than the body text, like LaTeX (settings
 * `mathImageScale`): at one ex per 0.72 cell heights the glyph strokes get
 * roughly 45% more device pixels, which is what a terminal-drawn ink mask
 * needs to read as clean rather than thin. Inline formulas keep the base
 * scale — their single row of cells clamps the resolution anyway.
 */
export const LARGE_DISPLAY_EX_TO_CELL_HEIGHT = 0.72
/** The next step up: about 80% more pixels than the base scale. */
export const XLARGE_DISPLAY_EX_TO_CELL_HEIGHT = 0.9
/**
 * Below this fraction of the base scale the formula is unreadable as an
 * image; the caller keeps the Unicode rendering instead of shrinking further.
 */
export const MIN_SCALE_FRACTION = 0.5

export interface FormulaSize {
  readonly widthEx: number
  readonly heightEx: number
}

export interface FormulaConstraints {
  readonly cellSize: TerminalCellSize
  /** Pixels per ex as a fraction of the cell height; defaults to the base scale. */
  readonly baseExToCellHeight?: number
  readonly maxColumns: number
  readonly maxRows: number
  /** Transparent margin around the ink, in device-independent pixels. */
  readonly bleed: number
  /** Largest canvas edge and RGBA byte size the raster may use. */
  readonly maxEdge: number
  readonly maxBytes: number
}

export interface FormulaLayoutPlan {
  readonly columns: number
  readonly rows: number
  /** Canvas size in device pixels (cells × cell size × deviceScale). */
  readonly canvasWidth: number
  readonly canvasHeight: number
  /** Ink box size in device pixels, centered in the canvas. */
  readonly contentWidth: number
  readonly contentHeight: number
  readonly pixelsPerEx: number
  readonly deviceScale: 1 | 2
}

export type FormulaLayoutFailure = 'invalid-dimensions' | 'too-small' | 'raster-limit'

export function planFormulaLayout(
  size: FormulaSize,
  constraints: FormulaConstraints,
): FormulaLayoutPlan | FormulaLayoutFailure {
  const { cellSize, maxColumns, maxRows, bleed } = constraints
  if (
    !(size.widthEx > 0) || !(size.heightEx > 0) ||
    !Number.isFinite(size.widthEx) || !Number.isFinite(size.heightEx) ||
    maxColumns < 1 || maxRows < 1
  ) {
    return 'invalid-dimensions'
  }
  const basePixelsPerEx = cellSize.height * (constraints.baseExToCellHeight ?? BASE_EX_TO_CELL_HEIGHT)
  const availableWidth = maxColumns * cellSize.width - bleed * 2
  const availableHeight = maxRows * cellSize.height - bleed * 2
  if (availableWidth <= 0 || availableHeight <= 0) return 'too-small'
  const pixelsPerEx = Math.min(
    basePixelsPerEx,
    availableWidth / size.widthEx,
    availableHeight / size.heightEx,
  )
  // Legibility is absolute, not relative to what the caller asked for: the
  // floor stays on the base scale so a larger display request shrinks back to
  // a readable size instead of flipping formulas to the Unicode fallback.
  if (pixelsPerEx < cellSize.height * BASE_EX_TO_CELL_HEIGHT * MIN_SCALE_FRACTION) return 'too-small'

  const contentWidth = size.widthEx * pixelsPerEx
  const contentHeight = size.heightEx * pixelsPerEx
  const columns = Math.min(maxColumns, Math.ceil((contentWidth + bleed * 2) / cellSize.width))
  const rows = Math.min(maxRows, Math.ceil((contentHeight + bleed * 2) / cellSize.height))
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
    pixelsPerEx: pixelsPerEx * deviceScale,
    deviceScale,
  }
}
