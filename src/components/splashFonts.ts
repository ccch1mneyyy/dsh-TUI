/**
 * 开屏大字字体表。每款字体 = 一张 5 行点阵表 + 自己的度量。
 *
 * `bold` 是基准款；`square` / `dot` / `bevel` / `wide` / `stencil` 由它**机械变换**
 * 而来（同一副骨架，只换笔画处理），所以改基准款会同步影响这几款——这是有意的：
 * 家族感来自共用骨架。`classic`（老的 5 列空心字）与 `slab`（PR #1058 的实心横笔
 * 设计，作者 zdjmrq）是独立设计，各自成表。
 *
 * 契约（`scripts/verify-splash-layout.ts` / `verify-splash-eggs.tsx` 逐款钉死）：
 * - 每款 5 行；每个字形、每个 fallback 行的显示宽度都等于 `glyphWidth`；
 * - 两行标题画出来的列数必须**相等**（靠 tagline 的字距 + `bottomIndent` 撑）；
 * - 缺字走 `fallback` 而不是抛错，且不改变字身宽度。
 *
 * 选择：设置项 `dsh-tui.splashFont` 取 `daily`（默认，按本地日期轮换）或某款 id；
 * `normalizeSplashFont` 是唯一的归一化入口（非法值一律回落 `daily`）。面板选项
 * 由注册表直接推（含中英标签），所以加一款字体不需要第二份清单。
 *
 * 字形覆盖两层：正常词 `DEEPSEEK`/`HARNESS`，以及节日彩蛋词用到的 `I M Y W`
 * （`splashEggs.ts` 的日期表）。
 */
import type { SplashFontId, SplashFontSetting } from '../adapter/ports/channel-display.js'
import { bigTextWidth, paintedWidth } from './bigfont.js'

// 取值类型住在端口的显示偏好词汇表里（ports 目录不许 import 到目录外），这里
// 转出去：设置链（Config / channel / /settings 面板）只认这一个入口。
export type { SplashFontId, SplashFontSetting } from '../adapter/ports/channel-display.js'

import type { Rgb } from './bigfont.js'

/** 透明格用 `·` 表示。 */
export type GlyphRows = readonly string[]
/** 字形表：字符 → 5 行。 */
export type GlyphTable = Readonly<Record<string, GlyphRows>>

