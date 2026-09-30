/**
 * 开屏头部契约，逐款字体钉死：
 * ① 字形——每款 5 行、每个字形与 fallback 行的宽度都等于 glyphWidth、覆盖
 *    `DEEPSEEK`/`HARNESS` 用到的全部字母（缺一个就会在开屏上出现空心方块）；
 * ② 两行标题——画出来的列数必须相等，且下排靠 `bottomIndent` 居中（左右留白差 ≤ 1 列）；
 * ③ `bigTextWidth` 必须等于实际画出的列数（去掉末尾字距留白）——布局判定与画面同源；
 * ④ 窄终端阶梯按「鲸鱼+大字 → 纯大字 → 纯鲸鱼 → 一行纯文字」降级，档位无空档；
 * ⑤ 按天轮换——同一天内恒定、连续 N 天覆盖全部字体、未知 id 退回基准款。
 * Run: node --import tsx/esm scripts/verify-splash-layout.ts
 */
import { bigTextWidth, renderBigText } from '../src/components/bigfont.js'
import { COLUMN_GAP, WHALE_BOX_WIDTH, resolveSplashLayout } from '../src/components/splashLayout.js'
import { SPLASH_FONTS, pickSplashFont, splashFontById } from '../src/components/splashFonts.js'

const ACCENT = { r: 63, g: 108, b: 196 }
const PALE = { r: 211, g: 225, b: 254 }
/** SGR only — the block font paints with truecolor foreground sequences. */
const SGR = /\x1b\[[0-9;]*m/g
/** 开屏实际用到的字母；每款字体都必须有。 */
const LETTERS = [...new Set([...'DEEPSEEK', ...'HARNESS'])]

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`)
  if (!ok) failed += 1
}

const columns = (row: string): number => [...row.replace(SGR, '')].length

// ── ①②③ 逐款字体 ─────────────────────────────────────────────────────────
for (const font of SPLASH_FONTS) {
  const { top, bottom, topKerning, bottomKerning, bottomIndent } = font.tagline
  const topRows = renderBigText(font, top, 0, ACCENT, ACCENT, PALE, 60, topKerning)
  const bottomRows = renderBigText(font, bottom, 0, ACCENT, PALE, PALE, 60, bottomKerning, bottomIndent)
  const topWidth = columns(topRows[0] ?? '')
  const bottomWidth = columns(bottomRows[0] ?? '')
  const inkTop = bigTextWidth(font, top, topKerning)
  const inkBottom = bigTextWidth(font, bottom, bottomKerning)

  check(`[${font.id}] 两行都是 5 行`, topRows.length === 5 && bottomRows.length === 5)
  check(
    `[${font.id}] 两行画出来的列数相等`,
    topWidth === bottomWidth && topRows.every((row, i) => columns(row) === columns(bottomRows[i] ?? '')),
    `${topWidth} vs ${bottomWidth}`,
  )
  check(
    `[${font.id}] 下排居中（左右留白差 ≤ 1 列）`,
    Math.abs(inkTop - inkBottom - 2 * bottomIndent) <= 1,
    `ink ${inkTop}/${inkBottom} indent ${bottomIndent}`,
  )
  check(
    `[${font.id}] bigTextWidth 等于实际画出的列数`,
    bigTextWidth(font, top, topKerning) === topWidth - topKerning &&
      bigTextWidth(font, bottom, bottomKerning) === bottomWidth - bottomIndent - bottomKerning,
  )
  check(
    `[${font.id}] 字形与 fallback 都是 glyphWidth 宽`,
    [...Object.values(font.glyphs), font.fallback].every(rows =>
      rows.length === 5 && rows.every(row => [...row.replace(SGR, '')].length === font.glyphWidth),
    ),
    `${font.glyphWidth} 列`,
  )
  check(
    `[${font.id}] 覆盖 DEEPSEEK/HARNESS 的全部字母`,
    LETTERS.every(letter => (font.glyphs[letter] ?? []).length === 5),
    LETTERS.join(''),
  )
  // 缺字退化成 fallback 而不是抛错，且不改变字身宽度。
  const unknown = renderBigText(font, 'Ø', 0, ACCENT, ACCENT, PALE, 60, topKerning)
  check(`[${font.id}] 缺字走 fallback 且宽度不变`, columns(unknown[0] ?? '') === font.glyphWidth + topKerning)
}

check('字体 id 唯一', new Set(SPLASH_FONTS.map(font => font.id)).size === SPLASH_FONTS.length)
check('字体数量 >= 2（轮换才有意义）', SPLASH_FONTS.length >= 2, `${SPLASH_FONTS.length} 款`)

// ── ④ 窄终端阶梯（用基准款算阈值） ────────────────────────────────────────
const font = SPLASH_FONTS[0]!
// 阈值口径 = **画出来**的列数（ink + 末尾那格字距）。按 ink 宽判「放得下」会在恰好
// 卡阈值时触发 Ink 的 `truncate-end`，把最后一个字形换成 `…`。
const inkWidth = bigTextWidth(font, font.tagline.top, font.tagline.topKerning)
const titleWidth = inkWidth + font.tagline.topKerning
const bothWidth = titleWidth + COLUMN_GAP + WHALE_BOX_WIDTH
const paintedWidth = (f: typeof font): number =>
  bigTextWidth(f, f.tagline.top, f.tagline.topKerning) + f.tagline.topKerning
const tier = (l: { showWhale: boolean; showBigTitle: boolean; showPlainTitle: boolean }): string =>
  `${l.showWhale ? 'W' : ''}${l.showBigTitle ? 'T' : ''}${l.showPlainTitle ? 'P' : ''}`
const ladder: readonly (readonly [number, boolean, string])[] = [
  [bothWidth + 30, true, 'WT'],
  [bothWidth, true, 'WT'],
  [bothWidth - 1, true, 'T'],
  [titleWidth, true, 'T'],
  [titleWidth - 1, true, 'W'],
  [WHALE_BOX_WIDTH, true, 'W'],
  [WHALE_BOX_WIDTH - 1, true, 'P'],
  [20, true, 'P'],
  [titleWidth - 1, false, 'P'],
  [bothWidth + 30, false, 'T'],
]
for (const [width, whale, expected] of ladder) {
  const actual = tier(resolveSplashLayout(width, { whale, font }))
  check(`${width} 列${whale ? '' : '（关掉鲸鱼）'} → ${expected}`, actual === expected, `得到 ${actual}`)
}
for (const width of [10, WHALE_BOX_WIDTH - 1, WHALE_BOX_WIDTH, titleWidth - 1, titleWidth, bothWidth, 300]) {
  const layout = resolveSplashLayout(width, { whale: true, font })
  check(
    `${width} 列：纯文字档只在两样都放不下时出现，且必定画点什么`,
    layout.showPlainTitle === (!layout.showWhale && !layout.showBigTitle) &&
      (layout.showWhale || layout.showBigTitle || layout.showPlainTitle),
  )
}
// 宽体字身更宽，阈值必须跟着走（不能写死 97）。
const widest = [...SPLASH_FONTS].sort((a, b) => paintedWidth(b) - paintedWidth(a))[0]!
check(
  '阶梯阈值随字体字身宽度变',
  resolveSplashLayout(bothWidth, { whale: true, font: widest }).showWhale ===
    (paintedWidth(widest) + COLUMN_GAP + WHALE_BOX_WIDTH <= bothWidth),
  `最宽字体 ${widest.id} = ${paintedWidth(widest)} 列（画出来）`,
)
// 卡在阈值的两侧：恰好等于画出来的宽度才放大字，少一列就不放——否则末字会被 `…` 吃掉。
check(
  `恰好 ${paintedWidth(font)} 列放大字、${paintedWidth(font) - 1} 列不放`,
  resolveSplashLayout(paintedWidth(font), { whale: false, font }).showBigTitle &&
    !resolveSplashLayout(paintedWidth(font) - 1, { whale: false, font }).showBigTitle,
)

// ── ⑤ 按天轮换 ────────────────────────────────────────────────────────────
const sameDay = [new Date(2026, 3, 1, 0, 1), new Date(2026, 3, 1, 23, 59)]
check(
  '同一天内（跨时刻）恒定',
  pickSplashFont(sameDay[0]).id === pickSplashFont(sameDay[1]).id,
  pickSplashFont(sameDay[0]).id,
)
const days = Array.from({ length: SPLASH_FONTS.length }, (_, i) => new Date(2026, 3, 1 + i))
const rolled = new Set(days.map(day => pickSplashFont(day).id))
check(`连续 ${SPLASH_FONTS.length} 天覆盖全部字体`, rolled.size === SPLASH_FONTS.length, [...rolled].join(','))
check('隔天会换一款', pickSplashFont(new Date(2026, 3, 1)).id !== pickSplashFont(new Date(2026, 3, 2)).id)
check('未知 id 退回基准款', splashFontById('nope').id === SPLASH_FONTS[0]!.id)
check('按 id 取到对应字体', splashFontById('classic').id === 'classic')

if (failed > 0) {
  console.error(`verify-splash-layout: ${failed} check(s) failed`)
  process.exit(1)
}
console.log(`verify-splash-layout OK (${SPLASH_FONTS.length} 款字体)`)
