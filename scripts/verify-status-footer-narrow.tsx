/**
 * 窄宽度下状态栏不得被撑高（#1926 / #1883，同一根因）。
 *
 * 状态行字段用 `wrap="truncate"`，绘制时只占一行。但布局测量在分数宽度
 * （`0 < width < 1`，flex 把某段挤到不足一格）走 `measureTextDimensions` 的
 * 提前返回：那里的高度是**未截断文本按该宽度换行**的行数（`~` 在 0.16 列下
 * 报 7 行），于是这一行被标记成 7 行高、只画 1 行，剩下 6 行就是字段与
 * `esc 中断` 之间的空白带：窄终端偶发、运行中随字段内容（缓存率、费用串、
 * 标题、计时）逐帧抖动、拉宽后全量重绘消失。
 *
 * 断言：一串宽度上页脚恒为 3 行（上下文条 + 字段行 + 提示行），且提示行
 * 紧贴字段行上方，中间没有空行。
 *
 * Run: node --import tsx/esm scripts/verify-status-footer-narrow.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'WezTerm'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, Box, Text }, { StatusLine }, { settled, screenHas, viewportLines }, { activateModernEmojiWidths }] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/screens/StatusLine.js'),
    import('./lib/term-test.mjs'),
    import('./lib/modern-widths.mjs'),
  ])

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, cb: () => void): void { cb() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

// 触发分数宽度的那组字段：长模型名 + 长标题 + 缓存/费用/速率读数把每一段都
// 挤到不足一格，flex 于是把它们分到 `0 < width < 1` 的预算上。
const channel = {
  minimalUi: false,
  model: 'volcengine/deepseek-v4.1-flash',
  provider: 'volcengine',
  sessionTitle: 'Review terminal layout and status fields',
  agentId: 'abcdef0123456789',
  displayCwd: '~',
  cwd: '~',
  gitBranch: 'feat/newapi-integration',
  mode: { plan: false },
  modeIndex: 0,
  reasoningEffort: 'max',
  tokens: { input: 57_000, output: 1_200 },
  contextWindow: 262_000,
  contextUsed: 57_000,
  contextSegments: {},
  contextBreakdown: undefined,
  contextBarEnabled: true,
  working: true,
  turnStart: Date.now() - 3_000,
  spinnerMode: 'requesting',
  responseChars: 1_024,
  activeToolCount: 1,
  tps: 157,
  tpsSamples: [],
  lastUsage: { input: 2_217, output: 325, cacheRead: 18_432, cacheWrite: 0, at: Date.now() },
  costReport: { currency: 'CNY', amount: 1.02, source: 'estimate' },
  backgroundJobs: [],
  activityFrames: [],
  goal: undefined,
  statusBar: {
    sessionTitle: true,
    cache: true,
    cost: true,
    tps: true,
    contextUsage: true,
    gitBranch: true,
    compact: true,
  },
}

const ROWS = 40
const WIDTHS = Array.from({ length: 71 }, (_, index) => 60 + index)

async function footerRows(cols: number): Promise<{ rows: string[]; painted: boolean }> {
  const term = new XTerm({ cols, rows: ROWS, scrollback: 50, allowProposedApi: true })
  activateModernEmojiWidths(term)
  const stdout = new Writable({
    write(chunk, _e, cb) { term.write(String(chunk), cb) },
  }) as unknown as NodeJS.WriteStream & { columns: number; rows: number; isTTY: boolean }
  stdout.columns = cols
  stdout.rows = ROWS
  stdout.isTTY = true
  const instance = await render(<StatusLine channel={channel as never} />, {
    stdout,
    stdin: new FakeStdin() as never,
    stderr: new FakeStderr() as never,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  // 页脚上屏即量高度：等待的谓词就是断言要读的那一行，超时即报未上屏。
  const painted = await settled(() => screenHas(term, 'esc 中断'))
  const lines = viewportLines(term, ROWS)
  instance.unmount()
  term.dispose()
  let last = -1
  lines.forEach((line, index) => { if (line !== '') last = index })
  return { rows: lines.slice(0, last + 1), painted }
}

const offenders: string[] = []
let worst = 0
let painted = 0
for (const cols of WIDTHS) {
  const measured = await footerRows(cols)
  if (!measured.painted) { offenders.push(`${cols}→未上屏`); continue }
  painted += 1
  worst = Math.max(worst, measured.rows.length)
  if (measured.rows.length !== 3) offenders.push(`${cols}→${measured.rows.length}`)
}
check('每个宽度都上屏且量到了高度', painted === WIDTHS.length, `painted=${painted}/${WIDTHS.length}`)
check('每个宽度页脚都是 3 行', offenders.length === 0, offenders.length === 0 ? `worst=${worst}` : `offenders=${offenders.slice(0, 8).join(',')}`)

// 空白带的具体形状：提示行紧贴字段行上方。
{
  const { rows } = await footerRows(127)
  const hint = rows.findIndex(line => line.includes('esc 中断'))
  const fields = rows.findIndex(line => line.includes('ctx '))
  check('127 列量到字段行与提示行', hint > 0 && fields > 0, `fields=${fields}, hint=${hint}`)
  check('提示行紧贴字段行（中间无空行）', hint === fields + 1, `fields=${fields}, hint=${hint}`)
  check('127 列页脚只有 3 行', rows.length === 3, `rows=${rows.length}`)
}

// 共享测量层的另一面：不足一列时截断节点只画一行（整串含换行被截空），
// 量高也必须是 1，否则多行截断文本会带出同样的空白带。用 width=0.4 直接
// 制造分数宽度，MARKER 的行号就是这个节点占的高度。
async function fractionalTruncateHeight(text: string): Promise<number> {
  const term = new XTerm({ cols: 20, rows: 10, scrollback: 20, allowProposedApi: true })
  const stdout = new Writable({
    write(chunk, _e, cb) { term.write(String(chunk), cb) },
  }) as unknown as NodeJS.WriteStream & { columns: number; rows: number; isTTY: boolean }
  stdout.columns = 20
  stdout.rows = 10
  stdout.isTTY = true
  const instance = await render(
    <Box flexDirection="column">
      <Box width={0.4}><Text wrap="truncate">{text}</Text></Box>
      <Text>MARKER</Text>
    </Box>,
    { stdout, stdin: new FakeStdin() as never, stderr: new FakeStderr() as never, exitOnCtrlC: false, patchConsole: false },
  )
  await settled(() => screenHas(term, 'MARKER'))
  const height = viewportLines(term, 10).findIndex(line => line.includes('MARKER'))
  instance.unmount()
  term.dispose()
  return height
}

const multilineHeight = await fractionalTruncateHeight('a\nb\nc')
const singlelineHeight = await fractionalTruncateHeight('abc')
check('分数宽度下多行截断文本只占 1 行', multilineHeight === 1, `rows=${multilineHeight}`)
check('分数宽度下单行截断文本仍占 1 行', singlelineHeight === 1, `rows=${singlelineHeight}`)

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
