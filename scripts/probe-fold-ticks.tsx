/** 探针：工具重会话（300 行折叠窗口内只有少量 user 轮）的 rail 节点数。 */
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

// 模拟真实工具重会话：每轮 = user + 50 个工具行 + assistant（~52 行/轮）。
// 12 轮 = 624 行 > 300 → 折叠窗口只留最后 300 行 ≈ 5-6 轮。
const rows: any[] = []
let id = 0
for (let turn = 1; turn <= 12; turn++) {
  rows.push({ id: ++id, kind: 'user', text: `问题 ${turn}` })
  for (let t = 0; t < 50; t++) {
    rows.push({
      id: ++id, kind: 'tool', text: '',
      tool: {
        callId: `t${turn}-${t}`, name: 'Read',
        argsText: `{"file_path": "/tmp/f${t}.ts"}`, argsFull: '{}',
        status: 'ok', startedAt: 0, durationMs: 30,
        resultText: `文件 ${t} 内容行 1\n文件 ${t} 内容行 2`,
      },
    })
  }
  rows.push({ id: ++id, kind: 'assistant', text: `回复 ${turn} 完毕。` })
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
  activityFrames: 'claude', agentPreset: undefined, subagents: [], lastUserText: '问题 12',
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
await sleep(900)

const buf = term.buffer.active
const rail: string[] = []
for (let y = 0; y < ROWS; y++) {
  rail.push((buf.getLine(buf.baseY + y)?.getCell(COLS - 2)?.getChars() ?? '') + (buf.getLine(buf.baseY + y)?.getCell(COLS - 1)?.getChars() ?? ''))
}
const all = rail.join('')
console.log(`rail 列 40 行：`)
rail.forEach((r, y) => { if (r !== '  ') console.log(`${String(y).padStart(2)}|[${r}]`) })
console.log(`tick 数（─+━）= ${all.split('─').length - 1 + all.split('━').length - 1}（会话共 12 轮）`)
console.log(`可见的「问题 N」编号：`, Array.from(new Set(Array.from({ length: ROWS }, (_, y) => buf.getLine(buf.baseY + y)?.translateToString(true) ?? '').join('\n').matchAll(/问题 (\d+)/g).map(m => Number(m[1])))).sort((a, b) => a - b).join(','))

await inst.unmount()
process.exit(0)
