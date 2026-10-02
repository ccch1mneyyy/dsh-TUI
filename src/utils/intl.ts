let graphemeSegmenter: Intl.Segmenter | undefined

/**
 * Memoized `Intl.Segmenter` with grapheme granularity for width-aware string
 * handling in the renderer and terminal parser.
 * @returns The shared grapheme segmenter, created once on first use.
 */
export function getGraphemeSegmenter(): Intl.Segmenter {
  return (graphemeSegmenter ??= new Intl.Segmenter('en', { granularity: 'grapheme' }))
}

let wordSegmenter: Intl.Segmenter | undefined

/**
 * Memoized `Intl.Segmenter` with word granularity (UAX #29 + ICU dictionary)
 * for the prompt draft's word boundaries. Locale is fixed to `'en'`: it
 * matches `getGraphemeSegmenter`, and measured Han/kana results are identical
 * to `'zh'`/`'ja'` for the segmentation the draft needs.
 * @returns The shared word segmenter, created once on first use.
 */
export function getWordSegmenter(): Intl.Segmenter {
  return (wordSegmenter ??= new Intl.Segmenter('en', { granularity: 'word' }))
}
