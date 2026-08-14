import emojiRegex from 'emoji-regex';
import { eastAsianWidth } from 'get-east-asian-width';
import stripAnsi from 'strip-ansi';
import { getGraphemeSegmenter } from '../utils/intl.js';
const EMOJI_REGEX = emojiRegex();
/**
 * Fallback JavaScript implementation of stringWidth when Bun.stringWidth is not available.
 *
 * Get the display width of a string as it would appear in a terminal.
 *
 * This is a more accurate alternative to the string-width package that correctly handles
 * characters like ⚠ (U+26A0) which string-width incorrectly reports as width 2.
 *
 * The implementation uses eastAsianWidth directly with ambiguousAsWide: false,
 * which correctly treats ambiguous-width characters as narrow (width 1) as
 * recommended by the Unicode standard for Western contexts.
 */
function stringWidthJavaScript(str) {
    if (typeof str !== 'string' || str.length === 0) {
        return 0;
    }
    // Fast path: pure ASCII string (no ANSI codes, no wide chars)
    let isPureAscii = true;
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        // Check for non-ASCII or ANSI escape (0x1b)
        if (code >= 127 || code === 0x1b) {
            isPureAscii = false;
            break;
        }
    }
    if (isPureAscii) {
        // Count printable characters (exclude control chars)
        let width = 0;
        for (let i = 0; i < str.length; i++) {
            const code = str.charCodeAt(i);
            if (code > 0x1f) {
                width++;
            }
        }
        return width;
    }
    // Strip ANSI if escape character is present
    if (str.includes('\x1b')) {
        str = stripAnsi(str);
        if (str.length === 0) {
            return 0;
        }
    }
    // Fast path: simple Unicode (no emoji, variation selectors, or joiners)
    if (!needsSegmentation(str)) {
        let width = 0;
        for (const char of str) {
            const codePoint = char.codePointAt(0);
            if (!isZeroWidth(codePoint)) {
                width += eastAsianWidth(codePoint, { ambiguousAsWide: false });
            }
        }
        return width;
    }
    let width = 0;
    for (const { segment: grapheme } of getGraphemeSegmenter().segment(str)) {
        // Check for emoji first (most emoji sequences are width 2)
        EMOJI_REGEX.lastIndex = 0;
        if (EMOJI_REGEX.test(grapheme)) {
            width += getEmojiWidth(grapheme);
            continue;
        }
        // Calculate width for non-emoji graphemes
        // For grapheme clusters (like Devanagari conjuncts with virama+ZWJ), only count
        // the first non-zero-width character's width since the cluster renders as one glyph
        for (const char of grapheme) {
            const codePoint = char.codePointAt(0);
            if (!isZeroWidth(codePoint)) {
                width += eastAsianWidth(codePoint, { ambiguousAsWide: false });
                break;
            }
        }
    }
    return width;
}
function needsSegmentation(str) {
    for (const char of str) {
        const cp = char.codePointAt(0);
        // Emoji ranges
        if (cp >= 0x1f300 && cp <= 0x1faff)
            return true;
        if (cp >= 0x2600 && cp <= 0x27bf)
            return true;
        if (cp >= 0x1f1e6 && cp <= 0x1f1ff)
            return true;
        // Variation selectors, ZWJ
        if (cp >= 0xfe00 && cp <= 0xfe0f)
            return true;
        if (cp === 0x200d)
            return true;
    }
    return false;
}
function getEmojiWidth(grapheme) {
    // Regional indicators: single = 1, pair = 2
    const first = grapheme.codePointAt(0);
    if (first >= 0x1f1e6 && first <= 0x1f1ff) {
        let count = 0;
        for (const _ of grapheme)
            count++;
        return count === 1 ? 1 : 2;
    }
    // Incomplete keycap: digit/symbol + VS16 without U+20E3
    if (grapheme.length === 2) {
        const second = grapheme.codePointAt(1);
        if (second === 0xfe0f &&
            ((first >= 0x30 && first <= 0x39) || first === 0x23 || first === 0x2a)) {
            return 1;
        }
    }
    // Single codepoint without VS16: only Emoji_Presentation=Yes characters
    // actually render as wide emoji. Text-default emoji (✳ U+2733, ⚠ U+26A0,
    // ❤ U+2764, ❄ U+2744, ✂ U+2702 …) render width 1 in terminals
    // (ghostty/kitty/iTerm2/xterm.js all agree) unless VS16 forces emoji
    // presentation. emoji-regex matches BOTH categories, so counting every
    // match as 2 desyncs the layout from the terminal: the spinner glyph ✳
    // measured 2 but painted 1, shifting the whole spinner row 1 column every
    // time the animation cycle hit it — leaving stray cells ("tthinking",
    // orphan "t" residue). VS16 sequences fall through to width 2 below.
    if (!grapheme.includes('\ufe0f')) {
        let codepoints = 0;
        for (const _ of grapheme)
            codepoints++;
        if (codepoints === 1 && !hasEmojiPresentation(first)) {
            return 1;
        }
    }
    return 2;
}
/**
 * Emoji_Presentation=Yes codepoints (Unicode emoji-data.txt, merged
 * ranges). These render as wide emoji without VS16; everything else
 * emoji-regex matches is text-default and renders narrow.
 */
