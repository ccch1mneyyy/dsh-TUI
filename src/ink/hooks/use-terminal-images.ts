import { createContext, useContext, useEffect, useSyncExternalStore } from 'react'
import type { TerminalCellSize } from '../terminal-image.js'

interface TerminalImages {
  subscribe(listener: () => void): () => void
  getSnapshot(): boolean
  getCellSize?(): TerminalCellSize | undefined
  getProtocol?(): TerminalImageProtocolName | undefined
  getStatus?(): TerminalImageStatus
  request(): () => void
}

/** The graphics protocol the renderer paints images with. */
export type TerminalImageProtocolName = 'kitty' | 'sixel'

/**
 * Why graphics are or are not painting, for consumers that draw their own
 * cell fallback.
 *
 * - `ready`: placements paint now (same as {@link useTerminalImages}).
 * - `pending`: not decided yet (capability probe in flight, first frame not
 *   painted, or a temporary pause such as an external-editor handoff).
 * - `unsupported`: this surface cannot paint graphics for the session —
 *   tmux/screen, `DSH_TUI_IMAGE_PROTOCOL=none`, a probe that found no
 *   protocol, or the inline main screen.
 * - `disabled`: pixel previews are off altogether: turned off
 *   (`terminalImages: false`, `DSH_TUI_DISABLE_TERMINAL_IMAGES`),
 *   accessibility mode, or output that is not a terminal.
 */
export type TerminalImageStatus = 'ready' | 'pending' | 'unsupported' | 'disabled'

const noCellSize = (): undefined => undefined
const noProtocol = (): undefined => undefined
const unknownStatus = (): TerminalImageStatus => 'pending'

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

/** The renderer's graphics status; a host without a renderer reports `pending`. */
export function useTerminalImageStatus(): TerminalImageStatus {
  const images = useContext(TerminalImagesContext)
  return useSyncExternalStore(images.subscribe, images.getStatus ?? unknownStatus)
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
