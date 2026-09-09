import React from 'react'
import { Box, Image, Text, useTerminalImages, useTerminalSize, useTerminalImageCellSize } from '../ui.js'
import measureElement from '../ink/measure-element.js'
import useApp from '../ink/hooks/use-app.js'
import { stringWidth } from '../ink/stringWidth.js'
import { truncateToWidth } from '../ink/truncateToWidth.js'
import type { DOMElement } from '../ink/dom.js'
import { DEFAULT_TERMINAL_CELL_SIZE } from '../ink/terminal-image.js'
import type { TranscriptImage } from '../dsh-adapter/transcript-images.js'
import { transcriptImageLabel } from './messages/TranscriptImages.js'
import { formatBytes } from '../sessions/format.js'
import { truncateMiddle } from '../utils/truncateMiddle.js'
import { getLang, subscribeLang, t } from '../i18n.js'
import { inspectionCells, IMAGE_ZOOM_LEVELS } from './messages/imageInspection.js'
import { useImageInspection } from './messages/useImageInspection.js'
import { exportOriginalImage } from './messages/originalImage.js'
import { openFile } from '../utils/openExternal.js'
import { useTooltip } from './Tooltip.js'

/** Below these viewport sizes the card is metadata-only: an image box would
 *  be too small to read and the chrome itself barely fits. */
const MIN_GRAPHICS_COLUMNS = 40
const MIN_GRAPHICS_ROWS = 12
/** The card is a floating layer, not a screen: its IMAGE may take at most
 *  this share of its region's width and height, so the conversation stays
 *  visible around it. The card itself may be wider than the image when the
 *  title needs the room. Card chrome outside the image box: title row +
 *  bottom border + toolbar + 1 padding row above and below = 5 rows; 2 border cols +
 *  2×2 padding = 6 cols. */
const PREVIEW_MAX_WIDTH_RATIO = 0.95
const PREVIEW_MAX_HEIGHT_RATIO = 0.95
const CARD_CHROME_ROWS = 5
const CARD_CHROME_COLS = 6
/** Metadata-only card (no image box): title row + one body row + bottom border. */
const CAPTION_ONLY_ROWS = 3
/** Narrowest card: room for a readable title. */
const MIN_CARD_COLUMNS = 40
/** A file name shortened below this many cells reads as noise; the title
 *  drops it instead (the path row still names the file when known). */
const MIN_TITLE_NAME_COLUMNS = 8

/**
 * The shared modal image preview: one centered card over a click-catcher
 * over the visible part of its parent, used by the composer's `[Image #N]`
 * tokens and the transcript thumbnails. Chat mounts it inside the
 * transcript row, so the prompt, status rows and sticky header stay visible
 * and untouched; only while the fullscreen draft editor is open does it sit
 * at the root and cover the whole screen. The card is sized from the
 * region the caller reports (the transcript viewport), refined by the
 * parent's visible cell box on later commits; it renders on the layer's
 * first frame.
 *
 * The card's title sits in its top border, centered: `Image #N — PNG ·
 * 361×379 · 19.0 KB · name.png`. The card is at least as wide as its
 * title, so a small image never squeezes the file name; when even the
 * region is too narrow, the name is shortened in its middle first and
 * dropped from the title last. Images staged from a file or the clipboard
 * in this process show their source path on the card's bottom row, head
 * and tail kept and the middle elided. Controls sit below the image;
 * Esc and a click outside close (Chat's key chain and the catcher).
 * Catcher and card are sibling absolute nodes — see the comment at the
 * card for why the card is not the catcher's child. The layer only paints
 * themed cells — terminal graphics stay inside the host `Image` primitive,
 * which keeps its own capability fallback.
 */
