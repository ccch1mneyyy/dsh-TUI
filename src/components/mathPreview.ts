/**
 * Formula-image previews.
 *
 * The transcript host (Chat) publishes an opener for as long as it is mounted,
 * and the math components call it when a formula image is clicked. A
 * module-level registry — the same shape the live display settings use —
 * keeps that callback out of the MessageList → Markdown prop chain, which
 * would otherwise thread it through every message row.
 */
import React from 'react'
import type { TerminalImageSource } from '../ink/terminal-image.js'
import type { MathRenderRequest } from '../math/renderer.js'
import { loadSharp } from '../dsh-adapter/sharp.js'

/** What a click on a formula image hands to the preview host. */
export interface MathPreviewRequest {
  /** The formula's TeX without delimiters; the card shows it as its title. */
  readonly tex: string
  /** The request that produced the raster currently on screen. */
  readonly request: MathRenderRequest
  /** Those pixels, used as-is when a sharper raster cannot be produced. */
  readonly source: TerminalImageSource
}

export type MathPreviewOpener = (request: MathPreviewRequest) => void

let opener: MathPreviewOpener | undefined
const listeners = new Set<() => void>()

/** Published by the transcript host; cleared when it unmounts. */
export function setMathPreviewOpener(next: MathPreviewOpener | undefined): void {
  if (opener === next) return
  opener = next
  for (const listener of listeners) listener()
}

export function getMathPreviewOpener(): MathPreviewOpener | undefined {
  return opener
}

export function subscribeMathPreviewOpener(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The host's opener, or undefined when nothing can show a preview card. */
export function useMathPreviewOpener(): MathPreviewOpener | undefined {
  return React.useSyncExternalStore(subscribeMathPreviewOpener, getMathPreviewOpener)
}

/**
 * RGBA raster → PNG bytes, the form the image preview card decodes. Sharp is
 * already a runtime dependency (Sixel encoding uses it) and is optional, so a
 * missing build rejects rather than returning a broken byte string.
 */
export async function rasterToPng(source: TerminalImageSource): Promise<Uint8Array> {
  const sharp = await loadSharp()
  if (sharp === undefined) throw new Error('image encoder unavailable')
  const buffer = await sharp(Buffer.from(source.data), {
    raw: { width: source.width, height: source.height, channels: 4 },
  }).png().toBuffer()
  return new Uint8Array(buffer)
}
