import chalk from 'chalk';
import { stringWidth } from '../ink/stringWidth.js';
import { getGraphemeSegmenter } from '../utils/intl.js';
import { interpolateColor } from '../components/Spinner/spinnerUtils.js';
/** Header blue-white ladder: brand → ice → pale → near-white flash. */
export const BRAND = { r: 77, g: 107, b: 254 };
export const ICE = { r: 147, g: 190, b: 255 };
export const PALE = { r: 215, g: 228, b: 255 };
export const FLASH = { r: 238, g: 244, b: 255 };
/**
 * Paint `word` with a 10-column highlight window sweeping across it (CC's
 * useShimmerAnimation non-requesting cadence: one column per 200ms frame,
 * highlight brightness pulsing on a 400ms sine).
 */
export function sweep(word, time, base, highlight) {
    const width = stringWidth(word);
    const cycle = width + 20;
    const glimmerStart = (Math.floor(time / 200) % cycle) - 10;
    let out = '';
    let col = 0;
    for (const { segment } of getGraphemeSegmenter().segment(word)) {
        const segWidth = stringWidth(segment);
        const highlighted = col >= glimmerStart && col + segWidth <= glimmerStart + 10;
        const opacity = highlighted ? (Math.sin(time / 400) + 1) / 2 : 0;
        const rgb = highlighted ? interpolateColor(base, highlight, opacity) : base;
        out += chalk.rgb(rgb.r, rgb.g, rgb.b).bold(segment);
        col += segWidth;
    }
    return out;
}
