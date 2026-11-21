/**
 * Character-cell rendering of a decoded image, for surfaces where terminal
 * graphics cannot paint (tmux/screen, the inline main screen, terminals
 * without Kitty or Sixel).
 *
 * Two modes:
 * - `color`: one cell holds two vertically stacked pixels — `▀` with the top
 *   pixel as foreground and the bottom one as background (`▄` / blank when a
 *   half is transparent). The renderer's chalk level downsamples the colours.
 * - `ascii`: one luminance character per cell, contrast-stretched between the
 *   2nd and 98th percentile so a dark-grey scene with grey objects still shows
 *   its outlines. Used when the terminal has no colour (`NO_COLOR`,
 *   `FORCE_COLOR=0`).
 *
 * Every target pixel is the coverage-weighted average of the source pixels
 * it covers; point sampling turns fine detail (viewport grids, noise, text)
 * into flicker-prone high-frequency cells. Pure and allocation-bounded: the
 * output is at most `columns × rows` cells, cached per source buffer.
 */
import chalk from 'chalk'
import type { TerminalImageSource } from '../../ink/terminal-image.js'
import type { RGBColor } from '../../ink/styles.js'

/** How a fallback paints, or `off` when it must not paint pixels at all. */
export type ImageTextMode = 'color' | 'ascii' | 'off'

/** One horizontal run of identically styled cells. */
export interface ImageTextRun {
  readonly text: string
  /** Raw foreground, or undefined for the terminal default. */
  readonly color?: RGBColor
  /** Raw background, or undefined for the terminal default. */
  readonly backgroundColor?: RGBColor
}

/** Exactly `rows` lines, each exactly `columns` cells wide. */
export type ImageTextGrid = readonly (readonly ImageTextRun[])[]

/** Dark → light. Ten steps read as shape without turning the box into noise. */
const ASCII_RAMP = ' .:-=+*#%@'
/** Below this luminance span the stretch would only amplify noise. */
const MIN_STRETCH_SPAN = 8
/** A target pixel at or below this mean coverage is treated as transparent. */
const TRANSPARENT_COVERAGE = 0.5
/** Colour channels snap to this step so flat regions merge into long runs. */
const CHANNEL_STEP = 4

/**
 * The mode for this process: `off` when `DSH_TUI_IMAGE_TEXT_FALLBACK` is set
 * to a false spelling, `ascii` without colour support, `color` otherwise.
 * Read per call so a test (or a future settings bridge) may change the env.
 */
export function imageTextMode(): ImageTextMode {
  const flag = process.env.DSH_TUI_IMAGE_TEXT_FALLBACK?.trim().toLowerCase()
  if (flag === '0' || flag === 'false' || flag === 'no' || flag === 'off') return 'off'
  return chalk.level === 0 ? 'ascii' : 'color'
}

/** Whether a `#rrggbb` terminal background is light (ASCII ramp inverts). */
export function isLightBackground(hex: string | undefined): boolean {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(hex ?? '')
  if (match === null) return false
  const [r, g, b] = [match[1]!, match[2]!, match[3]!].map(part => Number.parseInt(part, 16))
  return luminance(r!, g!, b!) > 127.5
}

const cache = new WeakMap<Uint8Array, Map<string, ImageTextGrid>>()

/**
 * Render `source` into a `columns × rows` cell box, aspect-fit and centered
 * (letterbox cells are blank). Memoized per source buffer and box, so a
 * re-render never repeats the pass; sources are immutable by contract.
 */
export function buildImageTextGrid(
  source: TerminalImageSource,
  columns: number,
  rows: number,
  mode: Exclude<ImageTextMode, 'off'>,
  lightBackground = false,
): ImageTextGrid {
  const width = Math.max(1, Math.floor(columns))
  const height = Math.max(1, Math.floor(rows))
  const key = `${width}x${height}:${mode}:${lightBackground ? 'light' : 'dark'}`
  let entries = cache.get(source.data)
  const hit = entries?.get(key)
  if (hit !== undefined) return hit
  const grid = mode === 'color'
    ? colorGrid(source, width, height)
    : asciiGrid(source, width, height, lightBackground)
  if (entries === undefined) cache.set(source.data, entries = new Map())
  entries.set(key, grid)
  return grid
}

/** Target pixel box inside `columns × pixelRows`, preserving the source aspect. */
function fitBox(
  source: TerminalImageSource,
  columns: number,
  pixelRows: number,
): { left: number; top: number; width: number; height: number } {
  // One cell is twice as tall as it is wide, so a cell column and a
  // half-cell row are the same physical size: the pixel grid is square.
  const scale = Math.min(columns / source.width, pixelRows / source.height)
  const width = Math.max(1, Math.min(columns, Math.round(source.width * scale)))
  const height = Math.max(1, Math.min(pixelRows, Math.round(source.height * scale)))
  return {
    left: Math.floor((columns - width) / 2),
    top: Math.floor((pixelRows - height) / 2),
    width,
    height,
  }
}

interface Sample {
  readonly r: number
  readonly g: number
  readonly b: number
  /** Mean alpha coverage in [0, 1]. */
  readonly coverage: number
}

/**
 * Average the source pixels a `width × height` target grid's cell (x, y)
 * covers. Colours are alpha-weighted so transparent pixels do not darken
 * the edge they share with an opaque one.
 */
