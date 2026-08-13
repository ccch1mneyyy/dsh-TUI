import { lineWidth } from './line-width-cache.js';
/**
 * Get the display width of the widest line in a string.
 * @param string - the text to measure, possibly containing newlines.
 * @returns the maximum display width across all lines.
 */
export function widestLine(string) {
    let maxWidth = 0;
    let start = 0;
    while (start <= string.length) {
        const end = string.indexOf('\n', start);
        const line = end === -1 ? string.substring(start) : string.substring(start, end);
        maxWidth = Math.max(maxWidth, lineWidth(line));
        if (end === -1)
            break;
        start = end + 1;
    }
    return maxWidth;
}
