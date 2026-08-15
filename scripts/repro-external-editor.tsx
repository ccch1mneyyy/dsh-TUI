/**
 * 外部编辑器 TTY 交接回归（issue #123 实机冒烟发现的三个 bug）：
 *
 * 1. 退出编辑器后 transcript 空白，发消息才重绘——vim 系编辑器的 rmcup
 *    已把我们弹回主屏，exitAlternateScreen 的 2J 落在主屏把内容擦了，
 *    而 inline 分支只调 repaint() 没置 prevFrameContaminated，blit 快路径
 *    从空 frontFrame 拷贝 → diff 无输出 → 空白。
 * 2. 输入框被清空只剩个 'i'——交接窗口的残留/晚到字节被解析成输入：
 *    游离 ESC 触发"单击清空"，其余字节落为文本。
 * 3. 乱码（如 [48;93;223;1953;2453）——同理，终端应答残片插入输入框。
 *
 * 本测试用 xterm headless + 假编辑器（node 子进程）端到端复现：
 * - 编辑器会话期间向 stdin 写入 '\x1b\x1b'（缓冲到恢复时若无 drain/
 *   抑制，双击 Esc 会清空输入并打开 rewind 选择器）
 * - 会话期间对 xterm writeSync rmcup（\x1b[?1049l），模拟 nvim 退出把
 *   终端弹回主屏，让我们的 2J 落在主屏（bug 1 的现场条件）
 * - 拦截 FakeStdout 里的 1049l（恢复流程起点），setImmediate 注入"晚到"
 *   终端应答乱码 + 'i'（落在 120ms 抑制窗口内，确定性覆盖 bug 2/3）
 *
 * Run: node --import tsx/esm scripts/repro-external-editor.tsx
 */
process.env.FORCE_COLOR = '3'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { writeFileSync, mkdtempSync, rmSync }, { tmpdir }, { join }, { render }, { Chat }, { QuestionStore }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('node:fs'),
  import('node:os'),
  import('node:path'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/questions.js'),
])

const COLS = 100
const ROWS = 40
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 50, allowProposedApi: true })

// 看到恢复流程的 1049l 时，立刻注入"晚到的终端应答"——此时
// suppressInputFor 已在同一同步块内武装完毕，乱码必然落在窗口内。
let lateGarbageInjected = false
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    const s = String(chunk)
    if (!lateGarbageInjected && s.includes('\x1b[?1049l')) {
      lateGarbageInjected = true
      setImmediate(() => stdinObj.write('\x1b[48;93;223;1953;2453u'))
      setImmediate(() => stdinObj.write('i'))
    }
    term.write(s, cb)
  }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const stdinObj = new FakeStdin()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
function screenHas(s: string): boolean {
  const buf = term.buffer.active
  for (let y = 0; y < ROWS; y++) {
    if ((buf.getLine(y)?.translateToString(true) ?? '').includes(s)) return true
  }
  return false
}

const listeners = new Set<() => void>()
let rowId = 0
const channel: any = {
  version: 0,
  rows: [],
  status: 'idle',
  sessionTitle: 'probe',
  agentId: 'probe',
  model: 'deepseek-v4-flash',
  mode: { plan: false },
  reasoningEffort: 'max',
  tokens: { input: 1, output: 1 },
  cwd: '/tmp/demo',
  gitBranch: 'main',
  working: false,
  spinnerMode: 'requesting',
  responseChars: 0,
  activeToolCount: 0,
  turnStart: Date.now(),
  lastUserText: '',
  pending: [],
  commandList: [],
  notifications: [],
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {}, cancel: () => {}, clear: () => {},
  steer: () => {}, interruptAndDeliver: () => 0, removePending: () => true,
  cycleMode: () => Promise.resolve(), listFiles: () => Promise.resolve([]),
  notify(msg: string) { channel.notifications.push(msg); bump() },
  listModels: () => Promise.resolve([]), listSessions: () => [], setResumeTarget: () => {},
  loadOlder: () => {}, mcpStatus: () => [],
}
const bump = () => { channel.version++; for (const cb of listeners) cb() }

// 假编辑器：睡 600ms（覆盖整个交接注入窗口）后把 ' EDITED' 追加进草稿。
const scratch = mkdtempSync(join(tmpdir(), 'dsh-tui-repro-editor-'))
const helper = join(scratch, 'fake-editor.cjs')
writeFileSync(helper, `
const fs = require('node:fs')
const file = process.argv[2]
setTimeout(() => { fs.appendFileSync(file, ' EDITED') }, 600)
`)
const savedEditor = process.env.EDITOR
delete process.env.VISUAL
process.env.EDITOR = `"${process.execPath}" "${helper}"`

const instance = await render(
  <Chat channel={channel} questionStore={new QuestionStore()} onExit={() => {}} />,
  { stdout: new FakeStdout(), stdin: stdinObj, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
)
await sleep(600)

let failed = 0
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}

// 预备：transcript 放一条历史消息（bug 1 的断言目标——空白的是它），
// 输入框打上草稿。
channel.rows.push({ id: rowId++, kind: 'user', text: 'transcript-anchor-历史消息' })
bump()
await sleep(300)
check('预备: transcript 历史消息可见', screenHas('transcript-anchor'))

stdinObj.write('什么是cordis')
await sleep(300)
check('预备: 草稿已入输入框', screenHas('什么是cordis'))

// Ctrl+X → 假编辑器（600ms 后写盘退出）
stdinObj.write('\x18')
await sleep(250)
// 交接会话期间的残留字节：若无 drain/抑制，恢复后双击 Esc = 清输入 +
// 空输入再 Esc = 打开 rewind 选择器。
stdinObj.write('\x1b\x1b')
await sleep(100)
// 模拟 nvim 的 rmcup：终端被弹回主屏，随后我们的 2J 将落在主屏上。
// write 回调在 xterm 解析完毕后触发，保证与后续 2J 的先后顺序。
await new Promise<void>(resolve => term.write('\x1b[?1049l', resolve))

// 等回填完成（编辑器 600ms 写盘 + 往返）
let roundTripped = false
for (let i = 0; i < 100; i++) {
  await sleep(50)
  if (screenHas('什么是cordis EDITED')) { roundTripped = true; break }
}
check('往返: 编辑结果回填输入框', roundTripped)
// 让晚到乱码（FakeStdout 注入）与任何延迟副作用落定
await sleep(600)

check('bug1: transcript 历史消息仍可见（全量重绘）', screenHas('transcript-anchor'))
check('bug2: 输入框内容完整（未被 ESC 清空）', screenHas('什么是cordis EDITED'))
check('bug2: rewind 选择器未被残留双击 Esc 打开', !screenHas('Pick a message to rewind'))
check('bug3: 终端应答残片未落入界面', !screenHas('48;93') && !screenHas('2453'))

// 活性：抑制窗口已过的正常输入必须可用
stdinObj.write('X')
await sleep(300)
check('活性: 抑制窗口结束后输入正常', screenHas('什么是cordis EDITEDX'))

if (savedEditor === undefined) delete process.env.EDITOR
else process.env.EDITOR = savedEditor
rmSync(scratch, { recursive: true, force: true })
await instance.unmount()
process.exit(failed)
