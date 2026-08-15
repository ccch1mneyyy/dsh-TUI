/**
 * Ctrl+V clipboard paste UI scenario (real input path via stdin, real
 * clipboard read against a stub wl-paste on PATH):
 * 1. '?' opens the help overlay → Ctrl+V closes it BEFORE the async read
 *    resolves (overlay/selection dismissal matches insertAtCaret's side
 *    effects — a paste must never land behind the help panel)
 * 2. the stub clipboard text lands in the prompt
 * 3. a second Ctrl+V pastes again — the busy latch was released after the
 *    first read (a stuck latch would silently eat the second press)
 *
 * Linux-only: stubs the wl-paste backend via PATH.
 */
process.env.FORCE_COLOR = '3'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { mkdtempSync, writeFileSync, rmSync }, { tmpdir }, { join }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/questions.js'),
  import('node:fs'),
  import('node:os'),
  import('node:path'),
])

if (process.platform !== 'linux') {
  console.log('SKIP: repro-clipboard (Linux-only wl-paste stub)')
  process.exit(0)
}

// A wl-paste stub serving fixed CJK text; the clipboard module reads env
// at call time, so point PATH/WAYLAND_DISPLAY at it before any Ctrl+V.
const stubDir = mkdtempSync(join(tmpdir(), 'repro-clipboard-stub-'))
writeFileSync(
  join(stubDir, 'wl-paste'),
  `#!/bin/sh
if [ "$1" = "--version" ]; then echo stub; exit 0; fi
if [ "$1" = "--list-types" ]; then printf 'text/plain\\n'; exit 0; fi
printf 'UI粘贴内容'
`,
  { mode: 0o755 },
)
const savedEnv = { PATH: process.env.PATH, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, DISPLAY: process.env.DISPLAY }
process.env.PATH = stubDir
process.env.WAYLAND_DISPLAY = 'wayland-repro-clipboard'
delete process.env.DISPLAY

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
  notify(msg: string) { channel.notifications.push(msg); bump0() },
  listModels: () => Promise.resolve([]), listSessions: () => [], setResumeTarget: () => {},
  loadOlder: () => {}, mcpStatus: () => [],
}
const bump0 = () => { channel.version++; for (const cb of listeners) cb() }

const stdinObj = new FakeStdin()
const instance = await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} onExit={() => {}} />
  </AlternateScreen>,
  { stdout: new FakeStdout(), stdin: stdinObj, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
)
await sleep(600)

let failed = 0
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}

try {
  // 1. '?' opens the help overlay; Ctrl+V must close it up front.
  stdinObj.write('?')
  await sleep(400)
  check('? opens the help overlay', screenHas('? for this help'))
  stdinObj.write('\x16')
  await sleep(300)
  check('Ctrl+V closes the help overlay before the read resolves', !screenHas('? for this help'))

  // 2. The stub clipboard text lands in the prompt.
  await sleep(600)
  check('clipboard text lands in the prompt', screenHas('UI粘贴内容'))

  // 3. Busy latch released: a second Ctrl+V pastes again (doubled text).
  stdinObj.write('\x16')
  await sleep(800)
  check('second Ctrl+V pastes again (busy latch released)', screenHas('UI粘贴内容UI粘贴内容'))
} finally {
  await instance.unmount()
  rmSync(stubDir, { recursive: true, force: true })
  if (savedEnv.PATH === undefined) delete process.env.PATH
  else process.env.PATH = savedEnv.PATH
  if (savedEnv.WAYLAND_DISPLAY === undefined) delete process.env.WAYLAND_DISPLAY
  else process.env.WAYLAND_DISPLAY = savedEnv.WAYLAND_DISPLAY
  if (savedEnv.DISPLAY === undefined) delete process.env.DISPLAY
  else process.env.DISPLAY = savedEnv.DISPLAY
}
process.exit(failed)
