/**
 * 开屏大字字体表。每款字体 = 一张 5 行点阵表 + 自己的度量。
 *
 * `bold` 是基准款；`square` / `dot` / `bevel` / `wide` / `stencil` 由它**机械变换**
 * 而来（同一副骨架，只换笔画处理），所以改基准款会同步影响这几款——这是有意的：
 * 家族感来自共用骨架。`classic`（老的 5 列空心字）与 `slab`（PR #1058 的实心横笔
 * 设计，作者 zdjmrq）是独立设计，各自成表。
 *
 * 契约（`scripts/verify-splash-layout.ts` 逐款钉死）：
 * - 每款 5 行；每个字形、每个 fallback 行的显示宽度都等于 `glyphWidth`；
 * - 两行标题画出来的列数必须**相等**（靠 tagline 的字距 + `bottomIndent` 撑）；
 * - 缺字走 `fallback` 而不是抛错，且不改变字身宽度。
 */

import type { Rgb } from './bigfont.js'

/** 透明格用 `·` 表示。 */
export type GlyphRows = readonly string[]
/** 字形表：字符 → 5 行。 */
export type GlyphTable = Readonly<Record<string, GlyphRows>>

/** 一款开屏大字字体。 */
export interface SplashFont {
  /** 稳定 id（设置项 `dsh-tui.splashFont` 用）。 */
  readonly id: string
  /** 一句中文说明，给设置面板/预览用。 */
  readonly label: string
  /** 字身宽度（列）。 */
  readonly glyphWidth: number
  readonly glyphs: GlyphTable
  readonly fallback: GlyphRows
  /** 两行标题各自的画法与字距。 */
  readonly tagline: {
    readonly top: string
    readonly bottom: string
    readonly topKerning: number
    readonly bottomKerning: number
    /** 下排左缩进：字距撑不到等宽时用它把下排居中（能等宽时为 0）。 */
    readonly bottomIndent: number
  }
  /**
   * 可选：这款字体自己的起止配色（不给就用主题的 `accent → activity`）。
   * 半立体那款用它铺出左亮右暗的灰阶——字形本身已经是"亮面/暗面"两档字符，
   * 再叠一层颜色渐变，才有金属受光的感觉。
   */
  readonly palette?: { readonly from: Rgb; readonly to: Rgb }
}

/** 基准款：6 列、竖笔 2 格、横笔 1 像素（保留圆角）。 */
const BOLD_GLYPHS: GlyphTable = {
  D: ['██▀▀▄▄', '██··██', '██··██', '██··██', '██▄▄▀▀'],
  E: ['██▀▀▀▀', '██····', '██▀▀▀·', '██····', '██▄▄▄▄'],
  P: ['██▀▀▄▄', '██··██', '██▄▄▀▀', '██····', '██····'],
  S: ['██▀▀▀▀', '██····', '·▀▀▀▀▄', '····██', '██▄▄▄▀'],
  K: ['██··██', '██·██·', '███···', '██·██·', '██··██'],
  H: ['██··██', '██··██', '██▀▀██', '██··██', '██··██'],
  A: ['·▄▀▀▄·', '██··██', '██▀▀██', '██··██', '██··██'],
  R: ['██▀▀▄▄', '██··██', '██▄▄▀▀', '██·██·', '██··██'],
  N: ['██··██', '███·██', '██·███', '██··██', '██··██'],
}
const BOLD_FALLBACK: GlyphRows = ['▄▄▄▄▄▄', '██··██', '██··██', '██··██', '▀▀▀▀▀▀']

/** 老的 5 列空心字（0.11.x 之前的开屏款）。 */
const CLASSIC_GLYPHS: GlyphTable = {
  D: ['█▀▀▀▄', '█···█', '█···█', '█···█', '█▄▄▄▀'],
  E: ['█▀▀▀▀', '█····', '█▀▀▀·', '█····', '█▄▄▄▄'],
  P: ['█▀▀▀▄', '█···█', '█▄▄▄▀', '█····', '█····'],
  S: ['█▀▀▀▀', '█····', '·▀▀▀▄', '····█', '█▄▄▄▀'],
  K: ['█···█', '█·█··', '██···', '█·█··', '█···█'],
  H: ['█···█', '█···█', '█▀▀▀█', '█···█', '█···█'],
  A: ['·▄▀▄·', '█···█', '█▀▀▀█', '█···█', '█···█'],
  R: ['█▀▀▀▄', '█···█', '█▄▄▄▀', '█·█··', '█···█'],
  N: ['█···█', '██··█', '█·█·█', '█··██', '█···█'],
}
const CLASSIC_FALLBACK: GlyphRows = ['▄▄▄▄▄', '█···█', '█···█', '█···█', '▀▀▀▀▀']

