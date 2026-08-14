import chalk from 'chalk';
import { stringWidth } from '../ink/stringWidth.js';
import { getGraphemeSegmenter } from '../utils/intl.js';
import { interpolateColor } from '../components/Spinner/spinnerUtils.js';
/** Header blue-white ladder: brand → ice → pale → soft ice flash.
 *  FLASH stays visibly blue (never pure white) — the highlight reads as a
 *  mist-brightened crest, not a white strobe. */
export const BRAND = { r: 77, g: 107, b: 254 };
/** Header ladder ice blue (`#93BEFF`). */
export const ICE = { r: 147, g: 190, b: 255 };
/** Header ladder pale blue (`#D7E4FF`). */
export const PALE = { r: 215, g: 228, b: 255 };
/** Soft ice flash blue (`#C6D8F8`); stays visibly blue, never pure white. */
export const FLASH = { r: 198, g: 216, b: 248 };
/**
 * Paint `word` with a 10-column highlight window sweeping across it. The
 * window advances one column per `stepMs` and the brightness pulse follows
 * the same cadence (period 2π·stepMs·... — one full sine per ~6 steps).
 * CC's original cadence was 200ms/column; callers pass 60 for the lively
 * sweep.
 * @param word - Text to paint.
 * @param time - Elapsed time in milliseconds; drives the sweep position and the brightness pulse.
 * @param base - Color for cells outside the highlight window.
 * @param highlight - Color mixed into the sweeping highlight window.
 * @param stepMs - Milliseconds per column of sweep advance (default 60).
 * @returns The ANSI bold-colored word with the moving highlight.
 */
export function sweep(word, time, base, highlight, stepMs = 60) {
    const width = stringWidth(word);
    const cycle = width + 20;
    const glimmerStart = (Math.floor(time / stepMs) % cycle) - 10;
    let out = '';
    let col = 0;
    for (const { segment } of getGraphemeSegmenter().segment(word)) {
        const segWidth = stringWidth(segment);
        const highlighted = col >= glimmerStart && col + segWidth <= glimmerStart + 10;
        const opacity = highlighted ? (Math.sin(time / (stepMs * 2)) + 1) / 2 : 0;
        const rgb = highlighted ? interpolateColor(base, highlight, opacity) : base;
        out += chalk.rgb(rgb.r, rgb.g, rgb.b).bold(segment);
        col += segWidth;
    }
    return out;
}
