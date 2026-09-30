/**
 * Ctrl+C rule scenario (real input path via stdin):
 * 1. type text → ctrl+c clears the input, app keeps running
 * 2. ctrl+c on empty input → arms exit ("Press Ctrl+C again to exit")
 * 3. second ctrl+c → exits
 * 4. working → first ctrl+c only interrupts (cancel runs once), arms the exit window
 * 5. working + cancelPending → next ctrl+c force-exits
 * 6. stuck turn (abort never converges) → next ctrl+c exits anyway (issue #1214)
 * 7. an idle-ladder exit arm plus a turn started inside its window → the
 *    interrupt replaces the arm instead of firing it (review follow-up)
 */
process.env.FORCE_COLOR = '3'
// This script asserts English UI copy; pin the language before any
// module import resolves the startup lang (env > persisted > locale).
process.env.DSH_TUI_LANG = 'en'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, termTest] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('./lib/term-test.mjs'),
])

const COLS = 100
const ROWS = 40
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 50, allowProposedApi: true })

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
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
// 等待/读屏走公共辅助（issue #532）：settle 轮询到预期状态再断言——固定
// sleep 在慢 runner 上会断言到旧屏幕。alt-screen 下 baseY 恒 0，视口读取
// 与旧的 getLine(0..ROWS) 直扫等价。
const { settle, settled } = termTest
const screenHas = (s: string): boolean => termTest.screenHas(term, s)

const listeners = new Set<() => void>()
const channel: any = {
  // 探针确定性：鲸鱼欢迎期闲置动画（默认开）不进本探针的测量窗口。
  whaleIdle: false,
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
  displayCwd: '/tmp/demo',
  gitBranch: 'main',
  working: false,
  cancelPending: false,
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
  notify(msg: string) { channel.notifications.push(msg); bump0() },
  listModels: () => Promise.resolve([]), listSessions: () => [], setResumeTarget: () => {},
  loadOlder: () => {}, mcpStatus: () => [],
}
const bump0 = () => { channel.version++; for (const cb of listeners) cb() }

let exited = false
const stdinObj = new FakeStdin()
const instance = await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} onExit={() => { exited = true }} />
  </AlternateScreen>,
  { stdout: new FakeStdout(), stdin: stdinObj, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
)
await settle(() => termTest.viewportLines(term).some(l => l.trim().length > 0))

let failed = 0
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}

// 1. type text, ctrl+c → cleared, no exit, no exit-arm notification
stdinObj.write('hello world')
check('typed text visible in prompt', await settled(() => screenHas('hello world')))
stdinObj.write('\x03')
check('ctrl+c clears non-empty input', await settled(() => !screenHas('hello world')))
check('ctrl+c with text does not exit', !exited)
check('ctrl+c with text does not arm exit', !screenHas('Press Ctrl+C again'), JSON.stringify(channel.notifications))

// 2. ctrl+c on empty input → arms exit
stdinObj.write('\x03')
check('ctrl+c on empty input arms exit', await settled(() => screenHas('Press Ctrl+C again') || channel.notifications.length > 0), JSON.stringify(channel.notifications))
check('first press does not exit', !exited)

// 3. second press exits
stdinObj.write('\x03')
check('second ctrl+c exits', await settled(() => exited))

// 4. working + first ctrl+c → only interrupts (cancel runs once), no exit
exited = false
channel.working = true
channel.cancelPending = false
let cancels = 0
channel.cancel = () => {
  cancels += 1
  channel.cancelPending = true
  bump0()
}
stdinObj.write('\x03')
await settle(() => cancels === 1)
check('ctrl+c while working interrupts', cancels === 1)
check('interrupt press does not exit', !exited)

// 5. working + cancelPending → the next press force-exits
stdinObj.write('\x03')
await settle(() => exited)
check('second ctrl+c while the abort is pending force-exits', exited)

// 6. stuck turn (issue #1214): the abort never converges into cancelPending
// (a tool call that never settles, a silent stream) — a second ctrl+c within
// the exit window must still leave instead of re-cancelling forever.
exited = false
channel.working = true
channel.cancelPending = false
cancels = 0
channel.cancel = () => {
  cancels += 1
  bump0()
}
stdinObj.write('\x03')
await settle(() => cancels === 1)
check('stuck turn: first ctrl+c interrupts without exiting', cancels === 1 && !exited)
stdinObj.write('\x03')
check('stuck turn: second ctrl+c exits regardless of cancelPending', await settled(() => exited))

// 7. review follow-up: an idle-ladder exit arm (empty-input press) must not
// fire under a turn that starts inside its window — the interrupt replaces
// it with a fresh arm + notify, and the replaced ladder still exits on its
// own second press.
exited = false
channel.working = false
channel.cancelPending = false
cancels = 0
channel.cancel = () => {
  cancels += 1
  channel.cancelPending = true
  bump0()
}
stdinObj.write('\x03')
const idleArmNotifies = channel.notifications.length
await settle(() => channel.notifications.length > idleArmNotifies)
check('idle arm notifies without exiting', !exited && channel.notifications.length > idleArmNotifies)
channel.working = true
bump0()
stdinObj.write('\x03')
await settle(() => cancels === 1)
check('interrupt replaces the stale idle arm instead of exiting',
  cancels === 1 && !exited && channel.notifications.length > idleArmNotifies + 1)
stdinObj.write('\x03')
check('the replaced ladder still exits on its own second press', await settled(() => exited))

await instance.unmount()
process.exit(failed)
