let graphemeSegmenter: Intl.Segmenter | undefined

/**
 * Memoized `Intl.Segmenter` with grapheme granularity for width-aware string
 * handling in the renderer and terminal parser.
 * @returns The shared grapheme segmenter, created once on first use.
 */
export function getGraphemeSegmenter(): Intl.Segmenter {
  return (graphemeSegmenter ??= new Intl.Segmenter('en', { granularity: 'grapheme' }))
}
