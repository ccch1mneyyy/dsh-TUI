import React from 'react'
import { Box, Image, Text, useTerminalSize } from '../ui.js'
import measureElement from '../ink/measure-element.js'
import type { DOMElement } from '../ink/dom.js'
import type { TerminalImageSource } from '../ink/terminal-image.js'
import type { TranscriptImage } from '../dsh-adapter/transcript-images.js'
import {
  loadTranscriptImageFull,
  transcriptImageLabel,
} from './messages/TranscriptImages.js'
import { t } from '../i18n.js'
import { cleanRenderText } from '../dsh-adapter/sanitize.js'

/** Below these viewport sizes the card is metadata-only: an image box would
 *  be too small to read and the chrome itself barely fits. */
const MIN_GRAPHICS_COLUMNS = 40
const MIN_GRAPHICS_ROWS = 12

/**
 * The shared modal image preview: one centered card over a click-catcher
 * that fills its parent, used by both the composer's staged `[Image #N]`
 * tokens and the transcript thumbnails. Chat mounts it inside the
 * transcript row, so the prompt, status rows and sticky header stay visible
 * and untouched; only while the fullscreen draft editor is open does it sit
 * at the root and cover the whole screen. The card is sized from the
 * catcher's measured cell box (one layout pass; the card renders on the
 * next frame), never from the raw terminal size. The catcher click closes
 * (click-outside), the card swallows its own clicks; Esc handling belongs
 * to Chat's key chain. The layer only paints themed cells — terminal
 * graphics stay inside the host `Image` primitive, which keeps its own
 * capability fallback.
 */
export function ImagePreviewOverlay({
  image,
  onClose,
}: {
  readonly image: TranscriptImage
  readonly onClose: () => void
}): React.ReactNode {
  // Re-measure on every commit: the transcript row also changes height when
  // bottom-chrome rows (spinner, pill, panels) come and go, not only on
  // terminal resize. setState with an equal box is a no-op, so this settles.
  useTerminalSize()
  const catcherRef = React.useRef<DOMElement | null>(null)
  const [bounds, setBounds] = React.useState<{ columns: number; rows: number } | null>(null)
  React.useLayoutEffect(() => {
    const node = catcherRef.current
    if (!node) return
    const { width, height } = measureElement(node)
    if (width <= 0 || height <= 0) return
    setBounds(previous =>
      previous !== null && previous.columns === width && previous.rows === height
        ? previous
        : { columns: width, rows: height })
  })
  const columns = bounds?.columns ?? 0
  const rows = bounds?.rows ?? 0
  const graphicsFit = columns >= MIN_GRAPHICS_COLUMNS && rows >= MIN_GRAPHICS_ROWS
  const [state, setState] = React.useState<
    | { readonly kind: 'loading' }
    | { readonly kind: 'ready'; readonly source: TerminalImageSource }
    | { readonly kind: 'failed' }
  >({ kind: 'loading' })

  React.useEffect(() => {
    // The metadata-only narrow card never draws pixels — decoding for it
    // would only fill the full-tier cache with bytes nobody paints.
    if (bounds === null || !graphicsFit) return
    let live = true
    setState({ kind: 'loading' })
    void loadTranscriptImageFull(image).then(
      source => { if (live) setState({ kind: 'ready', source }) },
      () => { if (live) setState({ kind: 'failed' }) },
    )
    return () => { live = false }
  }, [image, graphicsFit, bounds === null])

  const label = transcriptImageLabel(image)
  const meta = [
    ...(image.mediaType === undefined ? [] : [image.mediaType]),
    `${image.width}×${image.height}px`,
  ].join(' · ')
  const safeId = cleanRenderText(image.id, 24) || '…'
  const source = t('image-preview-source', { id: safeId })
  const [imageWidth, imageHeight] = graphicsFit
    ? fitPreviewCells(image, columns - 12, rows - 9)
    : [0, 0]
  const stateLine = state.kind === 'failed'
    ? t('transcript-image-unavailable', { name: label })
    : state.kind === 'ready'
      ? t('transcript-image-ready', { name: label })
      : t('transcript-image-loading', { name: label })

  return (
    <Box
      ref={catcherRef}
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      flexShrink={0}
      overflow="hidden"
      alignItems="center"
      justifyContent="center"
      onClick={event => {
        // Click outside the card (anywhere on the catcher) closes. The card
        // below stops propagation, so only true outside clicks land here.
        event.stopImmediatePropagation()
        onClose()
      }}
    >
      {bounds === null ? null : (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="suggestion"
        backgroundColor="toolCardBackground"
        opaque
        paddingX={2}
        paddingY={0}
        onClick={event => {
          event.stopImmediatePropagation()
        }}
      >
        <Text bold wrap="truncate">{label}</Text>
        <Text dimColor wrap="truncate">{meta} · {source}</Text>
        {graphicsFit ? (
          <Box marginTop={1} justifyContent="center">
            <Image
              source={state.kind === 'ready' ? state.source : undefined}
              width={imageWidth}
              height={imageHeight}
              alt={label}
            >
              <Box
                width={imageWidth}
                height={imageHeight}
                alignItems="center"
                justifyContent="center"
              >
                <Text dimColor wrap="truncate">[{stateLine}]</Text>
              </Box>
            </Image>
          </Box>
        ) : null}
        <Box marginTop={graphicsFit ? 1 : 0} justifyContent="center">
          <Text dimColor>{t('image-preview-close-hint')}</Text>
        </Box>
      </Box>
      )}
    </Box>
  )
}

/** Aspect-preserving cell box for the preview, assuming the conventional
 *  1:2 cell (the host primitive letterboxes with real cell metrics, so the
 *  content never distorts — this only sizes the reserved rectangle). */
function fitPreviewCells(
  image: TranscriptImage,
  maxWidth: number,
  maxHeight: number,
): readonly [number, number] {
  const ratio = Math.max(0.1, Math.min(10, image.width / image.height))
  let width = Math.max(1, maxWidth)
  let height = Math.max(1, Math.round(width / (2 * ratio)))
  if (height > maxHeight) {
    height = Math.max(1, maxHeight)
    width = Math.max(1, Math.min(maxWidth, Math.round(2 * height * ratio)))
  }
  return [width, height]
}
