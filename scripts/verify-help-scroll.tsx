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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const write = async (input: string): Promise<void> => {
  stdin.write(input)
  await sleep(180)
}

function screenText(): string {
  const buffer = term.buffer.active
  const lines: string[] = []
  for (let row = 0; row < term.rows; row++) {
    lines.push(buffer.getLine(row)?.translateToString(true) ?? '')
  }
  return lines.join('\n')
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
  await sleep(400)
  let text = screenText()
  check(text.includes('/new —'), 'help opens at the first command')
  check(!text.includes('/q —'), 'tail commands start outside the viewport')
  check(text.includes('/ for commands'), 'shortcut reference is visible at the top')
  check(text.includes('↑/↓'), 'a persistent scroll hint is visible')
  check(!text.includes('PENDING_SENTINEL'), 'pending preview stays behind the help overlay')

  await write('\x1b[6~')
  text = screenText()
  check(!text.includes('/new —'), 'PageDown advances by a viewport')
  await write('\x1b[5~')
  text = screenText()
  check(text.includes('/new —'), 'PageUp returns by a viewport')

  // More presses than the content requires also exercise end clamping.
  await write('\x1b[B'.repeat(60))
  text = screenText()
  check(text.includes('/q —'), 'Down reaches the final command')
  check(!text.includes('/new —'), 'the viewport actually moved away from the top')

  await write('\x1b[H')
  text = screenText()
  check(text.includes('/new —'), 'Home returns to the first command')

  await write('\x1b[F')
  text = screenText()
  check(text.includes('/q —'), 'End jumps to the final command')
  check(text.includes('/ for commands'), 'shortcut reference stays fixed at the tail')

  // SGR mouse wheel up. The fixture's Chat-like owner must not move the
  // transcript while Help owns the overlay, while Help itself must move.
  await write('\x1b[<64;10;10M'.repeat(20))
  check(transcriptWheelEvents === 0, 'help suppresses transcript wheel scrolling')
  check(!screenText().includes('/q —'), 'mouse wheel scrolls the help viewport')

  await write('\x1b')
  check(!screenText().includes('commands:'), 'Escape closes help')
  check(screenText().includes('PENDING_SENTINEL'), 'pending preview returns after help closes')
  await write('?')
  text = screenText()
  check(text.includes('/new —'), 'reopening help resets the viewport to the top')
  check(!text.includes('PENDING_SENTINEL'), 'reopened help remains visually exclusive')

  stdout.rows = 18
  term.resize(COLS, 18)
  stdout.emit('resize')
  await sleep(300)
  check(screenText().includes('↑/↓'), 'scroll hint remains visible after resize')
  await write('\x1b[F')
  check(screenText().includes('/q —'), 'resized help can still reach the tail')

  stdout.columns = 60
  term.resize(60, 18)
  stdout.emit('resize')
  await sleep(300)
  await write('\x1b[H')
  check(screenText().includes('/ for commands'), 'narrow Help stacks shortcuts into the scroll viewport')
  await write('\x1b[F')
  await write('\x1b[B'.repeat(60))
  check(LOCAL_COMMANDS.at(-1)?.name === 'q' && screenText().includes('/connect —'), 'narrow Help keeps the command-list tail reachable after End and navigation')
  check(screenText().includes('↑/↓'), 'narrow Help keeps the navigation hint fixed')
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
  await sleep(500)
  for (const key of '/help') await write(key)
  await write('\r')
  check(screenText().includes('↑/↓'), '/help opens Help through the real Chat command path')

  await write('\x1b')
  await write('/')
  let routed = screenText()
  check(!routed.includes('no matches'), 'ordinary Esc then slash stays in command completion')
  check(routed.includes('help'), 'ordinary slash completion is visible after Help closes')
  for (const key of 'help') await write(key)
  await write('\r')
  check(screenText().includes('↑/↓'), '/help reopens through the real Chat command path')

  // Ctrl+O must be inert behind Help; Esc then returns to the ordinary
  // prompt, where `/` belongs to slash-command completion.
  await write('\x0f')
  await write('\x1b')
  await write('/')
  routed = screenText()
  check(!routed.includes('no matches'), 'slash after Help does not open transcript search')
  check(routed.includes('help'), 'slash completion remains available after Help closes')

  for (const key of 'help') await write(key)
  await write('\r')
  routed = screenText()
  check(routed.includes('↑/↓'), '/help can be submitted again after closing Help')

  // Composer-local, Chat-global, and plugin bindings must not mutate hidden
  // state behind Help. The broad Chat yield guards future shortcuts too,
  // instead of relying on an incomplete list of per-binding conditions.
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
  await write('x')
  check(!screenText().includes('↑/↓'), 'typing after Shift+Up dismisses Help instead of being trapped in selection mode')
  await write('\x03')

  // Help owns Esc even during a live turn. The Chat-level cancel branch must
  // yield, so one Esc closes the overlay without aborting the agent.
  await write('?')
  const onSessionEvent = handlers.get('session/event') as
    | ((session: unknown, event: unknown) => void)
    | undefined
  onSessionEvent?.(agent.session, {
    seq: 1,
    time: Date.now(),
    type: 'turn/start',
    data: { turn: 1 },
  })
  await sleep(180)
  check(chatChannel.working, 'full Chat fixture enters working state')
  await write('\x1b')
  check(cancelCalls === 0, 'Escape closes Help without cancelling a working turn')
  check(!screenText().includes('↑/↓'), 'Escape still closes Help while a turn is working')
  onSessionEvent?.(agent.session, {
    seq: 2,
    time: Date.now(),
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
  })
  await sleep(180)

  // A deliberately enabled Ctrl+O transcript mode survives Help, but `/`
  // typed while Help is visible belongs to the prompt and dismisses Help;
  // it must not open the transcript search bar behind the overlay.
  await write('\x0f')
  await write('?')
  await write('/')
  routed = screenText()
  check(!routed.includes('no matches'), 'slash typed in Help does not open transcript search')
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
