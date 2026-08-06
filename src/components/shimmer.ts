import chalk from 'chalk'
import { stringWidth } from '../ink/stringWidth.js'
import { getGraphemeSegmenter } from '../utils/intl.js'
import { interpolateColor } from '../components/Spinner/spinnerUtils.js'

/**
 * Shared shimmer utilities: the blue-white color ladder of the header and a
 * moving-highlight text painter used by the header wordmark/tagline and the
 * working-activity status line.
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

/** Header blue-white ladder: brand → ice → pale → soft ice flash.
 *  FLASH stays visibly blue (never pure white) — the highlight reads as a
 *  mist-brightened crest, not a white strobe. */
export const BRAND: Rgb = { r: 77, g: 107, b: 254 }
export const ICE: Rgb = { r: 147, g: 190, b: 255 }
export const PALE: Rgb = { r: 215, g: 228, b: 255 }
export const FLASH: Rgb = { r: 198, g: 216, b: 248 }

/**
 * Paint `word` with a 10-column highlight window sweeping across it. The
 * window advances one column per `stepMs` and the brightness pulse follows
 * the same cadence (period 2π·stepMs·... — one full sine per ~6 steps).
 * CC's original cadence was 200ms/column; callers pass 100 for a livelier
 * sweep.
 */
export function sweep(word: string, time: number, base: Rgb, highlight: Rgb, stepMs = 200): string {
  const width = stringWidth(word)
  const cycle = width + 20
  const glimmerStart = (Math.floor(time / stepMs) % cycle) - 10
  let out = ''
  let col = 0
  for (const { segment } of getGraphemeSegmenter().segment(word)) {
    const segWidth = stringWidth(segment)
    const highlighted = col >= glimmerStart && col + segWidth <= glimmerStart + 10
    const opacity = highlighted ? (Math.sin(time / (stepMs * 2)) + 1) / 2 : 0
    const rgb = highlighted ? interpolateColor(base, highlight, opacity) : base
    out += chalk.rgb(rgb.r, rgb.g, rgb.b).bold(segment)
    col += segWidth
  }
  return out
}
