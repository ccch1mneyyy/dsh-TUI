/**
 * Session-switch viewport regression (issue #375): a long conversation
 * leaves the ScrollBox at a large scrollTop. Replacing it with an empty
 * `/new` session must put the new session header (including the whale) back
 * in the viewport immediately, before the user sends another message.
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'
process.env.TERM_PROGRAM = 'WezTerm'
process.env.DSH_TUI_THEME = 'dark'

// `createChannel` touches the session MRU marker; keep the probe away from the
// developer's real DSH home on every platform.
const [{ mkdtempSync }, { tmpdir }, { join }] = await Promise.all([
  import('node:fs'),
  import('node:os'),
  import('node:path'),
])
const testHome = mkdtempSync(join(tmpdir(), 'dsh-tui-375-'))
process.env.HOME = testHome
process.env.USERPROFILE = testHome

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { createRoot }, { default: instances }, { Chat }, { QuestionStore }, { createChannel }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/ink/instances.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/channel.js'),
])

const COLS = 100
const ROWS = 32
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 500, allowProposedApi: true })
const decoyTerm = new XTerm({ cols: COLS, rows: ROWS, scrollback: 50, allowProposedApi: true })
type HeadlessTerminal = InstanceType<typeof XTerm>

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  constructor(private readonly terminal: HeadlessTerminal) {
    super()
  }
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    this.terminal.write(String(chunk), callback)
  }
}

class FakeStderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void) { callback() }
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

let seq = 0
let now = Date.now()
const event = (type: string, data: Record<string, unknown>) => ({ seq: seq++, time: ++now, type, data })
const oldEvents: Array<Record<string, unknown>> = []
for (let turn = 0; turn < 24; turn++) {
  oldEvents.push(event('turn/start', { turn }))
  oldEvents.push(event('user/message', {
    source: { kind: 'user' },
    content: [{ type: 'text', text: `旧会话问题 ${turn + 1}` }],
  }))
  oldEvents.push(event('assistant/message', {
    turn,
    step: 0,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: `旧会话回答 ${turn + 1}：用于把欢迎页推离当前视口。` }],
    },
    usage: { inputTokens: 10, outputTokens: 10 },
  }))
  oldEvents.push(event('turn/end', { turn, reason: { kind: 'completed' } }))
}

const agentCtx = { on: () => () => {} }
const makeAgent = (id: string, events: readonly unknown[]) => ({
  id,
  status: 'idle',
  session: { id, seq: events.length, events, header: {} },
  ctx: agentCtx,
  followup() {},
  steer() {},
  inbox: { remove: () => true },
})

const services: Record<string, unknown> = {
  agents: {
    async create() {
      return { agent: makeAgent('new-session', []), dispose: async () => {} }
    },
  },
  llm: {
    listModels: async () => [{ id: 'deepseek-v4-flash' }],
  },
}
const ctx = {
  on: () => () => {},
  get: (name: string) => services[name],
  logger: { warn() {} },
}
const channel = createChannel(ctx as never, makeAgent('old-session', oldEvents) as never, {
  model: 'deepseek-v4-flash',
  provider: 'fake-provider',
  cwd: '/tmp/demo',
  activity: false,
})

function viewportText(): string {
  return viewportLines().join('\n')
}

function viewportLines(): string[] {
  const buffer = term.buffer.active
  const lines: string[] = []
  const start = buffer.viewportY
  for (let y = start; y < start + ROWS; y++) {
    lines.push((buffer.getLine(y)?.translateToString(true) ?? '').replace(/\s+$/, ''))
  }
  return lines
}

function fullBufferText(): string {
  const buffer = term.buffer.active
  const lines: string[] = []
  for (let y = 0; y < buffer.length; y++) {
    lines.push(buffer.getLine(y)?.translateToString(true) ?? '')
  }
  return lines.join('\n')
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1
}

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` (${detail})` : ''}`)
  if (!ok) failed++
}

function trackReanchors(stdout: FakeStdout): () => number {
  const ink = instances.get(stdout as NodeJS.WriteStream)
  if (!ink) throw new Error('expected the Ink root to be registered')
  const original = ink.reanchorViewport.bind(ink)
  let calls = 0
  ink.reanchorViewport = () => {
    calls++
    original()
  }
  return () => calls
}

// Register a decoy root first and mount Chat in a second root. The production
// component must address its owning root, not process.stdout or Map insertion
// order (the single-root fallback that originally hid this review regression).
const decoyStdout = new FakeStdout(decoyTerm)
const targetStdout = new FakeStdout(term)
const decoyRoot = await createRoot({
  stdout: decoyStdout as NodeJS.WriteStream,
  stdin: new FakeStdin() as NodeJS.ReadStream,
  stderr: new FakeStderr() as NodeJS.WriteStream,
  exitOnCtrlC: false,
  patchConsole: false,
})
const stdin = new FakeStdin()
const targetRoot = await createRoot({
  stdout: targetStdout as NodeJS.WriteStream,
  stdin: stdin as NodeJS.ReadStream,
  stderr: new FakeStderr() as NodeJS.WriteStream,
  exitOnCtrlC: false,
  patchConsole: false,
})
const decoyReanchors = trackReanchors(decoyStdout)
const targetReanchors = trackReanchors(targetStdout)
decoyRoot.render(<></>)
targetRoot.render(<Chat channel={channel} questionStore={new QuestionStore()} />)
await sleep(3500)

const beforeNew = viewportLines()
check('old long session has scrolled the welcome header away', !beforeNew.join('\n').includes('探索未至之境！'))
check('old session has exactly one whale header in the full buffer', count(fullBufferText(), '探索未至之境！') === 1)

for (const key of '/new') {
  stdin.write(key)
  await sleep(80)
}
await sleep(200)
stdin.write('\r')
await sleep(800)

const afterNew = viewportText()
check('/new command switched the channel session', channel.agentId === 'new-session', `agent=${channel.agentId}`)
check('/new shows the whale header before another message', afterNew.includes('探索未至之境！'))
check('/new viewport contains no old transcript rows', !afterNew.includes('旧会话'))
check('session switch adds exactly one new whale header', count(fullBufferText(), '探索未至之境！') === 2)
check('/new re-anchors the owning second Ink root', targetReanchors() === 1, `calls=${targetReanchors()}`)
check('/new does not re-anchor the first decoy root', decoyReanchors() === 0, `calls=${decoyReanchors()}`)

targetRoot.unmount()
decoyRoot.unmount()
process.exit(failed === 0 ? 0 : 1)
