/**
 * repro-thinking-stream-fold — 流式 thinking 行点击展开/折叠复现（用户报告：
 * thinking 流式时点击无效）。
 *
 * 病根：流式 reasoning 行 verbose 恒为 true（`isExpanded || expanded ||
 * streaming`），点击切换的是 expandedRows——显示毫无变化，落定前折叠语义
 * 不存在。修复：流式行走独立的 streamFoldedRows（默认展开，点击折叠到
 * ticker/单行头；再点展开），落定后自动回到默认折叠 + expandedRows 语义。
 *
 * 场景：fullscreen Chat + streaming reasoning 行（thinkingFold=full，即
 * 默认 live 全文），注入 SGR 点击：
 *   1. 初始：思考正文多行可见；
 *   2. 点击头部 → 正文消失（仅 spinner 头行）；
 *   3. 再点 → 正文恢复。
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
  thinkingFold: 'full',
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
check('默认展开：正文多行可见（≥6 行）', bodyLines(ls) >= 6, `body=${bodyLines(ls)}`)

// 点击头行 → 折叠为单行
stdin.write(`\x1b[<0;6;${headerIdx + 1}M`)
stdin.write(`\x1b[<0;6;${headerIdx + 1}m`)
await sleep(400)
ls = lines()
check('点击后正文折叠（0 行正文，头行仍在）', bodyLines(ls) === 0 && headerRow(ls) >= 0, `body=${bodyLines(ls)}`)

// 再点同一行 → 展开。等过 500ms 多击窗：同格快连两次会被判双击选词，
// 这是既有语义——快速连点本来就归选区，不归折叠。
await sleep(300)
const headerIdx2 = headerRow(ls)
stdin.write(`\x1b[<0;6;${headerIdx2 + 1}M`)
stdin.write(`\x1b[<0;6;${headerIdx2 + 1}m`)
await sleep(400)
ls = lines()
check('再点恢复展开（正文回到 ≥6 行）', bodyLines(ls) >= 6, `body=${bodyLines(ls)}`)

await inst.unmount()
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
