import React from 'react'
import { Box, Image, Text, useTerminalImages, useTerminalSize } from '../../ui.js'
import type { TerminalImageSource } from '../../ink/terminal-image.js'
import { TERMINAL_IMAGE_PREVIEW_MAX_EDGE, TERMINAL_IMAGE_PREVIEW_MAX_BYTES } from '../../ink/terminal-image.js'
import type { TranscriptImage } from '../../dsh-adapter/transcript-images.js'
import { makeDecodeTier } from './transcriptImageDecode.js'
import { cleanRenderText } from '../../dsh-adapter/sanitize.js'
import { getLang, subscribeLang, t } from '../../i18n.js'

const thumbnailTier = makeDecodeTier(384, 24)
// One modal at a time: current + previous suffices for instant reopen.
const fullTier = makeDecodeTier(TERMINAL_IMAGE_PREVIEW_MAX_EDGE, 2, TERMINAL_IMAGE_PREVIEW_MAX_BYTES / 4)

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
