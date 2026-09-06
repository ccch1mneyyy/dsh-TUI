import { createContext, useContext, useEffect, useSyncExternalStore } from 'react'
import type { TerminalCellSize } from '../terminal-image.js'

interface TerminalImages {
  subscribe(listener: () => void): () => void
  getSnapshot(): boolean
  getCellSize?(): TerminalCellSize | undefined
  request(): () => void
}

const noCellSize = (): undefined => undefined

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
