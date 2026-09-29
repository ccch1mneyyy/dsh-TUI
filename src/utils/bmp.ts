/**
 * Dependency-free BMP → PNG conversion for clipboard screenshots. WSLg (and
 * some X11 owners) expose a Windows bitmap copy as `image/bmp`, a format the
 * attachment profile does not accept and that `sharp`'s prebuilt libvips
 * cannot decode. Only the shapes a screenshot tool produces are handled:
 * uncompressed 24/32-bit pixels (BI_RGB, BI_BITFIELDS, BI_ALPHABITFIELDS),
 * bottom-up or top-down. Anything else returns null and the caller keeps its
 * "format unsupported" path.
 */

import { crc32, deflate, constants } from 'node:zlib'
import { promisify } from 'node:util'

const deflateAsync = promisify(deflate)

/** Refuse absurd dimensions before allocating the pixel buffer. */
const MAX_PIXELS = 100_000_000

const BI_RGB = 0
const BI_BITFIELDS = 3
const BI_ALPHABITFIELDS = 6

interface Channel {
  readonly mask: number
  readonly shift: number
  readonly max: number
}

function channel(mask: number): Channel {
  if (mask === 0) return { mask: 0, shift: 0, max: 0 }
  let shift = 0
  while (((mask >>> shift) & 1) === 0) shift += 1
  return { mask, shift, max: mask >>> shift }
}

function scale(px: number, c: Channel): number {
  if (c.max === 0) return 0
  const v = (px & c.mask) >>> c.shift
  return c.max === 255 ? v : Math.round((v * 255) / c.max)
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

async function encodePng(
  width: number,
  height: number,
  channels: 3 | 4,
  pixels: Buffer,
): Promise<Buffer> {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = channels === 4 ? 6 : 2
  const idat = await deflateAsync(pixels, { level: constants.Z_BEST_SPEED })
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Convert BMP bytes (a `BM` file, or a headerless DIB) to PNG.
 * @param bmp - Raw clipboard bytes.
 * @returns PNG bytes, or null when the bitmap is malformed or uses an
 *   unsupported layout (palettes, RLE, 16-bit, OS/2 core header).
 */
export async function bmpToPng(bmp: Buffer): Promise<Buffer | null> {
  const hasFileHeader = bmp.length >= 14 && bmp[0] === 0x42 && bmp[1] === 0x4d
  const dib = hasFileHeader ? 14 : 0
  if (bmp.length < dib + 40) return null
  const headerSize = bmp.readUInt32LE(dib)
  if (headerSize < 40 || bmp.length < dib + headerSize) return null

  const width = bmp.readInt32LE(dib + 4)
  const rawHeight = bmp.readInt32LE(dib + 8)
  const bpp = bmp.readUInt16LE(dib + 14)
  const compression = bmp.readUInt32LE(dib + 16)
  const height = Math.abs(rawHeight)
  if (width <= 0 || height === 0 || width * height > MAX_PIXELS) return null
  if (bpp !== 24 && bpp !== 32) return null
  if (compression !== BI_RGB && compression !== BI_BITFIELDS && compression !== BI_ALPHABITFIELDS) return null
  if (bpp === 24 && compression !== BI_RGB) return null

  // Channel masks: defaults for BI_RGB, else the three (or four) DWORDs that
  // follow a 40-byte header or sit inside V4/V5 headers at the same offset.
  let redMask = 0x00ff0000
  let greenMask = 0x0000ff00
  let blueMask = 0x000000ff
  let alphaMask = 0
  let maskBytes = 0
  if (bpp === 32 && compression !== BI_RGB) {
    const masksEnd = dib + 40 + (compression === BI_ALPHABITFIELDS ? 16 : 12)
    if (bmp.length < masksEnd) return null
    redMask = bmp.readUInt32LE(dib + 40)
    greenMask = bmp.readUInt32LE(dib + 44)
    blueMask = bmp.readUInt32LE(dib + 48)
    if (headerSize >= 56 || compression === BI_ALPHABITFIELDS) alphaMask = bmp.readUInt32LE(dib + 52)
    if (headerSize === 40) maskBytes = compression === BI_ALPHABITFIELDS ? 16 : 12
  }
  if (bpp === 32 && (redMask === 0 || greenMask === 0 || blueMask === 0)) return null

  const declaredOffset = hasFileHeader ? bmp.readUInt32LE(10) : 0
  const pixelOffset = declaredOffset > 0 ? declaredOffset : dib + headerSize + maskBytes
  const stride = Math.floor((bpp * width + 31) / 32) * 4
  if (pixelOffset + stride * height > bmp.length) return null

  const red = channel(redMask)
  const green = channel(greenMask)
  const blue = channel(blueMask)
  const alpha = channel(alphaMask)
  const bottomUp = rawHeight > 0

  // Alpha only counts when the mask exists AND at least one pixel uses it:
  // clipboard DIBs routinely carry a dead alpha byte of 0 that would turn the
  // whole screenshot transparent.
  let useAlpha = false
  if (bpp === 32 && alpha.max !== 0) {
    scan: for (let y = 0; y < height; y += 1) {
      const row = pixelOffset + y * stride
      for (let x = 0; x < width; x += 1) {
        if (scale(bmp.readUInt32LE(row + x * 4), alpha) !== 0) {
          useAlpha = true
          break scan
        }
      }
    }
  }

  const channels = useAlpha ? 4 : 3
  const rowBytes = width * channels
  const out = Buffer.alloc((rowBytes + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const src = pixelOffset + (bottomUp ? height - 1 - y : y) * stride
    let dst = y * (rowBytes + 1)
    out[dst++] = 0
    if (bpp === 24) {
      for (let x = 0; x < width; x += 1) {
        const p = src + x * 3
        out[dst++] = bmp[p + 2]
        out[dst++] = bmp[p + 1]
        out[dst++] = bmp[p]
      }
    } else {
      for (let x = 0; x < width; x += 1) {
        const px = bmp.readUInt32LE(src + x * 4)
        out[dst++] = scale(px, red)
        out[dst++] = scale(px, green)
        out[dst++] = scale(px, blue)
        if (useAlpha) out[dst++] = scale(px, alpha)
      }
    }
  }
  return encodePng(width, height, channels, out)
}
