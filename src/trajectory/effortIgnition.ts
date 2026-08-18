/**
 * Effort ignition — 切到最高思考强度档时的一次性点焰波形（数学层）。
 *
 * 只做纯函数计算：波形采样、缓动、逐列混色。组件每帧调用
 * {@link ignitionLineColors} 取得整行背景色。移植自 Codex CLI 的
 * effort_ignition(_styles).rs（openai/codex PR #34365），波形语义保留：
 * Wave 是余弦钟形行波自左向右扫过；Aurora 是多条正弦游走带同色相权重
 * 相加；Pulse 是三次缓动的扩散圆环。三者都只产生颜色——SGR-only 规则
 * （见 motion.ts）因此天然成立：glyph 恒为空格、行数恒为一，帧间变化
 * 全部走背景色 SGR。
 *
 * 档位语义：dsh 的思考强度是 adapter 拥有的动态档位表，没有 Codex 的
 * Max/Ultra 双档常量——这里只保留一套「最高档」色板（暖橙，深/浅背景
 * 两个变体），第二档色板留待真有双顶级档位时再引入。
 */
import type { Color } from '../ink/styles.js'
import type { RGBColor } from '../components/Spinner/spinnerUtils.js'
import { rgbString } from './motion.js'

/** 点焰风格：每次触发随机选一，且不与上一次重复。 */
export type IgnitionStyle = 'wave' | 'aurora' | 'pulse'

export const IGNITION_STYLES: readonly IgnitionStyle[] = ['wave', 'aurora', 'pulse']

/** 帧时长（ms），仅用于把墙钟时间折算成动画秒数，不创建任何定时器。 */
export const IGNITION_TOTAL_MS: Record<IgnitionStyle, number> = {
  wave: 1000,
  aurora: 1300,
  pulse: 900,
}

/**
 * 波形参数（对齐 Codex 的 bands 表）：
 * wave/pulse 为 `[launch, travel, strength]`；aurora 为
 * `[speed, phase, hueIndex]`。aurora 用两条带（第三条是 Ultra 双波专属，
 * 单档语义下不启用）。
 */
const BANDS: Record<IgnitionStyle, ReadonlyArray<readonly [number, number, number]>> = {
  wave: [[0.1, 0.75, 1]],
  aurora: [
    [0.35, 0.15, 0],
    [-0.5, 0.6, 1],
  ],
  pulse: [[0.1, 0.6, 1]],
}

/** 波形宽度参数（列）。 */
const WAVE_HALF_WIDTH = 9
const PULSE_HALF_WIDTH = 4.5

/**
 * 最高档色板：三 hue 按列权重混合。深色背景用亮暖橙系，浅色背景换深
 * 暖橙系（对齐 Codex Max 档的两个变体——浅底上亮橙没有对比度）。
 */
export function ignitionHues(onLight: boolean): readonly [RGBColor, RGBColor, RGBColor] {
  return onLight
    ? [
        { r: 176, g: 98, b: 0 },
        { r: 150, g: 110, b: 0 },
        { r: 200, g: 70, b: 20 },
      ]
    : [
        { r: 255, g: 178, b: 66 },
        { r: 255, g: 214, b: 120 },
        { r: 255, g: 120, b: 60 },
      ]
}

/**
 * 带底色（波向状态行本底淡入的目标色）。近似值：取主题深/浅背景的典
 * 型值而非逐主题读取——波只存活一秒，色差在低 alpha 下不可辨。
 */
const BAND_RGB_DARK: RGBColor = { r: 27, g: 30, b: 40 }
const BAND_RGB_LIGHT: RGBColor = { r: 240, g: 240, b: 242 }

/** 余弦钟形：`crest(0)=1`、`crest(1)=0`、之外为 0。 */
export function crest(distance: number): number {
  if (distance >= 1) return 0
  return 0.5 * (1 + Math.cos(Math.PI * distance))
}

