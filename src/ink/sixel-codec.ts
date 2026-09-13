import { FINALIZER, fromRGBA8888, introducer, PALETTE_ANSI_256, sixelEncode } from 'sixel'
import { loadSharp } from '../dsh-adapter/sharp.js'
import { isTerminalImageSource, TERMINAL_IMAGE_MAX_EDGE, TERMINAL_IMAGE_MAX_BYTES,
  TERMINAL_IMAGE_PREVIEW_MAX_EDGE, TERMINAL_IMAGE_PREVIEW_MAX_BYTES,
  SIXEL_MAX_ENCODED_BYTES, SIXEL_CACHE_BYTES, SIXEL_CACHE_ENTRIES } from './terminal-image.js'
import type { TerminalImageSource } from './terminal-image.js'

export interface SixelCrop {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export interface SixelEncodeRequest {
  readonly source: TerminalImageSource
  readonly width: number
  readonly height: number
  readonly background: string
  readonly presentation?: 'preview' | 'transcript'
  readonly crop?: SixelCrop
}

export interface SixelWorkerRequest {
  readonly assetKey: string
  readonly request: Omit<SixelEncodeRequest, 'source'> & { readonly source?: TerminalImageSource }
}

export interface SixelWorkerResponse {
  readonly raster?: SixelRaster
  readonly missing?: boolean
  readonly preparedKeys?: string[]
  readonly quantized?: boolean
}

interface PreparedSixel {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array
  readonly colors: [number, number, number][]
}

export interface SixelRaster {
  readonly width: number
  readonly height: number
  readonly data: string
}

/** CPU-heavy work: called in the image worker, never in the frame painter. */
export async function encodeSixel(request: SixelEncodeRequest): Promise<SixelRaster> {
  return encodeRegion(await prepareSixel(request), request.crop)
}

function validateRasterBounds(request: Omit<SixelEncodeRequest, 'source'>): void {
  const { width, height, background } = request
  const maxEdge = request.presentation === 'preview' ? TERMINAL_IMAGE_PREVIEW_MAX_EDGE : TERMINAL_IMAGE_MAX_EDGE
  const maxBytes = request.presentation === 'preview' ? TERMINAL_IMAGE_PREVIEW_MAX_BYTES : TERMINAL_IMAGE_MAX_BYTES
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || width > maxEdge || height > maxEdge ||
      width * height * 4 > maxBytes || background.length > 64) {
    throw new Error('Invalid Sixel raster bounds')
  }
}

async function prepareSixel(request: SixelEncodeRequest): Promise<PreparedSixel> {
  const { source, width, height, background } = request
  validateRasterBounds(request)
  if (!isTerminalImageSource(source, request.presentation)) throw new Error('Invalid Sixel source')
  const sharp = await loadSharp()
  if (sharp === undefined) throw new Error('Image decoder unavailable')
  const fill = resolveBackground(background)
  // The manager already fits the source aspect for large previews, so 'fill'
  // avoids a one-pixel letterbox stripe there.
  const highResolution = width > TERMINAL_IMAGE_MAX_EDGE || height > TERMINAL_IMAGE_MAX_EDGE
  // Native libimagequant for every size. A JS Wu quantizer pays a fixed 33³
  // histogram-moment cost (about 250 ms even for a 384 px thumbnail) and builds
  // millions of point objects for large previews; libvips does the same work
  // in 11–133 ms. The indexed PNG round trip is how sharp exposes its palette.
  // effort 1 keeps every colour within one level of the source, while effort
  // 10 costs seconds on noisy images.
  const indexed = await sharp(source.data, {
    raw: { width: source.width, height: source.height, channels: 4 },
  })
    .flatten({ background: fill })
    .resize({ width, height, fit: highResolution ? 'fill' : 'contain', background: fill })
    .toColourspace('srgb')
    .ensureAlpha()
    .png({ palette: true, colours: 256, dither: 0, effort: 1, compressionLevel: 1 })
    .toBuffer()
  const data = await sharp(indexed).ensureAlpha().raw().toBuffer()
  if (data.byteLength !== width * height * 4) throw new Error('Invalid quantized raster size')
  const palette = new Set<number>()
  for (let index = 0; index < data.length; index += 4) {
    palette.add((data[index]! << 16) | (data[index + 1]! << 8) | data[index + 2]!)
  }
  if (palette.size > 256) throw new Error('Native palette budget exceeded')
  const colors = [...palette].map(color => [color >>> 16, (color >>> 8) & 255, color & 255] as [number, number, number])
  return { width, height, data, colors }
}

