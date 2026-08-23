/**
 * verify-timeline-geometry — timeline rail 纯几何模型的单元检查（对齐
 * grok-build xai-grok-pager views/timeline.rs 的测试矩阵）。
 *
 * 覆盖：
 *   - 资格门：turn 数 / 终端宽 / 视口行数 / 可滚动性；
 *   - 小对话：全量 tick 垂直居中；
 *   - 溢出窗口：围绕 active 滑动、active 收尾 clamp、无 active 锚定末尾、
 *     at-bottom 贴尾但绝不排除 active；
 *   - railHit 行 ↔ (▲/tick/▼) 映射；
 *   - clipPreview：首个非空行、120 字符上限 + …；
 *   - wrapPreviewLines：CJK 宽度、两行上限、末行省略。
 *
 * 运行：node --import tsx/esm scripts/verify-timeline-geometry.ts
 */
import {
  RAIL_WIDTH,
  railEligible,
  computeRailGeometry,
  railHit,
  clipPreview,
  wrapPreviewLines,
} from '../src/ink/timeline-rail.js'
import { stringWidth } from '../src/ink/stringWidth.js'

let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// ── 资格门 ──
check('turn<2 隐藏', computeRailGeometry(1, 20, 0, false) === null)
check('viewport=2 隐藏（放不下 ▲+tick+▼）', computeRailGeometry(5, 2, 0, false) === null)
check('viewport=3 恰好 1 tick', computeRailGeometry(5, 3, 2, false) !== null &&
  computeRailGeometry(5, 3, 2, false)!.windowEnd - computeRailGeometry(5, 3, 2, false)!.windowStart === 1)
check('eligibility: 窄终端', !railEligible({ turnCount: 8, terminalWidth: 59, viewportRows: 30, scrollable: true }))
check('eligibility: 60 列', railEligible({ turnCount: 8, terminalWidth: 60, viewportRows: 30, scrollable: true }))
check('eligibility: 内容不足一屏（inline）', !railEligible({ turnCount: 8, terminalWidth: 100, viewportRows: 30, scrollable: false }))
check('eligibility: turn<2', !railEligible({ turnCount: 1, terminalWidth: 100, viewportRows: 30, scrollable: true }))
check('rail 宽 2 列', RAIL_WIDTH === 2)

// ── 小对话：全量 + 居中（grok: small_conversation_shows_all_ticks_centered）──
{
  const geo = computeRailGeometry(4, 20, 1, false)!
  check('4 turn 全显示', eq([geo.windowStart, geo.windowEnd], [0, 4]))
  check('6 行块在 20 行居中: upRow=7', geo.upRow === 7, `upRow=${geo.upRow}`)
  check('tickTop=8 downRow=12', geo.tickTop === 8 && geo.downRow === 12, `${geo.tickTop}/${geo.downRow}`)
}

// ── 溢出窗口（grok: overflow_windows_around_active）──
{
  const geo = computeRailGeometry(50, 20, 25, false)!
  check('50 turn/18 行: 窗口 18', geo.windowEnd - geo.windowStart === 18)
  check('窗口含 active', geo.windowStart <= 25 && 25 < geo.windowEnd)
  check('围绕 active: start=16', geo.windowStart === 25 - 9, `start=${geo.windowStart}`)
  check('active=49 收尾', (() => { const g = computeRailGeometry(50, 20, 49, false)!; return eq([g.windowStart, g.windowEnd], [32, 50]) })())
  check('active=null 锚定末尾', (() => { const g = computeRailGeometry(50, 20, null, false)!; return eq([g.windowStart, g.windowEnd], [32, 50]) })())
  check('at-bottom 贴尾但含 active', (() => { const g = computeRailGeometry(50, 20, 25, true)!; return eq([g.windowStart, g.windowEnd], [25, 43]) })())
  check('at-bottom active 已在尾部 → 固定末尾', (() => { const g = computeRailGeometry(50, 20, 40, true)!; return eq([g.windowStart, g.windowEnd], [32, 50]) })())
}

// ── railHit 映射（grok: hit_maps_chevrons_and_ticks）──
{
  const geo = computeRailGeometry(4, 20, 1, false)!
  check('▲ 行命中', eq(railHit(geo, geo.upRow), { kind: 'up' }))
  check('▼ 行命中', eq(railHit(geo, geo.downRow), { kind: 'down' }))
  check('首 tick = turn 0', eq(railHit(geo, geo.tickTop), { kind: 'tick', index: 0 }))
  check('末 tick = turn 3', eq(railHit(geo, geo.tickTop + 3), { kind: 'tick', index: 3 }))
  check('块外行未命中', railHit(geo, geo.upRow - 1) === null && railHit(geo, geo.downRow + 1) === null)
  const of = computeRailGeometry(50, 20, 25, false)!
  check('溢出窗口行映射窗口内序号', eq(railHit(of, of.tickTop), { kind: 'tick', index: of.windowStart }))
}

// ── clipPreview ──
check('跳过前导空行', clipPreview('\n\n  你好 世界  \n第二行') === '你好 世界')
{
  const long = 'x'.repeat(500)
  const p = clipPreview(long)
  check('120 上限 + …', p.length === 120 && p.endsWith('…'), `len=${p.length}`)
}

// ── wrapPreviewLines（CJK 感知）──
{
  const lines = wrapPreviewLines('问题 二', 4)
  check('CJK 按显示宽换行（4 列 → 2 行）', lines.length === 2 && stringWidth(lines[0]!) <= 4, JSON.stringify(lines))
  const ell = wrapPreviewLines('一二三四五六七八九十', 4)
  check('第二行截断加 …', ell.length === 2 && ell[1]!.endsWith('…') && stringWidth(ell[1]!) <= 4, JSON.stringify(ell))
  const one = wrapPreviewLines('短句', 16)
  check('短句单行', one.length === 1 && one[0] === '短句')
  const ascii = wrapPreviewLines('abcdefgh', 4)
  check('ASCII 硬切', eq(ascii, ['abcd', 'efgh']), JSON.stringify(ascii))
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
