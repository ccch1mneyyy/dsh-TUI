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

/** Below these viewport sizes the card is metadata-only: an image box would
 *  be too small to read and the chrome itself barely fits. */
const MIN_GRAPHICS_COLUMNS = 40
const MIN_GRAPHICS_ROWS = 12
/** The card is a floating layer, not a screen: it may take at most this share
 *  of its region's width and height, so the conversation stays visible
 *  around it. Card chrome outside the image box: 2 border rows + 1 margin +
 *  name + meta + hint = 6 rows; 2 border cols + 2×2 padding = 6 cols. */
const PREVIEW_MAX_WIDTH_RATIO = 0.7
const PREVIEW_MAX_HEIGHT_RATIO = 0.8
const CARD_CHROME_ROWS = 6
const CARD_CHROME_COLS = 6
/** Metadata-only card (no image box): 2 border rows + name + meta + hint. */
const CAPTION_ONLY_ROWS = 5
/** Narrowest card: room for the metadata line and the close hint. */
const MIN_CARD_COLUMNS = 40

/**
 * The shared modal image preview: one centered card over a click-catcher
 * that fills its parent, used by both the composer's staged `[Image #N]`
 * tokens and the transcript thumbnails. Chat mounts it inside the
 * transcript row, so the prompt, status rows and sticky header stay visible
 * and untouched; only while the fullscreen draft editor is open does it sit
 * at the root and cover the whole screen. The card is sized from the
 * region the caller reports (the transcript viewport), refined by the
 * catcher's measured cell box on later commits; it renders on the layer's
 * first frame. The catcher click closes
 * (click-outside), the card swallows its own clicks; Esc handling belongs
 * to Chat's key chain. The layer only paints themed cells — terminal
 * graphics stay inside the host `Image` primitive, which keeps its own
 * capability fallback.
 */
