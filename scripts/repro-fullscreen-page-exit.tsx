/**
 * repro-fullscreen-page-exit — 全屏模式下整屏页面退出后掉回主屏的稳定复现
 * （用户报告：进入 /resume 之类的整屏页面后 Esc 退回，稳定复现“退出
 * fullscreen、失去鼠标交互”）。
 *
 * 全屏模式结构：根 <AlternateScreen>（plugin.ts 包裹）+ Chat
 * fullscreen={true}——整屏页面（/resume、/settings、轨迹、子代理）在
 * Chat 里【不再】各自包 AlternateScreen（防嵌套 1049）。理论上开关页面
 * 不应产生任何 1049/鼠标模式写。
 *
 * 本复现驱动：/resume + Enter 打开浏览器 → Esc 退回，断言：
 *   1. 全程 buffer 保持 alternate（无 ?1049l）；
 *   2. 鼠标跟踪未被关（无 ?1000l/?1006l）；
 *   3. 退回后主对话仍可交互（再输入字符到达输入框）。
 * 任一失败即把 boot 以来的全部模式序列写入 stdout 定位肇事者。
 *
 * 运行：node --import tsx/esm scripts/repro-fullscreen-page-exit.tsx
 */
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
let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const writes: string[] = []
class FakeStdout extends Writable {
  columns = COLS; rows = ROWS; isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    writes.push(String(chunk))
    term.write(String(chunk), cb)
  }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const stdin = new FakeStdin(), stdout = new FakeStdout(), stderr = new FakeStderr()

const listeners = new Set<() => void>()
const channel: any = {
  version: 0,
  rows: [],
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
  working: false,
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
  subagents: [],
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {},
  cancel: () => {},
  clear: () => {},
  notify: () => {},
  listModels: () => Promise.resolve([]),
  listSessions: () => Promise.resolve([]),
  deleteSession: () => Promise.resolve(true),
  renameSessionTo: () => Promise.resolve(true),
  setResumeTarget: () => {},
  loadOlder: () => {},
  mcpStatus: () => [],
  pushLocal: () => {},
  commandCompletions: (input: string) => completeCommands(input),
}

// 全屏结构：根 AlternateScreen + fullscreen Chat（与 plugin.ts 948 一致）
const inst = await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} fullscreen />
  </AlternateScreen>,
  { stdout: stdout as any, stdin: stdin as any, stderr: stderr as any, exitOnCtrlC: false, patchConsole: false },
)
await sleep(700)
check('boot 后进入 alternate buffer', term.buffer.active.type === 'alternate', term.buffer.active.type)
writes.length = 0 // 只监控 boot 之后的模式写

// 打开 /resume
stdin.write('/resume')
await sleep(350)
stdin.write('\r')
await sleep(500)
const browserShown = term.buffer.active.type === 'alternate'
let lines = screenLines()
const resumeTitle = lines.some(l => l.includes('恢复') || l.includes('Resume') || l.includes('会话'))
check('/resume 打开整屏浏览器', browserShown && resumeTitle,
  `type=${term.buffer.active.type} title=${resumeTitle}`)

// Esc 退回
stdin.write('\x1b')
await sleep(500)
const afterType = term.buffer.active.type
check('Esc 退回后 buffer 仍是 alternate（未掉出全屏）', afterType === 'alternate', `type=${afterType}`)

const exitAlt = writes.filter(w => w.includes('\x1b[?1049l'))
const mouseOff = writes.filter(w => /\x1b\[\?(1000|1002|1003|1006)l/.test(w))
check('全程无 EXIT_ALT_SCREEN 写', exitAlt.length === 0, exitAlt.map(w => JSON.stringify(w.slice(0, 40))).join(' ').slice(0, 80))
check('全程无鼠标跟踪关闭写', mouseOff.length === 0, mouseOff.map(w => JSON.stringify(w.slice(0, 40))).join(' ').slice(0, 80))

// 退回后主对话仍活着：输入字符应出现在输入框
stdin.write('zz')
await sleep(400)
lines = screenLines()
check('退回后输入框仍可交互', lines.some(l => l.includes('❯ z') || lines.some(x => x.includes('zz'))),
  (lines.find(l => l.includes('❯')) ?? '').trimEnd().slice(0, 30))

if (failed > 0) {
  console.log('--- boot 以来的模式相关写（前 30 条）---')
  for (const w of writes.slice(0, 30)) {
    if (/1049|1000|1002|1003|1006/.test(w)) console.log('   ', JSON.stringify(w.slice(0, 70)))
  }
}

function screenLines(): string[] {
  const buf = term.buffer.active
  return Array.from({ length: ROWS }, (_, y) => buf.getLine(buf.baseY + y)?.translateToString(true) ?? '')
}

await inst.unmount()
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
