import type { DOMElement } from './dom.js'

/** Hard bounds for one decoded image admitted to the terminal renderer. */
export const TERMINAL_IMAGE_MAX_EDGE = 1024
export const TERMINAL_IMAGE_MAX_BYTES = 4 * 1024 * 1024
/** Maximum decoded RGBA bytes represented by placements in one frame. */
export const TERMINAL_IMAGE_MAX_FRAME_BYTES = 16 * 1024 * 1024
/**
 * Cell-box cap for one placement (a 128×128 grid). Pixel payload is bounded
 * separately by MAX_EDGE / MAX_BYTES / MAX_FRAME_BYTES; this only bounds the
 * screen area one image may claim, so a modal preview can fill a large
 * transcript while thumbnails and status views keep their own small boxes.
 */
export const TERMINAL_IMAGE_MAX_CELLS = 128 * 128
export const TERMINAL_IMAGE_MAX_PLACEMENTS = 64
export const SIXEL_MAX_ENCODED_BYTES = 4 * 1024 * 1024
export const SIXEL_THUMBNAIL_FRAME_BYTES = 1024 * 1024
export const SIXEL_CACHE_BYTES = 16 * 1024 * 1024
export const SIXEL_CACHE_ENTRIES = 64

/** Pixel dimensions of one terminal cell. */
export interface TerminalCellSize {
  readonly width: number
  readonly height: number
}

/** Conventional monospace cell used when XTWINOPS pixel queries are absent. */
export const DEFAULT_TERMINAL_CELL_SIZE: TerminalCellSize = Object.freeze({
  width: 8,
  height: 16,
})

/**
 * Immutable decoded image data accepted by the host image primitive.
 *
 * The renderer hashes `data` once per buffer and caches the digest by buffer
 * identity, so an in-place rewrite of the same buffer is never detected.
 * Callers must not mutate or refill `data` after passing it to `<Image>`;
 * changed pixels require a new `Uint8Array` (and therefore a new source
 * snapshot).
 */
export interface TerminalImageSource {
  /** Immutable row-major sRGB pixels, four bytes per pixel in RGBA order. */
  readonly data: Uint8Array
  readonly width: number
  readonly height: number
}

/** One laid-out image request collected from the current Ink frame. */
export interface TerminalImagePlacement {
  readonly node: DOMElement
  readonly x: number
  readonly y: number
  readonly columns: number
  readonly rows: number
  readonly source: TerminalImageSource
  readonly presentation?: 'preview' | 'transcript'
  /** Visible terminal cells, while x/y/columns/rows retain the full layout box. */
  readonly clip?: { readonly x: number; readonly y: number; readonly columns: number; readonly rows: number }
  readonly background?: string
  /** False while a protocol-specific raster is pending or unavailable. */
  readonly graphicsReady?: boolean
  /** Later paint operations cover this backing, including blank overlays. */
  readonly occluded?: boolean
}

/**
 * Normalize terminal-reported cell pixels before they reach allocation math.
 * The upper bound rejects corrupt or injected XTWINOPS replies; real terminal
 * cells remain far below it, including HiDPI displays.
 */
export function normalizeTerminalCellSize(
  value: TerminalCellSize | undefined,
): TerminalCellSize {
  return plausibleTerminalCellSize(value) ?? DEFAULT_TERMINAL_CELL_SIZE
}

/** Prefer a direct cell report, then derive it from text-area pixels. */
export function resolveTerminalCellSize(
  cell: TerminalCellSize | undefined,
  window: TerminalCellSize | undefined,
  columns: number,
  rows: number,
): TerminalCellSize | undefined {
  const direct = plausibleTerminalCellSize(cell)
  if (direct !== undefined) return direct
  if (
    window === undefined ||
    !Number.isFinite(window.width) ||
    !Number.isFinite(window.height) ||
    columns <= 0 ||
    rows <= 0
  ) {
    return undefined
  }
  return plausibleTerminalCellSize({
    width: window.width / columns,
    height: window.height / rows,
  })
}

function plausibleTerminalCellSize(
  value: TerminalCellSize | undefined,
): TerminalCellSize | undefined {
  if (
    value === undefined ||
    !Number.isFinite(value.width) ||
    !Number.isFinite(value.height) ||
    value.width < 1 ||
    value.height < 1 ||
    value.width > 512 ||
    value.height > 512
  ) {
    return undefined
  }
  return { width: Math.round(value.width), height: Math.round(value.height) }
}

