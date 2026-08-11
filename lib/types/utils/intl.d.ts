/**
 * Memoized `Intl.Segmenter` with grapheme granularity, used by the ported Ink
 * core for width-aware string handling (stringWidth, output, termio parser).
 * @returns The shared grapheme segmenter, created once on first use.
 */
export declare function getGraphemeSegmenter(): Intl.Segmenter;
//# sourceMappingURL=intl.d.ts.map