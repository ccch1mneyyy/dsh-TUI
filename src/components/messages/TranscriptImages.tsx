import React from 'react'
import { Box, Image, Text, useTerminalImages, useTerminalSize } from '../../ui.js'
import type { TerminalImageSource } from '../../ink/terminal-image.js'
import type { TranscriptImage } from '../../dsh-adapter/transcript-images.js'
import { loadSharp } from '../../dsh-adapter/sharp.js'
import { cleanRenderText } from '../../dsh-adapter/sanitize.js'
import { getLang, subscribeLang, t } from '../../i18n.js'

// Bound attachment I/O and native Sharp work across both resolution tiers.
let activeDecodes = 0
const decodeQueue: Array<{ start: () => void; cancel: () => void }> = []
function pumpDecodes(): void {
  while (activeDecodes < 2 && decodeQueue.length) decodeQueue.shift()!.start()
}
function scheduleDecode(signal: AbortSignal, work: () => Promise<TerminalImageSource>, priority = false): Promise<TerminalImageSource> {
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

/**
 * Decode caches in two size tiers sharing one LRU implementation (a hit
 * re-inserts, eviction takes the least recently used): small thumbnails for
 * transcript rows, and a bounded full tier for the modal preview overlay.
 * Keys are the facade objects themselves — one stable object per durable
 * reference (channel and projection guarantee that), so identical content
 * re-projected as a new object simply re-decodes.
 */
function makeDecodeTier(maxPixels: number, limit: number) {
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
    const pending = scheduleDecode(signal, async () => {
      signal.throwIfAborted()
      const data = await image.read(signal)
      signal.throwIfAborted()
      const sharp = await loadSharp()
      signal.throwIfAborted()
      if (sharp === undefined) throw new Error('sharp is unavailable')
      const decoded = await sharp(data, { failOn: 'error' })
        .resize({
          width: maxPixels,
          height: maxPixels,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .toColourspace('srgb')
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      signal.throwIfAborted()
      if (
        decoded.info.channels !== 4 ||
        decoded.data.byteLength !== decoded.info.width * decoded.info.height * 4
      ) {
        throw new Error('decoded image is not RGBA')
      }
      return {
        data: decoded.data,
        width: decoded.info.width,
        height: decoded.info.height,
      }
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

const thumbnailTier = makeDecodeTier(384, 24)
// One modal at a time: current + previous suffices for instant reopen.
const fullTier = makeDecodeTier(1024, 2)

/** Full-resolution (bounded) decode for the modal preview overlay. */
export const loadTranscriptImageFull = fullTier.load

/** Display label for one transcript image: sanitized name, or the generic
 *  localized fallback. Shared by thumbnails and the preview overlay. */
export function transcriptImageLabel(image: TranscriptImage): string {
  const name = cleanRenderText(image.name ?? '', 80)
  return name || t('transcript-image')
}

/** Bounded image gallery shared by user, assistant, and tool-result rows. */
export function TranscriptImages({
  images,
  indent = 2,
  onPreview,
  suppressGraphics = false,
}: {
  readonly images: readonly TranscriptImage[]
  readonly indent?: number
  /** Present = thumbnails are clickable and open the shared preview overlay. */
  readonly onPreview?: (image: TranscriptImage) => void
  /** Keep fallback geometry/click targets but yield the global terminal-image
   * frame budget to the modal full preview. */
  readonly suppressGraphics?: boolean
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const graphicsAvailable = useTerminalImages(images.length > 0 && !suppressGraphics)
  React.useSyncExternalStore(subscribeLang, getLang)
  if (images.length === 0) return null
  const available = Math.max(1, columns - indent - 3)
  return (
    <Box
      flexDirection="row"
      flexWrap="wrap"
      gap={1}
      paddingLeft={indent}
      width="100%"
    >
      {images.map((image, index) => {
        const [width, height] = previewSize(image, images.length, available)
        return (
          <TranscriptImagePreview
            key={`${image.id}:${index}`}
            image={image}
            width={width}
            height={height}
            graphicsAvailable={graphicsAvailable}
            onPreview={onPreview}
          />
        )
      })}
    </Box>
  )
}

function TranscriptImagePreview({
  image,
  width,
  height,
  graphicsAvailable,
  onPreview,
}: {
  readonly image: TranscriptImage
  readonly width: number
  readonly height: number
  readonly graphicsAvailable: boolean
  readonly onPreview?: (image: TranscriptImage) => void
}): React.ReactNode {
  const [state, setState] = React.useState<
    | { readonly kind: 'loading' }
    | { readonly kind: 'ready'; readonly source: TerminalImageSource }
    | { readonly kind: 'failed' }
  >({ kind: 'loading' })

  React.useEffect(() => {
    if (!graphicsAvailable) return
    let live = true
    const controller = new AbortController()
    setState({ kind: 'loading' })
    void thumbnailTier.load(image, controller.signal).then(
      source => { if (live) setState({ kind: 'ready', source }) },
      () => { if (live) setState({ kind: 'failed' }) },
    )
    return () => { live = false; controller.abort() }
  }, [image, graphicsAvailable])

  const label = transcriptImageLabel(image)
  const fallback = !graphicsAvailable
    ? t('transcript-image-ready', { name: label })
    : state.kind === 'failed'
      ? t('transcript-image-unavailable', { name: label })
      : state.kind === 'loading'
        ? t('transcript-image-loading', { name: label })
        : t('transcript-image-ready', { name: label })
  const preview = (
    <Image
      presentation="transcript"
      source={graphicsAvailable && state.kind === 'ready' ? state.source : undefined}
      width={width}
      height={height}
      alt={label}
    >
      <Box width={width} height={height} alignItems="center" justifyContent="center">
        <Text dimColor wrap="truncate">[{fallback}]</Text>
      </Box>
    </Image>
  )
  if (onPreview === undefined) return preview
  return (
    <Box
      onClick={event => {
        // A thumbnail click opens the preview; it must not also toggle the
        // row expansion or start a transcript selection underneath.
        event.stopImmediatePropagation()
        onPreview(image)
      }}
    >
      {preview}
    </Box>
  )
}

function previewSize(
  image: TranscriptImage,
  count: number,
  available: number,
): readonly [number, number] {
  if (count > 1) {
    const width = Math.max(1, Math.min(10, available))
    return [width, Math.max(1, Math.round(width / 2))]
  }
  const ratio = Math.max(0.25, Math.min(4, image.width / image.height))
  const maxWidth = Math.max(1, Math.min(24, available))
  const maxHeight = 12
  let width = maxWidth
  let height = Math.max(1, Math.round(width / (2 * ratio)))
  if (height > maxHeight) {
    height = maxHeight
    width = Math.max(1, Math.min(maxWidth, Math.round(2 * height * ratio)))
  }
  return [width, height]
}

/** @internal Focused regression scripts clear the process-local LRUs. */
export function clearTranscriptImageCacheForTests(): void {
  thumbnailTier.clear()
  fullTier.clear()
}
