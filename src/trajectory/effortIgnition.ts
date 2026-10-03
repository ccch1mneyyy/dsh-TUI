/** 三幕时间轴（ms）：扫光全长、字样启动（波至中段）、字样渐亮、渐隐起止。边框扫光与输入行字样徽标共用。 */
export const IGNITION_TIMELINE = {
  sweepMs: 1000,
  labelStartMs: 600,
  labelBrightenMs: 160,
  fadeStartMs: 1500,
  fadeEndMs: 2000,
} as const

/**
 * Effort ignition motion math — the keepers of the waveform (crest, easings,
 * sampling, blending) are pure and dependency-free; only {@link ignitionColors}
 * touches the palette, turning the `ignition` / `ignitionDim` theme keys into
 * the RGB pair the math consumes.
 *
 * Waveform semantics ported from Codex CLI's effort_ignition(_styles).rs
 * (openai/codex PR #34365) and revalidated in a dsh-TUI integration: a
 * cosine-bell travelling wave produces per-column colours only — a renderer
 * that keeps glyphs constant and changes colours per frame stays SGR-only
 * by construction.
 *
 * Consumers ride the FOREGROUND channel (a constant block glyph under a
 * varying fg colour): pure-background cells never reached the terminal in
 * the fullscreen log-update pipeline, while foreground is the channel every
 * live element already rides.
 */
import { parseRGB, type RGBColor } from '../components/Spinner/spinnerUtils.js'
import { getTheme, isLightThemeActive, type ThemeName } from '../theme.js'
import { rgbString } from './motion.js'

/** 扫光全长（ms），仅用于把墙钟时间折算成动画秒数，不创建任何定时器。 */
export const SWEEP_TOTAL_MS = 1000

/** 波形宽度参数（列）。 */
const WAVE_HALF_WIDTH = 14

/** 波形参数：`[launch, travel]`（秒）——扫光在何时启动、多久行至右缘。 */
const BAND: readonly [number, number] = [0.1, 0.75]

/** The ignition colour pair the wave, `❯` prefix and tier badge share. */
export type IgnitionColors = {
  /** Crest colour: the wave at full strength. */
  ignition: RGBColor
  /** Resting end the wave fades into (formerly the hardcoded band colour). */
  ignitionDim: RGBColor
}

/**
 * Pre-theme pair, kept as the fallback for palettes that predate the keys
 * (community themes): bright blue over the terminal's own substrate, with a
 * deepened variant for light backgrounds — bright hues have no contrast there.
 */
const FALLBACK_DARK: IgnitionColors = {
  ignition: { r: 130, g: 185, b: 255 },
  ignitionDim: { r: 27, g: 30, b: 40 },
}
const FALLBACK_LIGHT: IgnitionColors = {
  ignition: { r: 30, g: 95, b: 235 },
  ignitionDim: { r: 240, g: 240, b: 242 },
}

/** 匹配 `#rgb` / `#rrggbb` / `#rrggbbaa`（`customTheme` 的 `HEX_RE` 接受的全部 hex 形式）。 */
const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

/**
 * Resolve a theme colour to RGB for the gradient math. Only the forms that
 * carry fixed channels resolve (`rgb()`, hex); `ansi:*` / `ansi256()` depend
 * on the terminal's palette, so they take the caller's fallback — the wave
 * emits per-column truecolor SGR either way.
 *
 * The 8-digit hex form is accepted because the theme-file validator accepts it
 * (`customTheme.ts`'s `HEX_RE`); the alpha byte is dropped rather than falling
 * back silently — the wave blends per column and has no channel for it.
 */
function parseThemeColor(color: string | undefined): RGBColor | null {
  if (color === undefined) return null
  const parsed = parseRGB(color)
  if (parsed !== null) return parsed
  const match = HEX_COLOR.exec(color)
  if (match === null) return null
  const digits = match[1]!
  const opaque = digits.length === 8 ? digits.slice(0, 6) : digits
  const expanded = opaque.length === 3 ? opaque.replace(/./g, digit => digit + digit) : opaque
  const value = Number.parseInt(expanded, 16)
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff }
}

/**
 * The active palette's ignition pair. A palette without the keys keeps the
 * pre-theme pair for its background lightness, so light/dark still differ.
 * @param themeName - Theme to resolve (built-in, `auto`, or user theme name).
 */
export function ignitionColors(themeName: ThemeName): IgnitionColors {
  const theme = getTheme(themeName)
  const fallback = isLightThemeActive(themeName) ? FALLBACK_LIGHT : FALLBACK_DARK
  return {
    ignition: parseThemeColor(theme.ignition) ?? fallback.ignition,
    ignitionDim: parseThemeColor(theme.ignitionDim) ?? fallback.ignitionDim,
  }
}

/**
 * 充能色对（前缀强调用）：从带底色调暗端到全值，与波共用 ignition。
 */
