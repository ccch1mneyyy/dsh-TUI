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
 * The sizing probe is pure byte inspection (PNG/JPEG/WebP/GIF) and lives in
 * `src/backends/shared/image-size.ts` (D15), because backends admit pasted
 * images with the same measurement and must not reach into `src/utils/`
 * (B-3); it is re-exported here so this module stays one import for the
 * host's composer gate. Formats the probe cannot identify return null and
 * MUST be forced through an actual decode for measurement — the #432 review
 * gap was letting an "unrecognized but under the byte cap" image through,
 * where a large-resolution small-byte WebP/GIF would sail past the probe and
 * be rejected by upstream afterwards.
 *
 * The single entry point is {@link adaptImageForAdmission}: it decides
 * whether anything has to change (resample, re-encode, or both) and reports
 * exactly what it did, so the caller can tell the user instead of silently
 * rewriting their image.
 */
import { loadSharp } from '../dsh-adapter/sharp.js'
import { probeImageSize, sniffImageMediaType } from '../backends/shared/image-size.js'
import type { ImageSizeProbe } from '../backends/shared/image-size.js'

export { probeImageSize, sniffImageMediaType }
export type { ImageSizeProbe }

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

/** Structural subset of sharp's image pipeline. The dynamic output format
 * comes from profile admission and remains runtime-validated by sharp. */
interface SharpPipeline {
  flatten(options: { background: { r: number; g: number; b: number } }): SharpPipeline
  toFormat(format: string, options?: unknown): { toBuffer(): Promise<Uint8Array> }
}
interface SharpInstance extends SharpPipeline {
  metadata(): Promise<{ width?: number; height?: number; pages?: number; hasAlpha?: boolean }>
  resize(width: number, height: number, options: { fit: string }): SharpPipeline
}
type SharpFactory = (input: Uint8Array, options?: { animated?: boolean }) => SharpInstance

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
  // Share the host-first decoder with previews; a bare import here can load
  // a second libvips and write native warnings straight into the live TUI.
  const sharp = await loadSharp() as SharpFactory | undefined
  if (sharp === undefined) {
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
