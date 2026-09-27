/**
 * 开屏头部两条契约：
 * ① 大字排版——DEEPSEEK / HARNESS 必须都是 5 行高、且**等宽**（8×7 = 7×8），
 *    否则右边缘参差；`bigTextWidth` 这个判定真源必须等于实际画出来的列数。
 * ② 窄终端阶梯——`resolveSplashLayout` 必须按「鲸鱼+大字 → 纯大字 → 纯鲸鱼 →
 *    一行纯文字」的顺序降级，档位边界不许出现空档或两档同时成立。
 * Run: node --import tsx/esm scripts/verify-splash-layout.ts
 */
import { bigTextWidth, renderBigText } from '../src/components/bigfont.js'
import { COLUMN_GAP, WHALE_BOX_WIDTH, resolveSplashLayout } from '../src/components/splashLayout.js'

const ACCENT = { r: 63, g: 108, b: 196 }
const PALE = { r: 211, g: 225, b: 254 }
/** SGR only — the block font paints with truecolor foreground sequences. */
const SGR = /\x1b\[[0-9;]*m/g

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`)
  if (!ok) failed += 1
}

const columns = (row: string): number => [...row.replace(SGR, '')].length

// ── ① 大字排版 ────────────────────────────────────────────────────────────
// 与开屏完全相同的两次调用（见 LogoV2）：DEEPSEEK 默认字距，HARNESS 加宽到 2。
const deepseek = renderBigText('DEEPSEEK', 0, ACCENT, ACCENT, PALE, 60)
const harness = renderBigText('HARNESS', 0, ACCENT, PALE, PALE, 60, 2)
const dsColumns = columns(deepseek[0] ?? '')
const hnColumns = columns(harness[0] ?? '')

check('block font renders five rows per word', deepseek.length === 5 && harness.length === 5)
check(
  'both tagline rows come out the same width',
  dsColumns === hnColumns && deepseek.every((row, i) => columns(row) === columns(harness[i] ?? '')),
  `DEEPSEEK ${dsColumns} vs HARNESS ${hnColumns}`,
)
check(
  'each row paints ink only (no tab / line break leaks into a row)',
  [...deepseek, ...harness].every(row => !/[\t\n\r]/.test(row)),
)
// 布局判定用的宽度必须就是画出来的宽度（去掉末尾那一格字距留白）。
check(
  'bigTextWidth matches the painted width',
  bigTextWidth('DEEPSEEK') === dsColumns - 1 && bigTextWidth('HARNESS', 2) === hnColumns - 2,
  `DEEPSEEK ${bigTextWidth('DEEPSEEK')} / HARNESS ${bigTextWidth('HARNESS', 2)}`,
)

// 陌生字符退化成空心方块而不是抛错，且不改变字身宽度（打错字不能让版面位移）。
const unknown = renderBigText('Ø', 0, ACCENT, ACCENT, PALE, 60)
const single = renderBigText('D', 0, ACCENT, ACCENT, PALE, 60)
check('an unknown letter falls back to a box', unknown.length === 5 && unknown.join('').includes('█'))
check('the fallback box keeps the glyph advance', columns(unknown[0] ?? '') === columns(single[0] ?? ''))

// ── ② 窄终端阶梯 ──────────────────────────────────────────────────────────
// 阈值口径 = **画出来**的列数（ink + 末尾那格字距）。按 ink 宽判「放得下」会在恰好
// 卡阈值时触发 Ink 的 `truncate-end`，把最后一个字形换成 `…`。
const TITLE_KERNING = 1
const titleWidth = bigTextWidth('DEEPSEEK', TITLE_KERNING) + TITLE_KERNING
const bothWidth = titleWidth + COLUMN_GAP + WHALE_BOX_WIDTH

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
const tier = (showWhale: boolean, showBigTitle: boolean, showPlainTitle: boolean): string =>
  `${showWhale ? 'W' : ''}${showBigTitle ? 'T' : ''}${showPlainTitle ? 'P' : ''}`

for (const [width, whale, expected] of ladder) {
  const layout = resolveSplashLayout(width, { whale })
  const actual = tier(layout.showWhale, layout.showBigTitle, layout.showPlainTitle)
  check(
    `${width} 列${whale ? '' : '（关掉鲸鱼）'} → ${expected}`,
    actual === expected,
    actual === expected ? `边界 ${bothWidth}/${titleWidth}/${WHALE_BOX_WIDTH}` : `得到 ${actual}`,
  )
}
// 纯文字档只允许出现在「大字和鲸鱼都放不下」的宽度上，且任何宽度都不会什么都不画。
for (const width of [10, WHALE_BOX_WIDTH - 1, WHALE_BOX_WIDTH, titleWidth - 1, titleWidth, bothWidth - 1, bothWidth, 200]) {
  const { showWhale, showBigTitle, showPlainTitle } = resolveSplashLayout(width, { whale: true })
  check(
    `${width} 列：纯文字档只在两样都放不下时出现，且必定画点什么`,
    showPlainTitle === (!showWhale && !showBigTitle) && (showWhale || showBigTitle || showPlainTitle),
  )
}

if (failed > 0) {
  console.error(`verify-splash-layout: ${failed} check(s) failed`)
  process.exit(1)
}
console.log('verify-splash-layout OK')