/**
 * Prepare an RGBA raster that fits a laid-out cell rectangle without
 * distortion. The transparent canvas has the terminal rectangle's physical
 * aspect ratio; the host only downsamples source pixels and centers them
 * inside it. Kitty can then scale that bounded canvas to the requested cells.
 */
export function fitTerminalImageSource(
  source: TerminalImageSource,
  columns: number,
  rows: number,
  cellSize: TerminalCellSize = DEFAULT_TERMINAL_CELL_SIZE,
): TerminalImageSource {
  const cell = normalizeTerminalCellSize(cellSize)
  const safeColumns = Math.max(1, Math.floor(columns))
  const safeRows = Math.max(1, Math.floor(rows))
  const [boxWidth, boxHeight] = boundedPixelBox(
    safeColumns * cell.width,
    safeRows * cell.height,
  )

  // Kitty scales the raster to the requested cell rectangle, so its canvas
  // must have that rectangle's exact physical aspect ratio. Rounding each
  // side independently would distort tiny sources. Use the smallest integer
  // multiple of the reduced ratio that contains the fitted source.
  const requestedWidth = safeColumns * cell.width
  const requestedHeight = safeRows * cell.height
  const divisor = greatestCommonDivisor(requestedWidth, requestedHeight)
  let ratioWidth = requestedWidth / divisor
  let ratioHeight = requestedHeight / divisor
  let maximumMultiple = Math.floor(
    Math.min(boxWidth / ratioWidth, boxHeight / ratioHeight),
  )

  // Some coprime physical dimensions need more pixels than the allocation
  // budget even at their smallest exact ratio. Only then use the nearest
  // uniformly bounded raster ratio.
  if (maximumMultiple < 1) {
    const boundedDivisor = greatestCommonDivisor(boxWidth, boxHeight)
    ratioWidth = boxWidth / boundedDivisor
    ratioHeight = boxHeight / boundedDivisor
    maximumMultiple = boundedDivisor
  }

  const multiple = Math.min(
    maximumMultiple,
    Math.max(
      1,
      Math.ceil(source.width / ratioWidth),
      Math.ceil(source.height / ratioHeight),
    ),
  )
  const canvasWidth = ratioWidth * multiple
  const canvasHeight = ratioHeight * multiple

  const canvasScale = Math.min(
    1,
    canvasWidth / source.width,
    canvasHeight / source.height,
  )
  const fittedWidth = Math.max(
    1,
    Math.min(canvasWidth, Math.round(source.width * canvasScale)),
  )
  const fittedHeight = Math.max(
    1,
    Math.min(canvasHeight, Math.round(source.height * canvasScale)),
  )

  if (
    fittedWidth === source.width &&
    fittedHeight === source.height &&
    canvasWidth === source.width &&
    canvasHeight === source.height
  ) {
    return source
  }

  const content =
    fittedWidth === source.width && fittedHeight === source.height
      ? source.data
      : resizeRgba(source, fittedWidth, fittedHeight)
  if (canvasWidth === fittedWidth && canvasHeight === fittedHeight) {
    return { data: content, width: fittedWidth, height: fittedHeight }
  }

  const data = new Uint8Array(canvasWidth * canvasHeight * 4)
  const left = Math.floor((canvasWidth - fittedWidth) / 2)
  const top = Math.floor((canvasHeight - fittedHeight) / 2)
  const sourceStride = fittedWidth * 4
  for (let row = 0; row < fittedHeight; row++) {
    const sourceStart = row * sourceStride
    const targetStart = ((top + row) * canvasWidth + left) * 4
    data.set(content.subarray(sourceStart, sourceStart + sourceStride), targetStart)
  }
  return { data, width: canvasWidth, height: canvasHeight }
}

function greatestCommonDivisor(left: number, right: number): number {
  while (right !== 0) {
    const remainder = left % right
    left = right
    right = remainder
  }
  return left
}

function boundedPixelBox(width: number, height: number): readonly [number, number] {
  const maxPixels = TERMINAL_IMAGE_MAX_BYTES / 4
  const scale = Math.min(
    1,
    Math.sqrt(maxPixels / (width * height)),
  )
  return [
    Math.max(1, Math.floor(width * scale)),
    Math.max(1, Math.floor(height * scale)),
  ]
}

