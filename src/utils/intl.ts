let graphemeSegmenter: Intl.Segmenter | undefined

/**
 * Memoized `Intl.Segmenter` with grapheme granularity, used by the ported Ink
 * core for width-aware string handling (stringWidth, output, termio parser).
 * @returns The shared grapheme segmenter, created once on first use.
 */
export function getGraphemeSegmenter(): Intl.Segmenter {
  return (graphemeSegmenter ??= new Intl.Segmenter('en', { granularity: 'grapheme' }))
}