/** PR #1058（作者 zdjmrq）的实心横笔设计：横笔满格、竖笔 1 格。 */
const SLAB_GLYPHS: GlyphTable = {
  D: ['████·', '█···█', '█···█', '█···█', '████·'],
  E: ['█████', '█····', '████·', '█····', '█████'],
  P: ['████·', '█···█', '████·', '█····', '█····'],
  S: ['·████', '█····', '·███·', '····█', '████·'],
  K: ['█···█', '█··█·', '███··', '█··█·', '█···█'],
  H: ['█···█', '█···█', '█████', '█···█', '█···█'],
  A: ['·███·', '█···█', '█████', '█···█', '█···█'],
  R: ['████·', '█···█', '████·', '█··█·', '█···█'],
  N: ['█···█', '██··█', '█·█·█', '█··██', '█···█'],
}
const SLAB_FALLBACK: GlyphRows = ['▄▄▄▄▄', '█···█', '█···█', '█···█', '▀▀▀▀▀']

// ── 由基准款派生的笔画处理 ────────────────────────────────────────────────
type RowTransform = (row: string, y: number, rows: GlyphRows) => string

const isInk = (cell: string): boolean => cell === '█' || cell === '▀' || cell === '▄'
const applyRows = (rows: GlyphRows, fn: RowTransform): GlyphRows => rows.map((row, y) => fn(row, y, rows))
const applyTable = (table: GlyphTable, fn: RowTransform): GlyphTable =>
  Object.fromEntries(Object.entries(table).map(([ch, rows]) => [ch, applyRows(rows, fn)]))

/** 方角实心：把圆角的 `▀`/`▄` 全部填成 `█`。 */
const SQUARE: RowTransform = row => [...row].map(cell => (cell === '▀' || cell === '▄' ? '█' : cell)).join('')
/** 点阵灰度：笔画压成 `▓`、圆角压成 `▒`，做出老式点阵屏的灰度。 */
const DOT: RowTransform = row => [...row].map(cell => (cell === '█' ? '▓' : cell === '▀' || cell === '▄' ? '▒' : cell)).join('')
/**
 * 半立体：笔画朝**上/左**的那面留亮（`█`），朝**下/右**的那面压暗（`▓`），
 * 整款再配一条左亮右暗的灰阶（`BEVEL_PALETTE`），读起来像一块被左上光打过的厚字
 * ——opencode 那款招牌字的路子。判据只看这一格的邻居：
 *
 * - 上下都空 → 一格高的横线：最底那一行当底边压暗，其余当亮面；
 * - 下方空 → 笔画底边，压暗；上方空 → 笔画顶边，留亮；
 * - 否则看左右：右缘压暗，左缘/内部留亮。
 *
 * 圆角 `▀`/`▄` 一并按实心处理——这款要的是方角厚块，不是圆角。
 */
const BEVEL: RowTransform = (row, y, rows) => {
  const solid = (source: string | undefined, x: number): boolean => isInk(source?.[x] ?? ' ')
  return [...row].map((cell, x) => {
    if (!isInk(cell)) return cell
    const up = solid(rows[y - 1], x)
    const down = solid(rows[y + 1], x)
    if (!up && !down) return y === rows.length - 1 ? '▓' : '█'
    if (!down) return '▓'
    if (!up) return '█'
    const left = solid(row, x - 1)
    const right = solid(row, x + 1)
    return right || !left ? '█' : '▓'
  }).join('')
}
/** 宽体：6 列最近邻拉到 8 列（竖笔 3 格、字腔 2 格）。 */
const WIDE: RowTransform = row => {
  const cells = [...row]
  return Array.from({ length: 8 }, (_, x) => cells[Math.min(cells.length - 1, Math.floor(x * cells.length / 8))]).join('')
}
/**
 * 镂空模板：中段那一行只在竖笔上留 1 列桥，其余挖空。
 * 只挖竖笔，横笔不动——否则字母会断成两截，看着像坏了而不是像模板字。
 */
const STENCIL: RowTransform = (row, y, rows) => {
  if (y === 0 || y === rows.length - 1) return row
  const above = rows[y - 1] ?? ''
  const below = rows[y + 1] ?? ''
  const vertical = (x: number): boolean => isInk(above[x] ?? ' ') && isInk(below[x] ?? ' ')
  let bridge = false
  return [...row].map((cell, x) => {
    if (!isInk(cell) || !vertical(x)) {
      bridge = false
      return cell
    }
    if (!bridge) {
      bridge = true
      return cell
    }
    return ' '
  }).join('')
}