export function ImagePreviewOverlay({
  image,
  onClose,
  region,
  title,
  navigation,
}: {
  readonly image: TranscriptImage
  readonly onClose: () => void
  /**
   * Cell box of the region the layer fills, known to the caller before the
   * first paint (Chat passes the transcript viewport). The card renders at
   * this size on its first frame; without it the first frame falls back to
   * the terminal size. Either way the parent's visible box refines it on
   * the next commit.
   */
  readonly region?: { readonly columns: number; readonly rows: number }
  /** Leading title text, e.g. the composer token `Image #2`. Defaults to
   *  the generic image label. */
  readonly title?: string
  readonly navigation?: {
    readonly index: number
    readonly total: number
    readonly onPrevious: () => void
    readonly onNext: () => void
  }
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
  const { stdout } = useApp()
  React.useSyncExternalStore(subscribeLang, getLang)
  const catcherRef = React.useRef<DOMElement | null>(null)
  const [bounds, setBounds] = React.useState<{ columns: number; rows: number }>(
    () => region ?? { columns: terminal.columns, rows: terminal.rows },
  )
  React.useLayoutEffect(() => {
    const node = catcherRef.current
    const parent = node?.parentNode
    if (!node || !parent) return
    const { width } = measureElement(node)
    const { height } = measureElement(parent)
    if (width <= 0 || height <= 0) return
    // Inline layouts extend into scrollback. Anchor the layer to the
    // parent's visible tail, using Ink's extra cursor-restore row when the
    // root overflows. Measuring the parent keeps our own height out of the
    // next pass's input.
    let bottom = height
    let rootHeight = height
    for (let ancestor: DOMElement | undefined = parent; ancestor; ancestor = ancestor.parentNode) {
      bottom += ancestor.yogaNode?.getComputedTop() ?? 0
      rootHeight = ancestor.yogaNode?.getComputedHeight() ?? rootHeight
    }
    const terminalRows = stdout.rows ?? terminal.rows
    const viewportTop = rootHeight > terminalRows ? rootHeight - terminalRows + 1 : 0
    const visibleHeight = Math.max(1, Math.min(height, bottom - viewportTop))
    setBounds(previous =>
      previous.columns === width && previous.rows === visibleHeight
        ? previous
        : { columns: width, rows: visibleHeight })
  })
  const columns = bounds.columns
  const rows = bounds.rows
  const graphicsFit = columns >= MIN_GRAPHICS_COLUMNS && rows >= MIN_GRAPHICS_ROWS
  const graphicsAvailable = useTerminalImages(graphicsFit)
  const cell = useTerminalImageCellSize()
  const [view, setView] = React.useState({ image, zoom: 0 })
  React.useEffect(() => { setView(previous => previous.image === image ? previous : { image, zoom: 0 }) }, [image])
  const zoom = view.image === image && cell && graphicsAvailable ? view.zoom : 0
  const setZoom = (value: number): void => setView({ image, zoom: value })
  const maxImageColumns = Math.max(1, Math.min(columns - 2, Math.floor(columns * PREVIEW_MAX_WIDTH_RATIO)) - CARD_CHROME_COLS)
  const navigationRows = navigation && navigation.total > 1 && rows >= 6 ? 1 : 0
  const maxImageRows = Math.max(1, Math.min(rows - 2, Math.floor(rows * PREVIEW_MAX_HEIGHT_RATIO)) - CARD_CHROME_ROWS - 1 - navigationRows)
  const [imageWidth, imageHeight] = !graphicsFit ? [0, 0] : zoom === 0
    ? fitPreviewCells(image, maxImageColumns, maxImageRows, cell ?? DEFAULT_TERMINAL_CELL_SIZE)
    : inspectionCells(maxImageColumns, maxImageRows, cell!)
  const inspection = useImageInspection(image, graphicsAvailable, imageWidth, imageHeight, cell, zoom)

  // Title: `Image #N — PNG · 361×379 · 19.0 KB · name.png`, fitted to the
  // widest card the region allows. The attachment id is a content hash from
  // the host attachment store, not a path, so it is not shown; the source
  // path, when this process staged the image, gets its own row.
  const label = transcriptImageLabel(image)
  const format = image.mediaType === undefined
    ? undefined
    : image.mediaType.replace(/^image\//u, '').replace(/\+xml$/u, '').toUpperCase()
  const details = [
    format,
    `${image.width}×${image.height}`,
    formatBytes(image.bytes),
    zoom === 0 ? undefined : `${zoom * 100}%`,
  ].filter((part): part is string => part !== undefined && part !== '')
  const maxCardColumns = Math.max(1, columns)
  const fullTitle = fitTitle(
    title ?? t('transcript-image'),
    details,
    image.name,
    Math.max(0, maxCardColumns - CARD_CHROME_COLS),
  )
  const stateLine = !graphicsAvailable || inspection.source !== undefined
    ? t('transcript-image-ready', { name: label })
    : inspection.failed
      ? t('transcript-image-unavailable', { name: label })
      : t('transcript-image-loading', { name: label })

  const pathRows = 1 + navigationRows

  // The card is positioned by hand, as an absolute SIBLING of the catcher
  // rather than its child. Any update inside the card (image decoded, size
  // refined) marks its ancestors dirty, and the renderer clears a dirty
  // absolute node's whole rect before repainting it: a transparent parent
  // spanning the transcript row would wipe the conversation underneath.
  // The catcher has no children, so image decoding does not dirty it.
  // Width: the image plus chrome, never narrower than the title needs.
  const cardColumns = Math.max(1, Math.min(maxCardColumns, Math.max(
    graphicsFit ? imageWidth + CARD_CHROME_COLS : 0,
    stringWidth(fullTitle) + CARD_CHROME_COLS,
    MIN_CARD_COLUMNS,
  )))
  const pathLabel = t('image-preview-open-original')
  const pathRow = `${pathLabel}: ${truncateMiddle(
    image.path ?? label,
    Math.max(1, cardColumns - CARD_CHROME_COLS - stringWidth(pathLabel) - 2),
  )}`
  const cardRows = Math.max(1, Math.min(rows, (graphicsFit
    ? imageHeight + CARD_CHROME_ROWS
    : CAPTION_ONLY_ROWS) + pathRows))
  const cardLeft = Math.max(0, Math.floor((columns - cardColumns) / 2))
  const cardBottom = Math.max(0, Math.ceil((rows - cardRows) / 2))
  const titleRow = borderTitleRow(fullTitle, cardColumns)

  // Stable click handler: a new function identity each render would count
  // as a prop change and dirty the catcher.
  const onCloseRef = React.useRef(onClose)
  React.useLayoutEffect(() => { onCloseRef.current = onClose }, [onClose])
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
        bottom={0}
        left={0}
        width="100%"
        height={rows}
        flexShrink={0}
        overflow="hidden"
        backdrop="dim"
        onClick={closeFromCatcher}
      />
      <Box
        position="absolute"
        bottom={cardBottom}
        left={cardLeft}
        width={cardColumns}
        height={cardRows}
        flexDirection="column"
        flexShrink={0}
        overflow="hidden"
        backgroundColor="toolCardBackground"
        opaque
        onClick={swallow}
      >
        {/* Top border drawn by hand so the title can sit centered inside it. */}
        <Text color="text" wrap="truncate">{titleRow}</Text>
        <Box
          flexDirection="column"
          flexGrow={1}
          borderStyle="round"
          borderColor="inactive"
          borderTop={false}
          paddingX={2}
        >
          <Box flexGrow={1} alignItems="center" justifyContent="center"
            onDragStart={inspection.drag} onDragMove={inspection.drag} onDragEnd={inspection.drag}
            onWheel={event => { event.stopImmediatePropagation(); if (zoom > 0) inspection.pan(event.deltaX, event.deltaY) }}>
            {graphicsFit ? (
              <Image
                presentation="preview"
                source={inspection.source}
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
            ) : (
              <Text dimColor wrap="truncate">{label}</Text>
            )}
          </Box>
          {graphicsFit ? <Box height={1} flexShrink={0}>
            <PreviewControl label={t('image-preview-fit')} title={t('image-preview-fit')} active={zoom === 0} onClick={() => setZoom(0)} />
            <PreviewControl label="100%" title={cell ? t('image-preview-actual') : t('image-preview-no-metrics')}
              active={zoom === 1} disabled={!cell || !graphicsAvailable} onClick={() => setZoom(1)} />
            <PreviewControl label="-" title={t('image-preview-zoom-out')} disabled={zoom <= 1}
              onClick={() => setZoom(Math.max(1, zoom / 2))} />
            <PreviewControl label="+" title={t('image-preview-zoom-in')} disabled={!cell || !graphicsAvailable || zoom >= IMAGE_ZOOM_LEVELS.at(-1)!}
              onClick={() => setZoom(zoom === 0 ? 1 : zoom * 2)} />
            <PreviewControl label="←" title={t('image-preview-left')} disabled={zoom === 0} onClick={() => inspection.pan(-1, 0)} />
            <PreviewControl label="↑" title={t('image-preview-up')} disabled={zoom === 0} onClick={() => inspection.pan(0, -1)} />
            <PreviewControl label="↓" title={t('image-preview-down')} disabled={zoom === 0} onClick={() => inspection.pan(0, 1)} />
            <PreviewControl label="→" title={t('image-preview-right')} disabled={zoom === 0} onClick={() => inspection.pan(1, 0)} />
          </Box> : null}
          {navigationRows && navigation ? <Box height={1} flexShrink={0} justifyContent="center">
            <PreviewControl label="‹" title={t('image-preview-previous')} disabled={navigation.index <= 0} onClick={navigation.onPrevious} />
            <Text>{navigation.index + 1}/{navigation.total}</Text>
            <PreviewControl label="›" title={t('image-preview-next')} disabled={navigation.index >= navigation.total - 1} onClick={navigation.onNext} />
          </Box> : null}
          <OriginalImageLink key={image.id} image={image} label={pathRow} />
        </Box>
      </Box>
    </>
  )
}

/**
 * `lead — a · b · c · name` fitted to `maxWidth` cells. The name yields
 * first: shortened in its middle (stem start and extension survive), then
 * dropped when fewer than {@link MIN_TITLE_NAME_COLUMNS} cells remain for
 * it. Only after that is the rest cut from the end.
 */
function fitTitle(
  lead: string,
  details: readonly string[],
  name: string | undefined,
  maxWidth: number,
): string {
  const base = details.length === 0 ? lead : `${lead} — ${details.join(' · ')}`
  if (name === undefined || name === '') return truncateEnd(base, maxWidth)
  const prefix = details.length === 0 ? `${lead} — ` : `${base} · `
  const full = prefix + name
  if (stringWidth(full) <= maxWidth) return full
  const room = maxWidth - stringWidth(prefix)
  if (room >= MIN_TITLE_NAME_COLUMNS) return prefix + truncateMiddle(name, room)
  return truncateEnd(base, maxWidth)
}

function truncateEnd(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text
  return maxWidth <= 1 ? '' : `${truncateToWidth(text, maxWidth - 1)}…`
}

/**
 * `╭─── title ───╮` sized to the card width. The title is already fitted
 * by {@link fitTitle}; this only guards the degenerate case and keeps one
 * dash on each side of the corners so the row still reads as a border.
 */
function borderTitleRow(title: string, cardColumns: number): string {
  if (cardColumns < 2) return cardColumns === 1 ? '╭' : ''
  const inner = Math.max(0, cardColumns - 2)
  const text = truncateEnd(title, Math.max(0, inner - 4))
  const labelled = text === '' ? '' : ` ${text} `
  const fill = Math.max(0, inner - stringWidth(labelled))
  const left = Math.floor(fill / 2)
  return `╭${'─'.repeat(left)}${labelled}${'─'.repeat(fill - left)}╮`
}

/** Aspect-preserving layout using measured cell pixels, or the conventional
 *  1:2 cell when unavailable. The host independently fits the actual raster. */
function fitPreviewCells(
  image: TranscriptImage,
  maxWidth: number,
  maxHeight: number,
  cell: { readonly width: number; readonly height: number },
): readonly [number, number] {
  const ratio = Math.max(0.1, Math.min(10, image.width / image.height))
  let width = Math.max(1, maxWidth)
  const cellRatio = cell.height / cell.width
  let height = Math.max(1, Math.round(width / (cellRatio * ratio)))
  if (height > maxHeight) {
    height = Math.max(1, maxHeight)
    width = Math.max(1, Math.min(maxWidth, Math.round(cellRatio * height * ratio)))
  }
  return [width, height]
}

function PreviewControl({ label, title, disabled = false, active = false, onClick }: {
  label: string; title: string; disabled?: boolean; active?: boolean; onClick: () => void
}): React.ReactNode {
  const tooltip = useTooltip(title)
  return <Box width={stringWidth(label) + 2} height={1} flexShrink={0} justifyContent="center" {...tooltip}
    onDragStart={stopControlDrag}
    onClick={event => { event.stopImmediatePropagation(); if (!disabled) onClick() }}>
    <Text dimColor={disabled} bold={active} underline={active}>{label}</Text>
  </Box>
}

// Capture an unmodified press as a button gesture. Repeated +/- clicks must
// not become terminal word selection; moving off a button cancels its click.
function stopControlDrag(event: { stopImmediatePropagation(): void }): void {
  event.stopImmediatePropagation()
}

function OriginalImageLink({ image, label }: { image: TranscriptImage; label: string }): React.ReactNode {
  const [status, setStatus] = React.useState<'idle' | 'loading' | 'failed'>('idle')
  const pending = React.useRef<AbortController | null>(null)
  React.useEffect(() => {
    setStatus('idle')
    return () => { pending.current?.abort(); pending.current = null }
  }, [image])
  const tooltip = useTooltip(image.path ?? image.name ?? t('image-preview-open-original'))
  return <Box height={1} flexShrink={0} {...tooltip} onDragStart={stopControlDrag} onClick={event => {
    event.stopImmediatePropagation()
    if (pending.current && !pending.current.signal.aborted) return
    const controller = new AbortController()
    pending.current = controller
    setStatus('loading')
    void exportOriginalImage(image, controller.signal).then(path => {
      if (controller.signal.aborted) return
      openFile(path)
      setStatus('idle')
    }, () => { if (!controller.signal.aborted) setStatus('failed') }).finally(() => {
      if (pending.current === controller) pending.current = null
    })
  }}>
    <Text underline wrap="truncate">{status === 'loading' ? t('image-preview-opening') :
      status === 'failed' ? t('image-preview-open-failed') : label}</Text>
  </Box>
}
