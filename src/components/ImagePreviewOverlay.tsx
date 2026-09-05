import React from 'react'
import { Box, Image, Text, useTerminalImages, useTerminalSize } from '../ui.js'
import measureElement from '../ink/measure-element.js'
import useApp from '../ink/hooks/use-app.js'
import { stringWidth } from '../ink/stringWidth.js'
import { truncateToWidth } from '../ink/truncateToWidth.js'
import type { DOMElement } from '../ink/dom.js'
import type { TerminalImageSource } from '../ink/terminal-image.js'
import type { TranscriptImage } from '../dsh-adapter/transcript-images.js'
import {
  loadTranscriptImageFull,
  transcriptImageLabel,
} from './messages/TranscriptImages.js'
import { formatBytes } from '../sessions/format.js'
import { truncateMiddle } from '../utils/truncateMiddle.js'
import { getLang, subscribeLang, t } from '../i18n.js'

/** Below these viewport sizes the card is metadata-only: an image box would
 *  be too small to read and the chrome itself barely fits. */
const MIN_GRAPHICS_COLUMNS = 40
const MIN_GRAPHICS_ROWS = 12
/** The card is a floating layer, not a screen: its IMAGE may take at most
 *  this share of its region's width and height, so the conversation stays
 *  visible around it. The card itself may be wider than the image when the
 *  title needs the room. Card chrome outside the image box: title row +
 *  bottom border + 1 padding row above and below = 4 rows; 2 border cols +
 *  2×2 padding = 6 cols. */
const PREVIEW_MAX_WIDTH_RATIO = 0.7
const PREVIEW_MAX_HEIGHT_RATIO = 0.8
const CARD_CHROME_ROWS = 4
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
 * and tail kept and the middle elided. Nothing else surrounds the image;
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
  const [state, setState] = React.useState<
    | { readonly kind: 'loading' }
    | { readonly kind: 'ready'; readonly source: TerminalImageSource }
    | { readonly kind: 'failed' }
  >({ kind: 'loading' })

  React.useEffect(() => {
    if (!graphicsAvailable) return
    let live = true
    setState({ kind: 'loading' })
    void loadTranscriptImageFull(image).then(
      source => { if (live) setState({ kind: 'ready', source }) },
      () => { if (live) setState({ kind: 'failed' }) },
    )
    return () => { live = false }
  }, [image, graphicsAvailable])

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
  ].filter((part): part is string => part !== undefined && part !== '')
  const maxCardColumns = Math.max(1, columns)
  const fullTitle = fitTitle(
    title ?? t('transcript-image'),
    details,
    image.name,
    Math.max(0, maxCardColumns - CARD_CHROME_COLS),
  )
  const stateLine = !graphicsAvailable || state.kind === 'ready'
    ? t('transcript-image-ready', { name: label })
    : state.kind === 'failed'
      ? t('transcript-image-unavailable', { name: label })
      : t('transcript-image-loading', { name: label })

  const [imageWidth, imageHeight] = graphicsFit
    ? fitPreviewCells(
      image,
      Math.min(columns - 12, Math.floor(columns * PREVIEW_MAX_WIDTH_RATIO) - CARD_CHROME_COLS),
      Math.min(rows - 9, Math.floor(rows * PREVIEW_MAX_HEIGHT_RATIO) - CARD_CHROME_ROWS),
    )
    : [0, 0]

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
  const pathLabel = t('image-preview-path-label')
  const pathRow = image.path === undefined
    ? undefined
    : `${pathLabel}: ${truncateMiddle(
      image.path,
      Math.max(1, cardColumns - CARD_CHROME_COLS - stringWidth(pathLabel) - 2),
    )}`
  const pathRows = pathRow === undefined ? 0 : 1
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
        <Text color="suggestion" wrap="truncate">{titleRow}</Text>
        <Box
          flexDirection="column"
          flexGrow={1}
          borderStyle="round"
          borderColor="suggestion"
          borderTop={false}
          paddingX={2}
        >
          <Box flexGrow={1} alignItems="center" justifyContent="center">
            {graphicsFit ? (
              <Image
                source={graphicsAvailable && state.kind === 'ready' ? state.source : undefined}
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
          {pathRow === undefined ? null : (
            <Text dimColor wrap="truncate">{pathRow}</Text>
          )}
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