/**
 * 字距：让两行标题画出来的列数相等——上排 8 字、下排 7 字，解得
 * `glyphWidth = 7·bottomKerning - 8·topKerning`；撑不到整数解时用 `bottomIndent`
 * 把下排居中（`wide` 8 列就落在这一档）。
 * @param glyphWidth - 字身宽度（列）。
 * @returns 两排的字距与下排缩进。
 */
function taglineFor(glyphWidth: number): { topKerning: number; bottomKerning: number; bottomIndent: number } {
  for (let topKerning = 0; topKerning <= 4; topKerning++) {
    const bottomKerning = (glyphWidth + 8 * topKerning) / 7
    if (Number.isInteger(bottomKerning) && bottomKerning <= 4 && bottomKerning >= topKerning) {
      return { topKerning, bottomKerning, bottomIndent: 0 }
    }
  }
  const topKerning = 1
  const bottomKerning = 2
  const indent = 8 * (glyphWidth + topKerning) - 7 * (glyphWidth + bottomKerning)
  return { topKerning, bottomKerning, bottomIndent: Math.max(0, indent) }
}

const TOP_WORD = 'DEEPSEEK'
const BOTTOM_WORD = 'HARNESS'

const font = (id: string, label: string, glyphs: GlyphTable, fallback: GlyphRows): SplashFont => {
  const glyphWidth = [...(glyphs.D ?? fallback)[0] ?? ''].length
  return { id, label, glyphWidth, glyphs, fallback, tagline: { top: TOP_WORD, bottom: BOTTOM_WORD, ...taglineFor(glyphWidth) } }
}

/** 半立体的灰阶：左亮右暗——和字形的"亮面/暗面"共用同一套打光（光从左上来）。 */
const BEVEL_PALETTE = { from: { r: 214, g: 214, b: 214 }, to: { r: 104, g: 104, b: 104 } }

/**
 * 日常轮换池。顺序就是"按天轮换"的取模顺序；彩蛋词/彩蛋字体不进这里，
 * 它们只在各自日期覆盖（见 `pickSplashFont` 的调用方）。
 */
export const SPLASH_FONTS: readonly SplashFont[] = [
  font('bold', '加粗（默认）', BOLD_GLYPHS, BOLD_FALLBACK),
  font('square', '方角实心', applyTable(BOLD_GLYPHS, SQUARE), applyRows(BOLD_FALLBACK, SQUARE)),
  { ...font('bevel', '半立体', applyTable(BOLD_GLYPHS, BEVEL), applyRows(BOLD_FALLBACK, BEVEL)), palette: BEVEL_PALETTE },
  font('wide', '宽体', applyTable(BOLD_GLYPHS, WIDE), applyRows(BOLD_FALLBACK, WIDE)),
  font('dot', '点阵灰度', applyTable(BOLD_GLYPHS, DOT), applyRows(BOLD_FALLBACK, DOT)),
  font('stencil', '镂空模板', applyTable(BOLD_GLYPHS, STENCIL), applyRows(BOLD_FALLBACK, STENCIL)),
  font('classic', '细笔（经典）', CLASSIC_GLYPHS, CLASSIC_FALLBACK),
  font('slab', '方板（实心横笔）', SLAB_GLYPHS, SLAB_FALLBACK),
]

/** 找不到 id 时退回基准款（设置项写错不该让开屏挂掉）。 */
export const DEFAULT_SPLASH_FONT = SPLASH_FONTS[0] as SplashFont

/**
 * 按 id 取字体；未知 id 退回 `DEFAULT_SPLASH_FONT`。
 * @param id - 字体 id（设置项 `dsh-tui.splashFont` 的值）。
 * @returns 对应字体，未知时是基准款。
 */
export function splashFontById(id: string): SplashFont {
  return SPLASH_FONTS.find(candidate => candidate.id === id) ?? DEFAULT_SPLASH_FONT
}

/** 一天的天数（毫秒），用于把日期压成一个稳定序号。 */
const DAY_MS = 86_400_000

/**
 * 按**本地日期**轮换：同一天内恒定、隔天换一款，且与启动时刻无关（可复现）。
 * @param date - 注入的当前时间（测试缝；生产用 `new Date()`）。
 * @returns 当天的字体。
 */
export function pickSplashFont(date: Date = new Date()): SplashFont {
  const day = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS)
  const index = ((day % SPLASH_FONTS.length) + SPLASH_FONTS.length) % SPLASH_FONTS.length
  return SPLASH_FONTS[index] as SplashFont
}
