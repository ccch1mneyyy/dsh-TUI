/** 三幕时间轴（ms）：扫光全长、字样启动（波至中段）、字样渐亮、渐隐起止。边框扫光与输入行字样徽标共用。 */
export const IGNITION_TIMELINE = {
  sweepMs: 1000,
  labelStartMs: 600,
  labelBrightenMs: 160,
  fadeStartMs: 1500,
  fadeEndMs: 2000,
} as const

/**
 * Effort ignition motion math — pure functions, zero dependencies.
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
import type { RGBColor } from '../components/Spinner/spinnerUtils.js'
import { rgbString } from './motion.js'

/** 扫光全长（ms），仅用于把墙钟时间折算成动画秒数，不创建任何定时器。 */
export const SWEEP_TOTAL_MS = 1000

/** 波形宽度参数（列）。 */
const WAVE_HALF_WIDTH = 14

/** 波形参数：`[launch, travel]`（秒）——扫光在何时启动、多久行至右缘。 */
const BAND: readonly [number, number] = [0.1, 0.75]

/**
 * 高亮彩色色板：亮蓝/亮青/亮紫三 hue（浅色背景用加深变体——浅底上
 * 亮色没有对比度）。波只点亮 hues[0]，前两个 hue 留给未来的多带风格。
 */
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

/**
 * 带底色（波向终端本底淡入的目标色）。近似值：取主题深/浅背景的典
 * 型值而非逐主题读取——波只存活一秒，色差在低 alpha 下不可辨。
 */
const BAND_DARK: RGBColor = { r: 27, g: 30, b: 40 }
const BAND_LIGHT: RGBColor = { r: 240, g: 240, b: 242 }

export function ignitionHues(onLight: boolean): readonly [RGBColor, RGBColor, RGBColor] {
  return onLight ? HUES_LIGHT : HUES_DARK
}

/**
 * 充能色对（前缀强调用）：从带底色调暗端到全值，与波共用 hues[0]。
 */
export function accentRamp(onLight: boolean): { dim: RGBColor; full: RGBColor } {
  const band = onLight ? BAND_LIGHT : BAND_DARK
  return { dim: blend(band, ignitionHues(onLight)[0], 0.45), full: ignitionHues(onLight)[0] }
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
 * @param options.onLight - 浅色主题时用浅底色板与浅带底色。
 * @returns 逐列颜色（`rgb(r,g,b)` 字符串）；无波的列为 `undefined`，
 *   渲染层应输出本底色，保持行宽恒定。
 */
export function ignitionLineColors(options: {
  elapsedMs: number
  width: number
  onLight: boolean
}): ReadonlyArray<string | undefined> {
  const { elapsedMs, width, onLight } = options
  const elapsed = elapsedMs / 1000
  const total = SWEEP_TOTAL_MS / 1000
  if (width <= 0 || !Number.isFinite(elapsed) || elapsed <= 0 || elapsed >= total) return []
  const hue = ignitionHues(onLight)[0]
  const band = onLight ? BAND_LIGHT : BAND_DARK
  const colors: Array<string | undefined> = new Array(width)
  for (let column = 0; column < width; column++) {
    const weight = sampleColumn(elapsed, column, width)[0]
    if (weight <= 0.01) {
      colors[column] = undefined
      continue
    }
    // 波按强度淡入带底色：alpha=1 是纯 hue，alpha→0 收敛回本底；高亮
    // 度档满强度纯 hue 直出。输出前通道量化到 8 步长——渐变列因此能
    // 合并成长段（渲染层 RLE 段数降一个数量级），8/256 的色差在终端
    // cell 分辨率下不可辨。
    const tinted = blend(band, hue, Math.min(weight, 1))
    colors[column] = rgbString({
      r: Math.round(tinted.r / 8) * 8,
      g: Math.round(tinted.g / 8) * 8,
      b: Math.round(tinted.b / 8) * 8,
    })
  }
  return colors
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
