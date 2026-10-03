/**
 * The real `Chat` over a channel bound to a NON-DSH session (Phase 2
 * checkpoint B): the slash menu offers only the commands the backend serves,
 * a typed built-in the backend lacks shows `cmd-unavailable-backend` and
 * never reaches the model (nor steers into a running turn), and plain text
 * still goes through `session.submit`.
 *
 * Run: node --import tsx/esm scripts/verify-backend-chat.tsx
 */
process.env.FORCE_COLOR = '3'

const [{ Writable, PassThrough }, React, { Terminal: XTerm }, ui, { Chat }, { QuestionStore }, { ApprovalStore }, { createChannel }, { setLang, t }, { default: instances }, { settled, sleep, viewportLines }] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/screens/Chat.js'),
    import('../src/dsh-adapter/questions.js'),
    import('../src/dsh-adapter/approvals.js'),
    import('../src/dsh-adapter/channel.js'),
    import('../src/i18n.js'),
    import('../src/ink/instances.js'),
    import('./lib/term-test.mjs'),
  ])
import type { AgentEvent, AgentEventMeta } from '../src/agent/events.js'
import type { AgentInput, AgentSession, SubmitPlacement } from '../src/agent/session.js'

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) throw new Error(`${label}${detail ? `\n${detail}` : ''}`)
  passed += 1
  console.log(`PASS ${label}`)
}

const submits: { input: AgentInput; placement: SubmitPlacement }[] = []
const mcpCalls: string[] = []
const listeners = new Set<(batch: readonly AgentEvent[], meta: AgentEventMeta) => void>()
const session: AgentSession = {
  ref: { backendId: 'fake', sessionId: '44444444-4444-4444-8444-444444444444' },
  cwd: process.cwd(),
  status: 'idle',
  capabilities: {
    native: {},
    // Phase 5b: `/mcp reconnect|toggle` reach the backend's MCP control.
    mcp: {
      status: () => Promise.resolve([{ name: 'github', status: 'connected', toolCount: 2 }]),
      reconnect: name => { mcpCalls.push(`reconnect:${name}`); return Promise.resolve() },
      toggle: (name, enabled) => { mcpCalls.push(`toggle:${name}:${enabled}`); return Promise.resolve() },
    },
  },
  history: () => Promise.resolve([]),
  subscribe(listener) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  submit(input, placement) {
    submits.push({ input, placement })
    return Promise.resolve({ accepted: true })
  },
  removePending: () => false,
  cancel: () => Promise.resolve({ stillQueued: [] }),
  dispose: () => Promise.resolve(),
}
const emit = (events: readonly AgentEvent[]): void => {
  for (const listener of [...listeners]) listener(events, { replay: false, wake: 'sync' })
}

const ctx = {
  on: () => () => undefined,
  get: () => undefined,
  logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
} as never
const channel = createChannel(ctx, session, { model: 'fake-model', provider: '', cwd: process.cwd(), activity: false, backendLabel: 'Fake Agent' })

const COLS = 100
const ROWS = 30
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 200, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void { term.write(String(chunk), callback) }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const stdin = new FakeStdin()
const stdout = new FakeStdout()
const screen = (): string => viewportLines(term, ROWS).join('\n')
const instance = await ui.render(
  React.createElement(Chat, {
    channel: channel as never,
    questionStore: new QuestionStore(),
    approvalStore: new ApprovalStore(),
    onExit: () => undefined,
    fullscreen: false,
    trajectorySeen: true,
  }),
  { stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false },
)
for (const value of instances.values()) instances.set(process.stdout, value)
const toasts = (): string => channel.notifications.map(item => item.text).join(' | ')
const typeLine = async (text: string): Promise<void> => {
  for (const char of text) stdin.write(char)
  // 固定窗:pacing the prompt applies typed characters on its own render tick.
  await sleep(60)
}
const clearLine = async (): Promise<void> => {
  for (let i = 0; i < 24; i += 1) stdin.write('\x7f')
  // 固定窗:pacing backspaces land before the next keystroke batch.
  await sleep(60)
}