/** Premultiplied-alpha bilinear resize avoids dark fringes at transparency. */
function resizeRgba(
  source: TerminalImageSource,
  width: number,
  height: number,
): Uint8Array {
  const output = new Uint8Array(width * height * 4)
  const xScale = source.width / width
  const yScale = source.height / height

  for (let y = 0; y < height; y++) {
    const sourceY = (y + 0.5) * yScale - 0.5
    const rawY0 = Math.floor(sourceY)
    const y0 = Math.max(0, Math.min(source.height - 1, rawY0))
    const y1 = Math.max(0, Math.min(source.height - 1, rawY0 + 1))
    const yWeight = sourceY - rawY0

    for (let x = 0; x < width; x++) {
      const sourceX = (x + 0.5) * xScale - 0.5
      const rawX0 = Math.floor(sourceX)
      const x0 = Math.max(0, Math.min(source.width - 1, rawX0))
      const x1 = Math.max(0, Math.min(source.width - 1, rawX0 + 1))
      const xWeight = sourceX - rawX0
      const weight00 = (1 - xWeight) * (1 - yWeight)
      const weight10 = xWeight * (1 - yWeight)
      const weight01 = (1 - xWeight) * yWeight
      const weight11 = xWeight * yWeight
      const offset00 = (y0 * source.width + x0) * 4
      const offset10 = (y0 * source.width + x1) * 4
      const offset01 = (y1 * source.width + x0) * 4
      const offset11 = (y1 * source.width + x1) * 4
      const alpha00 = source.data[offset00 + 3]!
      const alpha10 = source.data[offset10 + 3]!
      const alpha01 = source.data[offset01 + 3]!
      const alpha11 = source.data[offset11 + 3]!
      const alpha =
        alpha00 * weight00 +
        alpha10 * weight10 +
        alpha01 * weight01 +
        alpha11 * weight11
      const red =
        source.data[offset00]! * alpha00 * weight00 +
        source.data[offset10]! * alpha10 * weight10 +
        source.data[offset01]! * alpha01 * weight01 +
        source.data[offset11]! * alpha11 * weight11
      const green =
        source.data[offset00 + 1]! * alpha00 * weight00 +
        source.data[offset10 + 1]! * alpha10 * weight10 +
        source.data[offset01 + 1]! * alpha01 * weight01 +
        source.data[offset11 + 1]! * alpha11 * weight11
      const blue =
        source.data[offset00 + 2]! * alpha00 * weight00 +
        source.data[offset10 + 2]! * alpha10 * weight10 +
        source.data[offset01 + 2]! * alpha01 * weight01 +
        source.data[offset11 + 2]! * alpha11 * weight11

      const target = (y * width + x) * 4
      if (alpha > 0) {
        output[target] = Math.round(red / alpha)
        output[target + 1] = Math.round(green / alpha)
        output[target + 2] = Math.round(blue / alpha)
      }
      output[target + 3] = Math.round(alpha)
    }
  }

  return output
}

/** Validate an untrusted decoded source without copying its pixel buffer. */
export function isTerminalImageSource(
  value: unknown,
): value is TerminalImageSource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const source = value as Partial<TerminalImageSource>
  if (
    !(source.data instanceof Uint8Array) ||
    !Number.isSafeInteger(source.width) ||
    !Number.isSafeInteger(source.height) ||
    source.width! <= 0 ||
    source.height! <= 0 ||
    source.width! > TERMINAL_IMAGE_MAX_EDGE ||
    source.height! > TERMINAL_IMAGE_MAX_EDGE
  ) {
    return false
  }
  const bytes = source.width! * source.height! * 4
  return bytes <= TERMINAL_IMAGE_MAX_BYTES && source.data.byteLength === bytes
}

/** Recover and validate a source stored as primitive Ink host attributes. */
export function terminalImageSourceFromAttributes(
  attributes: Readonly<Record<string, unknown>>,
): TerminalImageSource | undefined {
  const source = {
    data: attributes['imageData'],
    width: attributes['imageWidth'],
    height: attributes['imageHeight'],
  }
  return isTerminalImageSource(source) ? source : undefined
}
