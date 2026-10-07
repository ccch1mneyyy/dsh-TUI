/** Codex image inputs and durable lazy facades (§5.17). Clipboard bytes are
 * sent as data URLs so deleting a staged file cannot break history replay. */
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import type { ImageLimitsView } from '../../../agent/capabilities.js'
import type { ImageRef } from '../../../agent/events.js'
import { t } from '../../../i18n.js'
import { probeImageSize } from '../../../utils/imageResize.js'
import { arr, rec, str, type Rec } from '../narrow.js'
import type { UserInput } from '../protocol/index.js'

export const CODEX_IMAGE_LIMITS: ImageLimitsView = Object.freeze({
  mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  maxImageBytes: 20 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 50 * 1024 * 1024,
  maxImageDimension: 2048,
  maxImagePixels: 2048 * 2048,
})
const PROBE_CHARS = 87_384
const PROBE_BYTES = 65_536
const extensionType: Readonly<Record<string, string>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }

/** Read and recheck staged facades before any turn/steer request is sent. */
export async function codexImageInputs(images: readonly ImageRef[], limits: ImageLimitsView = CODEX_IMAGE_LIMITS): Promise<UserInput[]> {
  if (images.length > limits.maxImagesPerMessage) throw new Error(t('codex-images-too-many', { n: limits.maxImagesPerMessage }))
  const inputs: UserInput[] = []
  let total = 0
  for (const image of images) {
    const name = image.name ?? image.id
    const type = image.mediaType
    if (type === undefined || !CODEX_IMAGE_LIMITS.mediaTypes.includes(type) || !limits.mediaTypes.includes(type)) throw new Error(t('codex-image-type-refused', { name, type: type ?? '?' }))
    let data: Uint8Array
    try { data = await image.read() } catch { throw new Error(t('codex-image-unreadable', { name })) }
    if (data.byteLength > limits.maxImageBytes) throw new Error(t('codex-image-too-large', { name, mb: Math.round(limits.maxImageBytes / (1024 * 1024)) }))
    total += data.byteLength
    if (total > limits.maxMessageImageBytes) throw new Error(t('codex-images-too-large', { mb: Math.round(limits.maxMessageImageBytes / (1024 * 1024)) }))
    const size = probeImageSize(data)
    const width = size?.width ?? image.width
    const height = size?.height ?? image.height
    if (width > limits.maxImageDimension || height > limits.maxImageDimension || width * height > limits.maxImagePixels) throw new Error(t('codex-image-dimensions-refused', { name, px: limits.maxImageDimension }))
    inputs.push({ type: 'image', url: 'data:' + type + ';base64,' + Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64') })
  }
  return inputs
}

function base64Facade(id: string, mediaType: string, data: string): ImageRef {
  let size: { readonly width: number; readonly height: number } | null | undefined
  const measure = () => {
    if (size === undefined) size = probeImageSize(Buffer.from(data.slice(0, PROBE_CHARS), 'base64')) ?? (data.length > PROBE_CHARS ? probeImageSize(Buffer.from(data, 'base64')) : null)
    return size
  }
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return {
    id, mediaType, bytes: Math.max(0, Math.floor(data.length * 3 / 4) - padding),
    get width() { return measure()?.width ?? 1 },
    get height() { return measure()?.height ?? 1 },
    async read(signal) { signal?.throwIfAborted(); return new Uint8Array(Buffer.from(data, 'base64')) },
  }
}

/** No network fetches: only embedded supported-image data URLs are facades. */
export function dataUrlImageFacade(id: string, url: string): ImageRef | undefined {
  const prefix = /^data:(image\/(?:png|jpeg|gif|webp));base64,/iu.exec(url)
  if (prefix === null) return undefined
  const data = url.slice(prefix[0].length)
  if (data === '' || data.length > Math.ceil(CODEX_IMAGE_LIMITS.maxImageBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(data) || data.length % 4 === 1) return undefined
  return base64Facade(id, prefix[1]!.toLowerCase(), data)
}

/** Lazy local file view. A missing historical path still has a placeholder
 * facade; read rejects normally, letting the shared preview show unavailable. */
export function pathImageFacade(id: string, path: string, cwd: string): ImageRef {
  const absolute = resolve(cwd, path)
  let metadata: { bytes?: number; width: number; height: number } | undefined
  const measure = () => {
    if (metadata !== undefined) return metadata
    metadata = { width: 1, height: 1 }
    let fd: number | undefined
    try {
      const bytes = statSync(absolute).size
      fd = openSync(absolute, 'r')
      const head = Buffer.alloc(Math.min(bytes, PROBE_BYTES))
      const read = readSync(fd, head, 0, head.length, 0)
      const size = probeImageSize(head.subarray(0, read))
      metadata = { bytes, width: size?.width ?? 1, height: size?.height ?? 1 }
    } catch { /* A deleted path renders a square unavailable-image placeholder. */ }
    finally { if (fd !== undefined) closeSync(fd) }
    return metadata
  }
  return {
    id, path: absolute, name: basename(absolute), mediaType: extensionType[extname(absolute).toLowerCase()],
    get bytes() { return measure().bytes },
    get width() { return measure().width },
    get height() { return measure().height },
    read: signal => readFile(absolute, { signal }).then(data => new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
  }
}

/** userMessage.content image/localImage blocks, in their durable order. */
export function transcriptImages(content: unknown, idPrefix: string, cwd: string): ImageRef[] {
  const images: ImageRef[] = []
  arr(content).forEach((raw, index) => {
    const block = rec(raw)
    const id = idPrefix + '#' + index
    const url = str(block?.url)
    const path = str(block?.path)
    const image = block?.type === 'image' && url !== undefined ? dataUrlImageFacade(id, url)
      : block?.type === 'localImage' && path !== undefined ? pathImageFacade(id, path, cwd) : undefined
    if (image !== undefined) images.push(image)
  })
  return images
}

/** Native viewed/generated images. savedPath wins without decoding result. */
export function itemImages(item: Rec, idPrefix: string, cwd: string): ImageRef[] {
  if (item.type === 'imageView' && typeof item.path === 'string') return [pathImageFacade(idPrefix, item.path, cwd)]
  if (item.type !== 'imageGeneration' || item.status !== 'completed') return []
  if (typeof item.savedPath === 'string' && item.savedPath !== '') return [pathImageFacade(idPrefix, item.savedPath, cwd)]
  if (typeof item.result !== 'string' || item.result === '') return []
  const url = item.result.startsWith('data:') ? item.result : 'data:image/png;base64,' + item.result
  const image = dataUrlImageFacade(idPrefix, url)
  return image === undefined ? [] : [image]
}