function encodeRegion(image: PreparedSixel, crop?: SixelCrop): SixelRaster {
  const { left, top, width, height } = crop ?? { left: 0, top: 0, width: image.width, height: image.height }
  if (![left, top, width, height].every(Number.isSafeInteger) || left < 0 || top < 0 ||
      width < 1 || height < 1 || left + width > image.width || top + height > image.height) {
    throw new Error('Invalid Sixel crop')
  }
  let pixels: Uint8Array
  if (left === 0 && width === image.width) {
    const view = image.data.subarray(top * width * 4, (top + height) * width * 4)
    // sixel 0.16 reads new Uint32Array(data.buffer), ignoring byteOffset.
    // A clipped view must start at buffer offset zero or it encodes old rows.
    pixels = view.byteOffset === 0 ? view : new Uint8Array(view)
  } else {
    pixels = new Uint8Array(width * height * 4)
    for (let y = 0; y < height; y++) {
      const start = ((top + y) * image.width + left) * 4
      pixels.set(image.data.subarray(start, start + width * 4), y * width * 4)
    }
  }
  // Re-encode the clipped rows using the SAME palette. Cropping must not change
  // quantization or stretch the source, including non-six-pixel-aligned offsets.
  const data = introducer(1) + sixelEncode(pixels, width, height, image.colors) + FINALIZER
  if (data.length > SIXEL_MAX_ENCODED_BYTES) throw new Error('Sixel output budget exceeded')
  return { width, height, data }
}

/** Worker-local LRU: scrolling reuses resized/quantized pixels, not just sources. */
export class SixelEncoderCache {
  private readonly images = new Map<string, PreparedSixel>()
  private bytes = 0

  async render({ assetKey, request }: SixelWorkerRequest): Promise<SixelWorkerResponse> {
    validateRasterBounds(request)
    let image = this.images.get(assetKey)
    const quantized = image === undefined
    if (!image) {
      if (!request.source) return { missing: true }
      image = await prepareSixel({ ...request, source: request.source })
      this.bytes += image.data.byteLength
    } else {
      this.images.delete(assetKey)
    }
    this.images.set(assetKey, image)
    while (this.bytes > SIXEL_CACHE_BYTES || this.images.size > SIXEL_CACHE_ENTRIES) {
      const oldest = this.images.keys().next().value!
      this.bytes -= this.images.get(oldest)!.data.byteLength
      this.images.delete(oldest)
    }
    if (image.width !== request.width || image.height !== request.height) throw new Error('Sixel cache geometry mismatch')
    return { raster: encodeRegion(image, request.crop), preparedKeys: [...this.images.keys()], quantized }
  }
}

/** ANSI themes use terminal color names which sharp does not understand. */
function resolveBackground(color: string): string | { r: number; g: number; b: number } {
  const ansi = /^ansi256\((\d+)\)$/u.exec(color)
  let index = ansi ? Number(ansi[1]) : -1
  if (color.startsWith('ansi:')) {
    const name = color.slice(5)
    const base = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'].indexOf(name.replace(/Bright$/u, ''))
    if (base >= 0) index = base + (name.endsWith('Bright') ? 8 : 0)
    else if (name === 'gray' || name === 'grey') index = 8
  }
  if (index < 0 || index > 255) return color
  const [r, g, b] = fromRGBA8888(PALETTE_ANSI_256[index])
  return { r, g, b }
}
