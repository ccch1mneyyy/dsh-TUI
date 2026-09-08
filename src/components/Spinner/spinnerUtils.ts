/**
 * Spinner 动画的通用工具集：固定单列宽的帧字符选择、RGB 颜色插值、
 * HSL 色相转 RGB，以及 `rgb(...)` 颜色字符串的解析与记忆化。
 * 这些纯函数被 Spinner 组件及若干加载/装饰元素复用。
 */

export type RGBColor = { r: number; g: number; b: number }

/**
 * A calm breathing dot: every frame is one display cell, including in
 * narrow CJK terminals, and no platform-specific glyph set is needed.
 */
const DEFAULT_FRAME_SET = ['·', '•', '●', '•']

/**
 * 返回 spinner 帧字符序列。
 * 每次调用都返回独立数组，调用方可以安全持有或改动，互不影响。
 */
export function getDefaultCharacters(): string[] {
  return [...DEFAULT_FRAME_SET]
}

/**
 * 在两种颜色之间按系数 t 线性插值（t ∈ [0, 1]），
 * 各分量四舍五入到整数后返回。
 */
export function interpolateColor(
  color1: RGBColor,
  color2: RGBColor,
  t: number,
): RGBColor {
  const blend = (from: number, to: number): number =>
    Math.round(from + (to - from) * t)
  return {
    r: blend(color1.r, color2.r),
    g: blend(color1.g, color2.g),
    b: blend(color1.b, color2.b),
  }
}

/**
 * 把 RGB 对象格式化为 `rgb(r,g,b)` 字符串，供 Ink 的 Text 组件使用。
 */
export function toRGBColor(
  color: RGBColor,
): `rgb(${number},${number},${number})` {
  return `rgb(${color.r},${color.g},${color.b})`
}

/**
 * 计算色相在六个扇区中的基准 RGB 分量（未加亮度偏移）。
 * 扇区按 60° 划分：红→黄→绿→青→蓝→品红→红。
 */
function hueSector(
  hue: number,
  chroma: number,
  secondary: number,
): [number, number, number] {
  if (hue < 60) return [chroma, secondary, 0]
  if (hue < 120) return [secondary, chroma, 0]
  if (hue < 180) return [0, chroma, secondary]
  if (hue < 240) return [0, secondary, chroma]
  if (hue < 300) return [secondary, 0, chroma]
  return [chroma, 0, secondary]
}

/**
 * 把色相角（单位：度）转换为 RGB 颜色。
 * 采用固定饱和度 0.7、亮度 0.6 的 HSL 参数（波形动画的配色基准）；
 * 色相先归一化到 [0, 360)，任意角度（含负数、超一圈）都能安全转换。
 */
export function hueToRgb(hue: number): RGBColor {
  const wrapped = ((hue % 360) + 360) % 360
  const saturation = 0.7
  const lightness = 0.6
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const secondary = chroma * (1 - Math.abs(((wrapped / 60) % 2) - 1))
  const luminanceOffset = lightness - chroma / 2
  const [r, g, b] = hueSector(wrapped, chroma, secondary)
  return {
    r: Math.round((r + luminanceOffset) * 255),
    g: Math.round((g + luminanceOffset) * 255),
    b: Math.round((b + luminanceOffset) * 255),
  }
}

/** 匹配 `rgb(r,g,b)` 文本，分量允许任意空格。 */
const RGB_STRING_PATTERN = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/

/** 按输入字符串记忆化解析结果，重复调用不再做正则匹配。 */
const rgbParseCache = new Map<string, RGBColor | null>()

/**
 * 解析 `rgb(r,g,b)` 颜色字符串；格式不合法时返回 null。
 * 同一输入的解析结果会被缓存（含 null），之后取用零成本。
 */
export function parseRGB(colorStr: string): RGBColor | null {
  const remembered = rgbParseCache.get(colorStr)
  if (remembered !== undefined) return remembered

  const parts = colorStr.match(RGB_STRING_PATTERN)
  const parsed = parts
    ? {
        r: parseInt(parts[1]!, 10),
        g: parseInt(parts[2]!, 10),
        b: parseInt(parts[3]!, 10),
      }
    : null
  rgbParseCache.set(colorStr, parsed)
  return parsed
}
