import type { TranscriptImage } from '../../dsh-adapter/transcript-images.js'
import { loadSharp } from '../../dsh-adapter/sharp.js'
import { TERMINAL_IMAGE_PREVIEW_MAX_BYTES, TERMINAL_IMAGE_PREVIEW_MAX_EDGE, TERMINAL_IMAGE_MAX_CELLS } from '../../ink/terminal-image.js'
import type { TerminalCellSize, TerminalImageSource } from '../../ink/terminal-image.js'
import { scheduleImageDecode } from './transcriptImageDecode.js'

export interface ImageDimensions { readonly width: number; readonly height: number }
export interface ImageCenter { readonly x: number; readonly y: number }
export const IMAGE_ORIGINAL_MAX_BYTES = 64 * 1024 * 1024
const INPUT_MAX_PIXELS = 64_000_000
export const IMAGE_ZOOM_LEVELS = [1, 2, 4, 8] as const

/** Shrink the cell viewport, never the original pixels, when budgets apply. */
export function inspectionCells(columns: number, rows: number, cell: TerminalCellSize): readonly [number, number] {
  let width = Math.max(1, Math.min(Math.floor(columns), Math.floor(TERMINAL_IMAGE_PREVIEW_MAX_EDGE / cell.width)))
  let height = Math.max(1, Math.min(Math.floor(rows), Math.floor(TERMINAL_IMAGE_PREVIEW_MAX_EDGE / cell.height)))
  const scale = Math.min(1, Math.sqrt(TERMINAL_IMAGE_PREVIEW_MAX_BYTES / (4 * width * height * cell.width * cell.height)),
    Math.sqrt(TERMINAL_IMAGE_MAX_CELLS / (width * height)))
  width = Math.max(1, Math.floor(width * scale))
  height = Math.max(1, Math.floor(height * scale))
  return [width, height]
}

export function inspectionRegion(image: ImageDimensions, viewport: ImageDimensions, zoom: number, center: ImageCenter) {
  if (!IMAGE_ZOOM_LEVELS.some(value => value === zoom) ||
      ![image.width, image.height, viewport.width, viewport.height].every(value => Number.isSafeInteger(value) && value > 0) ||
      !Number.isFinite(center.x) || !Number.isFinite(center.y) ||
      viewport.width > TERMINAL_IMAGE_PREVIEW_MAX_EDGE || viewport.height > TERMINAL_IMAGE_PREVIEW_MAX_EDGE ||
      viewport.width * viewport.height * 4 > TERMINAL_IMAGE_PREVIEW_MAX_BYTES) {
    throw new Error('Invalid original-pixel viewport')
  }
  const width = Math.min(image.width, Math.ceil(viewport.width / zoom))
  const height = Math.min(image.height, Math.ceil(viewport.height / zoom))
  return {
    left: Math.max(0, Math.min(image.width - width, Math.round(center.x - width / 2))),
    top: Math.max(0, Math.min(image.height - height, Math.round(center.y - height / 2))),
    width, height,
  }
}

/** One preview owns one encoded original; no full-resolution JS pixel cache. */
export class ImageInspectionSession {
  private original: Promise<Uint8Array> | undefined
  private dimensions: Promise<ImageDimensions> | undefined
  private readonly lifetime = new AbortController()

  constructor(private readonly image: TranscriptImage) {}

  private read(): Promise<Uint8Array> {
    this.lifetime.signal.throwIfAborted()
    return this.original ??= this.image.read(this.lifetime.signal).then(data => {
      this.lifetime.signal.throwIfAborted()
      if (data.byteLength > IMAGE_ORIGINAL_MAX_BYTES) throw new Error('Original image byte budget exceeded')
      return data
    })
  }

  metadata(): Promise<ImageDimensions> {
    return this.dimensions ??= scheduleImageDecode(this.lifetime.signal, async () => {
      const data = await this.read()
      const sharp = await loadSharp()
      this.lifetime.signal.throwIfAborted()
      if (!sharp) throw new Error('Image decoder unavailable')
      const metadata = await sharp(data, { failOn: 'error', limitInputPixels: INPUT_MAX_PIXELS }).metadata()
      this.lifetime.signal.throwIfAborted()
      const { width, height } = metadata.autoOrient
      if (!width || !height || width * height > INPUT_MAX_PIXELS) throw new Error('Invalid original image dimensions')
      return { width, height }
    }, true)
  }

  async render(viewport: ImageDimensions, zoom: number, center: ImageCenter, signal: AbortSignal): Promise<TerminalImageSource> {
    signal.throwIfAborted()
    const dimensions = await this.metadata()
    signal.throwIfAborted()
    return scheduleImageDecode(signal, async () => {
      signal.throwIfAborted()
      const data = await this.read()
      const sharp = await loadSharp()
      signal.throwIfAborted()
      this.lifetime.signal.throwIfAborted()
      if (!sharp) throw new Error('Image decoder unavailable')
      const crop = inspectionRegion(dimensions, viewport, zoom, center)
      // Crop the original BEFORE resizing. Nearest keeps each source pixel an
      // exact zoom-by-zoom block, including on non-cell-aligned pan positions.
      const pipeline = sharp(data, { failOn: 'error', limitInputPixels: INPUT_MAX_PIXELS })
        .autoOrient().extract(crop)
      if (zoom !== 1) pipeline.resize(crop.width * zoom, crop.height * zoom, { kernel: 'nearest', fit: 'fill' })
      const decoded = await pipeline.toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      signal.throwIfAborted()
      this.lifetime.signal.throwIfAborted()
      if (decoded.info.channels !== 4 || decoded.info.width !== crop.width * zoom || decoded.info.height !== crop.height * zoom) {
        throw new Error('Unexpected original-pixel crop geometry')
      }
      const output = new Uint8Array(viewport.width * viewport.height * 4)
      const width = Math.min(viewport.width, decoded.info.width)
      const height = Math.min(viewport.height, decoded.info.height)
      const left = Math.max(0, Math.floor((viewport.width - decoded.info.width) / 2))
      const top = Math.max(0, Math.floor((viewport.height - decoded.info.height) / 2))
      for (let row = 0; row < height; row++) {
        const offset = row * decoded.info.width * 4
        output.set(decoded.data.subarray(offset, offset + width * 4), ((row + top) * viewport.width + left) * 4)
      }
      return { data: output, ...viewport }
    }, true)
  }

  dispose(): void {
    this.lifetime.abort()
    this.original = undefined
    this.dimensions = undefined
  }
}
