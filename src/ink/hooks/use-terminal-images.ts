import { createContext, useContext, useEffect, useSyncExternalStore } from 'react'
import type { TerminalCellSize } from '../terminal-image.js'

interface TerminalImages {
  subscribe(listener: () => void): () => void
  getSnapshot(): boolean
  getCellSize?(): TerminalCellSize | undefined
  getProtocol?(): TerminalImageProtocolName | undefined
  request(): () => void
}

/** The graphics protocol the renderer paints images with. */
export type TerminalImageProtocolName = 'kitty' | 'sixel'

const noCellSize = (): undefined => undefined
const noProtocol = (): undefined => undefined

/**
 * The protocol images are painted with, or undefined without graphics.
 *
 * Kitty provides persistent placements; Sixel paints rasters into the
 * renderer-managed transcript surface. Both may host inline media as long as
 * the placement joins the normal image lifecycle (a `presentation` of
 * `'transcript'` or `'preview'`), which is the real capability boundary.
 */
export function useTerminalImageProtocol(): TerminalImageProtocolName | undefined {
  const images = useContext(TerminalImagesContext)
  return useSyncExternalStore(images.subscribe, images.getProtocol ?? noProtocol)
}

/** Only measured pixels qualify for an original-pixel (100%) image view. */
export function useTerminalImageCellSize(): TerminalCellSize | undefined {
  const images = useContext(TerminalImagesContext)
  return useSyncExternalStore(images.subscribe, images.getCellSize ?? noCellSize)
}

export const TerminalImagesContext = createContext<TerminalImages>({
  subscribe: () => () => {},
  getSnapshot: () => false,
  request: () => () => {},
})

/** Request the renderer's capability probe before reading or decoding pixels. */
export function useTerminalImages(requested = true): boolean {
  const images = useContext(TerminalImagesContext)
  const available = useSyncExternalStore(images.subscribe, images.getSnapshot)
  useEffect(() => {
    if (requested) return images.request()
  }, [images, requested])
  return requested && available
}
