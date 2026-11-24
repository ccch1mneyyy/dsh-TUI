/**
 * One delivered image, painted inline under its file row.
 *
 * The card decides WHEN to show it (`deliveredImages.length === 1` in
 * `AssistantToolUseMessage`: a single image deliverable, wide enough
 * terminal, no minimal UI); this component owns the
 * file → facade probe, the bounded thumbnail decode and the graphics
 * fallback. Without a terminal graphics protocol it renders nothing: a
 * delivery receipt must not grow a placeholder for an image the terminal
 * cannot paint.
 *
 * Decoding and backing follow the transcript thumbnail exactly — the same
 * bounded tier (`loadTranscriptImageThumb`) and the same
 * `dsh-tui.imageBacking` treatment — so a delivered screenshot costs what a
 * sent one costs.
 */
import React from 'react'
import { Box, Image, Text, useTerminalImageCellSize, useTerminalImages } from '../../ui.js'
import type { TerminalImageSource } from '../../ink/terminal-image.js'
import type { TranscriptImage } from '../../dsh-adapter/transcript-images.js'
import { getLang, subscribeLang, t } from '../../i18n.js'
import { getImageBacking, subscribeImageBacking } from '../../tuiDisplayPrefs.js'
import { useTerminalBackground } from '../design-system/ThemeProvider.js'
import { presentedImageFacade } from './presentedImage.js'
import { loadTranscriptImageThumb } from './TranscriptImages.js'

/** Widest the inline thumbnail may get: a delivery card is a receipt, not a gallery. */
const MAX_COLUMNS = 32
/** Flatter than a transcript thumbnail's 12 rows, so the card stays compact. */
const MAX_ROWS = 9
/** Narrower than this the image is not worth the rows it would cost. */
const MIN_COLUMNS = 12

export interface ThumbnailBox {
  readonly columns: number
  readonly rows: number
}

/** One tile in the multi-image strip: the transcript grid's cell size, so
 *  delivered and sent galleries read the same. Rasters letterbox inside. */
const STRIP_BOX: ThumbnailBox = { columns: 10, rows: 5 }
/** A delivery card shows at most this many tiles; the rest are counted. */
export const PRESENT_STRIP_MAX = 8

/**
 * Display cells for one inline thumbnail: the widest box `availableColumns`
 * allows, capped at 32×9 and fitted to the image's aspect ratio through the
 * measured cell geometry (the conventional 1:2 cell before the terminal has
 * reported pixels). Undefined when the result would be too narrow to read.
 */
export function thumbnailCells(
  image: { readonly width: number; readonly height: number },
  availableColumns: number,
  cell: { readonly width: number; readonly height: number } | undefined,
): ThumbnailBox | undefined {
  const maxColumns = Math.min(MAX_COLUMNS, Math.floor(availableColumns))
  if (maxColumns < MIN_COLUMNS) return undefined
  const ratio = Math.max(0.1, Math.min(10, image.width / image.height))
  const cellRatio = cell === undefined ? 2 : cell.height / cell.width
  let columns = maxColumns
  let rows = Math.max(1, Math.round(columns / (cellRatio * ratio)))
  if (rows > MAX_ROWS) {
    rows = MAX_ROWS
    columns = Math.max(1, Math.min(maxColumns, Math.round(cellRatio * rows * ratio)))
  }
  return columns >= MIN_COLUMNS ? { columns, rows } : undefined
}

