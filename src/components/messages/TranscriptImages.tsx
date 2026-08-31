import React from 'react'
import { Box, Image, Text, useTerminalSize } from '../../ui.js'
import type { TerminalImageSource } from '../../ink/terminal-image.js'
import type { TranscriptImage } from '../../dsh-adapter/transcript-images.js'
import { t } from '../../i18n.js'

const PREVIEW_PIXELS = 384
const DECODED_CACHE_LIMIT = 24
const decodedImages = new Map<TranscriptImage, Promise<TerminalImageSource>>()

/** Bounded image gallery shared by user, assistant, and tool-result rows. */
export function TranscriptImages({
  images,
  indent = 2,
}: {
  readonly images: readonly TranscriptImage[]
  readonly indent?: number
}): React.ReactNode {
  const { columns } = useTerminalSize()
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
}: {
  readonly image: TranscriptImage
  readonly width: number
  readonly height: number
}): React.ReactNode {
  const [state, setState] = React.useState<
    | { readonly kind: 'loading' }
    | { readonly kind: 'ready'; readonly source: TerminalImageSource }
    | { readonly kind: 'failed' }
  >({ kind: 'loading' })

  React.useEffect(() => {
    let live = true
    setState({ kind: 'loading' })
    void loadDecodedImage(image).then(
      source => { if (live) setState({ kind: 'ready', source }) },
      () => { if (live) setState({ kind: 'failed' }) },
    )
    return () => { live = false }
  }, [image])

  const label = cleanLabel(image.name) || t('transcript-image')
  const fallback = state.kind === 'failed'
    ? t('transcript-image-unavailable', { name: label })
    : state.kind === 'loading'
      ? t('transcript-image-loading', { name: label })
      : t('transcript-image-ready', { name: label })
  return (
    <Image
      source={state.kind === 'ready' ? state.source : undefined}
      width={width}
      height={height}
      alt={label}
    >
      <Box width={width} height={height} alignItems="center" justifyContent="center">
        <Text dimColor wrap="truncate">[{fallback}]</Text>
      </Box>
    </Image>
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

async function loadDecodedImage(image: TranscriptImage): Promise<TerminalImageSource> {
  const cached = decodedImages.get(image)
  if (cached !== undefined) {
    decodedImages.delete(image)
    decodedImages.set(image, cached)
    return cached
  }

  const pending = image.read().then(async data => {
    const { default: sharp } = await import('sharp')
    const decoded = await sharp(data, { failOn: 'error' })
      .resize({
        width: PREVIEW_PIXELS,
        height: PREVIEW_PIXELS,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
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
  })
  decodedImages.set(image, pending)
  while (decodedImages.size > DECODED_CACHE_LIMIT) {
    const oldest = decodedImages.keys().next().value as TranscriptImage | undefined
    if (oldest === undefined) break
    decodedImages.delete(oldest)
  }
  void pending.catch(() => {
    if (decodedImages.get(image) === pending) decodedImages.delete(image)
  })
  return pending
}

function cleanLabel(value: string | undefined): string {
  return (value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').trim().slice(0, 80)
}

/** @internal Focused regression scripts clear the process-local LRU. */
export function clearTranscriptImageCacheForTests(): void {
  decodedImages.clear()
}
