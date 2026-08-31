import type { DOMElement } from './dom.js'

/** Hard bounds for one decoded image admitted to the terminal renderer. */
export const TERMINAL_IMAGE_MAX_EDGE = 1024
export const TERMINAL_IMAGE_MAX_BYTES = 4 * 1024 * 1024
export const TERMINAL_IMAGE_MAX_CELLS = 512
export const TERMINAL_IMAGE_MAX_PLACEMENTS = 64

/** Immutable decoded image data accepted by the host image primitive. */
export interface TerminalImageSource {
  /** Row-major sRGB pixels, four bytes per pixel in RGBA order. */
  readonly data: Uint8Array
  readonly width: number
  readonly height: number
}

/** One laid-out image request collected from the current Ink frame. */
export interface TerminalImagePlacement {
  readonly node: DOMElement
  readonly x: number
  readonly y: number
  readonly columns: number
  readonly rows: number
  readonly source: TerminalImageSource
}

/** Validate an untrusted decoded source without copying its pixel buffer. */
export function isTerminalImageSource(
  value: unknown,
): value is TerminalImageSource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const source = value as Partial<TerminalImageSource>
  if (
    !(source.data instanceof Uint8Array) ||
    !Number.isSafeInteger(source.width) ||
    !Number.isSafeInteger(source.height) ||
    source.width! <= 0 ||
    source.height! <= 0 ||
    source.width! > TERMINAL_IMAGE_MAX_EDGE ||
    source.height! > TERMINAL_IMAGE_MAX_EDGE
  ) {
    return false
  }
  const bytes = source.width! * source.height! * 4
  return bytes <= TERMINAL_IMAGE_MAX_BYTES && source.data.byteLength === bytes
}

/** Recover and validate a source stored as primitive Ink host attributes. */
export function terminalImageSourceFromAttributes(
  attributes: Readonly<Record<string, unknown>>,
): TerminalImageSource | undefined {
  const source = {
    data: attributes['imageData'],
    width: attributes['imageWidth'],
    height: attributes['imageHeight'],
  }
  return isTerminalImageSource(source) ? source : undefined
}
