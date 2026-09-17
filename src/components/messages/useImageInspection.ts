import React from 'react'
import type { TranscriptImage } from '../../dsh-adapter/transcript-images.js'
import type { TerminalCellSize, TerminalImageSource } from '../../ink/terminal-image.js'
import type { DragEvent } from '../../ink/events/drag-event.js'
import { ImageInspectionSession, inspectionRegion, type ImageCenter, type ImageDimensions } from './imageInspection.js'
import { loadTranscriptImageFull } from './TranscriptImages.js'

// The attachment is identified by `image.id` (a content hash), never by the
// facade object: callers may hand a fresh facade for the same attachment on
// every render, and keying effects or memos on the object would then restart
// the session and re-request pixels each commit — a render loop (#885).
export function useImageInspection(image: TranscriptImage, available: boolean, columns: number, rows: number,
  cell: TerminalCellSize | undefined, zoom: number) {
  const imageId = image.id
  // Committed facade for the loaders below. Written in a layout effect, not
  // during render: an interrupted render must not leak its facade into a
  // timer that an earlier commit already scheduled.
  const latestImage = React.useRef(image)
  React.useLayoutEffect(() => { latestImage.current = image }, [image])
  const session = React.useRef<ImageInspectionSession | null>(null)
  const [position, setPosition] = React.useState<{ imageId: string; center: ImageCenter } | null>(null)
  const center = position?.imageId === imageId ? position.center : undefined
  const dimensions = React.useRef<ImageDimensions | null>(null)
  React.useEffect(() => {
    const current = new ImageInspectionSession(latestImage.current)
    session.current = current
    dimensions.current = null
    setPosition(null)
    return () => { current.dispose(); session.current = null }
  }, [imageId])
  const request = React.useMemo(() => ({ imageId, available, columns, rows, cell, zoom, center }),
    [imageId, available, columns, rows, cell, zoom, center])
  const [result, setResult] = React.useState<{
    request: typeof request; source?: TerminalImageSource; failed?: boolean
  } | null>(null)
  React.useEffect(() => {
    if (!available || (zoom > 0 && !cell)) return
    const controller = new AbortController()
    const current = session.current!
    // Coalesce drag/wheel bursts before starting native work. The shared
    // scheduler also bounds jobs already running when a request is cancelled.
    const timer = setTimeout(() => {
      void (async () => {
        if (zoom === 0) return loadTranscriptImageFull(latestImage.current, controller.signal)
        const size = await current.metadata()
        controller.signal.throwIfAborted()
        dimensions.current = size
        return current.render({ width: columns * cell!.width, height: rows * cell!.height }, zoom,
          center ?? { x: size.width / 2, y: size.height / 2 }, controller.signal)
      })().then(source => {
        if (!controller.signal.aborted) setResult({ request, source })
      }, () => {
        if (!controller.signal.aborted) setResult({ request, failed: true })
      })
    }, zoom === 0 ? 0 : 100)
    return () => { clearTimeout(timer); controller.abort() }
  }, [request])

  const clampedCenter = React.useCallback((value?: ImageCenter): ImageCenter | undefined => {
    const size = dimensions.current
    if (!size || !cell || zoom === 0) return undefined
    const crop = inspectionRegion(size, { width: columns * cell.width, height: rows * cell.height }, zoom,
      value ?? center ?? { x: size.width / 2, y: size.height / 2 })
    return { x: crop.left + crop.width / 2, y: crop.top + crop.height / 2 }
  }, [center, cell, columns, rows, zoom])
  const move = React.useCallback((x: number, y: number, origin?: ImageCenter) => {
    const previous = origin ?? clampedCenter()
    if (!previous) return
    const next = clampedCenter({ x: previous.x + x, y: previous.y + y })
    if (next) setPosition(old => old?.imageId === imageId && old.center.x === next.x && old.center.y === next.y
      ? old : { imageId, center: next })
  }, [clampedCenter, imageId])
  const dragOrigin = React.useRef<ImageCenter | undefined>(undefined)
  const drag = React.useCallback((event: DragEvent) => {
    event.stopImmediatePropagation()
    if (!cell || zoom === 0) return
    if (event.type === 'dragstart') dragOrigin.current = clampedCenter()
    if (dragOrigin.current) move((event.startCol - event.col) * cell.width / zoom,
      (event.startRow - event.row) * cell.height / zoom, dragOrigin.current)
    if (event.type === 'dragend') dragOrigin.current = undefined
  }, [cell, zoom, clampedCenter, move])
  // Preserve the previous pixels while panning, but never stretch stale pixels
  // across a new geometry, zoom, terminal cell size, or attachment.
  const reusable = result?.request.imageId === imageId && result.request.zoom === zoom &&
    result.request.columns === columns && result.request.rows === rows && result.request.cell === cell
  return {
    source: available && reusable ? result?.source : undefined,
    failed: result?.request === request && result.failed === true,
    pan: (x: number, y: number): void => move(x * columns * (cell?.width ?? 1) / Math.max(1, zoom) / 4,
      y * rows * (cell?.height ?? 1) / Math.max(1, zoom) / 4),
    drag,
  }
}
