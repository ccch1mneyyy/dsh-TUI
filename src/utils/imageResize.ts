/**
 * Inbound image adaptation for the composer's staging gate.
 *
 * The upstream attachment store admits images by media type, byte budget,
 * pixel budget and a per-side dimension cap (`maxImageDimension`). Two kinds
 * of paste used to fail with no user-side recourse: one that exceeds the
 * dimension cap, and one whose format the deployment does not accept. This
 * module measures the bytes BEFORE staging and produces an admissible pair
 * (bytes + media type) through sharp — an optionalDependency, absent on
 * minimal installs, which must degrade with a clear error, not a crash.
 *
 * Sizing probe is pure byte inspection (PNG/JPEG/WebP/GIF). Formats the
 * probe cannot identify return null and MUST be forced through an actual
 * decode for measurement — the #432 review gap was letting an
 * "unrecognized but under the byte cap" image through, where a
 * large-resolution small-byte WebP/GIF would sail past the probe and be
 * rejected by upstream afterwards.
 *
 * The single entry point is {@link adaptImageForAdmission}: it decides
 * whether anything has to change (resample, re-encode, or both) and reports
 * exactly what it did, so the caller can tell the user instead of silently
 * rewriting their image.
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
    // Uncompressed chunk header (10 bytes) then keyframe tag (3) then the
    // dimensions: 14-bit width/height in the low bits of each u16, with a
    // 2-bit horizontal/vertical scale in the top bits (RFC 6386 §9.1). Mask
    // them off, or an encoder that sets the scale bits is measured up to
    // 49152px too wide and gets shrunk far past the caps.
    const width = (b[26]! | (b[27]! << 8)) & 0x3fff
    const height = (b[28]! | (b[29]! << 8)) & 0x3fff
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

function probeGif(b: Uint8Array): ImageSizeProbe | null {
  // Logical screen descriptor: u16 LE at fixed offsets 6/8. A truncated header
  // reads as 0×0 and would then look "inside the caps", so the zero check is
  // what keeps an unmeasurable file on the decode path.
  const width = b[6]! | (b[7]! << 8)
  const height = b[8]! | (b[9]! << 8)
  return width > 0 && height > 0 ? { width, height } : null
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

/** Re-encode preference for a source format the profile does not accept.
 *  Alpha first: never trade transparency away for bytes. For opaque sources
 *  JPEG leads because the per-image BYTE cap — not the pixel cap — is what a
 *  lossless re-encode of a large photo most often blows; PNG is the last
 *  resort there: lossless, and by far the largest wire form. */
const ALPHA_TARGETS = ['image/png', 'image/webp', 'image/jpeg'] as const
const OPAQUE_TARGETS = ['image/jpeg', 'image/webp', 'image/png'] as const

/** Background composited under an alpha channel when the only writable
 *  target carries no transparency. White matches the screenshots and document
 *  captures this gate mostly sees; sharp's default composite is BLACK, which
 *  reads as a broken image on any light UI. */
const OPAQUE_BACKGROUND = { r: 255, g: 255, b: 255 }

/**
 * The media type one re-encode should produce.
 *
 * 1. A source format the profile already accepts is kept: re-encoding a format
 *    nobody objected to costs quality (JPEG) or losslessness (PNG) for
 *    nothing.
 * 2. Otherwise the first accepted entry of the alpha/opaque order above. An
 *    empty allowlist falls back to the source format, which the caller's own
 *    admission check then refuses with the established message.
 */
function chooseTargetMediaType(input: {
  readonly hasAlpha: boolean
  readonly sourceMediaType: string
  readonly acceptedMediaTypes: readonly string[]
}): string {
  const { hasAlpha, sourceMediaType, acceptedMediaTypes } = input
  if (acceptedMediaTypes.includes(sourceMediaType)) return sourceMediaType
  return (hasAlpha ? ALPHA_TARGETS : OPAQUE_TARGETS).find(type => acceptedMediaTypes.includes(type))
    ?? sourceMediaType
}

