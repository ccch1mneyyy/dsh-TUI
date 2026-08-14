/**
 * Pill decrement scenario: pre-seed rows, wheel up, push 8 new rows, then
 * wheel down step by step — the "↓ N new messages" count must decrease as
 * new rows enter the viewport and vanish at the bottom (not stay pinned
 * at 8 until the exact bottom). Drives the REAL input path: SGR wheel
 * sequences on stdin → Chat wheel handler → ScrollBox.scrollBy.
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
function pillText(): string {
  const buf = term.buffer.active
  for (let y = 0; y < ROWS; y++) {
    const l = buf.getLine(y)?.translateToString(true) ?? ''
    if (l.includes('new message')) return l.trim()
  }
  return ''
}

const listeners = new Set<() => void>()
const channel: any = {
  version: 0,
  rows: [] as any[],
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
  submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => [], setResumeTarget: () => {},
  loadOlder: () => {}, mcpStatus: () => [],
}
const bump = () => { channel.version++; for (const cb of listeners) cb() }

let id = 0
const addRows = (n: number) => {
  for (let i = 0; i < n; i++) {
    channel.rows.push({ id: id++, kind: 'assistant', text: `消息 ${id}: 短内容`, streaming: false })
  }
  bump()
}
addRows(30)

const stdinObj = new FakeStdin()
const instance = await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} />
  </AlternateScreen>,
  { stdout: new FakeStdout(), stdin: stdinObj, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
)
await sleep(600)

// SGR mouse: 64=wheel up, 65=wheel down; position inside the scroll area.
const wheel = (dir: 'up' | 'down', clicks = 1) => {
  for (let i = 0; i < clicks; i++) stdinObj.write(`\x1b[<${dir === 'up' ? 64 : 65};50;10M`)
}

let failed = 0
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}

check('at bottom: no pill initially', pillText() === '', JSON.stringify(pillText()))

// scroll well up, then 8 new rows arrive
wheel('up', 6)
await sleep(500)
addRows(8)
await sleep(500)
const pill0 = pillText()
check('pill appears with the new-message count', /8 new messages/.test(pill0), pill0)

// wheel down in small steps: the count must DECREASE monotonically
const seen: string[] = []
let prev = 8
let monotonic = true
for (let step = 0; step < 12; step++) {
  wheel('down', 2)
  await sleep(300)
  const t = pillText()
  seen.push(t === '' ? 'gone' : t.match(/(\d+) new/)?.[1] ?? '?')
  const n = t === '' ? 0 : parseInt(t.match(/(\d+) new/)?.[1] ?? '99', 10)
  if (n > prev) monotonic = false
  prev = n
}
check('count decrements while scrolling down (not pinned at max)', seen.some(v => v !== 'gone' && v !== '8') , seen.join(' → '))
check('count never increases while scrolling down', monotonic, seen.join(' → '))
check('pill gone at the bottom', pillText() === '', JSON.stringify(pillText()))

await instance.unmount()
process.exit(failed)
