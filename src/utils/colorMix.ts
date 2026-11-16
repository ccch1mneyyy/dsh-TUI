/**
 * Blend theme colours for derived surfaces. Built-in palettes use the
 * `rgb(r,g,b)` strings `rgb()` produces; user themes may use hex. ANSI-named
 * colours (`ansi:blackBright`) cannot be mixed and come back unchanged so the
 * caller keeps the palette's own surface instead of inventing one.
 */

const RGB = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/u
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/iu

function parse(color: string): readonly [number, number, number] | undefined {
  const rgb = RGB.exec(color)
  if (rgb !== null) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  const hex = HEX.exec(color)
  if (hex === null) return undefined
  const digits = hex[1]!
  if (digits.length === 3) {
    const expand = (digit: string): number => Number.parseInt(digit + digit, 16)
    return [expand(digits[0]!), expand(digits[1]!), expand(digits[2]!)]
  }
  // The theme contract accepts #rrggbbaa with the alpha ignored.
  const value = Number.parseInt(digits.slice(0, 6), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

const channel = (value: number): number => Math.max(0, Math.min(255, Math.round(value)))

/**
 * Blend `overlay` into `base` by `amount` (0–1); a colour the parser does not
 * understand wins as-is.
 * @param base - Palette colour the surface starts from.
 * @param overlay - Tint colour.
 * @param amount - Tint strength, clamped to 0–1.
 */
export function mixColor(base: string, overlay: string, amount: number): string {
  const from = parse(base)
  const to = parse(overlay)
  if (from === undefined || to === undefined) return base
  const alpha = Math.max(0, Math.min(1, amount))
  return `rgb(${channel(from[0] * (1 - alpha) + to[0] * alpha)},`
    + `${channel(from[1] * (1 - alpha) + to[1] * alpha)},`
    + `${channel(from[2] * (1 - alpha) + to[2] * alpha)})`
}

/** Nudge a colour toward white, preserving its hue (hover faces). */
export function lightenColor(color: string, amount: number): string {
  return mixColor(color, 'rgb(255,255,255)', amount)
}

/** sRGB luma (Rec. 601), or undefined when the colour cannot be parsed. */
export function colorLuma(color: string): number | undefined {
  const rgb = parse(color)
  return rgb === undefined ? undefined : 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]
}
