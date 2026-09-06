import { createHash } from 'node:crypto'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptImage } from '../../dsh-adapter/transcript-images.js'
import { IMAGE_ORIGINAL_MAX_BYTES } from './imageInspection.js'

const exportsByImage = new WeakMap<TranscriptImage, Promise<string>>()
let directory: Promise<string> | undefined

/** Signature-derived extension: never let an attachment name select a program. */
function originalExtension(data: Uint8Array): string {
  const head = Buffer.from(data.buffer, data.byteOffset, Math.min(data.byteLength, 12))
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png'
  if (head[0] === 255 && head[1] === 216 && head[2] === 255) return 'jpg'
  if (head.subarray(0, 6).toString('ascii') === 'GIF87a' || head.subarray(0, 6).toString('ascii') === 'GIF89a') return 'gif'
  if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
  throw new Error('Unsupported original image format')
}

/** Only called by an explicit open action. Keep exact bytes in OS temp storage
 * after closing the TUI, since an external viewer may read the file later. */
export async function exportOriginalImage(image: TranscriptImage, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  let pending = exportsByImage.get(image)
  if (!pending) {
    pending = (async () => {
      const data = await image.read(signal)
      signal?.throwIfAborted()
      if (data.byteLength > IMAGE_ORIGINAL_MAX_BYTES) throw new Error('Original image byte budget exceeded')
      const extension = originalExtension(data)
      const digest = createHash('sha256').update(data).digest('hex')
      directory ??= mkdtemp(join(tmpdir(), 'dsh-tui-original-')).then(async path => {
        await chmod(path, 0o700)
        return path
      }).catch(error => { directory = undefined; throw error })
      const path = join(await directory, `${digest}.${extension}`)
      signal?.throwIfAborted()
      try {
        await writeFile(path, data, { flag: 'wx', mode: 0o600 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      return path
    })()
    exportsByImage.set(image, pending)
    void pending.catch(() => { if (exportsByImage.get(image) === pending) exportsByImage.delete(image) })
  }
  const path = await pending
  signal?.throwIfAborted()
  return path
}
