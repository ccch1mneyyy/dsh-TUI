let graphemeSegmenter;
/**
 * Memoized `Intl.Segmenter` with grapheme granularity, used by the ported Ink
 * core for width-aware string handling (stringWidth, output, termio parser).
 */
export function getGraphemeSegmenter() {
    return (graphemeSegmenter ??= new Intl.Segmenter('en', { granularity: 'grapheme' }));
}
//# sourceMappingURL=intl.js.map