/** ease-in cubic：`p³`，两端 clamp。 */
export function easeInCubic(progress: number): number {
  const p = Math.min(1, Math.max(0, progress))
  return p * p * p
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

/**
 * 一次性包络：`[0, total]` 外为 0，进入段按 `fadeIn` 线性升起、离开段
 * 按 `fadeOut` 线性落下，取两者较小值。
 */
export function envelope(elapsed: number, total: number, fadeIn: number, fadeOut: number): number {
  if (elapsed <= 0 || elapsed >= total) return 0
  const inPart = elapsed / Math.max(fadeIn, Number.EPSILON)
  const outPart = (total - elapsed) / Math.max(fadeOut, Number.EPSILON)
  return Math.min(1, Math.max(0, inPart, outPart))
}

/** 单列对全部波带的采样结果：三 hue 各自的权重（未归一）。 */
function sampleColumn(
  style: IgnitionStyle,
  elapsed: number,
  column: number,
  width: number,
): [number, number, number] {
  const weights: [number, number, number] = [0, 0, 0]
  for (const band of BANDS[style]) {
    const [first, second, third] = band
    if (style === 'wave') {
      const progress = (elapsed - first) / second
      if (progress < 0 || progress > 1) continue
      const center = easeInOutCubic(progress) * (width + 2 * WAVE_HALF_WIDTH) - WAVE_HALF_WIDTH
      weights[0] = Math.max(weights[0], crest(Math.abs(column - center) / WAVE_HALF_WIDTH))
    } else if (style === 'aurora') {
      const center =
        (0.5 + 0.38 * Math.sin(Math.PI * 2 * (first * elapsed + second))) * width
      const halfWidth = Math.max(width * 0.22, 4)
      weights[third] += crest(Math.abs(column - center) / halfWidth)
    } else {
      const progress = (elapsed - first) / second
      if (progress < 0 || progress > 1) continue
      const inverse = 1 - progress
      const radius = (1 - inverse * inverse * inverse) * (width / 2 + 2 * PULSE_HALF_WIDTH)
      const distance = Math.abs(column - width / 2)
      weights[0] = Math.max(
        weights[0],
        crest(Math.abs(distance - radius) / PULSE_HALF_WIDTH) * third * (1 - 0.6 * progress),
      )
    }
  }
  return weights
}

/**
 * 混两个 RGB（线性插值）。
 * @param t - 位置，`0` 返回 `a`、`1` 返回 `b`，不 clamp（调用方负责）。
 */
function blend(a: RGBColor, b: RGBColor, t: number): RGBColor {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  }
}

/**
 * 点焰某一时刻的整行背景色。
 *
 * @param options - 波形参数。
 * @param options.style - 点焰风格。
 * @param options.elapsedMs - 距触发的时间；达到 {@link IGNITION_TOTAL_MS}
 *   后整行返回 `undefined`（无波，行恢复本底）。
 * @param options.width - 行列数（终端宽）。
 * @param options.onLight - 浅色主题时用浅底色板与浅带底色。
 * @returns 逐列背景色（`rgb(r,g,b)` 字符串）；无波的列为 `undefined`，
 *   渲染层应输出不设背景的空格，保持行宽恒定。
 */
export function ignitionLineColors(options: {
  style: IgnitionStyle
  elapsedMs: number
  width: number
  onLight: boolean
}): ReadonlyArray<Color | undefined> {
  const { style, elapsedMs, width, onLight } = options
  const total = IGNITION_TOTAL_MS[style] / 1000
  const elapsed = elapsedMs / 1000
  if (width <= 0 || elapsed <= 0 || elapsed >= total) return []
  const hues = ignitionHues(onLight)
  const bandRgb = onLight ? BAND_RGB_LIGHT : BAND_RGB_DARK
  const fade =
    style === 'aurora' ? envelope(elapsed, total, /* fadeIn */ 0.25, /* fadeOut */ 0.4) : 1
  const colors: Array<Color | undefined> = new Array(width)
  for (let column = 0; column < width; column++) {
    const weights = sampleColumn(style, elapsed, column, width)
    const weight = weights[0] + weights[1] + weights[2]
    if (weight <= 0.01) {
      colors[column] = undefined
      continue
    }
    let r = 0
    let g = 0
    let b = 0
    for (let hue = 0; hue < 3; hue++) {
      r += weights[hue]! * hues[hue]!.r
      g += weights[hue]! * hues[hue]!.g
      b += weights[hue]! * hues[hue]!.b
    }
    const hue: RGBColor = { r: r / weight, g: g / weight, b: b / weight }
    const alpha =
      style === 'aurora' ? Math.min(weight * 0.4, 0.5) * fade : weight * 0.55
    // 波按强度淡入带底色：alpha=1 是纯 hue，alpha→0 收敛回本底。上限
    // 0.6（同 Codex）——满强度也留一点底色，不刺眼。
    const tinted = blend(bandRgb, hue, Math.min(alpha, 0.6))
    colors[column] = rgbString(tinted)
  }
  return colors
}

/**
 * 随机选一种风格，且不与上一次重复（连续两次切档不重样）。
 * @param previous - 上一次的风格；首次触发传 `undefined`。
 */
export function randomIgnitionStyle(previous: IgnitionStyle | undefined): IgnitionStyle {
  const pool = IGNITION_STYLES.filter(style => style !== previous)
  return pool[Math.floor(Math.random() * pool.length)]!
}
