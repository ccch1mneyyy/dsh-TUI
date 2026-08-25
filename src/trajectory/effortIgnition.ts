/** Named effort tiers own distinct border-front motion. */
export type EffortIgnitionStyle = 'ltr' | 'inward' | 'outward'

/** One bounded prompt transition: the centered label exists for exactly 900ms. */
export const IGNITION_TIMELINE = {
  sweepMs: 900,
  labelStartMs: 0,
  labelBrightenMs: 160,
  labelDurationMs: 900,
  fadeStartMs: 650,
  fadeEndMs: 900,
} as const

/**
 * Effort ignition motion math — pure functions, zero dependencies.
 * Consumers keep glyphs constant and change foreground colours per frame, so
 * border animation remains SGR-only.
 */
import type { RGBColor } from '../components/Spinner/spinnerUtils.js'
import { rgbString } from './motion.js'

export const SWEEP_TOTAL_MS = IGNITION_TIMELINE.sweepMs
const WAVE_HALF_WIDTH = 14
const LAUNCH = 0.05
const TRAVEL = 0.78

const HUES_DARK: readonly [RGBColor, RGBColor, RGBColor] = [
  { r: 130, g: 185, b: 255 },
  { r: 140, g: 252, b: 248 },
  { r: 195, g: 172, b: 255 },
]
const HUES_LIGHT: readonly [RGBColor, RGBColor, RGBColor] = [
  { r: 30, g: 95, b: 235 },
  { r: 10, g: 160, b: 200 },
  { r: 120, g: 80, b: 235 },
]
const MAX_DARK: RGBColor = { r: 255, g: 189, b: 46 }
const MAX_LIGHT: RGBColor = { r: 180, g: 105, b: 0 }
const ULTRA_DARK: RGBColor = { r: 195, g: 172, b: 255 }
const ULTRA_LIGHT: RGBColor = { r: 120, g: 80, b: 235 }
const BAND_DARK: RGBColor = { r: 27, g: 30, b: 40 }
const BAND_LIGHT: RGBColor = { r: 240, g: 240, b: 242 }

export function effortIgnitionStyle(effort: string | undefined): EffortIgnitionStyle | undefined {
  switch (effort?.toLowerCase()) {
    case 'high':
    case 'xhigh':
      return 'ltr'
    case 'max':
      return 'inward'
    case 'ultra':
      return 'outward'
    default:
      return undefined
  }
}

export function ignitionHues(onLight: boolean): readonly [RGBColor, RGBColor, RGBColor] {
  return onLight ? HUES_LIGHT : HUES_DARK
}

export function effortIgnitionHue(effort: string | undefined, onLight: boolean): RGBColor {
  switch (effort?.toLowerCase()) {
    case 'xhigh':
      return ignitionHues(onLight)[1]
    case 'max':
      return onLight ? MAX_LIGHT : MAX_DARK
    case 'ultra':
      return onLight ? ULTRA_LIGHT : ULTRA_DARK
    default:
      return ignitionHues(onLight)[0]
  }
}

export function accentRamp(onLight: boolean, effort?: string): { dim: RGBColor; full: RGBColor } {
  const band = onLight ? BAND_LIGHT : BAND_DARK
  const full = effortIgnitionHue(effort, onLight)
  return { dim: blend(band, full, 0.45), full }
}

export function crest(distance: number): number {
  if (distance >= 1 || distance <= -1) return 0
  return 0.5 * (1 + Math.cos(Math.PI * distance))
}

export function easeOutCubic(progress: number): number {
  const p = Math.min(1, Math.max(0, progress))
  const inverse = 1 - p
  return 1 - inverse * inverse * inverse
}

export function easeInOutCubic(progress: number): number {
  const p = Math.min(1, Math.max(0, progress))
  if (p < 0.5) return 4 * p * p * p
  const inverse = -2 * p + 2
  return 1 - (inverse * inverse * inverse) / 2
}

function centers(elapsed: number, width: number, style: EffortIgnitionStyle): readonly number[] {
  const raw = (elapsed - LAUNCH) / TRAVEL
  if (raw < 0 || raw > 1) return []
  const progress = easeInOutCubic(raw)
  const left = -WAVE_HALF_WIDTH
  const right = width - 1 + WAVE_HALF_WIDTH
  const middle = (width - 1) / 2
  if (style === 'ltr') return [left + progress * (right - left)]
  if (style === 'inward') {
    return [left + progress * (middle - left), right - progress * (right - middle)]
  }
  return [middle - progress * (middle - left), middle + progress * (right - middle)]
}

function sampleColumn(elapsed: number, column: number, width: number, style: EffortIgnitionStyle): number {
  return Math.min(
    1,
    centers(elapsed, width, style).reduce(
      (weight, center) => Math.max(weight, crest(Math.abs(column - center) / WAVE_HALF_WIDTH)),
      0,
    ),
  )
}

export function blend(a: RGBColor, b: RGBColor, t: number): RGBColor {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  }
}

export function ignitionLineColors(options: {
  elapsedMs: number
  width: number
  onLight: boolean
  style?: EffortIgnitionStyle
  effort?: string
}): ReadonlyArray<string | undefined> {
  const elapsed = options.elapsedMs / 1000
  const total = SWEEP_TOTAL_MS / 1000
  if (options.width <= 0 || !Number.isFinite(elapsed) || elapsed <= 0 || elapsed >= total) return []
  const style = options.style ?? 'ltr'
  const hue = effortIgnitionHue(options.effort, options.onLight)
  const band = options.onLight ? BAND_LIGHT : BAND_DARK
  const colors: Array<string | undefined> = new Array(options.width)
  for (let column = 0; column < options.width; column++) {
    const weight = sampleColumn(elapsed, column, options.width, style)
    if (weight <= 0.01) {
      colors[column] = undefined
      continue
    }
    const tinted = blend(band, hue, weight)
    colors[column] = rgbString({
      r: Math.round(tinted.r / 8) * 8,
      g: Math.round(tinted.g / 8) * 8,
      b: Math.round(tinted.b / 8) * 8,
    })
  }
  return colors
}

/** A cold mount never enters; only a changed id with a named style does. */
export function entersTopTier(
  previous: string | undefined,
  current: string | undefined,
  _levels?: readonly string[],
): boolean {
  return previous !== undefined && current !== undefined && previous !== current && effortIgnitionStyle(current) !== undefined
}

export const CHARGE_MS = 150

export function chargeProgress(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs)) return 0
  return Math.min(1, Math.max(0, elapsedMs) / CHARGE_MS)
}
