import React, { type ReactNode } from 'react'
import type { TerminalImageSource } from '../terminal-image.js'
import {
  isTerminalImageSource,
  TERMINAL_IMAGE_MAX_CELLS,
} from '../terminal-image.js'
import Text from './Text.js'

export interface ImageProps {
  /** Decoded immutable RGBA pixels. Invalid/oversized sources use fallback. */
  readonly source?: TerminalImageSource
  /** Width reserved in terminal columns. */
  readonly width: number
  /** Height reserved in terminal rows. */
  readonly height: number
  /** Text alternative. Use an empty string for a decorative image. */
  readonly alt: string
  /** Same-size terminal-cell fallback rendered when graphics are unavailable. */
  readonly children?: ReactNode
}

/**
 * A renderer-owned terminal image with a deterministic cell fallback.
 *
 * The component never emits protocol bytes itself. It contributes a normal
 * Yoga leaf; the Ink host decides after layout whether to paint its fallback
 * children or attach a terminal-graphics placement over the same cells.
 */
export default function Image({
  source,
  width,
  height,
  alt,
  children,
}: ImageProps): React.ReactNode {
  const [columns, rows] = normalizeSize(width, height)
  const image = isTerminalImageSource(source) ? source : undefined
  const alternative = cleanAlternative(alt)

  return (
    <ink-image
      imageData={image?.data}
      imageWidth={image?.width}
      imageHeight={image?.height}
      imageAlt={alternative}
      style={{
        width: columns,
        height: rows,
        flexGrow: 0,
        flexShrink: 0,
        overflow: 'hidden',
      }}
    >
      {children ??
        (alternative === '' ? null : (
          <Text dimColor wrap="truncate">
            {alternative}
          </Text>
        ))}
    </ink-image>
  )
}

function normalizeSize(width: number, height: number): readonly [number, number] {
  let columns = normalizeEdge(width)
  let rows = normalizeEdge(height)
  const cells = columns * rows
  if (cells > TERMINAL_IMAGE_MAX_CELLS) {
    const scale = Math.sqrt(TERMINAL_IMAGE_MAX_CELLS / cells)
    columns = Math.max(1, Math.floor(columns * scale))
    rows = Math.max(1, Math.floor(rows * scale))
  }
  return [columns, rows]
}

function normalizeEdge(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.min(TERMINAL_IMAGE_MAX_CELLS, Math.floor(value)))
}

function cleanAlternative(value: string): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').slice(0, 200)
}