/** 一款开屏大字字体。 */
export interface SplashFont {
  /** 稳定 id（设置项 `dsh-tui.splashFont` 用；取值域见端口的 `SplashFontId`）。 */
  readonly id: SplashFontId
  /** 一句中文说明，给设置面板/预览用（面板的 zh 侧）。 */
  readonly label: string
  /** 同一句的英文（面板的 en 侧；`label` 只服务 zh）。 */
  readonly labelEn: string
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
  // 彩蛋字母（HAPPINESS / MERRY / NEW YEAR）：与 `N` 的斜笔同一套画法。
  I: ['▀▀██▀▀', '··██··', '··██··', '··██··', '▄▄██▄▄'],
  M: ['██··██', '██████', '██▀▀██', '██··██', '██··██'],
  Y: ['██··██', '██··██', '▀▀██▀▀', '··██··', '··██··'],
  W: ['██··██', '██··██', '██▄▄██', '██████', '██··██'],
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
  // 彩蛋字母：5 列 1 格笔画，与 `N` 同骨架。
  I: ['▀▀█▀▀', '··█··', '··█··', '··█··', '▄▄█▄▄'],
  M: ['█···█', '██·██', '█·█·█', '█···█', '█···█'],
  Y: ['█···█', '█···█', '·█·█·', '··█··', '··█··'],
  W: ['█···█', '█···█', '█·█·█', '██·██', '█···█'],
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
  // 彩蛋字母：方角实心（没有 `▀`/`▄` 半格）。
  I: ['█████', '··█··', '··█··', '··█··', '█████'],
  M: ['█···█', '██·██', '█·█·█', '█···█', '█···█'],
  Y: ['█···█', '█···█', '·█·█·', '··█··', '··█··'],
  W: ['█···█', '█···█', '█·█·█', '██·██', '█···█'],
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

/** 一对词的字距解。 */
interface TaglineKernings {
  topKerning: number
  bottomKerning: number
  bottomIndent: number
}

/**
 * 字距上限。当前词表最大用到 7（8 列字身 × `MERRY`），再大字形之间就空得能走人；
 * 撞到上限还解不出来时走下面的兜底分支，而不是把字距一直放大。
 */
const MAX_KERNING = 8

/**
 * 解一对词的标题字距：让两行**画出来的列数相等**，且下排墨迹在上排墨迹下居中
 * （左右留白差 ≤ 1 列）。词长不再写死——旧的 `taglineFor` 把「上排 8 字、下排
 * 7 字」代进方程解，彩蛋词长度不同（9 / 5 / 7 字）就解不动了。
 *
 * 契约（`painted` 含末尾字距留白，`ink` 不含）：
 *   painted(top, tk) = painted(bottom, bk) + indent        （indent ≥ 0，两行等宽）
 *   |ink(top, tk) − ink(bottom, bk) − 2·indent| ≤ 1        （下排墨迹居中）
 * 相减即 `|indent − (bk − tk)| ≤ 1`——所以缩进不是自由变量，字距才是。
 *
 * 选解顺序：先要求两行相邻字形之间都至少留 1 列（字身相接会糊成一片），再按
 * `tk + bk` 从小到大取第一个满足契约的解——字距最紧、画面最不松散。个别
 * (字身宽, 词长) 组合（如 8 列的 `wide` × 9 字的 `HAPPINESS`）只解得出下排零字距，
 * 那时才退到允许 0：契约（等宽 + 居中）优先于美观。
 * @param glyphWidth - 字身宽度（列）。
 * @param top - 上排词。
 * @param bottom - 下排词（可含空格，空格宽度由 `paintedWidth` 算）。
 * @returns 两排字距与下排缩进。
 */
function solveTagline(glyphWidth: number, top: string, bottom: string): TaglineKernings {
  const metrics = { glyphWidth }
  // 兜底：契约在字距上限内无解时，宁可居中差一点，也不让开屏抛错（当前词表不可达）。
  let closest: (TaglineKernings & { error: number }) | null = null
  for (const minKerning of [1, 0]) {
    for (let sum = minKerning * 2; sum <= MAX_KERNING * 2; sum++) {
      for (let topKerning = minKerning; topKerning <= Math.min(sum - minKerning, MAX_KERNING); topKerning++) {
        const bottomKerning = sum - topKerning
        const bottomIndent = paintedWidth(metrics, top, topKerning) - paintedWidth(metrics, bottom, bottomKerning)
        if (bottomIndent < 0) continue
        const error = Math.abs(
          bigTextWidth(metrics, top, topKerning) - bigTextWidth(metrics, bottom, bottomKerning) - 2 * bottomIndent,
        )
        if (error <= 1) return { topKerning, bottomKerning, bottomIndent }
        if (closest === null || error < closest.error) closest = { topKerning, bottomKerning, bottomIndent, error }
      }
    }
  }
  return closest ?? { topKerning: 1, bottomKerning: 1, bottomIndent: 0 }
}

const TOP_WORD = 'DEEPSEEK'
const BOTTOM_WORD = 'HARNESS'

/** 一款字体的非几何数据：中英标签 + 字形表。 */
interface FaceData {
  readonly zh: string
  readonly en: string
  readonly glyphs: GlyphTable
  readonly fallback: GlyphRows
}

const font = (id: SplashFontId, face: FaceData): SplashFont => {
  const glyphWidth = [...(face.glyphs.D ?? face.fallback)[0] ?? ''].length
  return {
    id,
    label: face.zh,
    labelEn: face.en,
    glyphWidth,
    glyphs: face.glyphs,
    fallback: face.fallback,
    tagline: { top: TOP_WORD, bottom: BOTTOM_WORD, ...solveTagline(glyphWidth, TOP_WORD, BOTTOM_WORD) },
  }
}

/**
 * 换一副标题词（节日彩蛋用）：字形、字身宽度、id 都不变，只按新词重解字距。
 * 布局阈值（`resolveSplashLayout`）与渲染都读字体自己的 `tagline`，所以派生对象
 * 可以直接顶替原字体——窄终端阶梯一行都不用改。
 * @param font - 基准字体。
 * @param top - 上排词。
 * @param bottom - 下排词。
 * @returns 换词后的字体描述符。
 */
export function withTagline(font: SplashFont, top: string, bottom: string): SplashFont {
  return { ...font, tagline: { top, bottom, ...solveTagline(font.glyphWidth, top, bottom) } }
}

/** 半立体的灰阶：左亮右暗——和字形的"亮面/暗面"共用同一套打光（光从左上来）。 */
const BEVEL_PALETTE = { from: { r: 214, g: 214, b: 214 }, to: { r: 104, g: 104, b: 104 } }

/**
 * 字体表：键就是 id（`Record<SplashFontId, …>` 保证不多不少，加一款字体必须先
 * 进端口的 id 联合）。**书写顺序就是"按天轮换"的取模顺序**；彩蛋词/彩蛋字体不
 * 进这里，它们只在各自日期覆盖（见 `pickSplashFont` 的调用方）。
 */
const SPLASH_FONT_TABLE: Record<SplashFontId, SplashFont> = {
  bold: font('bold', { zh: '加粗（基准款）', en: 'Bold (base)', glyphs: BOLD_GLYPHS, fallback: BOLD_FALLBACK }),
  square: font('square', { zh: '方角实心', en: 'Square solid', glyphs: applyTable(BOLD_GLYPHS, SQUARE), fallback: applyRows(BOLD_FALLBACK, SQUARE) }),
  bevel: { ...font('bevel', { zh: '半立体', en: 'Bevel', glyphs: applyTable(BOLD_GLYPHS, BEVEL), fallback: applyRows(BOLD_FALLBACK, BEVEL) }), palette: BEVEL_PALETTE },
  wide: font('wide', { zh: '宽体', en: 'Wide', glyphs: applyTable(BOLD_GLYPHS, WIDE), fallback: applyRows(BOLD_FALLBACK, WIDE) }),
  dot: font('dot', { zh: '点阵灰度', en: 'Dot matrix', glyphs: applyTable(BOLD_GLYPHS, DOT), fallback: applyRows(BOLD_FALLBACK, DOT) }),
  stencil: font('stencil', { zh: '镂空模板', en: 'Stencil', glyphs: applyTable(BOLD_GLYPHS, STENCIL), fallback: applyRows(BOLD_FALLBACK, STENCIL) }),
  classic: font('classic', { zh: '细笔（经典）', en: 'Thin (classic)', glyphs: CLASSIC_GLYPHS, fallback: CLASSIC_FALLBACK }),
  slab: font('slab', { zh: '方板（实心横笔）', en: 'Slab (solid bars)', glyphs: SLAB_GLYPHS, fallback: SLAB_FALLBACK }),
}

/** 轮换池（渲染侧只读这一份；表的书写顺序即轮换顺序）。 */
export const SPLASH_FONTS: readonly SplashFont[] = Object.values(SPLASH_FONT_TABLE)

/** 设置项 `dsh-tui.splashFont` 的默认值：按本地日期轮换。 */
export const SPLASH_FONT_DAILY = 'daily' satisfies SplashFontSetting

/**
 * 值是否是合法设置（`daily` 或注册表里的 id）。
 * @param value - 不可信来源的值（cordis.yml / settings 用户层）。
 */
export function isSplashFontSetting(value: unknown): value is SplashFontSetting {
  return typeof value === 'string'
    && (value === SPLASH_FONT_DAILY || SPLASH_FONTS.some(font => font.id === value))
}

/**
 * 归一化不可信来源的设置值：合法值原样通过，其余回落 `daily`（默认行为）。
 * 不退回"某一款"是刻意的——写错的 id 若悄悄变成某款字体，用户会以为设置生效了。
 * @param value - 不可信来源的值；`undefined`（未设置）也走默认。
 */
export function normalizeSplashFont(value: unknown): SplashFontSetting {
  return isSplashFontSetting(value) ? value : SPLASH_FONT_DAILY
}

/**
 * 设置值 → `LogoV2` 的 `fontId` 缝：`daily` 交回按天轮换（`undefined`），其余
 * 原样交给注册表。**不要**把设置值直接塞进 `fontId`——`splashFontById('daily')`
 * 取不到会静默退回基准款，用户看到的就是"轮换变成了加粗"。
 * @param setting - 归一化后的设置值。
 * @returns 要 pin 的字体 id；`undefined` 表示按天轮换。
 */
export function splashFontIdOf(setting: SplashFontSetting): string | undefined {
  return setting === SPLASH_FONT_DAILY ? undefined : setting
}

/** 一款字体在 `/settings` 里的选项（面板字段的形状子集）。 */
export interface SplashFontOption {
  readonly value: SplashFontSetting
  readonly label: string
  readonly descriptions: { readonly zh: string }
}

/**
 * `/settings` 的字体选项：`daily` 在前，其余按轮换顺序跟着注册表走——加一款字体
 * 就自动出现在面板里，不漏项。标签的 en 侧取 `labelEn`、zh 侧取 `label`。
 */
export const SPLASH_FONT_OPTIONS: readonly SplashFontOption[] = [
  { value: SPLASH_FONT_DAILY, label: 'Daily rotation (default)', descriptions: { zh: '按天轮换（默认）' } },
  ...SPLASH_FONTS.map(font => ({ value: font.id, label: font.labelEn, descriptions: { zh: font.label } })),
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
