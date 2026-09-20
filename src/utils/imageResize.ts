/**
 * Inbound image resizing for the composer's staging gate.
 *
 * The upstream attachment store admits images by media type, byte budget,
 * pixel budget and a per-side dimension cap (`maxImageDimension`). A paste
 * that exceeds the dimension cap used to fail at submit with no user-side
 * recourse; this module measures the bytes BEFORE staging and, when they
 * overshoot, resamples through sharp (an optionalDependency — absent on
 * minimal installs, which must degrade with a clear error, not a crash).
 *
 * Sizing probe is pure byte inspection (PNG/JPEG/WebP/GIF). Formats the
 * probe cannot identify return null and MUST be forced through an actual
 * decode for measurement — the #432 review gap was letting an
 * "unrecognized but under the byte cap" image through, where a
 * large-resolution small-byte WebP/GIF would sail past the probe and be
 * rejected by upstream afterwards.
 */

export interface ImageSizeProbe {
  readonly width: number
  readonly height: number
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

function probePng(b: Uint8Array): ImageSizeProbe | null {
  // IHDR is required to be the first chunk: width/height are big-endian
  // u32 at fixed offsets 16/20.
  if (b.length < 24) return null
  const width = (b[16]! << 24) | (b[17]! << 16) | (b[18]! << 8) | b[19]!
  const height = (b[20]! << 24) | (b[21]! << 16) | (b[22]! << 8) | b[23]!
  return width > 0 && height > 0 ? { width, height } : null
}

function probeJpeg(b: Uint8Array): ImageSizeProbe | null {
  // Walk the segment chain to the first SOF marker (C0–CF except C4 DHT,
  // C8 JPG, CC DAC); height/width are big-endian u16 at +5/+7 inside it.
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]!
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2 // standalone markers carry no length
      continue
    }
    const segLen = (b[i + 2]! << 8) | b[i + 3]!
    if (segLen < 2) return null
    const isSof = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      const height = (b[i + 5]! << 8) | b[i + 6]!
      const width = (b[i + 7]! << 8) | b[i + 8]!
      return width > 0 && height > 0 ? { width, height } : null
    }
    i += 2 + segLen
  }
  return null
}

function probeWebp(b: Uint8Array): ImageSizeProbe | null {
  // RIFF....WEBP followed by VP8X (extended) or VP8 (lossy) or VP8L
  // (lossless). VP8X carries the canvas size as 1-subtracted 24-bit LE;
  // VP8 carries u16 LE after the frame tag; VP8L packs 14-bit
  // 1-subtracted fields after the signature byte.
  if (b.length < 30) return null
  if (b[0] !== 0x52 || b[1] !== 0x49 || b[2] !== 0x46 || b[3] !== 0x46) return null
  if (b[8] !== 0x57 || b[9] !== 0x45 || b[10] !== 0x42 || b[11] !== 0x50) return null
  const fourcc = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!)
  if (fourcc === 'VP8X') {
    const width = 1 + ((b[24]! | (b[25]! << 8) | (b[26]! << 16)) & 0xffffff)
    const height = 1 + ((b[27]! | (b[28]! << 8) | (b[29]! << 16)) & 0xffffff)
    return { width, height }
  }
  if (fourcc === 'VP8 ') {
    // Uncompressed chunk header (10 bytes) then keyframe tag (3) then
    // the 16-bit dimensions.
    const width = b[26]! | (b[27]! << 8)
    const height = b[28]! | (b[29]! << 8)
    return width > 0 && height > 0 ? { width, height } : null
  }
  if (fourcc === 'VP8L') {
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0
    const width = (bits & 0x3fff) + 1
    const height = ((bits >> 14) & 0x3fff) + 1
    return { width, height }
  }
  return null
}

function probeGif(b: Uint8Array): ImageSizeProbe {
  // Logical screen descriptor: u16 LE at fixed offsets 6/8.
  const width = b[6]! | (b[7]! << 8)
  const height = b[8]! | (b[9]! << 8)
  return { width, height }
}

/**
 * Measure intrinsic pixel dimensions from the encoded bytes alone — no
 * decode, no dependencies. Recognizes PNG / JPEG / WebP (VP8X, VP8,
 * VP8L) / GIF; anything else returns null, which callers MUST treat as
 * "unknown, force a real decode" — never as "small enough".
 */
export function probeImageSize(bytes: Uint8Array): ImageSizeProbe | null {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((v, i) => bytes[i] === v)) {
    return probePng(bytes)
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return probeJpeg(bytes)
  }
  if (bytes.length >= 30 && bytes[0] === 0x52 && bytes[8] === 0x57) {
    return probeWebp(bytes)
  }
  if (bytes.length >= 10
    && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return probeGif(bytes)
  }
  return null
}

/** The admission limits that matter for resampling decisions. */
export interface ResizeLimits {
  /** Maximum intrinsic width AND height, per side, in pixels. */
  readonly maxImageDimension: number
  /** Maximum width × height in pixels. */
  readonly maxImagePixels: number
}