export function PresentedImageThumb({
  path,
  availableColumns,
  box: fixedBox,
  onPreview,
  suppressGraphics = false,
}: {
  readonly path: string
  /** Card body width in cells (gutter and padding already deducted). Used to
   *  fit the single-image thumbnail; ignored when `box` is given. */
  readonly availableColumns?: number
  /** Exact cell box (the multi-image strip's uniform grid). */
  readonly box?: ThumbnailBox
  /** Same action as the file row: open the shared preview. */
  readonly onPreview?: (path: string) => void
  /** The modal preview owns the terminal-image budget: keep the cell box (so
   *  the card never reflows) but paint nothing. */
  readonly suppressGraphics?: boolean
}): React.ReactNode {
  React.useSyncExternalStore(subscribeLang, getLang)
  const cell = useTerminalImageCellSize()
  const graphicsAvailable = useTerminalImages(!suppressGraphics)
  const [image, setImage] = React.useState<TranscriptImage | null>(null)
  // The decoded pixels are keyed by the facade's id: a facade handed back for
  // another image (or replaced after the file changed) must never paint its
  // predecessor's raster for a frame.
  const [decoded, setDecoded] = React.useState<{ id: string; source: TerminalImageSource } | null>(null)

  React.useEffect(() => {
    setImage(null)
    setDecoded(null)
    let live = true
    void presentedImageFacade(path).then(facade => {
      if (live && facade !== undefined) setImage(facade)
    }, () => {})
    return () => { live = false }
  }, [path])

  React.useEffect(() => {
    if (image === null || !graphicsAvailable) return
    let live = true
    const controller = new AbortController()
    void loadTranscriptImageThumb(image, controller.signal).then(source => {
      if (live) setDecoded({ id: image.id, source })
    }, () => {})
    return () => { live = false; controller.abort() }
  }, [image, graphicsAvailable])

  // What sits behind the raster follows `dsh-tui.imageBacking`, exactly like
  // transcript thumbnails: photos may float transparent or composite onto the
  // terminal colour.
  const backing = React.useSyncExternalStore(subscribeImageBacking, getImageBacking)
  const terminalBackground = useTerminalBackground()

  const box = fixedBox ?? (image === null || availableColumns === undefined
    ? undefined
    : thumbnailCells(image, availableColumns, cell))
  if (image === null || box === undefined) return null
  const source = graphicsAvailable && decoded !== null && decoded.id === image.id ? decoded.source : undefined
  if (source === undefined) {
    // Suppressed: hold the box so opening/closing the modal never reflows the
    // card. Simply undecoded: reserve nothing (the image has never been seen).
    return suppressGraphics ? <Box width={box.columns} height={box.rows} /> : null
  }
  const composited = backing === 'terminal'
  const preview = (
    <Box backgroundColor={composited ? terminalBackground : undefined}>
      <Image
        {...(composited ? {} : { transparent: true })}
        presentation="transcript"
        source={source}
        width={box.columns}
        height={box.rows}
        // Decorative: the file row right above names it, and a non-empty alt
        // would be painted as its cell fallback whenever the raster cannot.
        alt=""
      />
    </Box>
  )
  if (onPreview === undefined) return preview
  return (
    <Box onClick={event => {
      // Same action as the row's name; never fold the card or start a
      // transcript selection underneath.
      event.stopImmediatePropagation()
      onPreview(path)
    }}>
      {preview}
    </Box>
  )
}

/**
 * The multi-image delivery sheet: one wrapped row of uniform tiles under the
 * file rows. Tiles carry no captions — the rows directly above list the same
 * files in the same order, and a caption at 10 cells would cut every long
 * name to the same prefix. Beyond {@link PRESENT_STRIP_MAX} the sheet counts
 * what it left out instead of growing another line.
 */
export function PresentedImageStrip({
  paths,
  onPreview,
  suppressGraphics,
}: {
  readonly paths: readonly string[]
  readonly onPreview?: (path: string) => void
  readonly suppressGraphics?: boolean
}): React.ReactNode {
  React.useSyncExternalStore(subscribeLang, getLang)
  const shown = paths.slice(0, PRESENT_STRIP_MAX)
  const hidden = paths.length - shown.length
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        {shown.map(path => (
          <PresentedImageThumb
            key={path}
            path={path}
            box={STRIP_BOX}
            onPreview={onPreview}
            suppressGraphics={suppressGraphics}
          />
        ))}
      </Box>
      {hidden > 0 && <Text dimColor>{t('present-strip-more', { count: hidden })}</Text>}
    </Box>
  )
}
