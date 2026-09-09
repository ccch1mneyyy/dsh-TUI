import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { rememberImagePath, transcriptImageFromAttachment } from '../transcript-images.js'
import { mentionAttachments } from './mentions.js'
import type { ChannelOwner } from './owner.js'
import type {
  ChannelImageBlock,
  ComposerImageRef,
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
    if (!attachments.imageLimits.mediaTypes.includes(input.mediaType)) {
      throw new Error(`${input.mediaType} images are not accepted by this profile`)
    }
    if (input.data.byteLength > attachments.imageLimits.maxImageBytes) {
      throw new Error(`image exceeds this profile's per-image size limit`)
    }
    // The source path is TUI-side display metadata; the store only sees the
    // fields its contract names.
    const { path, ...stored } = input
    const attachment = await attachments.saveImage(stored)
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
    return { stageId }
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
