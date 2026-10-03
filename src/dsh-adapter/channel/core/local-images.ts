/**
 * Image staging for a session that takes images without the DSH attachments
 * service (Phase 5b): a backend that declares the `images` capability (the
 * Claude backend sends images as base64 blocks of the message itself) gets
 * the composer's pasted images and `@`-mentioned image files staged HERE —
 * bytes held in memory, never written anywhere — under the limits the
 * backend declares, through the same limit model the DSH store uses
 * (`imageLimits`: media types, per-image and per-message bytes, image count,
 * per-side and total pixel caps) and the same ingress adaptation
 * (`adaptImageForAdmission`: an unaccepted format is converted, an oversize
 * image resampled, when sharp is available).
 *
 * The staged reference has the DSH shape (`ImageAttachmentRef`), so the
 * composer, the `@` expansion and the input pipeline treat it exactly as a
 * stored attachment; its id is local (`local-<sha256 prefix>`, content-
 * addressed). The facade a transcript row shows reads the same bytes back.
 *
 * Bounded: at most {@link LOCAL_IMAGE_LIMIT} images and
 * {@link LOCAL_IMAGE_BYTES} bytes, the oldest dropped first — a facade whose
 * bytes were dropped reports itself unavailable (the row shows the
 * placeholder), it never holds bytes of its own.
 */
import { createHash } from 'node:crypto'
import type { TranscriptImage } from '../../../adapter/ports/channel-view.js'
import type { ImageLimitsView } from '../../../agent/capabilities.js'
import { adaptImageForAdmission, probeImageSize, sniffImageMediaType, withinDimensionLimits } from '../../../utils/imageResize.js'
import type { MentionAttachments, MentionImageBlock, MentionImageMediaType } from '../types.js'

type ImageRef = MentionImageBlock['attachment']

/** Images kept in memory at most (oldest dropped first). */
export const LOCAL_IMAGE_LIMIT = 64
/** Bytes kept in memory at most (oldest dropped first). */
export const LOCAL_IMAGE_BYTES = 96 * 1024 * 1024

interface Stored {
  readonly data: Uint8Array
  readonly ref: ImageRef
}

/** The local store: the attachments subset the composer and `@` expansion
 *  use, plus the facades rows show. */
export interface LocalImageStore extends MentionAttachments {
  /** The lazily-read facade of a staged image (one object per id). */
  facade(attachment: ImageRef): TranscriptImage | undefined
  /** The staged bytes, while kept. */
  bytes(attachmentId: string): Uint8Array | undefined
}

const IMAGE_TYPES: readonly MentionImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Create the store over the limits of the bound session (read per call). */
export function createLocalImageStore(limits: () => ImageLimitsView): LocalImageStore {
  const images = new Map<string, Stored>()
  const facades = new Map<string, TranscriptImage>()
  let total = 0

  const imageLimits = (): MentionAttachments['imageLimits'] => {
    const view = limits()
    return {
      maxImageBytes: view.maxImageBytes,
      maxImagesPerMessage: view.maxImagesPerMessage,
      maxMessageImageBytes: view.maxMessageImageBytes,
      maxImageDimension: view.maxImageDimension,
      maxImagePixels: view.maxImagePixels,
      mediaTypes: IMAGE_TYPES.filter(type => view.mediaTypes.includes(type)),
    }
  }

  const evict = (): void => {
    for (const [id, entry] of images) {
      if (images.size <= LOCAL_IMAGE_LIMIT && total <= LOCAL_IMAGE_BYTES) break
      images.delete(id)
      facades.delete(id)
      total -= entry.data.byteLength
    }
  }

  const facade = (ref: ImageRef): TranscriptImage => {
    const id = String(ref.attachmentId)
    const known = facades.get(id)
    if (known !== undefined) return known
    const view: TranscriptImage = {
      id,
      width: ref.width,
      height: ref.height,
      ...(ref.name === undefined ? {} : { name: ref.name }),
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      read: () => {
        const stored = images.get(id)
        return stored === undefined
          ? Promise.reject(new Error('the image is no longer held in memory'))
          : Promise.resolve(stored.data)
      },
    }
    facades.set(id, view)
    return view
  }

  return {
    get imageLimits() { return imageLimits() },
    async saveImage(input: { data: Uint8Array; mediaType: MentionImageMediaType; name?: string }): Promise<ImageRef> {
      const caps = imageLimits()
      let data = input.data
      let mediaType: MentionImageMediaType = input.mediaType
      // The content wins over the label: a paste or @-mention declares a
      // media type from the filename, and a renamed file would otherwise
      // travel (and be sent to the backend) under a type its bytes
      // contradict. The sniff reads magic bytes only — no decode, no
      // re-encode — so a mislabeled image keeps its bytes, animation
      // included; unmeasurable content still takes the decode-or-refuse
      // path below with the declared label.
      const sniffed = sniffImageMediaType(data)
      if (sniffed !== undefined && sniffed !== mediaType) mediaType = sniffed
      const dimensions = { maxImageDimension: caps.maxImageDimension, maxImagePixels: caps.maxImagePixels }
      let size = probeImageSize(data)
      let originalDimensions: { width: number; height: number } | undefined
      const accepted = caps.mediaTypes.includes(mediaType)
      if (!accepted || size === null || !withinDimensionLimits(size, dimensions)) {
        const outcome = await adaptImageForAdmission(data, mediaType, dimensions, caps.mediaTypes)
        if (outcome.kind === 'adapted') {
          if (size !== null && outcome.resized) originalDimensions = { width: size.width, height: size.height }
          data = outcome.data
          mediaType = outcome.mediaType as MentionImageMediaType
          size = { width: outcome.width, height: outcome.height }
        } else if (outcome.kind === 'unavailable') {
          if (!accepted) throw new Error(`${mediaType} images are not accepted by this backend and could not be converted (${outcome.detail})`)
          if (size === null) throw new Error(`the image could not be measured (${outcome.detail})`)
          // An accepted format the gate could not resample: the backend's
          // own downscaling is the backstop (its hard caps are larger).
        }
      }
      if (size === null) throw new Error('the image could not be measured')
      if (!caps.mediaTypes.includes(mediaType)) throw new Error(`${mediaType} images are not accepted by this backend`)
      if (data.byteLength > caps.maxImageBytes) throw new Error('the image exceeds the backend\'s per-image size limit')
      const attachmentId = `local-${createHash('sha256').update(data).digest('hex').slice(0, 32)}`
      const ref = {
        attachmentId,
        mediaType,
        bytes: data.byteLength,
        width: size.width,
        height: size.height,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(originalDimensions === undefined ? {} : { originalDimensions }),
      } as ImageRef
      const known = images.get(attachmentId)
      if (known !== undefined) {
        // Content-addressed: the same bytes again move to the newest slot.
        images.delete(attachmentId)
        images.set(attachmentId, known)
        return known.ref
      }
      images.set(attachmentId, { data, ref })
      total += data.byteLength
      evict()
      return ref
    },
    facade(attachment: ImageRef): TranscriptImage | undefined {
      return images.has(String(attachment.attachmentId)) ? facade(attachment) : undefined
    },
    bytes: attachmentId => images.get(attachmentId)?.data,
  }
}
