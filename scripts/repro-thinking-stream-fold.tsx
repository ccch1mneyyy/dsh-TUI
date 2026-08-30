/**
 * repro-thinking-stream-fold — 流式 thinking 行三行预览/全文切换回归。
 *
 * 用户报告：thinkingFold=preview 时默认能看到三行，但点击后正文变成
 * 0 行，只剩 spinner 头；期望点击展开全文，再点收回三行预览。
 *
 * 场景：fullscreen Chat + streaming reasoning 行（thinkingFold=preview），
 * 注入 SGR 点击：
 *   1. 初始：固定三行最新思考预览；
 *   2. 点击头部 → 展开完整正文；
 *   3. 再点 → 收回三行预览（而不是隐藏正文）；
 *   4. full 默认全文，点击同样只收为三行预览。
 *
 * 运行：node --import tsx/esm scripts/repro-thinking-stream-fold.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { LOCAL_COMMANDS }] = await Promise.all([
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

const BODY = Array.from({ length: 12 }, (_, i) => `推理第${i}行：探索未至之境`).join('\n')
const listeners = new Set<() => void>()
const channel: any = {
  version: 0,
  rows: [{ id: 1, kind: 'reasoning', text: BODY, streaming: true }],
  status: 'idle',
  sessionTitle: 'probe',
  agentId: 'probe',
  model: 'deepseek-v4-flash',
  provider: 'deepseek',
  reasoningEffort: 'max',
  effortLevels: [],
  tokens: { input: 0, output: 0 },
  cwd: '/tmp/demo',
  displayCwd: '/tmp/demo',
  gitBranch: 'main',
  working: true,
  spinnerMode: 'requesting',
  responseChars: 0,
  activeToolCount: 0,
  turnStart: 0,
  pending: [],
  commandList: LOCAL_COMMANDS,
  notifications: [],
  mode: { plan: false, sandbox: undefined },
  activityFrames: 'claude',
  agentPreset: undefined,
  thinkingFold: 'preview',
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {},
  cancel: () => {},
  clear: () => {},
  notify: () => {},
  listModels: () => Promise.resolve([]),
  listSessions: () => [],
  setResumeTarget: () => {},
  loadOlder: () => {},
  mcpStatus: () => [],
  pushLocal: () => {},
  commandCompletions: () => [],
}

const inst = await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} />
  </AlternateScreen>,
  { stdout: stdout as any, stdin: stdin as any, stderr: stderr as any, exitOnCtrlC: false, patchConsole: false },
)
await sleep(600)

const lines = () => {
  const buf = term.buffer.active
  return Array.from({ length: ROWS }, (_, y) => buf.getLine(buf.baseY + y)?.translateToString(true) ?? '')
}
const bodyLines = (ls: string[]) => ls.filter(l => l.includes('推理第')).length
const headerRow = (ls: string[]) => ls.findIndex(l => l.includes('Thinking') || l.includes('思考'))

let ls = lines()
const headerIdx = headerRow(ls)
check('流式思考头行可见', headerIdx >= 0, headerIdx >= 0 ? `行${headerIdx}` : '未找到')
check('默认三行预览', bodyLines(ls) === 3, `body=${bodyLines(ls)}`)
check('预览跟随最新三行', ls.some(line => line.includes('推理第11行')), '应包含推理第11行')

// 点击头行 → 展开全文。
stdin.write(`\x1b[<0;6;${headerIdx + 1}M`)
stdin.write(`\x1b[<0;6;${headerIdx + 1}m`)
await sleep(400)
ls = lines()
check('点击后展开完整正文', bodyLines(ls) >= 10, `body=${bodyLines(ls)}`)

// 再点同一行 → 收回三行预览。等过 500ms 多击窗：同格快连两次会被判
// 双击选词，这是既有语义——快速连点归选区，不归折叠。
await sleep(300)
const headerIdx2 = headerRow(ls)
stdin.write(`\x1b[<0;6;${headerIdx2 + 1}M`)
stdin.write(`\x1b[<0;6;${headerIdx2 + 1}m`)
await sleep(400)
ls = lines()
check('再点收回三行预览', bodyLines(ls) === 3, `body=${bodyLines(ls)}`)
check('收起后不会隐藏全部正文', bodyLines(ls) > 0, `body=${bodyLines(ls)}`)

// full 只是默认值相反：仍然只在全文/三行预览间切换，不再进入 0 行正文。
channel.thinkingFold = 'full'
channel.version += 1
for (const listener of listeners) listener()
await sleep(400)
ls = lines()
check('full 设置默认展开全文', bodyLines(ls) >= 10, `body=${bodyLines(ls)}`)

await sleep(200)
const fullHeaderIdx = headerRow(ls)
stdin.write(`\x1b[<0;6;${fullHeaderIdx + 1}M`)
stdin.write(`\x1b[<0;6;${fullHeaderIdx + 1}m`)
await sleep(400)
ls = lines()
check('full 设置点击后收为三行预览', bodyLines(ls) === 3, `body=${bodyLines(ls)}`)

await inst.unmount()
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
