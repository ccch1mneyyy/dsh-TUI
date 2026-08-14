import { stringWidth } from './stringWidth.js';
// During streaming, text grows but completed lines are immutable.
// Caching stringWidth per-line avoids re-measuring hundreds of
// unchanged lines on every token (~50x reduction in stringWidth calls).
const cache = new Map();
const MAX_CACHE_SIZE = 4096;
const MAX_CACHE_CHARS = 100_000;
// Lines longer than this are never cached: the cache key would retain the
// whole line, and during streaming the growing last line changes every
// frame (zero reuse for the cost of a full copy per frame).
const MAX_CACHEABLE_LINE = 500;
let cacheChars = 0;
/**
 * Copy a string into a fresh flat string with no parent references.
 * A line substring'd out of a large streaming buffer is a V8 SlicedString
 * that pins the entire parent (the full message text); using it directly
 * as a cache key retains the parent for the lifetime of the entry.
 */
function detachString(s) {
    return Buffer.from(s, 'utf8').toString('utf8');
}
/**
 * Measure the display width of a line, cached per line across calls.
 * Completed lines are immutable during streaming, so caching avoids
 * re-measuring hundreds of unchanged lines on every token.
 * @param line - the line to measure.
 * @returns the display width in terminal cells.
 */
export function lineWidth(line) {
    const cached = cache.get(line);
    if (cached !== undefined)
        return cached;
    const width = stringWidth(line);
    if (line.length > MAX_CACHEABLE_LINE)
        return width;
    // Evict when cache grows too large (e.g. after many different responses).
    // Simple full-clear is fine — the cache repopulates in one frame.
    if (cache.size >= MAX_CACHE_SIZE || cacheChars + line.length > MAX_CACHE_CHARS) {
        cache.clear();
        cacheChars = 0;
    }
    cache.set(detachString(line), width);
    cacheChars += line.length;
    return width;
}
