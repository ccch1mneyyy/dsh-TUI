import { interpolateColor } from './Spinner/spinnerUtils.js'
import type { SplashFont } from './splashFonts.js'

/**
 * 5 行点阵大字的画布：横向颜色渐变 + 一道从左往右扫的高光（节奏与 `✦ dsh-TUI`
 * 字标的扫光一致，见 `stepMs`）。字形与度量来自 `splashFonts.ts` 的字体描述符，
 * 这里只负责"把某款字体画出来"——所以加字体是加数据，不是改画布。
 *
 * 缺字走字体自带的 `fallback` 空心方块：打错字要看得见，而不是让开屏崩掉。
 */

/** 颜色通道。 */
export interface Rgb {
  r: number
  g: number
  b: number
}

/** 词组之间的间隔列数。 */
const WORD_GAP = 2
/** 扫光窗口宽度（列）。 */
const SWEEP_WINDOW = 8
/** 一行字画几行。 */
const ROWS = 5

const esc = (rgb: Rgb): string => `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m`
const RESET = '\x1b[39m'

/**
 * `text` 在该字体、该字距下画出来的列数（含末尾那格字距留白）——与渲染循环
 * 用同一套算术，放在这里以免两处漂移。
 * @param font - 字体描述符。
 * @param text - 要量的文本。
 * @param kerning - 每个字形之后补的空列数。
 * @returns 画出来的列数。
 */
function paintedWidth(font: SplashFont, text: string, kerning: number): number {
  let width = 0
  for (const ch of text) width += ch === ' ' ? WORD_GAP : font.glyphWidth + kerning
  return width
}

/**
 * `text` 的显示宽度：含字距、**不含**最后一个字形之后的留白。开屏用它判断
 * 某个词还放不放得下（配合鲸鱼），`verify-splash-layout` 会把它与实际画出的
 * 列数对齐钉死。
 * @param font - 字体描述符。
 * @param text - 要量的文本（只有字体表里定义的字母有字形）。
 * @param kerning - 每个字形之后的空列数（默认 1）。
 * @returns 显示宽度（终端列）。
 */
export function bigTextWidth(font: SplashFont, text: string, kerning = 1): number {
  const characters = Array.from(text)
  if (characters.length === 0) return 0
  const trailing = characters[characters.length - 1] === ' ' ? WORD_GAP : kerning
  return paintedWidth(font, text, kerning) - trailing
}

/**
 * 用某款字体渲染 `text`：渐变从 `from` 走到 `to`，一段 SWEEP_WINDOW 宽的高光
 * 混向 `flash` 并随时间从左扫到右。返回 5 行 ANSI。
 * @param font - 字体描述符（字形 + 字身宽度 + fallback）。
 * @param text - 要渲染的文本；缺字的字母退化成 fallback 方块。
 * @param time - 毫秒；决定扫光位置与脉动亮度（定格时传 0）。
 * @param from - 渐变起点色（最左列）。
 * @param to - 渐变终点色（最右列）。
 * @param flash - 扫光窗口混入的高光色。
 * @param stepMs - 扫光每前进一列的毫秒数（默认 60）。
 * @param kerning - 每个字形之后的空列数（默认 1）。两行标题靠它撑到等宽。
 * @param indent - 每行左侧缩进列数（下排居中用，默认 0）。
 * @returns 5 行 ANSI，每行是点阵字的一行。
 */
export function renderBigText(
  font: SplashFont,
  text: string,
  time: number,
  from: Rgb,
  to: Rgb,
  flash: Rgb,
  stepMs = 60,
  kerning = 1,
  indent = 0,
): string[] {
  const width = paintedWidth(font, text, kerning) + indent
  const cycle = width + SWEEP_WINDOW * 2
  const sweepStart = (Math.floor(time / stepMs) % cycle) - SWEEP_WINDOW
  const pulse = (Math.sin(time / (stepMs * 2)) + 1) / 2

  const rows: string[] = []
  for (let row = 0; row < ROWS; row++) {
    let out = ''
    let current = ''
    let x = 0
    const emit = (ch: string): void => {
      if (ch === ' ' || ch === '·') {
        if (current !== '') {
          out += RESET
          current = ''
        }
        out += ' '
        x += 1
        return
      }
      const t = width <= 1 ? 0 : x / (width - 1)
      let color = interpolateColor(from, to, t)
      if (x >= sweepStart && x < sweepStart + SWEEP_WINDOW) {
        color = interpolateColor(color, flash, pulse)
      }
      const seq = esc(color)
      if (seq !== current) {
        out += seq
        current = seq
      }
      out += ch
      x += 1
    }
    for (let i = 0; i < indent; i++) emit(' ')
    for (const ch of text) {
      if (ch === ' ') {
        for (let i = 0; i < WORD_GAP; i++) emit(' ')
        continue
      }
      const glyph = font.glyphs[ch] ?? font.fallback
      for (const cell of glyph[row] ?? '') emit(cell)
      for (let i = 0; i < kerning; i++) emit(' ')
    }
    if (current !== '') out += RESET
    rows.push(out)
  }
  return rows
}
