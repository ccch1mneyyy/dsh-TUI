/**
 * Spinner animation utilities, ported from the leaked Claude Code source
 * (`src/components/Spinner/utils.ts`).
 */

export type RGBColor = { r: number; g: number; b: number }

/**
 * The platform-appropriate default spinner character set.
 * @returns The spinner frame characters for the current terminal/platform.
 */
export function getDefaultCharacters(): string[] {
  if (process.env.TERM === 'xterm-ghostty') {
    return ['·', '✢', '✳', '✶', '✻', '*']
  }
  return process.platform === 'darwin'
    ? ['·', '✢', '✳', '✶', '✻', '✽']
    : ['·', '✢', '*', '✶', '✻', '✽']
}

/**
 * Interpolate between two RGB colors.
 * @param color1 - Start color.
 * @param color2 - End color.
 * @param t - Interpolation factor, 0 to 1.
 * @returns The interpolated color, components rounded to integers.
 */
export function interpolateColor(
  color1: RGBColor,
  color2: RGBColor,
  t: number,
): RGBColor {
  return {
    r: Math.round(color1.r + (color2.r - color1.r) * t),
    g: Math.round(color1.g + (color2.g - color1.g) * t),
    b: Math.round(color1.b + (color2.b - color1.b) * t),
  }
}

/**
 * Convert an RGB object to an `rgb()` color string for the Text component.
 * @param color - The RGB color to format.
 * @returns The `rgb(r,g,b)` string.
 */
export function toRGBColor(color: RGBColor): string {
  return `rgb(${color.r},${color.g},${color.b})`
}

/**
 * Convert an HSL hue to RGB, using voice-mode waveform parameters (s=0.7, l=0.6).
 * @param hue - Hue in degrees (0–360; wrapped into range).
 * @returns The RGB color for the hue.
 */
export function hueToRgb(hue: number): RGBColor {
  const h = ((hue % 360) + 360) % 360
  const s = 0.7
  const l = 0.6
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) {
    r = c
    g = x
  } else if (h < 120) {
    r = x
    g = c
  } else if (h < 180) {
    g = c
    b = x
  } else if (h < 240) {
    g = x
    b = c
  } else if (h < 300) {
    r = x
    b = c
  } else {
    r = c
    b = x
  }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  }
}

const RGB_CACHE = new Map<string, RGBColor | null>()

/**
 * Parse an `rgb(r,g,b)` color string, memoized per input.
 * @param colorStr - The color string to parse.
 * @returns The parsed RGB color, or null when the string is not `rgb(r,g,b)`.
 */
export function parseRGB(colorStr: string): RGBColor | null {
  const cached = RGB_CACHE.get(colorStr)
  if (cached !== undefined) return cached

  const match = colorStr.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/)
  const result = match
    ? {
        r: parseInt(match[1]!, 10),
        g: parseInt(match[2]!, 10),
        b: parseInt(match[3]!, 10),
      }
    : null
  RGB_CACHE.set(colorStr, result)
  return result
}
