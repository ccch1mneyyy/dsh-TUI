/**
 * `/help` viewport regression (issue #368): a command list taller than the
 * terminal must remain reachable without moving the transcript or editing
 * prompt history.
 *
 * Run: node --import tsx/esm scripts/verify-help-scroll.tsx
 */
process.env.FORCE_COLOR = '0'
process.env.DSH_TUI_LANG = 'en'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { Box, render, useInput },
  { PromptInput },
  { LOCAL_COMMANDS },
  { Chat },
  { QuestionStore },
  { createChannel },
  { settle, settled, sleep, viewportLines },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/PromptInput.js'),
  import('../src/commands.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/channel.js'),
  import('./lib/term-test.mjs'),
])

const COLS = 80
const INITIAL_ROWS = 24
const term = new XTerm({
  cols: COLS,
  rows: INITIAL_ROWS,
  scrollback: 100,
  allowProposedApi: true,
})

class FakeStdout extends Writable {
  columns = COLS
  rows = INITIAL_ROWS
  isTTY = true

  override _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    term.write(String(chunk), callback)
  }
}

class FakeStderr extends Writable {
  isTTY = true

  override _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    callback()
  }
}

class FakeStdin extends PassThrough {
  isTTY = true
  isRaw = false
  setRawMode(next: boolean): this { this.isRaw = next; return this }
  override setEncoding(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

const stdout = new FakeStdout()
const stderr = new FakeStderr()
const stdin = new FakeStdin()
let transcriptWheelEvents = 0

const channel = {
  mode: { id: 'default', plan: false },
  modeIndex: 0,
  cycleMode() {},
  commandList: LOCAL_COMMANDS,
  commandCompletions: () => [],
  notifications: [],
  pending: [{ id: 'pending-help-test', text: 'PENDING_SENTINEL', placement: 'followup' }],
  working: false,
  notify() {},
  submit() {},
  steer() {},
  interruptAndDeliver() { return 0 },
  removePending() { return false },
  stageImage() {},
  listFiles: async () => [],
}

function Fixture(): React.ReactNode {
  const [helpOpen, setHelpOpen] = React.useState(true)

  // Mirrors Chat's transcript-wheel ownership boundary. While help is open,
  // wheel input must fall through to PromptInput's help viewport instead.
  useInput((_input, key) => {
    if (key.wheelUp || key.wheelDown) {
      if (helpOpen) return
      transcriptWheelEvents++
    }
  })

  return (
    <Box height={stdout.rows} flexDirection="column" justifyContent="flex-end">
      <Box><Box /></Box>
      <PromptInput
        channel={channel as never}
        helpOpen={helpOpen}
        onToggleHelp={() => setHelpOpen(open => !open)}
        onRunCommand={() => false}
        selectionActive={false}
      />
    </Box>
  )
}

const write = async (input: string): Promise<void> => {
  stdin.write(input)
  await sleep(180)
}

function screenText(): string {
  // 视口读取（baseY 起）：inline 模式有 scrollback 时直扫 getLine(0..rows)
  // 读的是缓冲区开头，会混入已滚出的旧行。
  return viewportLines(term).join('\n')
}

let failures = 0
function check(condition: boolean, message: string): void {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${message}`)
  if (!condition) failures++
}

const app = await render(<Fixture />, {
  stdout: stdout as unknown as NodeJS.WriteStream,
  stderr: stderr as unknown as NodeJS.WriteStream,
  stdin: stdin as unknown as NodeJS.ReadStream,
  exitOnCtrlC: false,
  patchConsole: false,
})

try {
  // 正向条件各自 settled；负向（尚未滚到的尾部/被遮住的 pending）在正向
  // 落定后的同帧同步判定——空帧上轮询「不存在」会立即真。
  check(await settled(() => screenText().includes('/new —')), 'help opens at the first command')
  check(await settled(() => screenText().includes('/ for commands')), 'shortcut reference is visible at the top')
  check(await settled(() => screenText().includes('↑/↓')), 'a persistent scroll hint is visible')
  check(!screenText().includes('/q —'), 'tail commands start outside the viewport')
  check(!screenText().includes('PENDING_SENTINEL'), 'pending preview stays behind the help overlay')

  stdin.write('\x1b[6~')
  check(await settled(() => !screenText().includes('/new —')), 'PageDown advances by a viewport')
  stdin.write('\x1b[5~')
  check(await settled(() => screenText().includes('/new —')), 'PageUp returns by a viewport')

  // More presses than the content requires also exercise end clamping.
  stdin.write('\x1b[B'.repeat(60))
  check(await settled(() => screenText().includes('/q —')), 'Down reaches the final command')
  check(await settled(() => !screenText().includes('/new —')), 'the viewport actually moved away from the top')

  stdin.write('\x1b[H')
  check(await settled(() => screenText().includes('/new —')), 'Home returns to the first command')

  stdin.write('\x1b[F')
  check(await settled(() => screenText().includes('/q —')), 'End jumps to the final command')
  check(await settled(() => screenText().includes('/ for commands')), 'shortcut reference stays fixed at the tail')

  // SGR mouse wheel up. The fixture's Chat-like owner must not move the
  // transcript while Help owns the overlay, while Help itself must move.
  // Stability probe (transcriptWheelEvents must stay 0): a settle on the
  // already-true condition would return immediately — keep the fixed window
  // so a leaked wheel event has time to surface.
  await write('\x1b[<64;10;10M'.repeat(20))
  check(transcriptWheelEvents === 0, 'help suppresses transcript wheel scrolling')
  check(await settled(() => !screenText().includes('/q —')), 'mouse wheel scrolls the help viewport')

  stdin.write('\x1b')
  check(await settled(() => !screenText().includes('commands:')), 'Escape closes help')
  check(await settled(() => screenText().includes('PENDING_SENTINEL')), 'pending preview returns after help closes')
  stdin.write('?')
  check(await settled(() => screenText().includes('/new —')), 'reopening help resets the viewport to the top')
  check(await settled(() => !screenText().includes('PENDING_SENTINEL')), 'reopened help remains visually exclusive')

  // Stability probe across a resize (the hint must REMAIN visible): the
  // condition is already true before the repaint, so a settle would return
  // immediately — keep the fixed window for a wrong reflow to surface.
  stdout.rows = 18
  term.resize(COLS, 18)
  stdout.emit('resize')
  await sleep(300)
  check(screenText().includes('↑/↓'), 'scroll hint remains visible after resize')
  stdin.write('\x1b[F')
  check(await settled(() => screenText().includes('/q —')), 'resized help can still reach the tail')

  // Ordering sleep kept: the narrow reflow has no single anchored condition
  // to poll before the next keypress.
  stdout.columns = 60
  term.resize(60, 18)
  stdout.emit('resize')
  await sleep(300)
  stdin.write('\x1b[H')
  check(await settled(() => screenText().includes('/ for commands')), 'narrow Help stacks shortcuts into the scroll viewport')
  stdin.write('\x1b[F')
  await settle(() => screenText().includes('/q —'))
  stdin.write('\x1b[B'.repeat(60))
  check(LOCAL_COMMANDS.at(-1)?.name === 'q' && await settled(() => screenText().includes('/connect —')), 'narrow Help keeps the command-list tail reachable after End and navigation')
  check(await settled(() => screenText().includes('↑/↓')), 'narrow Help keeps the navigation hint fixed')
} finally {
  app.unmount()
}

// Full Chat routing regression: Ctrl+O used while Help is visible must not
// toggle the hidden transcript-search mode. Otherwise the next `/` after
// closing Help opens TranscriptSearchBar (a second input-looking row with
// "no matches") and slash commands appear to be wedged.
stdout.rows = INITIAL_ROWS
stdout.columns = COLS
term.resize(COLS, INITIAL_ROWS)
term.reset()
stdout.emit('resize')

const handlers = new Map<string, unknown>()
let cancelCalls = 0
const agent = {
  id: 'help-routing-agent',
  status: 'idle',
  session: { id: 'help-routing-session', seq: 0, events: [], header: {} },
  ctx: { on: () => () => {} },
  followup() {},
  steer() {},
  cancel() { cancelCalls++ },
  inbox: { remove: () => true },
}
const services: Record<string, unknown> = {
  sessions: { fork: () => ({ events: [] }) },
  agents: { create: async () => ({ agent, dispose: async () => {} }) },
  llm: { listProviders: () => [], listModels: async () => [] },
}
const chatChannel = createChannel({
  on(event: string, handler: unknown) {
    handlers.set(event, handler)
    return () => handlers.delete(event)
  },
  get(name: string) { return services[name] },
  logger: { warn() {} },
} as never, agent as never, {
  model: 'deepseek-v4-flash',
  cwd: '/tmp/help-routing',
  provider: 'deepseek-official',
  activity: false,
})
let modeCycles = 0
let extensionShortcutCalls = 0
;(chatChannel as unknown as { cycleMode(): void }).cycleMode = () => { modeCycles++ }
const extensionShortcuts = {
  setErrorHandler() { return () => {} },
  dispatch(input: string, key: { ctrl?: boolean }) {
    if (key.ctrl && input === 'y') {
      extensionShortcutCalls++
      return true
    }
    return false
  },
}

const chat = await render(
  <Chat
    channel={chatChannel as never}
    questionStore={new QuestionStore()}
    extensionShortcuts={extensionShortcuts as never}
    onExit={() => {}}
  />,
  {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
  },
)

try {
  // Startup and per-key typing keep fixed sleeps: the prompt echo has no
  // single stable anchor to poll while the completion menu reshuffles.
  await sleep(500)
  for (const key of '/help') await write(key)
  stdin.write('\r')
  check(await settled(() => screenText().includes('↑/↓')), '/help opens Help through the real Chat command path')

  stdin.write('\x1b')
  await settle(() => !screenText().includes('↑/↓'))
  // Negative probe (transcript search must NOT open on `/`): a settle would
  // return immediately on the already-true condition — keep a fixed window.
  await write('/')
  check(!screenText().includes('no matches'), 'ordinary Esc then slash stays in command completion')
  check(await settled(() => screenText().includes('help')), 'ordinary slash completion is visible after Help closes')
  for (const key of 'help') await write(key)
  stdin.write('\r')
  check(await settled(() => screenText().includes('↑/↓')), '/help reopens through the real Chat command path')

  // Ctrl+O must be inert behind Help; Esc then returns to the ordinary
  // prompt, where `/` belongs to slash-command completion. (The Ctrl+O
  // inertness is a must-not-change probe — fixed window kept.)
  await write('\x0f')
  stdin.write('\x1b')
  await settle(() => !screenText().includes('↑/↓'))
  await write('/')
  check(!screenText().includes('no matches'), 'slash after Help does not open transcript search')
  check(await settled(() => screenText().includes('help')), 'slash completion remains available after Help closes')

  for (const key of 'help') await write(key)
  stdin.write('\r')
  check(await settled(() => screenText().includes('↑/↓')), '/help can be submitted again after closing Help')

  // Composer-local, Chat-global, and plugin bindings must not mutate hidden
  // state behind Help. The broad Chat yield guards future shortcuts too,
  // instead of relying on an incomplete list of per-binding conditions.
  // These are all must-not-change probes: polling the already-true condition
  // would return immediately, so each keeps its fixed observation window.
  await write('\x14')
  check(screenText().includes('↑/↓'), 'Ctrl+T does not open trajectory behind Help')
  await write('\x10')
  check(screenText().includes('↑/↓'), 'Ctrl+P does not toggle loaded context behind Help')
  await write('\x05')
  check(screenText().includes('↑/↓'), 'Ctrl+E does not expand transcript behind Help')
  await write('\x19')
  check(extensionShortcutCalls === 0, 'plugin shortcut does not dispatch behind Help')
  await write('\x1b[Z')
  check(modeCycles === 0, 'Shift+Tab does not cycle session mode behind Help')
  await write('\x1b[1;2A')
  stdin.write('x')
  check(await settled(() => !screenText().includes('↑/↓')), 'typing after Shift+Up dismisses Help instead of being trapped in selection mode')
  await write('\x03')

  // Help owns Esc even during a live turn. The Chat-level cancel branch must
  // yield, so one Esc closes the overlay without aborting the agent.
  stdin.write('?')
  await settle(() => screenText().includes('↑/↓'))
  const onSessionEvent = handlers.get('session/event') as
    | ((session: unknown, event: unknown) => void)
    | undefined
  onSessionEvent?.(agent.session, {
    seq: 1,
    time: Date.now(),
    type: 'turn/start',
    data: { turn: 1 },
  })
  check(await settled(() => chatChannel.working), 'full Chat fixture enters working state')
  stdin.write('\x1b')
  check(await settled(() => !screenText().includes('↑/↓')), 'Escape still closes Help while a turn is working')
  check(cancelCalls === 0, 'Escape closes Help without cancelling a working turn')
  onSessionEvent?.(agent.session, {
    seq: 2,
    time: Date.now(),
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
  })
  await settle(() => !chatChannel.working)

  // A deliberately enabled Ctrl+O transcript mode survives Help, but `/`
  // typed while Help is visible belongs to the prompt and dismisses Help;
  // it must not open the transcript search bar behind the overlay.
  await write('\x0f')
  stdin.write('?')
  await settle(() => screenText().includes('↑/↓'))
  stdin.write('/')
  await settle(() => !screenText().includes('↑/↓'))
  check(!screenText().includes('no matches'), 'slash typed in Help does not open transcript search')
  check(chatChannel.commandCompletions('/').some(command => command.name === 'help'), 'slash typed in Help returns to command completion')
  await write('\x03')
  await write('\x0f')
} finally {
  chat.unmount()
}

if (failures > 0) {
  console.error(`verify-help-scroll: ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('verify-help-scroll OK')
