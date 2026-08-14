import { stringWidth } from './stringWidth.js';
/**
 * Slice a string to at most `maxWidth` terminal cells, walking by code
 * point so CJK wide characters never split mid-glyph. Assumes no ANSI in
 * the input (callers pass plain text).
 */
export function truncateToWidth(text, maxWidth) {
    let width = 0;
    let out = '';
    for (const char of text) {
        const charWidth = stringWidth(char);
        if (width + charWidth > maxWidth)
            break;
        width += charWidth;
        out += char;
    }
    return out;
}
