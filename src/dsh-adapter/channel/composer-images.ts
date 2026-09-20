import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { rememberImagePath, transcriptImageFromAttachment } from '../transcript-images.js'
import { probeImageSize, adaptImageForAdmission, withinDimensionLimits } from '../../utils/imageResize.js'
import type { AdaptOutcome, ImageSizeProbe, ResizeLimits } from '../../utils/imageResize.js'
import { mentionAttachments } from './mentions.js'
import type { ChannelOwner } from './owner.js'
import type {
  ChannelImageBlock,
  ComposerImageRef,
  StagedImageAdjustment,
  StagedImageHandle,
  StagedImageInput,
  TranscriptImage,
} from './types.js'

/** Every visible composer placeholder token, in source order. */
export const COMPOSER_IMAGE_TOKEN = /\[Image #\d+\]/gu

/** One whole placeholder token; the distinction matters because a mention
 *  reference needs an `@` prefix while an image token must stay verbatim. */
export const COMPOSER_IMAGE_TOKEN_EXACT = /^\[Image #\d+\]$/u

export const formatMissingReference = (reference: string): string =>
  COMPOSER_IMAGE_TOKEN_EXACT.test(reference) ? reference : `@${reference}`

/** Resolve only capabilities explicitly carried by this draft, in first
 *  textual-occurrence order. The visible token is presentation, never
 *  identity: raw history/rewind text has no stageId and therefore resolves
 *  to nothing even if a later draft happens to display the same number. */
export function orderedComposerImages<T>(
  text: string,
  refs: readonly ComposerImageRef[],
  staged: ReadonlyMap<string, T>,
): Map<string, T> {
  const byToken = new Map<string, string>()
  for (const ref of refs) {
    if (!byToken.has(ref.token)) byToken.set(ref.token, ref.stageId)
  }
  const ordered = new Map<string, T>()
  for (const match of text.matchAll(COMPOSER_IMAGE_TOKEN)) {
    const token = match[0]
    if (ordered.has(token)) continue
    const stageId = byToken.get(token)
    if (stageId === undefined) continue
    const image = staged.get(stageId)
    if (image !== undefined) ordered.set(token, image)
  }
  return ordered
}

/** The FIRST placeholder in `text` that resolved to no live capability: an
 *  evicted (FIFO cap) or foreign draft's token would otherwise ship as plain
 *  text with no image attached. Callers warn once and deliver unchanged. */
export function firstStaleComposerToken(
  text: string,
  ordered: ReadonlyMap<string, unknown>,
): string | undefined {
  for (const match of text.matchAll(COMPOSER_IMAGE_TOKEN)) {
    if (!ordered.has(match[0])) return match[0]
  }
  return undefined
}

/** Insertion-order FIFO bound on live capabilities. References are
 *  content-addressed and durable; this map only connects editable
 *  placeholders to them. */
const STAGED_IMAGE_LIMIT = 128

export interface ComposerImageLimits {
  readonly maxImageBytes: number
  readonly maxImagesPerMessage: number
  /** Per-side intrinsic pixel cap mirrored from the upstream store so the
   *  ingress gate can resample before staging (issue #938). */
  readonly maxImageDimension: number
  /** Total-pixel cap ditto. */
  readonly maxImagePixels: number
}

/** The composer's staged-image capability store plus its draft-binding rules. */
export interface ComposerImages {
  /** Current composer generation. Async paste continuations capture this
   *  before I/O and must not mutate a different session's draft. */
  stagedImageGeneration(): number
  /** Validate and persist an image, returning the historical scene-facing
   *  `[Image #N]` token accepted by submit/steer/registry commands. */
  stageImage(input: StagedImageInput): Promise<string>
  /** Draft-safe composer companion: bind persistence to one session epoch
   *  and return an opaque capability whose visible label belongs to Prompt. */
  stageComposerImage(input: StagedImageInput, generation: number): Promise<StagedImageHandle>
  hasStagedImage(stageId: string): boolean
  discardStagedImage(stageId: string): void
  stagedImage(stageId: string): TranscriptImage | undefined
  stagedImageLimits(): ComposerImageLimits | undefined
  /** Revoke every capability of the session being replaced and bump the
   *  generation so in-flight saves cannot register into the new one. */
  clearStagedImages(): void
  /** Immutable view of the live capabilities (stageId → durable reference). */
  snapshot(): ReadonlyMap<string, ChannelImageBlock['attachment']>
  /** Add scene-era token bindings only when the caller did not supply an
   *  explicit draft capability for that visible token. */
  includeLegacyImageRefs(text: string, images: readonly ComposerImageRef[]): readonly ComposerImageRef[]
  /** Enqueue-time capture: legacy bindings merged, one object per ref. */
  captureDraftImages(text: string, images: readonly ComposerImageRef[]): readonly ComposerImageRef[]
}

/** Failure text for a refusal the ingress gate can state before the store:
 *  every reason except a missing sharp describes an image the deployment
 *  would reject anyway, so the paste is refused with the cause named. */
function admissionFailure(
  outcome: Extract<AdaptOutcome, { kind: 'unavailable' }>,
  context: { readonly probe: ImageSizeProbe | null; readonly mediaType: string; readonly limits: ResizeLimits },
): string {
  switch (outcome.reason) {
    case 'sharp-missing':
      return context.probe !== null
        ? `image is ${context.probe.width}×${context.probe.height} (over ${context.limits.maxImageDimension}px) and sharp is unavailable to resample it`
        : `${context.mediaType} is not accepted by this profile and sharp is unavailable to convert it`
    case 'animated-unsupported':
      return `resizing or converting this animated image cannot keep its frames (${outcome.detail})`
    default:
      return `image could not be decoded to resize or convert it (${outcome.detail})`
  }
}

/** A store-reported pixel dimension, or the gate's own value when the store
 *  reported none (lean attachment fakes in the verify scripts). */
const positiveOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && value > 0 ? value : fallback

/**
 * Owns the editable-composer image capabilities: the session epoch, the
 * capability map, its preview facades and the `[Image #N]` compatibility
 * bindings minted by the public scene `stageImage()` API.
 */
export function createComposerImages(
  ctx: Context,
  owner: ChannelOwner,
  deps: { generation(): number },
): ComposerImages {
  /** Session epoch for the staged-image maps: bumped by every clear so a
   *  `saveImage` that was still in flight when the session changed cannot
   *  register its capability in the NEW session. */
  let stagedImageEpoch = 0
  const stagedImages = new Map<string, ChannelImageBlock['attachment']>()
  /** Compatibility bindings minted by the public scene `stageImage()` API.
   * New Prompt drafts carry explicit opaque refs instead. */
  const legacyStagedImageRefs = new Map<string, string>()
  let legacyStagedImageSequence = 0
  /** UI facades for staged capabilities, one stable object per id so the
   *  component-side decode cache (keyed by object identity) can hit. Keys
   *  mirror `stagedImages` exactly — same insert, evict and clear. */
  const stagedImageViews = new Map<string, TranscriptImage>()

  const deleteStagedImage = (stageId: string): void => {
    stagedImages.delete(stageId)
    stagedImageViews.delete(stageId)
    for (const [token, candidate] of legacyStagedImageRefs) {
      if (candidate === stageId) legacyStagedImageRefs.delete(token)
    }
  }

  const clearStagedImages = (): void => {
    stagedImageEpoch += 1
    stagedImages.clear()
    stagedImageViews.clear()
    legacyStagedImageRefs.clear()
    legacyStagedImageSequence = 0
  }

  /** The binding generation the live capabilities belong to. Every entry
   *  point re-checks it, so a replacement session revokes the old draft's
   *  capabilities BEFORE any subscriber can observe it — the invariant the
   *  single-file channel got by clearing immediately after the agent rebind,
   *  made independent of the caller's ordering. */
  let syncedGeneration: number | undefined
  const syncSession = (): void => {
    const generation = deps.generation()
    if (syncedGeneration === undefined) {
      syncedGeneration = generation
      return
    }
    if (generation === syncedGeneration) return
    syncedGeneration = generation
    clearStagedImages()
  }

  const includeLegacyImageRefs = (
    text: string,
    images: readonly ComposerImageRef[],
  ): readonly ComposerImageRef[] => {
    if (legacyStagedImageRefs.size === 0) return images
    const merged = images.map(image => ({ ...image }))
    const claimed = new Set(merged.map(image => image.token))
    for (const match of text.matchAll(COMPOSER_IMAGE_TOKEN)) {
      const token = match[0]
      if (claimed.has(token)) continue
      const stageId = legacyStagedImageRefs.get(token)
      if (stageId === undefined || !stagedImages.has(stageId)) continue
      merged.push({ token, stageId })
      claimed.add(token)
    }
    return merged
  }

  const persistComposerImage = async (
    input: StagedImageInput,
    generation: number,
  ): Promise<StagedImageHandle> => {
    syncSession()
    const attachments = mentionAttachments(ctx)
    if (attachments === undefined) throw new Error('image attachments are unavailable in this profile')
    if (generation !== stagedImageEpoch) {
      throw new Error('the session changed while the image was being staged')
    }
    if (input.data.byteLength > attachments.imageLimits.maxImageBytes) {
      throw new Error(`image exceeds this profile's per-image size limit`)
    }
    // Ingress adaptation (issue #938): the store admits by media type, byte
    // budget and the per-side / total pixel caps, and refuses on all of them
    // when the bytes reach it. Measure and re-encode HERE instead, while the
    // paste can still be explained to the user. Admission is judged against
    // the pair this gate HANDS OVER (the store may normalize further on its
    // own — that step is outside this feature), and both triggers are
    // size-independent:
    //   * a source media type the profile does not accept is converted, so a
    //     small PNG is never refused while a large one succeeds;
    //   * a probe-recognized image inside the caps skips sharp entirely;
    //   * an unrecognized format is decoded for measurement (never trusted by
    //     byte budget alone — the #432 gap);
    //   * with sharp absent the image goes to the store unchanged ONLY while
    //     it is still admissible as-is — an accepted format whose size the
    //     probe could not prove fits (upstream stays the backstop); a measured
    //     oversize, a decode failure, an unaccepted format or a multi-frame
    //     image this gate would have to re-encode is reported now instead of
    //     becoming a token that dies at save time.
    // The runtime guards keep older attachment fakes (whose imageLimits
    // predate the dimension fields) on the legacy synchronous path.
    const dimensionCap = attachments.imageLimits.maxImageDimension
    const pixelCap = attachments.imageLimits.maxImagePixels
    let mediaType = input.mediaType
    let data = input.data
    let adapted: Extract<AdaptOutcome, { kind: 'adapted' }> | undefined
    if (typeof dimensionCap === 'number' && typeof pixelCap === 'number'
      && Number.isFinite(dimensionCap) && Number.isFinite(pixelCap)) {
      const dimensionLimits = { maxImageDimension: dimensionCap, maxImagePixels: pixelCap }
      const probe = probeImageSize(data)
      const sourceAccepted = attachments.imageLimits.mediaTypes.includes(mediaType)
      // Only a probe-measured oversize is *known* to be refused by the store;
      // an unmeasurable image may well be admissible, which is what keeps the
      // sharp-less degradation a degradation rather than a guess.
      const knownOversize = probe !== null && !withinDimensionLimits(probe, dimensionLimits)
      if (!sourceAccepted || probe === null || knownOversize) {
        const outcome = await adaptImageForAdmission(
          data,
          mediaType,
          dimensionLimits,
          attachments.imageLimits.mediaTypes,
        )
        if (outcome.kind === 'adapted') {
          // outcome.mediaType comes from the accepted list inside the gate, so
          // it is one of the profile's media types at runtime — narrowing,
          // not trusting.
          mediaType = outcome.mediaType as typeof mediaType
          data = outcome.data
          adapted = outcome
          if (data.byteLength > attachments.imageLimits.maxImageBytes) {
            throw new Error(`image still exceeds this profile's per-image size limit after resampling`)
          }
        } else if (outcome.kind === 'unavailable') {
          // Degrade ONLY when the paste is still admissible as-is: an accepted
          // format whose size the probe could not prove fits. Everything else
          // (measured oversize, unaccepted format, decode failure, animation
          // that cannot survive) is a refusal we can state now.
          const degraded = outcome.reason === 'sharp-missing' && sourceAccepted && !knownOversize
          if (!degraded) throw new Error(admissionFailure(outcome, { probe, mediaType, limits: dimensionLimits }))
        }
      }
    }
    // What the store will actually see: an accepted media type, inside the
    // byte cap. A media type can still be unaccepted here only when the
    // adaptation did not run (legacy limits) or could not produce one.
    if (!attachments.imageLimits.mediaTypes.includes(mediaType)) {
      throw new Error(`${mediaType} images are not accepted by this profile`)
    }
    // The source path is TUI-side display metadata; the store only sees the
    // fields its contract names. mediaType/data may be the adapted pair from
    // the ingress gate above.
    const { path, ...stored } = input
    const attachment = await attachments.saveImage({ ...stored, mediaType, data })
    // A session change (/new, resume, rewind, model switch, background)
    // cleared the maps while the save was in flight: the durable object is
    // harmless, but the OLD session's capability must not reach the new one.
    syncSession()
    if (generation !== stagedImageEpoch) {
      throw new Error('the session changed while the image was being staged')
    }
    const stageId = randomUUID()
    stagedImages.set(stageId, attachment)
    if (path !== undefined) rememberImagePath(String(attachment.attachmentId), path)
    const view = transcriptImageFromAttachment(attachment, () => ctx.get('attachments'))
    if (view !== undefined) stagedImageViews.set(stageId, view)
    while (stagedImages.size > STAGED_IMAGE_LIMIT) {
      const oldest = stagedImages.keys().next().value as string | undefined
      if (oldest === undefined) break
      deleteStagedImage(oldest)
    }
    // The adjustment travels with the capability so the composer can say what
    // happened instead of letting a rewritten image reach the store silently.
    // Its numbers come from the STORE's own report, not from what this gate
    // handed over: the store normalizes further (dimensions, and the media type
    // too), and a notice quoting the gate's numbers would contradict the
    // preview card the user is looking at.
    const adjustment: StagedImageAdjustment | undefined = adapted === undefined ? undefined : {
      sourceMediaType: input.mediaType,
      mediaType: attachment.mediaType,
      width: positiveOr(attachment.width, adapted.width),
      height: positiveOr(attachment.height, adapted.height),
      resized: adapted.resized
        || positiveOr(attachment.width, adapted.width) !== adapted.width
        || positiveOr(attachment.height, adapted.height) !== adapted.height,
      flattened: adapted.flattened,
    }
    return adjustment === undefined ? { stageId } : { stageId, adjustment }
  }

  return {
    stagedImageGeneration(): number {
      syncSession()
      return stagedImageEpoch
    },
    async stageImage(input: StagedImageInput): Promise<string> {
      owner.assertActive()
      syncSession()
      const generation = stagedImageEpoch
      const { stageId } = await persistComposerImage(input, generation)
      legacyStagedImageSequence += 1
      const token = `[Image #${legacyStagedImageSequence}]`
      legacyStagedImageRefs.set(token, stageId)
      return token
    },
    stageComposerImage(input: StagedImageInput, generation: number): Promise<StagedImageHandle> {
      owner.assertActive()
      syncSession()
      return persistComposerImage(input, generation)
    },
    hasStagedImage(stageId: string): boolean {
      syncSession()
      return stagedImages.has(stageId)
    },
    discardStagedImage(stageId: string): void {
      // Revocation stays callable after disposal: the composer's own cleanup
      // paths release capabilities they already own.
      syncSession()
      deleteStagedImage(stageId)
    },
    stagedImage(stageId: string): TranscriptImage | undefined {
      syncSession()
      return stagedImageViews.get(stageId)
    },
    stagedImageLimits(): ComposerImageLimits | undefined {
      syncSession()
      const limits = mentionAttachments(ctx)?.imageLimits
      if (limits === undefined) return undefined
      return {
        maxImageBytes: limits.maxImageBytes,
        maxImagesPerMessage: limits.maxImagesPerMessage,
        maxImageDimension: limits.maxImageDimension,
        maxImagePixels: limits.maxImagePixels,
      }
    },
    clearStagedImages(): void {
      syncSession()
      clearStagedImages()
    },
    snapshot(): ReadonlyMap<string, ChannelImageBlock['attachment']> {
      syncSession()
      return new Map(stagedImages)
    },
    includeLegacyImageRefs(text: string, images: readonly ComposerImageRef[]): readonly ComposerImageRef[] {
      syncSession()
      return includeLegacyImageRefs(text, images)
    },
    captureDraftImages(text: string, images: readonly ComposerImageRef[]): readonly ComposerImageRef[] {
      syncSession()
      return includeLegacyImageRefs(text, images).map(image => ({ ...image }))
    },
  }
}
