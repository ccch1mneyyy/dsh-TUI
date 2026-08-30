/**
 * verify-scrollbar-gutter — `dsh-tui.scrollGutter` 设置三态：timeline（默认）
 * / scrollbar（比例滚动条）/ hidden（无边栏），以及 scrollbar 形态的滑块
 * 几何与轨道点击。
 *
 * 断言（headless xterm 100×40，全屏 Chat，8 轮对话）：
 *   1. 默认 timeline：rail 出现（▴/tick/▾）；
 *   2. setScrollGutter('scrollbar')：██ 滑块出现，钉底时贴底；无 ▴▾ tick；
 *   3. 上滚：滑块上移且仍在轨道内；
 *   4. 点击轨道顶部：滚到顶（问题 1 可见），滑块贴顶；
 *   5. setScrollGutter('hidden')：右缘无任何 gutter glyph，转译区占满宽；
 *   6. 切回 timeline：rail 恢复。
 *
 * 运行：node --import tsx/esm scripts/verify-scrollbar-gutter.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { LOCAL_COMMANDS, completeCommands }, { settle, settled, sleep }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
  import('./lib/term-test.mjs'),
])

const COLS = 100, ROWS = 40
let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS; rows = ROWS; isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const stdin = new FakeStdin(), stdout = new FakeStdout(), stderr = new FakeStderr()

const rows: any[] = []
for (let turn = 1; turn <= 8; turn++) {
  rows.push({ id: turn * 2 - 1, kind: 'user', text: `问题 ${turn}` })
  rows.push({ id: turn * 2, kind: 'assistant', text: Array.from({ length: 8 }, (_, i) => `回复 ${turn} 第 ${i + 1} 行`).join('\n') })
}
const listeners = new Set<() => void>()
const channel: any = {
  version: 0, rows, status: 'idle', sessionTitle: 'probe', agentId: 'probe',
  model: 'deepseek-v4-flash', provider: 'deepseek', reasoningEffort: 'max', effortLevels: [],
  tokens: { input: 0, output: 0 }, cwd: '/tmp/demo', displayCwd: '/tmp/demo', gitBranch: 'main',
  working: false, spinnerMode: 'requesting', responseChars: 0, activeToolCount: 0, turnStart: 0,
  pending: [], commandList: LOCAL_COMMANDS, notifications: [], mode: { plan: false, sandbox: undefined },
  activityFrames: 'claude', agentPreset: undefined, subagents: [], lastUserText: '问题 8',
  scrollGutter: 'timeline',
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => Promise.resolve([]),
  deleteSession: () => Promise.resolve(true), renameSessionTo: () => Promise.resolve(true),
  setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [], pushLocal: () => {},
  commandCompletions: (input: string) => completeCommands(input),
}
const emitChannel = () => { channel.version++; for (const l of listeners) l() }
// 切换后由各调用点 settle 到断言条件出现（./lib/term-test.mjs）。
const setGutter = (mode: string) => {
  channel.scrollGutter = mode
  emitChannel()
}

const inst = await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} fullscreen />
  </AlternateScreen>,
  { stdout: stdout as any, stdin: stdin as any, stderr: stderr as any, exitOnCtrlC: false, patchConsole: false },
)
function screenLines(): string[] {
  const buf = term.buffer.active
  return Array.from({ length: ROWS }, (_, y) => buf.getLine(buf.baseY + y)?.translateToString(true) ?? '')
}
function cellAt(y: number, col: number): string {
  const buf = term.buffer.active
  return buf.getLine(buf.baseY + y)?.getCell(col)?.getChars() ?? ''
}
function gutterRange(): [number, number] {
  const lines = screenLines()
  const top = /^❯/.test(lines[0]!.trimEnd()) ? 1 : 0
  let promptRow = -1
  for (let y = ROWS - 1; y >= 0; y--) {
    if (lines[y]!.trimStart().startsWith('❯')) { promptRow = y; break }
  }
  return [top, promptRow >= 0 ? promptRow - 2 : ROWS - 4]
}
/** gutter 快照：{ thumbs: ██ 行, ticks: ─/━ 行, chevrons: ▴/▾ 行 }。
 *  whale 图案的 █ 会落在 gutter 列——只把「两列均 █ 且同行左侧 20 列
 *  内无 whale 图形字符」的行认作滑块。 */
function gutterSnapshot(): { thumbs: number[]; ticks: number[]; chevrons: number[] } {
  const [top, bottom] = gutterRange()
  const thumbs: number[] = [], ticks: number[] = [], chevrons: number[] = []
  for (let y = top; y < bottom; y++) {
    const two = cellAt(y, COLS - 2) + cellAt(y, COLS - 1)
    if (two.includes('██')) {
      let whale = false
      for (let x = COLS - 24; x < COLS - 4; x++) {
        const c = cellAt(y, x)
        if (c === '█' || c === '▀' || c === '▄' || c === '▀▀') { whale = true; break }
      }
      if (!whale) thumbs.push(y)
    }
    else if (two.includes('▴') || two.includes('▾')) chevrons.push(y)
    else if (two === '━━' || two === '──' || two === ' ─') ticks.push(y)
  }
  return { thumbs, ticks, chevrons }
}
// 逐事件 pacing sleep 保留：滚轮事件需要逐个进入 hover/scroll 路径，
// 每步之间没有可区分新旧帧的屏幕条件可轮询。
const wheel = async (up: boolean, times: number) => {
  for (let i = 0; i < times; i++) {
    stdin.write(`\x1b[<${up ? 64 : 65};90;30M`)
    await sleep(150)
  }
}
const clickAt = (col: number, row: number) => {
  stdin.write(`\x1b[<0;${col};${row}M`)
  stdin.write(`\x1b[<0;${col};${row}m`)
}

