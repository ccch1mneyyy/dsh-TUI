import chalk from 'chalk'
import { stringWidth } from '../ink/stringWidth.js'
import { getGraphemeSegmenter } from '../utils/intl.js'
import { interpolateColor } from '../components/Spinner/spinnerUtils.js'

/**
 * Shared shimmer utilities: the blue-white color ladder of the header and a
 * moving-highlight text painter used by the header wordmark/tagline and the
 * working-activity status line.
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

/** Header blue-white ladder: brand → ice → pale → soft ice flash.
 *  FLASH stays visibly blue (never pure white) — the highlight reads as a
 *  mist-brightened crest, not a white strobe. */
export const BRAND: Rgb = { r: 77, g: 107, b: 254 }
/** Header ladder ice blue (`#93BEFF`). */
export const ICE: Rgb = { r: 147, g: 190, b: 255 }
/** Header ladder pale blue (`#D7E4FF`). */
export const PALE: Rgb = { r: 215, g: 228, b: 255 }
/** Soft ice flash blue (`#C6D8F8`); stays visibly blue, never pure white. */
export const FLASH: Rgb = { r: 198, g: 216, b: 248 }

/**
 * Claude 陶土橙阶（claude 品牌开屏用，branding.ts / theme.ts 双主题共用）：
 * 深底从正色 `#D77757` 起步、经亮橙、奔奶油橙收——三档对比拉满（用户反馈
 * "渐变要明显、要亮"，起点不再用暗端）；浅底（claude-paper）反向：深化橙
 * 起步、正色收（浅底上"亮"是加深）。
 */
export const EMBER: Rgb = { r: 215, g: 119, b: 87 } // #D77757 陶土橙（深底起点/正色）
export const EMBER_BRIGHT: Rgb = { r: 239, g: 169, b: 126 } // #EFA97E 亮橙（深底中档/浅底终点）
export const EMBER_PALE: Rgb = { r: 251, g: 214, b: 176 } // #FBD6B0 奶油橙（深底终点，够亮）
export const EMBER_LIGHT: Rgb = { r: 230, g: 138, b: 105 } // #E68A69 亮橙（浅底终点档）
export const EMBER_FLASH: Rgb = { r: 245, g: 201, b: 180 } // #F5C9B4 暖阳高光（深底）
export const EMBER_PAPER: Rgb = { r: 201, g: 100, b: 66 } // #C96442 深化橙（浅底起点）
export const EMBER_PAPER_FLASH: Rgb = { r: 184, g: 87, b: 56 } // #B85738 浅底高光

/**
 * Codex 薰衣草紫阶（codex 品牌开屏用，branding.ts / theme.ts 双主题共用）：
 * 与 claude 同构——深底从亮紫起步、经淡紫、奔近白的薰衣草收（三档对比拉
 * 满）；浅底（codex-paper）反向：深化紫起步、正色收（浅底上"亮"是加深）。
 */
export const LAVENDER: Rgb = { r: 166, g: 155, b: 232 } // #A69BE8 薰衣草紫（正色/浅底终点）
export const LAVENDER_BRIGHT: Rgb = { r: 197, g: 191, b: 238 } // #C5BFEE 亮紫（深底起点）
export const LAVENDER_SOFT: Rgb = { r: 217, g: 213, b: 243 } // #D9D5F3 淡紫（深底中档）
export const LAVENDER_PALE: Rgb = { r: 226, g: 222, b: 248 } // #E2DEF8 近白薰衣草（深底终点，够亮）
export const LAVENDER_LIGHT: Rgb = { r: 138, g: 126, b: 217 } // #8A7ED9 深亮紫（浅底中档）
export const LAVENDER_FLASH: Rgb = { r: 207, g: 199, b: 245 } // #CFC7F5 高光（深底）
export const LAVENDER_PAPER: Rgb = { r: 107, g: 92, b: 200 } // #6B5CC8 深化紫（浅底起点）
export const LAVENDER_PAPER_FLASH: Rgb = { r: 122, g: 106, b: 214 } // #7A6AD6 浅底高光

/**
 * Paint `word` with a 10-column highlight window sweeping across it. The
 * window advances one column per `stepMs` and the brightness pulse follows
 * the same cadence (period 2π·stepMs·... — one full sine per ~6 steps).
 * The shimmer cadence is configurable; callers pass 60 for the lively
 * sweep.
 * @param word - Text to paint.
 * @param time - Elapsed time in milliseconds; drives the sweep position and the brightness pulse.
 * @param base - Color for cells outside the highlight window.
 * @param highlight - Color mixed into the sweeping highlight window.
 * @param stepMs - Milliseconds per column of sweep advance (default 60).
 * @returns The ANSI bold-colored word with the moving highlight.
 */
export function sweep(word: string, time: number, base: Rgb, highlight: Rgb, stepMs = 60): string {
  const width = stringWidth(word)
  const cycle = width + 20
  const glimmerStart = (Math.floor(time / stepMs) % cycle) - 10
  let out = ''
  let col = 0
  for (const { segment } of getGraphemeSegmenter().segment(word)) {
    const segWidth = stringWidth(segment)
    const highlighted = col >= glimmerStart && col + segWidth <= glimmerStart + 10
    const opacity = highlighted ? (Math.sin(time / (stepMs * 2)) + 1) / 2 : 0
    const rgb = highlighted ? interpolateColor(base, highlight, opacity) : base
    out += chalk.rgb(rgb.r, rgb.g, rgb.b).bold(segment)
    col += segWidth
  }
  return out
}