export function ImagePreviewOverlay({
  image,
  onClose,
  region,
}: {
  readonly image: TranscriptImage
  readonly onClose: () => void
  /**
   * Cell box of the region the layer fills, known to the caller before the
   * first paint (Chat passes the transcript viewport). The card renders at
   * this size on its first frame; without it the first frame falls back to
   * the terminal size. Either way the catcher's measured box refines it on
   * the next commit.
   */
  readonly region?: { readonly columns: number; readonly rows: number }
}): React.ReactNode {
  // The card must exist on the layer's FIRST frame. A frame with an empty
  // catcher followed by a frame with the card marks the catcher dirty, and
  // the renderer clears a dirty absolute node's whole rect before repainting
  // it — the transparent catcher covers the transcript row, so that clear
  // wiped the conversation underneath (visible as a blank flash on the
  // first open and as a blank transcript on every reopen).
  // Re-measure on every commit: the transcript row also changes height when
  // bottom-chrome rows (spinner, pill, panels) come and go, not only on
  // terminal resize. setState with an equal box is a no-op, so this settles.
  const terminal = useTerminalSize()
  const catcherRef = React.useRef<DOMElement | null>(null)
  const [bounds, setBounds] = React.useState<{ columns: number; rows: number }>(
    () => region ?? { columns: terminal.columns, rows: terminal.rows },
  )
  React.useLayoutEffect(() => {
    const node = catcherRef.current
    if (!node) return
    const { width, height } = measureElement(node)
    if (width <= 0 || height <= 0) return
    setBounds(previous =>
      previous.columns === width && previous.rows === height
        ? previous
        : { columns: width, rows: height })
  })
  const columns = bounds.columns
  const rows = bounds.rows
  const graphicsFit = columns >= MIN_GRAPHICS_COLUMNS && rows >= MIN_GRAPHICS_ROWS
  const [state, setState] = React.useState<
    | { readonly kind: 'loading' }
    | { readonly kind: 'ready'; readonly source: TerminalImageSource }
    | { readonly kind: 'failed' }
  >({ kind: 'loading' })

  React.useEffect(() => {
    // The metadata-only narrow card never draws pixels — decoding for it
    // would only fill the full-tier cache with bytes nobody paints.
    if (!graphicsFit) return
    let live = true
    setState({ kind: 'loading' })
    void loadTranscriptImageFull(image).then(
      source => { if (live) setState({ kind: 'ready', source }) },
      () => { if (live) setState({ kind: 'failed' }) },
    )
    return () => { live = false }
  }, [image, graphicsFit])

  // Caption under the image: file name on one line, media type and pixel
  // size on the next (two lines so narrow cards keep both). The attachment
  // id is a content hash from the host attachment store, not a path — the
  // original path never enters the durable event — so it is not shown.
  const label = transcriptImageLabel(image)
  const meta = [
    ...(image.mediaType === undefined ? [] : [image.mediaType]),
    `${image.width}×${image.height}px`,
  ].join(' · ')
  const [imageWidth, imageHeight] = graphicsFit
    ? fitPreviewCells(
      image,
      Math.min(columns - 12, Math.floor(columns * PREVIEW_MAX_WIDTH_RATIO) - CARD_CHROME_COLS),
      Math.min(rows - 9, Math.floor(rows * PREVIEW_MAX_HEIGHT_RATIO) - CARD_CHROME_ROWS),
    )
    : [0, 0]
  const stateLine = state.kind === 'failed'
    ? t('transcript-image-unavailable', { name: label })
    : state.kind === 'ready'
      ? t('transcript-image-ready', { name: label })
      : t('transcript-image-loading', { name: label })

  // The card is positioned by hand, as an absolute SIBLING of the catcher
  // rather than its child. Any update inside the card (image decoded, size
  // refined) marks its ancestors dirty, and the renderer clears a dirty
  // absolute node's whole rect before repainting it: a transparent parent
  // spanning the transcript row would wipe the conversation underneath.
  // The catcher has no children and stable props, so it never repaints.
  const cardColumns = Math.max(1, Math.min(columns, graphicsFit
    ? Math.max(imageWidth + CARD_CHROME_COLS, MIN_CARD_COLUMNS)
    : MIN_CARD_COLUMNS))
  const cardRows = Math.max(1, Math.min(rows, graphicsFit
    ? imageHeight + CARD_CHROME_ROWS
    : CAPTION_ONLY_ROWS))
  const cardLeft = Math.max(0, Math.floor((columns - cardColumns) / 2))
  const cardTop = Math.max(0, Math.floor((rows - cardRows) / 2))

  // Stable click handler: a new function identity each render would count
  // as a prop change and dirty the catcher.
  const onCloseRef = React.useRef(onClose)
  onCloseRef.current = onClose
  const closeFromCatcher = React.useCallback((event: { stopImmediatePropagation(): void }) => {
    // Click outside the card (anywhere on the catcher) closes. The card is a
    // later sibling in paint order, so its own clicks never reach here.
    event.stopImmediatePropagation()
    onCloseRef.current()
  }, [])
  const swallow = React.useCallback((event: { stopImmediatePropagation(): void }) => {
    event.stopImmediatePropagation()
  }, [])

  return (
    <>
      <Box
        ref={catcherRef}
        position="absolute"
        top={0}
        left={0}
        width="100%"
        height="100%"
        flexShrink={0}
        overflow="hidden"
        onClick={closeFromCatcher}
      />
      <Box
        position="absolute"
        top={cardTop}
        left={cardLeft}
        width={cardColumns}
        height={cardRows}
        flexDirection="column"
        flexShrink={0}
        overflow="hidden"
        borderStyle="round"
        borderColor="suggestion"
        backgroundColor="toolCardBackground"
        opaque
        paddingX={2}
        paddingY={0}
        onClick={swallow}
      >
        {graphicsFit ? (
          <Box justifyContent="center">
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
          <Text bold wrap="truncate">{label}</Text>
        </Box>
        <Box justifyContent="center">
          <Text dimColor wrap="truncate">{meta}</Text>
        </Box>
        <Box justifyContent="center">
          <Text dimColor wrap="truncate">{t('image-preview-close-hint')}</Text>
        </Box>
      </Box>
    </>
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
