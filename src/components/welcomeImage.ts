/**
 * PNG decoding for the six image header modes.
 *
 * Every welcome PNG is decoded once per element and cached: the raw RGBA
 * source feeds the terminal graphics protocol, and a half-block cell-art
 * sample of the same bytes is the fallback for terminals without image
 * support (`toHalfBlockRows`).
 *
 * Native pixel modes never load or resample these PNGs.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadSharp } from '../dsh-adapter/sharp.js'
import type { TerminalImageSource } from '../ink/terminal-image.js'
import type { WhaleImageId, WordmarkImageId } from './welcomeArt.js'

/** One decoded PNG plus the cell-art fallback sampled from the same bytes. */
export interface WelcomeArtImage {
  readonly source: TerminalImageSource
  /** Decoded pixel width, so callers can derive cell geometry from the aspect. */
  readonly width: number
  readonly height: number
  /** Half-block rows sampled at the fixed grid below. */
  readonly rows: readonly string[]
  readonly fallbackColumns: number
  readonly fallbackRows: number
}

/** The whale and wordmark PNGs of one `image` mode. */
export interface WelcomeImagePair {
  readonly whale: WelcomeArtImage
  readonly wordmark: WelcomeArtImage
}

/** Cell grid each element family is sampled on for the cell-art fallback. */
const FALLBACK_GRID = {
  whale: { columns: 40, rows: 13 },
  mark: { columns: 48, rows: 12 },
} as const

const decoded = new Map<string, Promise<WelcomeArtImage>>()

function assetUrl(file: string): URL {
  // Compiled module: lib/types/components/ → repository/package root.
  return new URL(`../../../assets/welcome/${file}`, import.meta.url)
}

/**
 * Decode one welcome PNG. `file` is resolved inside `assets/welcome`, so the
 * element ids in `welcomeArt.ts` are the only reachable inputs.
 */
function loadImage(file: string, columns: number, rows: number): Promise<WelcomeArtImage> {
  const cached = decoded.get(file)
  if (cached !== undefined) return cached
  const pending = decode(file, columns, rows).catch(error => {
    // A failed decode must not poison the cache: the next mount retries so a
    // transient read (a half-written install, a locked file) can recover.
    decoded.delete(file)
    throw error
  })
  decoded.set(file, pending)
  return pending
}

/** Decode the whale PNGs of the `image` modes. */
export function loadWhaleImage(id: WhaleImageId): Promise<WelcomeArtImage> {
  return loadImage(`whale-${id}.png`, FALLBACK_GRID.whale.columns, FALLBACK_GRID.whale.rows)
}

/** Decode the wordmark PNGs of the `image` modes. */
export function loadWordmarkImage(id: WordmarkImageId): Promise<WelcomeArtImage> {
  return loadImage(`mark-${id}.png`, FALLBACK_GRID.mark.columns, FALLBACK_GRID.mark.rows)
}

/** Decode both PNGs of an `image` mode. */
export function loadWelcomeArtPair(
  whale: WhaleImageId,
  wordmark: WordmarkImageId,
): Promise<WelcomeImagePair> {
  return Promise.all([loadWhaleImage(whale), loadWordmarkImage(wordmark)])
    .then(([whaleImage, wordmarkImage]) => ({ whale: whaleImage, wordmark: wordmarkImage }))
}

/**
 * Rows a terminal cell grid needs so a `width`×`height` PNG keeps its aspect
 * (a terminal cell is about twice as tall as it is wide).
 */
export function cellRowsFor(width: number, height: number, columns: number): number {
  return Math.max(1, Math.round((columns * height) / (width * 2)))
}

/**
 * The R1U pair — the art study's selected variant (`R1U` → the `glitch`
 * elements). Kept as a named entry point because the R1U regression pins the
 * decoded pixel sizes of exactly this pair.
 */
export function loadR1UWelcomeImages(): Promise<WelcomeImagePair> {
  return loadWelcomeArtPair('glitch', 'glitch')
}

async function decode(file: string, columns: number, rows: number): Promise<WelcomeArtImage> {
  const data = await readFile(fileURLToPath(assetUrl(file)))
  const sharp = await loadSharp()
  if (sharp === undefined) throw new Error('PNG decoder is unavailable')
  const result = await sharp(data, { failOn: 'error', limitInputPixels: 1024 * 1024 })
    .toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  if (result.info.channels !== 4 || result.data.byteLength !== result.info.width * result.info.height * 4) {
    throw new Error('Invalid welcome image RGBA data')
  }
  const source = { data: result.data, width: result.info.width, height: result.info.height }
  // The fallback grid is intentionally lower resolution than terminal graphics.
  // Nearest preserves the native relief grid; area filtering preserves thin PNG details.
  // A low alpha cutoff keeps fine dots visible after reduction. Full fidelity needs graphics.
  const grid = rows > 0
    ? { columns, rows }
    : { columns, rows: cellRowsFor(result.info.width, result.info.height, columns) }
  const reduced = await sharp(data, { failOn: 'error' })
    .resize(grid.columns, grid.rows * 2, { fit: 'contain', kernel: file === 'whale-original.png' || file === 'mark-relief.png' ? 'nearest' : 'lanczos3', background: '#00000000' })
    .toColourspace('srgb').ensureAlpha().raw().toBuffer()
  return {
    source,
    width: result.info.width,
    height: result.info.height,
    rows: toHalfBlockRows(reduced, grid.columns, grid.rows),
    fallbackColumns: grid.columns,
    fallbackRows: grid.rows,
  }
}

function toHalfBlockRows(data: Uint8Array, columns: number, rows: number): readonly string[] {
  const output: string[] = []
  const colorAt = (x: number, y: number): string | undefined => {
    const offset = (y * columns + x) * 4
    if (data[offset + 3] < 24) return undefined
    return `${data[offset]};${data[offset + 1]};${data[offset + 2]}`
  }
  for (let y = 0; y < rows; y++) {
    let row = ''
    for (let x = 0; x < columns; x++) {
      const top = colorAt(x, y * 2)
      const bottom = colorAt(x, y * 2 + 1)
      if (top && bottom) row += `\x1b[38;2;${top}m\x1b[48;2;${bottom}m▀`
      else if (top) row += `\x1b[38;2;${top}m\x1b[49m▀`
      else if (bottom) row += `\x1b[38;2;${bottom}m\x1b[49m▄`
      else row += '\x1b[0m '
    }
    output.push(row + '\x1b[0m')
  }
  return output
}
