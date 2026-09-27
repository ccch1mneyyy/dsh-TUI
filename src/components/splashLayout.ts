import { bigTextWidth } from './bigfont.js'
import type { SplashFont } from './splashFonts.js'

/**
 * 开屏头部的窄终端降级阶梯——越窄越先放弃「并排」这件事：
 *
 *   ① 像素鲸鱼 + `DEEPSEEK`/`HARNESS` 大字 —— 两者都放得下
 *   ② 只留大字 logo                        —— 先撤鲸鱼：大字被截断会毁掉品牌字形，
 *                                            鲸鱼被撤只是少一个装饰
 *   ③ 只留像素鲸鱼                          —— 大字放不下，鲸鱼顶上撑住开屏
 *   ④ 一行纯文字                            —— 两者都放不下
 *
 * 列数一律按**内容区**算：`PageMargin` 已经把 `TerminalSizeContext` 收窄成
 * 内容宽（`PageMargin.tsx`），所以这里不再减页边距。
 */

/**
 * 鲸鱼 art 的固定盒宽：甩尾帧比标准姿势向右多出 4 列，钉死宽度才不让文字列
 * 跟着左右跳。
 */
export const WHALE_BOX_WIDTH = 40

/** 鲸鱼与文字列之间的间隔列数（头部那行 `Box` 的 `gap`）。 */
export const COLUMN_GAP = 2

/** 一行开屏头部在该宽度下要渲染哪些部件。 */
export interface SplashLayout {
  /** 渲染像素鲸鱼。 */
  readonly showWhale: boolean
  /** 渲染 `DEEPSEEK`/`HARNESS` 大字。 */
  readonly showBigTitle: boolean
  /** 两者都放不下：退化成一行纯文字标题。 */
  readonly showPlainTitle: boolean
}

/**
 * 解析开屏头部的阶梯档位。
 * @param columns - 内容区列数（不是终端总宽）。
 * @param options - `whale` 对应 `dsh-tui.whale` 设置；`font` 是当天那款字体
 * （字身宽度不同，阈值也就不同）。
 * @returns 该宽度下要渲染的部件。
 */
export function resolveSplashLayout(
  columns: number,
  options: { whale: boolean; font: SplashFont },
): SplashLayout {
  const { font } = options
  // 阈值按**画出来**的列数算：每行末尾还会画出一格字距，而 `bigTextWidth` 只算到
  // 最后一个字形。按 ink 宽判「放得下」，会在恰好卡阈值时让 Ink 走 `truncate-end`
  // ——最后一个字形被换成 `…`（可达边界：基准款 55 列即复现）。末尾那一格是空白，
  // 少画一格不可惜，字形被吃掉才可惜。
  const titleWidth = bigTextWidth(font, font.tagline.top, font.tagline.topKerning) + font.tagline.topKerning
  const fitsTitle = columns >= titleWidth
  const showWhale =
    options.whale &&
    columns >= WHALE_BOX_WIDTH &&
    (columns >= titleWidth + COLUMN_GAP + WHALE_BOX_WIDTH || !fitsTitle)
  return { showWhale, showBigTitle: fitsTitle, showPlainTitle: !fitsTitle && !showWhale }
}