try {
  // 固定窗:pacing the key handlers attach after the first frame.
  await sleep(300)
  await typeLine('/pre')
  // 固定窗:探针 a menu that must NOT open has no completion condition to poll.
  await sleep(200)
  check('the slash menu hides commands the backend lacks', !screen().includes(t('sugg-commands-title')) && channel.commandCompletions('/pre').length === 0, screen())
  await clearLine()
  await typeLine('/ne')
  check('the slash menu offers served commands', await settled(() => screen().includes(t('sugg-commands-title')) && screen().includes('Start a new conversation')), screen())
  await clearLine()

  await typeLine('/preset')
  stdin.write('\r')
  const refusal = t('cmd-unavailable-backend', { cmd: 'preset', backend: 'Fake Agent' })
  check('a typed unavailable command explains itself', await settled(() => toasts().includes(refusal)), toasts())
  check('the refused command never reaches the model', submits.length === 0)
  await clearLine()

  emit([{ type: 'turn.start', turn: 1, origin: 'user', time: Date.now() }])
  await typeLine('/rewind')
  stdin.write('\r')
  const rewindRefusal = t('cmd-unavailable-backend', { cmd: 'rewind', backend: 'Fake Agent' })
  check('while working it is refused, not steered in', await settled(() => toasts().includes(rewindRefusal)) && submits.length === 0, toasts())
  emit([{ type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: Date.now() }])
  await clearLine()

  // Review fix: keys that open DSH-only surfaces explain themselves instead
  // of opening an empty UI (or cycling nothing).
  stdin.write('\x1b[Z')
  check('Shift+Tab without native modes explains itself', await settled(() => toasts().includes(t('capability-unavailable-backend', { name: 'mode' }))), toasts())
  stdin.write('\x14')
  check('Ctrl+T without a trace explains itself and opens no scene', await settled(() => toasts().includes(t('capability-unavailable-backend', { name: 'trace' }))) && !screen().includes('trajectory'), toasts())
  stdin.write('\x1b')
  // 固定窗:pacing the double-Esc detector needs two distinct key events.
  await sleep(80)
  stdin.write('\x1b')
  check('double-Esc without rewind explains itself', await settled(() => toasts().includes(t('capability-unavailable-backend', { name: 'rewind' }))), toasts())

  // Phase 5b: /mcp subcommands where the backend controls its servers.
  await typeLine('/mcp reconnect github')
  stdin.write('\r')
  check('/mcp reconnect <name> reaches the backend and says so', await settled(() => mcpCalls.includes('reconnect:github') && toasts().includes(t('mcp-reconnected', { name: 'github' }))), `${mcpCalls.join()} | ${toasts()}`)
  await clearLine()
  await typeLine('/mcp toggle github off')
  stdin.write('\r')
  check('/mcp toggle <name> off reaches the backend', await settled(() => mcpCalls.includes('toggle:github:false')), mcpCalls.join())
  await clearLine()
  await typeLine('/mcp toggle github')
  stdin.write('\r')
  check('/mcp toggle without on|off shows the usage', await settled(() => toasts().includes(t('mcp-control-usage'))) && mcpCalls.length === 2, toasts())
  await clearLine()
  await typeLine('/mcp')
  stdin.write('\r')
  check('plain /mcp still shows the status report', await settled(() => screen().includes('github')) && submits.length === 0, screen())
  await clearLine()

  await typeLine('hello backend')
  stdin.write('\r')
  check('plain text goes to session.submit', await settled(() => submits.length === 1) && submits[0]!.input.text === 'hello backend', JSON.stringify(submits))
} finally {
  instance.unmount()
  channel.releaseContributions()
  term.dispose()
}

console.log(`\nverify-backend-chat OK (${passed} checks)`)
process.exit(0)