function sampler(source: TerminalImageSource, width: number, height: number): (x: number, y: number) => Sample {
  const { data, width: sw, height: sh } = source
  return (x, y) => {
    const x0 = Math.floor((x * sw) / width)
    const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / width))
    const y0 = Math.floor((y * sh) / height)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / height))
    let r = 0
    let g = 0
    let b = 0
    let alpha = 0
    let count = 0
    for (let sy = y0; sy < Math.min(y1, sh); sy++) {
      for (let sx = x0; sx < Math.min(x1, sw); sx++) {
        const at = (sy * sw + sx) * 4
        const a = data[at + 3]! / 255
        r += data[at]! * a
        g += data[at + 1]! * a
        b += data[at + 2]! * a
        alpha += a
        count++
      }
    }
    if (count === 0 || alpha === 0) return { r: 0, g: 0, b: 0, coverage: 0 }
    return { r: r / alpha, g: g / alpha, b: b / alpha, coverage: alpha / count }
  }
}

function colorGrid(source: TerminalImageSource, columns: number, rows: number): ImageTextGrid {
  const box = fitBox(source, columns, rows * 2)
  const sample = sampler(source, box.width, box.height)
  const pixel = (x: number, y: number): RGBColor | undefined => {
    const px = x - box.left
    const py = y - box.top
    if (px < 0 || py < 0 || px >= box.width || py >= box.height) return undefined
    const value = sample(px, py)
    return value.coverage <= TRANSPARENT_COVERAGE ? undefined : rgb(value)
  }
  const grid: ImageTextRun[][] = []
  for (let row = 0; row < rows; row++) {
    const line = new RunBuilder()
    for (let column = 0; column < columns; column++) {
      const top = pixel(column, row * 2)
      const bottom = pixel(column, row * 2 + 1)
      if (top === undefined && bottom === undefined) line.push(' ')
      else if (top === undefined) line.push('▄', bottom)
      else line.push('▀', top, bottom)
    }
    grid.push(line.done())
  }
  return grid
}

function asciiGrid(
  source: TerminalImageSource,
  columns: number,
  rows: number,
  lightBackground: boolean,
): ImageTextGrid {
  // One character per cell: the cell grid's own aspect is 1:2, so fit the
  // image into half as many pixel rows as a square grid would use.
  const square = fitBox(source, columns, rows * 2)
  const box = {
    left: square.left,
    top: Math.floor(square.top / 2),
    width: square.width,
    height: Math.max(1, Math.round(square.height / 2)),
  }
  const sample = sampler(source, box.width, box.height)
  const values = new Float32Array(box.width * box.height)
  const opaque: number[] = []
  for (let y = 0; y < box.height; y++) {
    for (let x = 0; x < box.width; x++) {
      const value = sample(x, y)
      // NaN marks a transparent cell: it renders blank and stays out of the
      // percentile window.
      const lum = value.coverage <= TRANSPARENT_COVERAGE ? Number.NaN : luminance(value.r, value.g, value.b)
      values[y * box.width + x] = lum
      if (!Number.isNaN(lum)) opaque.push(lum)
    }
  }
  opaque.sort((a, b) => a - b)
  const quantile = (q: number): number => opaque[Math.min(opaque.length - 1, Math.max(0, Math.round((opaque.length - 1) * q)))] ?? 0
  const low = quantile(0.02)
  const span = quantile(0.98) - low
  const last = ASCII_RAMP.length - 1
  const level = (lum: number): number => span >= MIN_STRETCH_SPAN
    ? Math.round(((lum - low) / span) * last)
    : Math.floor((lum / 256) * ASCII_RAMP.length)
  const grid: ImageTextRun[][] = []
  for (let row = 0; row < rows; row++) {
    let text = ''
    for (let column = 0; column < columns; column++) {
      const x = column - box.left
      const y = row - box.top
      const lum = x < 0 || y < 0 || x >= box.width || y >= box.height ? Number.NaN : values[y * box.width + x]!
      if (Number.isNaN(lum)) {
        text += ' '
        continue
      }
      const step = Math.max(0, Math.min(last, level(lum)))
      // Dense glyphs read as ink: on a light terminal they must mark the
      // dark pixels, so the ramp runs the other way.
      text += ASCII_RAMP[lightBackground ? last - step : step]
    }
    grid.push([{ text }])
  }
  return grid
}

/** Rec. 709 relative luminance on 0..255 channels. */
function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function rgb(sample: Sample): RGBColor {
  const snap = (value: number): number => Math.min(255, Math.round(value / CHANNEL_STEP) * CHANNEL_STEP)
  return `rgb(${snap(sample.r)},${snap(sample.g)},${snap(sample.b)})`
}

/** Merges adjacent cells that share a glyph and both colours into one run. */
class RunBuilder {
  private readonly runs: ImageTextRun[] = []
  private text = ''
  private color: RGBColor | undefined
  private backgroundColor: RGBColor | undefined

  push(glyph: string, color?: RGBColor, backgroundColor?: RGBColor): void {
    if (this.text !== '' && (this.text.at(-1) !== glyph || this.color !== color || this.backgroundColor !== backgroundColor)) {
      this.flush()
    }
    this.text += glyph
    this.color = color
    this.backgroundColor = backgroundColor
  }

  done(): ImageTextRun[] {
    this.flush()
    return this.runs
  }

  private flush(): void {
    if (this.text === '') return
    this.runs.push({
      text: this.text,
      ...(this.color === undefined ? {} : { color: this.color }),
      ...(this.backgroundColor === undefined ? {} : { backgroundColor: this.backgroundColor }),
    })
    this.text = ''
  }
}
