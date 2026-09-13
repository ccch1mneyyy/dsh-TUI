import type { TerminalImageSource } from '../../ink/terminal-image.js'
import type { TranscriptImage } from '../../dsh-adapter/transcript-images.js'
import { loadSharp } from '../../dsh-adapter/sharp.js'

// Share the attachment I/O and native decode budget across resolution tiers.
let activeDecodes = 0
const decodeQueue: Array<{ start: () => void; cancel: () => void }> = []
function pumpDecodes(): void {
  while (activeDecodes < 2 && decodeQueue.length) decodeQueue.shift()!.start()
}
export function scheduleImageDecode<T>(signal: AbortSignal, work: () => Promise<T>, priority: boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    if (decodeQueue.length >= (priority ? 65 : 64)) { reject(new Error('Image decode queue budget exceeded')); return }
    const job = {
      start: (): void => {
        signal.removeEventListener('abort', job.cancel)
        if (signal.aborted) { reject(signal.reason); return }
        activeDecodes++
        void Promise.resolve().then(work).then(resolve, reject).finally(() => {
          activeDecodes--
          pumpDecodes()
        })
      },
      cancel: (): void => {
        const index = decodeQueue.indexOf(job)
        if (index >= 0) decodeQueue.splice(index, 1)
        signal.removeEventListener('abort', job.cancel)
        reject(signal.reason)
      },
    }
    signal.addEventListener('abort', job.cancel, { once: true })
    if (priority) decodeQueue.unshift(job)
    else decodeQueue.push(job)
    pumpDecodes()
  })
}

/** Bounded LRU keyed by durable facade identity, with shared cancellation. */
export function makeDecodeTier(maxPixels: number, limit: number, maxDecodedPixels = maxPixels * maxPixels) {
  type Entry = { promise: Promise<TerminalImageSource>; controller: AbortController; refs: number; settled: boolean }
  const cache = new Map<TranscriptImage, Entry>()
  const trim = (): void => {
    for (const [image, entry] of cache) {
      if (cache.size <= limit) break
      if (entry.settled && entry.refs === 0) cache.delete(image)
    }
  }
  const create = (image: TranscriptImage): Entry => {
    const controller = new AbortController()
    const signal = controller.signal
    const pending = scheduleImageDecode(signal, async () => {
      signal.throwIfAborted()
      const data = await image.read(signal)
      signal.throwIfAborted()
      const sharp = await loadSharp()
      signal.throwIfAborted()
      if (sharp === undefined) throw new Error('sharp is unavailable')
      const decoder = sharp(data, { failOn: 'error' })
      let width = maxPixels
      let height = maxPixels
      if (maxDecodedPixels < maxPixels * maxPixels) {
        const metadata = await decoder.metadata()
        signal.throwIfAborted()
        const inputWidth = metadata.width ?? image.width
        const inputHeight = metadata.height ?? image.height
        if (!Number.isSafeInteger(inputWidth) || !Number.isSafeInteger(inputHeight) || inputWidth < 1 || inputHeight < 1) {
          throw new Error('invalid image dimensions')
        }
        const scale = Math.min(1, maxPixels / inputWidth, maxPixels / inputHeight,
          Math.sqrt(maxDecodedPixels / (inputWidth * inputHeight)))
        width = Math.max(1, Math.floor(inputWidth * scale))
        height = Math.max(1, Math.floor(inputHeight * scale))
      }
      const decoded = await decoder
        .resize({ width, height, fit: 'inside', withoutEnlargement: true })
        .toColourspace('srgb')
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      signal.throwIfAborted()
      if (decoded.info.channels !== 4 || decoded.data.byteLength !== decoded.info.width * decoded.info.height * 4) {
        throw new Error('decoded image is not RGBA')
      }
      if (decoded.data.byteLength > maxDecodedPixels * 4) throw new Error('Image decode pixel budget exceeded')
      return { data: decoded.data, width: decoded.info.width, height: decoded.info.height }
    }, maxPixels > 384)
    const entry: Entry = { promise: pending, controller, refs: 0, settled: false }
    void pending.then(() => { entry.settled = true; trim() }, () => {
      entry.settled = true
      if (cache.get(image) === entry) cache.delete(image)
    })
    return entry
  }
  const load = (image: TranscriptImage, signal?: AbortSignal): Promise<TerminalImageSource> => {
    if (signal?.aborted) return Promise.reject(signal.reason)
    const entry = cache.get(image) ?? create(image)
    cache.delete(image)
    cache.set(image, entry)
    entry.refs++
    trim()
    return new Promise((resolve, reject) => {
      let released = false
      const release = (): boolean => {
        if (released) return false
        released = true
        signal?.removeEventListener('abort', abort)
        entry.refs--
        if (!entry.settled && entry.refs === 0) {
          if (cache.get(image) === entry) cache.delete(image)
          entry.controller.abort()
        }
        trim()
        return true
      }
      const abort = (): void => { if (release()) reject(signal?.reason) }
      signal?.addEventListener('abort', abort, { once: true })
      void entry.promise.then(value => { if (release()) resolve(value) }, error => { if (release()) reject(error) })
    })
  }
  return { load, clear: (): void => {
    for (const entry of cache.values()) entry.controller.abort()
    cache.clear()
  } }
}
