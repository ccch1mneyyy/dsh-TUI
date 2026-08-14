/**
 * Ctrl+C rule scenario (real input path via stdin):
 * 1. type text → ctrl+c clears the input, app keeps running
 * 2. ctrl+c on empty input → arms exit ("Press Ctrl+C again to exit")
 * 3. second ctrl+c → exits
 */
process.env.FORCE_COLOR = '3'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/questions.js'),
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
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
function screenHas(s: string): boolean {
  const buf = term.buffer.active
  for (let y = 0; y < ROWS; y++) {
    if ((buf.getLine(y)?.translateToString(true) ?? '').includes(s)) return true
  }
  return false
}

const listeners = new Set<() => void>()
const channel: any = {
  version: 0,
  rows: [],
  status: 'idle',
  sessionTitle: 'probe',
  agentId: 'probe',
  model: 'deepseek-v4-flash',
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
await sleep(600)

let failed = 0
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}

// 1. type text, ctrl+c → cleared, no exit, no exit-arm notification
stdinObj.write('hello world')
await sleep(400)
check('typed text visible in prompt', screenHas('hello world'))
stdinObj.write('\x03')
await sleep(400)
check('ctrl+c clears non-empty input', !screenHas('hello world'))
check('ctrl+c with text does not exit', !exited)
check('ctrl+c with text does not arm exit', !screenHas('Press Ctrl+C again'), JSON.stringify(channel.notifications))

// 2. ctrl+c on empty input → arms exit
stdinObj.write('\x03')
await sleep(400)
check('ctrl+c on empty input arms exit', screenHas('Press Ctrl+C again') || channel.notifications.length > 0, JSON.stringify(channel.notifications))
check('first press does not exit', !exited)

// 3. second press exits
stdinObj.write('\x03')
await sleep(400)
check('second ctrl+c exits', exited)

await instance.unmount()
process.exit(failed)