export function accentRamp(colors: IgnitionColors): { dim: RGBColor; full: RGBColor } {
  return { dim: blend(colors.ignitionDim, colors.ignition, 0.45), full: colors.ignition }
}

/** 余弦钟形：`crest(0)=1`、`crest(±1)=0`、之外为 0（负距离同样静默——
 * 现有调用方都传 `Math.abs`，这里兜底防未来调用方拿到全强度）。 */
export function crest(distance: number): number {
  if (distance >= 1 || distance <= -1) return 0
  return 0.5 * (1 + Math.cos(Math.PI * distance))
}

/** ease-out cubic：`1-(1-p)³`，两端 clamp。 */
export function easeOutCubic(progress: number): number {
  const p = Math.min(1, Math.max(0, progress))
  const inverse = 1 - p
  return 1 - inverse * inverse * inverse
}

/** ease-in-out cubic：前半 `4p³`、后半镜像，两端 clamp。 */
export function easeInOutCubic(progress: number): number {
  const p = Math.min(1, Math.max(0, progress))
  if (p < 0.5) return 4 * p * p * p
  const inverse = -2 * p + 2
  return 1 - (inverse * inverse * inverse) / 2
}

/** 单列对波带的采样：三 hue 权重（未归一；单波形只点亮 hue[0]）。 */
function sampleColumn(elapsed: number, column: number, width: number): [number, number, number] {
  const weights: [number, number, number] = [0, 0, 0]
  const [launch, travel] = BAND
  const progress = (elapsed - launch) / travel
  if (progress < 0 || progress > 1) return weights
  const center = easeInOutCubic(progress) * (width + 2 * WAVE_HALF_WIDTH) - WAVE_HALF_WIDTH
  weights[0] = crest(Math.abs(column - center) / WAVE_HALF_WIDTH)
  return weights
}

/** 线性混色（t=0 → a，t=1 → b，不 clamp）。 */
export function blend(a: RGBColor, b: RGBColor, t: number): RGBColor {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  }
}

/**
 * 扫光某一时刻的整行颜色。
 *
 * @param options.elapsedMs - 距触发的时间；达到 {@link SWEEP_TOTAL_MS}
 *   后整行返回空数组（无波，行恢复本底）。
 * @param options.width - 行列数（终端宽）。
 * @param options.colors - 主题点火色对（{@link ignitionColors}）。
 * @returns 逐列颜色（`rgb(r,g,b)` 字符串）；无波的列为 `undefined`，
 *   渲染层应输出本底色，保持行宽恒定。
 */
export function ignitionLineColors(options: {
  elapsedMs: number
  width: number
  colors: IgnitionColors
}): ReadonlyArray<string | undefined> {
  const { elapsedMs, width, colors } = options
  const elapsed = elapsedMs / 1000
  const total = SWEEP_TOTAL_MS / 1000
  if (width <= 0 || !Number.isFinite(elapsed) || elapsed <= 0 || elapsed >= total) return []
  const hue = colors.ignition
  const band = colors.ignitionDim
  const line: Array<string | undefined> = new Array(width)
  for (let column = 0; column < width; column++) {
    const weight = sampleColumn(elapsed, column, width)[0]
    if (weight <= 0.01) {
      line[column] = undefined
      continue
    }
    // 波按强度淡入带底色：alpha=1 是纯 hue，alpha→0 收敛回本底；高亮
    // 度档满强度纯 hue 直出。输出前通道量化到 8 步长——渐变列因此能
    // 合并成长段（渲染层 RLE 段数降一个数量级），8/256 的色差在终端
    // cell 分辨率下不可辨。上限 255：主题可以给纯白/纯亮色，量化不得
    // 溢出成 256。
    const tinted = blend(band, hue, Math.min(weight, 1))
    line[column] = rgbString({
      r: quantize(tinted.r),
      g: quantize(tinted.g),
      b: quantize(tinted.b),
    })
  }
  return line
}

/** 通道量化到 8 步长，clamp 到 255（255 → 256 是非法 SGR 分量）。 */
function quantize(channel: number): number {
  return Math.min(255, Math.round(channel / 8) * 8)
}

/**
 * 顶档切入判定：从「已有档位」变为「另一档位」且新档位是档位表末位
 * 最高档。冷启动恢复偏好、单档表、档位表未知都不触发。
 */
export function entersTopTier(
  previous: string | undefined,
  current: string | undefined,
  levels: readonly string[] | undefined,
): boolean {
  return (
    current !== undefined &&
    previous !== undefined &&
    current !== previous &&
    levels !== undefined &&
    levels.length > 1 &&
    current === levels[levels.length - 1]
  )
}

/** 充能时长（ms）与充能进度（钳 [0,1]，负 elapsed 钳 0）。 */
export const CHARGE_MS = 150

export function chargeProgress(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs)) return 0
  return Math.min(1, Math.max(0, Math.max(0, elapsedMs) / CHARGE_MS))
}
