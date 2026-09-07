/** 探针：滚动中 rail 列与悬停卡区域的残影。 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { LOCAL_COMMANDS, completeCommands }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
])

const COLS = 100, ROWS = 40
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
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
  // 探针确定性：鲸鱼欢迎期闲置动画（默认开）不进本探针的测量窗口。
  whaleIdle: false,
  version: 0, rows, status: 'idle', sessionTitle: 'probe', agentId: 'probe',
  model: 'deepseek-v4-flash', provider: 'deepseek', reasoningEffort: 'max', effortLevels: [],
  tokens: { input: 0, output: 0 }, cwd: '/tmp/demo', displayCwd: '/tmp/demo', gitBranch: 'main',
  working: false, spinnerMode: 'requesting', responseChars: 0, activeToolCount: 0, turnStart: 0,
  pending: [], commandList: LOCAL_COMMANDS, notifications: [], mode: { plan: false, sandbox: undefined },
  activityFrames: 'claude', agentPreset: undefined, subagents: [], lastUserText: '问题 8',
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => Promise.resolve([]),
  deleteSession: () => Promise.resolve(true), renameSessionTo: () => Promise.resolve(true),
  setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [], pushLocal: () => {},
  commandCompletions: (input: string) => completeCommands(input),
}

const inst = await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} fullscreen />
  </AlternateScreen>,
  { stdout: stdout as any, stdin: stdin as any, stderr: stderr as any, exitOnCtrlC: false, patchConsole: false },
)
await sleep(700)

function railCol(y: number, offset = 0): string {
  const buf = term.buffer.active
  return (buf.getLine(buf.baseY + y)?.getCell(COLS - 2 + offset)?.getChars() ?? '')
}
function railColStr(): string {
  return Array.from({ length: ROWS }, (_, y) => railCol(y) + railCol(y, 1)).join('')
}
/** rail 列里非空白 glyph 总数（残影 = 超过预期的 ─/━━/▴/▾ 数量）。 */
function countGlyph(s: string, ch: string): number {
  return s.split(ch).length - 1
}

console.log('== 阶段 1：无悬停，快速上滚 ==')
const settledBefore = railColStr()
const midSamples: string[] = []
for (let burst = 0; burst < 3; burst++) {
  for (let i = 0; i < 15; i++) {
    stdin.write('\x1b[<64;90;30M')
    await sleep(6)
  }
  midSamples.push(railColStr())
  await sleep(60)
}
await sleep(600) // 充分排空
console.log('== 排空后原子快照（rail 逐行 + 全屏摘要，同一次读取）==')
{
  const buf = term.buffer.active
  const railCells: string[] = []
  const heads: string[] = []
  for (let y = 0; y < ROWS; y++) {
    const a = buf.getLine(buf.baseY + y)?.getCell(COLS - 2)?.getChars() ?? ''
    const b = buf.getLine(buf.baseY + y)?.getCell(COLS - 1)?.getChars() ?? ''
    railCells.push(a + b)
    heads.push((buf.getLine(buf.baseY + y)?.translateToString(true) ?? '').slice(0, 24))
  }
  for (let y = 0; y < ROWS; y++) {
    if (railCells[y] !== '  ') console.log(`${String(y).padStart(2)}| rail=${JSON.stringify(railCells[y])}  head=${JSON.stringify(heads[y])}`)
  }
  console.log(`轻─=${railCells.join('').split('─').length - 1} 重━=${railCells.join('').split('━').length - 1}`)
  const again: string[] = []
  for (let y = 0; y < ROWS; y++) {
    again.push((buf.getLine(buf.baseY + y)?.getCell(COLS - 2)?.getChars() ?? '') + (buf.getLine(buf.baseY + y)?.getCell(COLS - 1)?.getChars() ?? ''))
  }
  console.log(`立即复读相同: ${again.join('') === railCells.join('')}`)
  await sleep(300)
  const third: string[] = []
  for (let y = 0; y < ROWS; y++) {
    third.push((buf.getLine(buf.baseY + y)?.getCell(COLS - 2)?.getChars() ?? '') + (buf.getLine(buf.baseY + y)?.getCell(COLS - 1)?.getChars() ?? ''))
  }
  console.log(`300ms 后仍相同: ${third.join('') === railCells.join('')}  轻─=${third.join('').split('─').length - 1}`)
}
process.exit(0)

console.log('== 阶段 2：悬停 tick 上滚动 ==')
// 悬停第 4 个 tick
stdin.write('\x1b[<35;100;18M')
await sleep(300)
const withCard = railColStr()
console.log(`悬停后 rail 列轻─=${countGlyph(withCard, '─')} 重━=${countGlyph(withCard, '━')}`)
// 卡在 rail 左侧：采样 84..98 列找圆角边框
function cardRegion(): string[] {
  const buf = term.buffer.active
  return Array.from({ length: ROWS }, (_, y) => {
    let s = ''
    for (let x = 80; x < 98; x++) s += buf.getLine(buf.baseY + y)?.getCell(x)?.getChars() ?? ''
    return s
  })
}
const cardRows = cardRegion().filter(l => /[╭╮╰╯│]/.test(l))
console.log(`悬停卡行数=${cardRows.length}（期望 3）`)
// 滚动（指针不动 → hover 保持，窗口滑动卡跟随）
for (let i = 0; i < 10; i++) {
  stdin.write('\x1b[<64;90;30M')
  await sleep(8)
}
await sleep(200)
const cardRowsDuring = cardRegion().filter(l => /[╭╮╰╯│]/.test(l))
console.log(`滚动中卡行数=${cardRowsDuring.length}`)
// 移开悬停
stdin.write('\x1b[<35;30;20M')
await sleep(300)
const cardRowsAfter = cardRegion().filter(l => /[╭╮╰╯│]/.test(l))
console.log(`移开后卡残留行数=${cardRowsAfter.length}（期望 0）`)
if (cardRowsAfter.length > 0) console.log(`  残留内容: ${JSON.stringify(cardRowsAfter)}`)

console.log('== 阶段 3：滚回底部 ==')
for (let i = 0; i < 40; i++) {
  stdin.write('\x1b[<65;90;30M')
  await sleep(6)
}
await sleep(300)
const final = railColStr()
console.log(`最终 rail 列: 轻─=${countGlyph(final, '─')} 重━=${countGlyph(final, '━')} ▴=${countGlyph(final, '▴')} ▾=${countGlyph(final, '▾')}`)

await inst.unmount()
process.exit(0)
