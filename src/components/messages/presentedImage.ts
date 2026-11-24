/**
 * A `present` deliverable rendered through the shared image preview.
 *
 * The preview overlay speaks `TranscriptImage`: an attachment-backed facade
 * whose dimensions are known before the first frame (the card sizes its image
 * box from them) and whose bytes are read lazily. A delivered image is an
 * ordinary file on disk, so this module builds the same shape around it —
 * dimensions from a header-only probe, bytes from the file itself — and the
 * overlay, its zoom/pan inspection and its failure states all apply unchanged.
 *
 * Best-effort by design: a missing or non-regular file, an unreadable or
 * oversized source, a format the decoder cannot read, or no decoder at all
 * returns undefined, and the caller keeps the file-action menu. `present` does
 * not put a hard size limit on deliverables, so the byte budget matches the
 * preview's own original-read budget (IMAGE_ORIGINAL_MAX_BYTES).
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import type { ToolPresentedFile } from '../../dsh-adapter/channel.js'
import type { TranscriptImage } from '../../dsh-adapter/transcript-images.js'
import { imagePathMediaType } from '../../utils/pastedImagePath.js'
import { IMAGE_ORIGINAL_MAX_BYTES, probeImageFile } from './imageInspection.js'

/** Decoder format names for the raster types the composer stages. */
const FORMAT_MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/**
 * One facade per (path, size, mtime). Reopening a deliverable then reuses the
 * preview's decode tier, which is keyed by facade identity, instead of reading
 * and decoding the file again; a rewritten file misses on size/mtime. Bounded
 * because a session may present many images; each entry only holds the closure.
 */
const facades = new Map<string, TranscriptImage>()
const FACADE_CACHE_MAX = 8

function remember(id: string, image: TranscriptImage): TranscriptImage {
  facades.set(id, image)
  for (const key of facades.keys()) {
    if (facades.size <= FACADE_CACHE_MAX) break
    if (key !== id) facades.delete(key)
  }
  return image
}

/**
 * Build the preview facade for one delivered image, or undefined when the
 * overlay could not show it.
 * @param path - Absolute path (the caller resolves relative card targets).
 */
export async function presentedImageFacade(path: string): Promise<TranscriptImage | undefined> {
  // The card only marks the four raster extensions the composer accepts
  // (`imagePathMediaType`); anything else belongs to the file-action menu.
  const declaredType = imagePathMediaType(path)
  if (declaredType === undefined) return undefined
  let size: number
  let mtimeMs: number
  try {
    const info = await stat(path)
    // An empty file cannot be decoded, and nothing above the preview's own
    // budget is worth handing to the decoder in the first place.
    if (!info.isFile() || info.size <= 0 || info.size > IMAGE_ORIGINAL_MAX_BYTES) return undefined
    size = info.size
    mtimeMs = info.mtimeMs
  } catch {
    return undefined
  }
  const id = `present:${path}#${mtimeMs}:${size}`
  const cached = facades.get(id)
  if (cached !== undefined) return cached
  const probed = await probeImageFile(path)
  if (probed === undefined) return undefined
  // A misnamed file (a JPEG saved as .png) still previews, and the title
  // reports what the bytes are rather than what the name claims.
  const detectedType = probed.format === undefined ? undefined : FORMAT_MEDIA_TYPES[probed.format]
  const mediaType = detectedType ?? declaredType
  return remember(id, {
    id,
    width: probed.width,
    height: probed.height,
    name: basename(path),
    mediaType,
    bytes: size,
    path,
    // The bytes above are this very file: the preview's "open original" opens
    // it in place rather than exporting a temp copy under a hash name.
    pathIsOriginal: true,
    async read(signal) {
      signal?.throwIfAborted()
      // Re-check at read time: the file may have grown or been replaced
      // since the click, and readFile pulls the whole thing into memory
      // before any byte check can run.
      const info = await stat(path)
      if (!info.isFile() || info.size > IMAGE_ORIGINAL_MAX_BYTES) {
        throw new Error('presented image changed or exceeds the preview budget')
      }
      const data = await readFile(path, signal === undefined ? undefined : { signal })
      if (data.byteLength > IMAGE_ORIGINAL_MAX_BYTES) {
        throw new Error('presented image exceeds the preview budget')
      }
      return data
    },
  })
}

/**
 * Every delivered image the card may paint, in delivery order.
 *
 * One image becomes the inline thumbnail under its row; several become the
 * contact strip below the rows. Only absolute paths qualify — the card has no
 * session cwd, so a relative target still opens correctly on click (Chat
 * resolves it) but cannot be painted here. A repeated path collapses to one
 * tile: a card that lists the same file twice still shows it once.
 */
export function previewableImages(files: readonly ToolPresentedFile[]): readonly string[] {
  const seen = new Set<string>()
  const images: string[] = []
  for (const file of files) {
    const path = file.target ?? file.path
    if (imagePathMediaType(path) === undefined || !isAbsolute(path) || seen.has(path)) continue
    seen.add(path)
    images.push(path)
  }
  return images
}