export type AdaptOutcome =
  | { readonly kind: 'unchanged' }
  | {
    readonly kind: 'adapted'
    readonly data: Uint8Array
    /** Media type of the produced bytes (equals the source's when accepted). */
    readonly mediaType: string
    readonly width: number
    readonly height: number
    /** The source exceeded the caps and was resampled. */
    readonly resized: boolean
    /** An alpha channel was composited onto {@link OPAQUE_BACKGROUND}. */
    readonly flattened: boolean
  }
  | {
    /** Nothing could be produced. Only `sharp-missing` is a degradation a
     * caller may tolerate (the optional dependency is absent, so nothing could
     * be measured at all); every other reason is a definite refusal that must
     * be reported instead of handed to the store. */
    readonly kind: 'unavailable'
    readonly reason: 'sharp-missing' | 'decode-failed' | 'animated-unsupported'
    readonly detail: string
  }

/** Minimal structural types for the sharp calls used here — keeps the
 * module typechecking without depending on the optional package's d.ts
 * resolution in every tsconfig that pulls it in. */
interface SharpPipeline {
  flatten(options: { background: { r: number; g: number; b: number } }): SharpPipeline
  toFormat(format: string, options?: unknown): { toBuffer(): Promise<Uint8Array> }
}
interface SharpInstance extends SharpPipeline {
  metadata(): Promise<{ width?: number; height?: number; pages?: number; hasAlpha?: boolean }>
  resize(width: number, height: number, options: { fit: string }): SharpPipeline
}
type SharpFactory = (input: Uint8Array, options?: { animated?: boolean }) => SharpInstance

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
 * Produce bytes the profile can admit, and report what had to change.
 *
 * Both triggers are size-independent by design: a media type the profile does
 * not accept is converted even when it fits the pixel caps (a small PNG must
 * not be refused while a large one succeeds), and an image the byte probe
 * cannot measure is decoded so its real dimensions decide. The probe still
 * short-circuits the common case — bytes it proves to be inside the caps in an
 * accepted format are returned untouched, with no encoder loaded.
 *
 * Aspect ratio is preserved by {@link downscaleTarget}. An animated source is
 * REFUSED whenever this gate would have to touch its bytes: re-encoding a
 * multi-page image here cannot promise frames, delays and loop survive, and
 * silently returning a still is a data loss the store's own refusal (the
 * behaviour without this gate) never inflicted. Animated images that need no
 * change pass through untouched.
 */
export async function adaptImageForAdmission(
  bytes: Uint8Array,
  sourceMediaType: string,
  limits: ResizeLimits,
  acceptedMediaTypes: readonly string[],
): Promise<AdaptOutcome> {
  const probe = probeImageSize(bytes)
  const sharp = await loadSharp()
  if (sharp === null) {
    return { kind: 'unavailable', reason: 'sharp-missing', detail: 'sharp is not installed in this environment' }
  }
  try {
    // One header read drives every decision below: dimensions for a format
    // the byte probe cannot measure (the #432 gap), alpha support, and the
    // frame count that decides whether this gate may touch the bytes at all.
    const image = sharp(bytes)
    const meta = await image.metadata()
    const measured = probe ?? (meta.width !== undefined && meta.height !== undefined
      ? { width: meta.width, height: meta.height }
      : null)
    if (measured === null) {
      return { kind: 'unavailable', reason: 'decode-failed', detail: 'the image decodes without pixel dimensions' }
    }
    const hasAlpha = meta.hasAlpha === true
    const resized = !withinDimensionLimits(measured, limits)
    if (!resized && acceptedMediaTypes.includes(sourceMediaType)) return { kind: 'unchanged' }
    if ((meta.pages ?? 1) > 1) {
      return {
        kind: 'unavailable',
        reason: 'animated-unsupported',
        detail: `${meta.pages} frames`,
      }
    }
    const mediaType = chooseTargetMediaType({ hasAlpha, sourceMediaType, acceptedMediaTypes })
    const target = downscaleTarget(measured, limits)
    const flattened = hasAlpha && mediaType === 'image/jpeg'
    let pipeline: SharpPipeline = image
    if (resized) pipeline = image.resize(target.width, target.height, { fit: 'inside' })
    if (flattened) pipeline = pipeline.flatten({ background: OPAQUE_BACKGROUND })
    const data = await pipeline
      .toFormat(mediaType.replace('image/', ''), mediaType === 'image/jpeg' ? { quality: 90 } : {})
      .toBuffer()
    return {
      kind: 'adapted',
      data,
      mediaType,
      width: target.width,
      height: target.height,
      resized,
      flattened,
    }
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: 'decode-failed',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}