/** Whether a measured image already satisfies the dimension/pixel caps. */
export function withinDimensionLimits(size: ImageSizeProbe, limits: ResizeLimits): boolean {
  return size.width <= limits.maxImageDimension
    && size.height <= limits.maxImageDimension
    && size.width * size.height <= limits.maxImagePixels
}

/**
 * Target dimensions that bring an oversized image inside `limits` while
 * preserving the aspect ratio: scale down by the largest of the three
 * required factors (per-side, per-side, total-pixels).
 */
export function downscaleTarget(size: ImageSizeProbe, limits: ResizeLimits): ImageSizeProbe {
  const factors = [
    size.width / limits.maxImageDimension,
    size.height / limits.maxImageDimension,
    Math.sqrt((size.width * size.height) / limits.maxImagePixels),
  ]
  const factor = Math.max(1, ...factors)
  return {
    width: Math.max(1, Math.floor(size.width / factor)),
    height: Math.max(1, Math.floor(size.height / factor)),
  }
}

export type ShrinkOutcome =
  | { readonly kind: 'unchanged' }
  | {
    readonly kind: 'resized'
    readonly data: Uint8Array
    /** Media type of the re-encoded bytes (may differ from the input's). */
    readonly mediaType: string
    readonly width: number
    readonly height: number
  }
  | {
    /** sharp missing (optionalDependency not installed) or the decode of
     * the oversized bytes failed — distinct reasons, same shape: staging
     * must stop with a message naming the cause. */
    readonly kind: 'unavailable'
    readonly reason: 'sharp-missing' | 'decode-failed'
    readonly detail: string
  }

/** Minimal structural types for the sharp calls used here — keeps the
 * module typechecking without depending on the optional package's d.ts
 * resolution in every tsconfig that pulls it in. */
interface SharpPipeline {
  toFormat(format: string, options?: unknown): { toBuffer(): Promise<Uint8Array> }
}
interface SharpInstance {
  metadata(): Promise<{ width?: number; height?: number }>
  resize(width: number, height: number, options: { fit: string }): SharpPipeline
}
type SharpFactory = (input: Uint8Array) => SharpInstance

/** Load sharp lazily so a missing optionalDependency stays a typed outcome. */
async function loadSharp(): Promise<SharpFactory | null> {
  try {
    // The ESM build exposes the factory as the namespace's default; some
    // bundlers hand the function itself. Handle both without trusting either.
    const mod: unknown = await import('sharp')
    if (typeof mod === 'function') return mod as SharpFactory
    if (typeof mod === 'object' && mod !== null) {
      const candidate = (mod as { default?: unknown }).default
      if (typeof candidate === 'function') return candidate as SharpFactory
    }
    return null
  } catch {
    return null
  }
}

/**
 * Bring image bytes inside `limits`, preserving aspect ratio.
 *
 * `acceptedMediaTypes` orders the re-encode fallback: an oversized image is
 * re-encoded in its own format when that format is still accepted,
 * otherwise in the first accepted format sharp can write (png/jpeg are the
 * dependable writers). Pass the input's media type as `sourceMediaType`.
 */
export async function shrinkImageToLimits(
  bytes: Uint8Array,
  sourceMediaType: string,
  limits: ResizeLimits,
  acceptedMediaTypes: readonly string[],
): Promise<ShrinkOutcome> {
  const probe = probeImageSize(bytes)
  const sharp = await loadSharp()
  if (sharp === null) {
    return { kind: 'unavailable', reason: 'sharp-missing', detail: 'sharp is not installed in this environment' }
  }
  try {
    let measured = probe
    if (measured === null) {
      // Unknown-to-the-probe format (or corrupted header): the #432 gap —
      // measure by actually decoding instead of trusting the byte budget.
      const meta = await sharp(bytes).metadata()
      if (meta.width === undefined || meta.height === undefined) {
        return { kind: 'unavailable', reason: 'decode-failed', detail: 'the image decodes without pixel dimensions' }
      }
      measured = { width: meta.width, height: meta.height }
    }
    if (withinDimensionLimits(measured, limits)) return { kind: 'unchanged' }
    const target = downscaleTarget(measured, limits)
    const targetMediaType = acceptedMediaTypes.includes(sourceMediaType)
      ? sourceMediaType
      : (acceptedMediaTypes.find(t => t === 'image/png' || t === 'image/jpeg') ?? 'image/png')
    const output = await sharp(bytes)
      .resize(target.width, target.height, { fit: 'inside' })
      .toFormat(targetMediaType.replace('image/', ''), targetMediaType === 'image/jpeg' ? { quality: 90 } : {})
      .toBuffer()
    return {
      kind: 'resized',
      data: output,
      mediaType: targetMediaType,
      width: target.width,
      height: target.height,
    }
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: 'decode-failed',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}