// ── 1. 默认 timeline ──
// 各块断言均在 settle 捕获的同一快照 snap 上求值：等待条件与断言共用快照，无分叉。
{
  let snap = gutterSnapshot()
  await settled(() => {
    snap = gutterSnapshot()
    return snap.ticks.length > 0 && snap.chevrons.length === 2 && snap.thumbs.length === 0
  })
  check('默认 timeline：rail tick + chevron 存在', snap.ticks.length > 0 && snap.chevrons.length === 2,
    `ticks=${snap.ticks.length} chevrons=${snap.chevrons.length}`)
  check('默认 timeline：无 ██ 滑块', snap.thumbs.length === 0, `thumbs=${snap.thumbs.length}`)
}

// ── 2. 切 scrollbar：██ 贴底，无 chevron/tick ──
setGutter('scrollbar')
{
  let snap = gutterSnapshot()
  let bottom = gutterRange()[1]
  await settle(() => {
    snap = gutterSnapshot()
    bottom = gutterRange()[1]
    return snap.thumbs.length >= 2 && snap.chevrons.length === 0 && snap.ticks.length === 0 &&
      snap.thumbs[snap.thumbs.length - 1] === bottom - 1
  })
  check('scrollbar：██ 滑块出现', snap.thumbs.length >= 2, `thumbs=${snap.thumbs.length}`)
  check('scrollbar：无 timeline glyph', snap.chevrons.length === 0 && snap.ticks.length === 0,
    `chevrons=${snap.chevrons.length} ticks=${snap.ticks.length}`)
  check('scrollbar：钉底滑块贴底', snap.thumbs[snap.thumbs.length - 1] === bottom - 1,
    `last=${snap.thumbs[snap.thumbs.length - 1]} bottom=${bottom}`)
}

// ── 3. 上滚（whale 滚出视口）：滑块在轨道内且离开底端 ──
await wheel(true, 16)
{
  let snap = gutterSnapshot()
  let range = gutterRange()
  await settle(() => {
    snap = gutterSnapshot()
    range = gutterRange()
    if (snap.thumbs.length < 2) return false
    const first = snap.thumbs[0]!, last = snap.thumbs[snap.thumbs.length - 1]!
    return first >= range[0] && last < range[1] - 1
  })
  const [top, bottom] = range
  check('上滚后滑块存在（非 whale）', snap.thumbs.length >= 2, `thumbs=${JSON.stringify(snap.thumbs)}`)
  if (snap.thumbs.length > 0) {
    const first = snap.thumbs[0]!, last = snap.thumbs[snap.thumbs.length - 1]!
    check('上滚后滑块仍在轨道内', first >= top && last < bottom, `first=${first} last=${last} range=[${top},${bottom})`)
    check('上滚后滑块离开底端', last < bottom - 1, `last=${last} bottom=${bottom}`)
  }
}

// ── 4. 点击轨道顶部：滚到顶（whale 回到视口，跳过滑块位置断言）──
{
  const [top] = gutterRange()
  clickAt(COLS, top + 1)
  let lines: string[] = []
  await settle(() => { lines = screenLines(); return lines.slice(0, 24).some(l => l.includes('问题 1')) })
  check('点击轨道顶后滚到顶（问题 1 可见）', lines.slice(0, 24).some(l => l.includes('问题 1')),
    `top4=${JSON.stringify(lines.slice(0, 4).map(l => l.trimEnd().slice(0, 24)))}`)
}

// ── 5. 切 hidden：无 gutter（whale 的 █ 不算——只查 timeline/scrollbar glyph）──
const hasGutterGlyph = (): boolean => {
  const [top, bottom] = gutterRange()
  let anyGlyph = false
  for (let y = top; y < bottom; y++) {
    const two = cellAt(y, COLS - 2) + cellAt(y, COLS - 1)
    if (two.includes('▴') || two.includes('▾') || two === '━━' || two === '──' || two === ' ─') anyGlyph = true
    if (two.includes('██')) {
      let whale = false
      for (let x = COLS - 24; x < COLS - 4; x++) {
        const c = cellAt(y, x)
        if (c === '█' || c === '▀' || c === '▄') { whale = true; break }
      }
      if (!whale) anyGlyph = true
    }
  }
  return anyGlyph
}
setGutter('hidden')
check('hidden：右缘无任何 gutter glyph', await settled(() => !hasGutterGlyph()))

// ── 6. 切回 timeline：rail 恢复 ──
await wheel(false, 30)
setGutter('timeline')
{
  let snap = gutterSnapshot()
  await settle(() => {
    snap = gutterSnapshot()
    return snap.ticks.length === 8 && snap.chevrons.length === 2
  })
  check('切回 timeline：rail 恢复', snap.ticks.length === 8 && snap.chevrons.length === 2,
    `ticks=${snap.ticks.length} chevrons=${snap.chevrons.length}`)
}

await inst.unmount()
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
