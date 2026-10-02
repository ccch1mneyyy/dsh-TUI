/**
 * Image input for Claude sessions (Phase 5b): the limits the composer stages
 * images under (the `images` capability), the base64 image blocks a user
 * message carries after its text, and the lazy facades a transcript image
 * block replays as.
 *
 * Limits (the Anthropic Messages API): PNG / JPEG / GIF / WebP, at most
 * 5 MiB per image after the composer's downsample path; a message carries
 * at most 20 images (the API's dimension cap tightens to 2000 px per side
 * beyond 20) and 20 MiB of image bytes (≈ 27 MB of base64, under the 32 MB
 * request cap); images are resampled into 2000 px per side / 4 MP — the API
 * scales larger ones down anyway.
 *
 * Replay: `getSessionMessages` returns the base64 blocks as sent. A facade
 * keeps the base64 string the transcript already holds and decodes nothing
 * until asked: its size is probed from a short decoded prefix on first
 * access, its bytes decoded on `read()` — no pixels in the projection.
 */
import type { TranscriptImage } from '../../adapter/ports/channel-view.js'
import type { ImageLimitsView } from '../../agent/capabilities.js'
import type { ImageRef } from '../../agent/events.js'
import { t } from '../../i18n.js'
import { probeImageSize } from '../../utils/imageResize.js'

/** What a Claude message may carry (see the module comment). */
export const CLAUDE_IMAGE_LIMITS: ImageLimitsView = Object.freeze({
  mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  maxImageBytes: 5 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 20 * 1024 * 1024,
  maxImageDimension: 2000,
  maxImagePixels: 4_000_000,
})

/** One base64 image block as the Messages API takes it. */
export interface ClaudeImageBlock {
  readonly type: 'image'
  readonly source: { readonly type: 'base64'; readonly media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; readonly data: string }
}

const isAccepted = (mediaType: string | undefined): mediaType is ClaudeImageBlock['source']['media_type'] =>
  mediaType !== undefined && (CLAUDE_IMAGE_LIMITS.mediaTypes as readonly string[]).includes(mediaType)

/**
 * The image blocks of one message, in order: every staged image read back
 * and checked against the limits once more (a limit change, a foreign
 * facade). Throws a user-facing sentence when one cannot be sent — never a
 * message silently missing an image.
 */
export async function claudeImageBlocks(images: readonly TranscriptImage[], limits: ImageLimitsView = CLAUDE_IMAGE_LIMITS): Promise<ClaudeImageBlock[]> {
  if (images.length > limits.maxImagesPerMessage) throw new Error(t('claude-images-too-many', { n: limits.maxImagesPerMessage }))
  const blocks: ClaudeImageBlock[] = []
  let total = 0
  for (const image of images) {
    const label = image.name ?? image.id
    if (!isAccepted(image.mediaType) || !limits.mediaTypes.includes(image.mediaType)) throw new Error(t('claude-image-type-refused', { name: label, type: image.mediaType ?? '?' }))
    let data: Uint8Array
    try {
      data = await image.read()
    } catch (error) {
      throw new Error(t('claude-image-unreadable', { name: label, err: error instanceof Error ? error.message : String(error) }))
    }
    if (data.byteLength > limits.maxImageBytes) throw new Error(t('claude-image-too-large', { name: label, mb: Math.round(limits.maxImageBytes / (1024 * 1024)) }))
    total += data.byteLength
    if (total > limits.maxMessageImageBytes) throw new Error(t('claude-images-too-large', { mb: Math.round(limits.maxMessageImageBytes / (1024 * 1024)) }))
    blocks.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64') } })
  }
  return blocks
}

/** Base64 characters decoded to probe an image's size (a multiple of 4: ≈ 64 KiB). */
const PROBE_CHARS = 87_384

/** The decoded byte length of a base64 string (no decoding). */
function decodedLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(data.length * 3 / 4) - padding)
}

/**
 * A lazy facade over one base64 image the transcript holds: the size is
 * probed on first access (a decoded prefix; the whole image only when the
 * prefix does not reach the size header), the bytes decoded on `read()`.
 */
export function base64ImageFacade(id: string, mediaType: string, data: string): TranscriptImage {
  let size: { readonly width: number; readonly height: number } | null | undefined
  const measure = (): { readonly width: number; readonly height: number } | null => {
    if (size !== undefined) return size
    const head = Buffer.from(data.slice(0, PROBE_CHARS), 'base64')
    size = probeImageSize(head) ?? (data.length > PROBE_CHARS ? probeImageSize(Buffer.from(data, 'base64')) : null)
    return size
  }
  return {
    id,
    mediaType,
    bytes: decodedLength(data),
    // A size the probe cannot read lays out square (the preview still loads).
    get width(): number { return measure()?.width ?? 1 },
    get height(): number { return measure()?.height ?? 1 },
    read: () => Promise.resolve(new Uint8Array(Buffer.from(data, 'base64'))),
  }
}

type Rec = Readonly<Record<string, unknown>>
const rec = (value: unknown): Rec | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Rec : undefined

/** The base64 image blocks of a user message's content, as lazy facades
 *  (`<idPrefix>#<n>`); other sources (URLs, files) are not shown. */
export function transcriptImages(content: unknown, idPrefix: string): ImageRef[] {
  if (!Array.isArray(content)) return []
  const images: ImageRef[] = []
  content.forEach((raw, index) => {
    const block = rec(raw)
    const source = rec(block?.source)
    if (block?.type !== 'image' || source?.type !== 'base64') return
    const data = source.data
    const mediaType = source.media_type
    if (typeof data !== 'string' || data === '' || typeof mediaType !== 'string') return
    images.push(base64ImageFacade(`${idPrefix}#${index}`, mediaType, data))
  })
  return images
}
