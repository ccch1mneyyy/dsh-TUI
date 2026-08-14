/**
 * CJK 截断回归（issue #41 / PR #45 同款 bug 的 @ 文件建议面板修复）：
 *   1. truncateToWidth 单元断言——按终端显示宽度截断，绝不劈开宽字符；
 *   2. FileSuggestions 窄终端渲染——CJK 文件名 + 描述截断后每行宽度不超限；
 *   3. MessageList compactPreview 同款修复由 truncateToWidth 单元断言覆盖
 *      （该函数未导出，逻辑与 FileSuggestions 共用同一 helper）。
 * 运行：node --import tsx/esm scripts/verify-cjk-truncate.tsx
 */
process.env.FORCE_COLOR = '3'

const [{ Writable }, React, { Terminal: XTerm }, { render }, { FileSuggestions }, { stringWidth }, { truncateToWidth }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/FileSuggestions.js'),
  import('../src/ink/stringWidth.js'),
  import('../src/ink/truncateToWidth.js'),
])

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let failures = 0
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`)
  } else {
    failures++
    console.error(`  ✗ ${msg}`)
  }
}

// --- 1. truncateToWidth 单元断言 -------------------------------------------

console.log('truncateToWidth 单元断言:')

// 纯 CJK：每个字 2 列，limit=3 只能放下 1 个字（旧的 slice(0,2) 会放 2 字 = 4 列超限，
// slice(0,3) 按字符数会截出 1.5 个字）。
for (const limit of [0, 1, 2, 3, 4, 5, 7, 8]) {
  const out = truncateToWidth('你好世界', limit)
  assert(
    stringWidth(out) <= limit,
    `'你好世界' 截到 ${limit} 列 → '${out}'（宽 ${stringWidth(out)}）不超限`,
  )
}
assert(truncateToWidth('你好世界', 3) === '你', 'limit=3 只保留 1 个整字，不劈开第二个字')
assert(truncateToWidth('你好世界', 4) === '你好', 'limit=4 恰好 2 个字')

// 中英混排
const mixed = truncateToWidth('ab中cd', 4)
assert(mixed === 'ab中' && stringWidth(mixed) === 4, `中英混排截到 4 列 → '${mixed}'`)

// 宽字符恰好卡在边界：'a中' 宽 3，limit=2 时 '中' 放不进，只留 'a'
assert(truncateToWidth('a中b', 2) === 'a', '宽字符卡边界时不塞半个字')

// 短于 limit 原样返回
assert(truncateToWidth('file', 10) === 'file', '短字符串原样返回')

// --- 2. FileSuggestions 窄终端渲染 ------------------------------------------

console.log('FileSuggestions 窄终端渲染:')

const COLS = 28
const ROWS = 12
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
}

// descriptionWidth = COLS - 24 = 4，'directory'（9 列）必走截断路径 → 'dir…' 恰好 4 列；
// CJK 文件名走 `20 - stringWidth(name)` 的 padding 路径。
const files = ['中文目录名/', 'src/中文文件.ts', 'README.md']
const app = await render(
  React.createElement(FileSuggestions, { files, selectedIndex: 0, columns: COLS }),
  { stdout: new FakeStdout(), exitOnCtrlC: false, patchConsole: false },
)
await sleep(300)
app.unmount()
await sleep(100)

const buf = term.buffer.active
let sawEllipsis = false
for (let y = 0; y < ROWS; y++) {
  const line = buf.getLine(y)?.translateToString(true) ?? ''
  if (line.trim() === '') continue
  const w = stringWidth(line)
  assert(w <= COLS, `第 ${y} 行宽 ${w} ≤ 终端宽 ${COLS}：'${line.trimEnd()}'`)
  if (line.includes('…')) sawEllipsis = true
}
assert(sawEllipsis, '窄宽度下 directory 描述被截断并带省略号')

// --- 结果 -------------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} 项断言失败`)
  process.exit(1)
}
console.log('\n全部断言通过')
process.exit(0)
