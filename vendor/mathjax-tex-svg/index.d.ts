/** One TeX-to-SVG converter; construct once and reuse. */
export interface TexToSvg {
  /**
   * Typeset `tex` (no delimiters). Throws on malformed or unknown TeX.
   * @returns the standalone `<svg>` markup (glyphs as paths, `currentColor`
   *   ink) and its size in ex; `verticalAlignEx` is the baseline offset.
   */
  convert(tex: string, display: boolean): {
    svg: string
    widthEx: number
    heightEx: number
    verticalAlignEx: number
  }
}

export function createTexToSvg(): TexToSvg