const EMOJI_PRESENTATION_RANGES = [
    [0x231a, 0x231b], [0x23e9, 0x23ec], 0x23f0, 0x23f3, [0x25fd, 0x25fe],
    [0x2614, 0x2615], [0x2648, 0x2653], 0x267f, 0x2693, 0x26a1,
    [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], 0x26ce, 0x26d4,
    0x26ea, [0x26f2, 0x26f3], 0x26f5, 0x26fa, 0x26fd, 0x2705,
    [0x270a, 0x270b], 0x2728, 0x274c, 0x274e, [0x2753, 0x2755], 0x2757,
    [0x2795, 0x2797], 0x27b0, 0x27bf, [0x2b1b, 0x2b1c], 0x2b50, 0x2b55,
    0x1f004, 0x1f0cf, 0x1f18e, [0x1f191, 0x1f19a], [0x1f1e6, 0x1f1ff],
    0x1f201, 0x1f21a, 0x1f22f, [0x1f232, 0x1f236], [0x1f238, 0x1f23a],
    [0x1f250, 0x1f251], [0x1f300, 0x1f320], [0x1f32d, 0x1f335],
    [0x1f337, 0x1f37c], [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca],
    [0x1f3cf, 0x1f3d3], [0x1f3e0, 0x1f3f0], 0x1f3f4, [0x1f3f8, 0x1f43e],
    0x1f440, [0x1f442, 0x1f4fc], [0x1f4ff, 0x1f53d], [0x1f54b, 0x1f54e],
    [0x1f550, 0x1f567], 0x1f57a, [0x1f595, 0x1f596], 0x1f5a4,
    [0x1f5fb, 0x1f64f], [0x1f680, 0x1f6c5], 0x1f6cc, [0x1f6d0, 0x1f6d2],
    [0x1f6d5, 0x1f6d8], [0x1f6dc, 0x1f6df], [0x1f6eb, 0x1f6ec],
    [0x1f6f4, 0x1f6fc], [0x1f7e0, 0x1f7eb], 0x1f7f0, [0x1f90c, 0x1f93a],
    [0x1f93c, 0x1f945], [0x1f947, 0x1f9ff], [0x1fa70, 0x1fa7c],
    [0x1fa80, 0x1fa8a], [0x1fa8e, 0x1fac6], 0x1fac8, [0x1facd, 0x1fadc],
    [0x1fadf, 0x1faea], [0x1faef, 0x1faf8],
];
/** Binary search over the merged, sorted Emoji_Presentation ranges. */
function hasEmojiPresentation(cp) {
    let lo = 0;
    let hi = EMOJI_PRESENTATION_RANGES.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const entry = EMOJI_PRESENTATION_RANGES[mid];
        const start = typeof entry === 'number' ? entry : entry[0];
        const end = typeof entry === 'number' ? entry : entry[1];
        if (cp < start)
            hi = mid - 1;
        else if (cp > end)
            lo = mid + 1;
        else
            return true;
    }
    return false;
}
function isZeroWidth(codePoint) {
    // Fast path for common printable range
    if (codePoint >= 0x20 && codePoint < 0x7f)
        return false;
    if (codePoint >= 0xa0 && codePoint < 0x0300)
        return codePoint === 0x00ad;
    // Control characters
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
        return true;
    // Zero-width and invisible characters
    if ((codePoint >= 0x200b && codePoint <= 0x200d) || // ZW space/joiner
        codePoint === 0xfeff || // BOM
        (codePoint >= 0x2060 && codePoint <= 0x2064) // Word joiner etc.
    ) {
        return true;
    }
    // Variation selectors
    if ((codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
        (codePoint >= 0xe0100 && codePoint <= 0xe01ef)) {
        return true;
    }
    // Combining diacritical marks
    if ((codePoint >= 0x0300 && codePoint <= 0x036f) ||
        (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
        (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
        (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
        (codePoint >= 0xfe20 && codePoint <= 0xfe2f)) {
        return true;
    }
    // Indic script combining marks (covers Devanagari through Malayalam)
    if (codePoint >= 0x0900 && codePoint <= 0x0d4f) {
        // Signs and vowel marks at start of each script block
        const offset = codePoint & 0x7f;
        if (offset <= 0x03)
            return true; // Signs at block start
        if (offset >= 0x3a && offset <= 0x4f)
            return true; // Vowel signs, virama
        if (offset >= 0x51 && offset <= 0x57)
            return true; // Stress signs
        if (offset >= 0x62 && offset <= 0x63)
            return true; // Vowel signs
    }
    // Thai/Lao combining marks
    // Note: U+0E32 (SARA AA), U+0E33 (SARA AM), U+0EB2, U+0EB3 are spacing vowels (width 1), not combining marks
    if (codePoint === 0x0e31 || // Thai MAI HAN-AKAT
        (codePoint >= 0x0e34 && codePoint <= 0x0e3a) || // Thai vowel signs (skip U+0E32, U+0E33)
        (codePoint >= 0x0e47 && codePoint <= 0x0e4e) || // Thai vowel signs and marks
        codePoint === 0x0eb1 || // Lao MAI KAN
        (codePoint >= 0x0eb4 && codePoint <= 0x0ebc) || // Lao vowel signs (skip U+0EB2, U+0EB3)
        (codePoint >= 0x0ec8 && codePoint <= 0x0ecd) // Lao tone marks
    ) {
        return true;
    }
    // Arabic formatting
    if ((codePoint >= 0x0600 && codePoint <= 0x0605) ||
        codePoint === 0x06dd ||
        codePoint === 0x070f ||
        codePoint === 0x08e2) {
        return true;
    }
    // Surrogates, tag characters
    if (codePoint >= 0xd800 && codePoint <= 0xdfff)
        return true;
    if (codePoint >= 0xe0000 && codePoint <= 0xe007f)
        return true;
    return false;
}
// Note: complex-script graphemes like Devanagari क्ष (ka+virama+ZWJ+ssa) render
// as a single ligature glyph but occupy 2 terminal cells (wcwidth sums the base
// consonants). Bun.stringWidth=2 matches terminal cell allocation, which is what
// we need for cursor positioning — the JS fallback's grapheme-cluster width of 1
// would desync Ink's layout from the terminal.
//
// Bun.stringWidth is resolved once at module scope rather than checked on every
// call — typeof guards deopt property access and this is a hot path (~100k calls/frame).
const bunStringWidth = typeof Bun !== 'undefined' && typeof Bun.stringWidth === 'function'
    ? Bun.stringWidth
    : null;
const BUN_STRING_WIDTH_OPTS = { ambiguousIsNarrow: true };
/**
 * Get the display width of a string as it would appear in a terminal.
 *
 * Uses Bun.stringWidth when available; otherwise falls back to the JS
 * implementation above, which strips ANSI codes and handles emoji, wide
 * characters, and zero-width combining marks.
 * @param str - the string to measure.
 * @returns the number of terminal cells the string occupies.
 */
export const stringWidth = bunStringWidth
    ? str => bunStringWidth(str, BUN_STRING_WIDTH_OPTS)
    : stringWidthJavaScript;
