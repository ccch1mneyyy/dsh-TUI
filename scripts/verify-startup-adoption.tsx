/**
 * Startup adoption: the standalone entry mounts on a placeholder session and
 * the channel adopts the real one when the backend opens. Covers the channel
 * (real `createChannel`, fake sessions, hand-settled open: success, failure,
 * release mid-open, `/new` racing it) and the screen (real `Chat`, composer
 * and first-boot landing page, before and after adoption).
 *
 * Run: node --import tsx/esm scripts/verify-startup-adoption.tsx
 */
import './lib/fake-home.mjs'
process.env.FORCE_COLOR = '3'

const [{ Writable, PassThrough }, React, { Terminal: XTerm }, ui, { Chat }, { QuestionStore }, { ApprovalStore }, { createChannel }, { createStartingSession }, { setLang, t }, { default: instances }, { settled, sleep, viewportLines }, { kernelEntriesOf }, { listBackends }] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/screens/Chat.js'),
    import('../src/dsh-adapter/questions.js'),
    import('../src/dsh-adapter/approvals.js'),
    import('../src/dsh-adapter/channel.js'),
    import('../src/agent/starting-session.js'),
    import('../src/i18n.js'),
    import('../src/ink/instances.js'),
    import('./lib/term-test.mjs'),
    import('../src/components/kernelCatalog.js'),
    import('../src/dsh-adapter/backend-registry.js'),
  ])
import type { AgentEvent, AgentEventMeta } from '../src/agent/events.js'
import type { AgentInput, AgentSession, SubmitPlacement } from '../src/agent/session.js'
import type { SessionCapabilities } from '../src/agent/capabilities.js'
import type { ChannelLaunchOptions } from '../src/dsh-adapter/channel.js'

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) throw new Error(`${label}${detail ? `\n${detail}` : ''}`)
  passed += 1
  console.log(`PASS ${label}`)
}

interface FakeSession extends AgentSession {
  readonly submits: { input: AgentInput; placement: SubmitPlacement }[]
  disposed: boolean
  listenerCount(): number
}
const fakeSession = (sessionId: string, cwd: string, capabilities: Omit<SessionCapabilities, 'native'> = {}): FakeSession => {
  const listeners = new Set<(batch: readonly AgentEvent[], meta: AgentEventMeta) => void>()
  const session: FakeSession = {
    ref: { backendId: 'claude', sessionId },
    cwd,
    status: 'idle',
    capabilities: { ...capabilities, native: {} },
    submits: [],
    disposed: false,
    history: () => Promise.resolve([]),
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    submit(input, placement) {
      session.submits.push({ input, placement })
      return Promise.resolve({ accepted: true })
    },
    cancel: () => Promise.resolve({ stillQueued: [], outcome: 'confirmed' }),
    dispose() {
      session.disposed = true
      return Promise.resolve()
    },
    listenerCount: () => listeners.size,
  }
  return session
}
type Startup = NonNullable<ChannelLaunchOptions['startup']>
const deferred = () => {
  let resolve!: (value: Awaited<Startup>) => void
  let reject!: (error: unknown) => void
  const promise: Startup = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const ctx = {
  on: () => () => undefined,
  get: () => undefined,
  logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
} as never
const LAUNCH = '/fixture/launch'
const opened: FakeSession[] = []
const launch = (startup: Startup): ChannelLaunchOptions => ({
  model: 'Claude', provider: 'claude', cwd: LAUNCH, activity: false, backendLabel: 'Claude',
  startup,
  openSession: target => {
    const next = fakeSession(`33333333-3333-4333-8333-33333333333${opened.length}`, target.kind === 'create' ? target.cwd : LAUNCH, {
      subagents: { interrupt: () => Promise.resolve(true), history: () => Promise.resolve(null) } as never,
    })
    opened.push(next)
    return Promise.resolve(next)
  },
  sessionCatalog: { list: () => Promise.resolve([]) } as never,
})
const notices = (channel: { rows: readonly { kind: string; text: string }[] }): string[] =>
  channel.rows.filter(row => row.kind === 'notice').map(row => row.text)

// ── adoption ──────────────────────────────────────────────────────────
{
  const open = deferred()
  const placeholder = createStartingSession('claude', LAUNCH)
  const channel = createChannel(ctx, placeholder, launch(open.promise))
  check('not ready while the open runs', channel.ready === false)
  check('the placeholder names no session', channel.agentId === '' && channel.sessionRef.sessionId === '' && channel.sessionRef.backendId === 'claude')
  check('the placeholder serves no subagent transcript', channel.subagentControl.history === undefined)
  channel.pushLocal('/help', ['local output while starting'])
  const real = fakeSession('11111111-1111-4111-8111-111111111111', '/fixture/recorded', {
    subagents: { interrupt: () => Promise.resolve(true), history: () => Promise.resolve(null) } as never,
  })
  const history: AgentEvent[] = [
    { type: 'user.message', id: 'u1', anchor: 'u1', seq: 1, turn: 1, time: 1, source: 'user', text: 'earlier prompt', blocks: [{ type: 'text', text: 'earlier prompt' }] },
  ]
  open.resolve({ session: real, history })
  check('ready once the open settles', await settled(() => channel.ready))
  check('the real session is bound', channel.agentId === real.ref.sessionId && channel.sessionId === real.ref.sessionId && channel.sessionRef.sessionId === real.ref.sessionId)
  check('the real session is subscribed once', real.listenerCount() === 1)
  check('the cwd is the session\'s own (resume)', channel.cwd === '/fixture/recorded')
  check('the subagent control follows the real session', channel.subagentControl.history !== undefined)
  check('the history is painted', channel.rows.some(row => row.kind === 'user' && row.text === 'earlier prompt'))
  check('a local row printed while starting survives', channel.rows.some(row => row.text.includes('local output while starting')), JSON.stringify(channel.rows))
  check('the placeholder is closed', await settled(() => placeholder.status === 'disposed'))
  channel.submit('after ready')
  check('submit reaches the real session', await settled(() => real.submits.some(item => item.input.text === 'after ready')))
  channel.releaseContributions()
  check('releasing closes the real session', await settled(() => real.disposed))
}

// ── the opener's route and preset (the in-process DSH kernel) ─────────
{
  const open = deferred()
  const channel = createChannel(ctx, createStartingSession('claude', LAUNCH), { ...launch(open.promise), agentPreset: 'boot-preset' })
  check('before adoption the construction route stands', channel.model === 'Claude' && channel.provider === 'claude' && channel.agentPreset === 'boot-preset')
  open.resolve({ session: fakeSession('77777777-7777-4777-8777-777777777777', LAUNCH), history: [], route: { provider: 'deepseek-official', model: 'deepseek-v4-pro' }, agentPreset: 'standard' })
  check('the adoption takes the route the opener resolved', await settled(() => channel.ready) && channel.model === 'deepseek-v4-pro' && channel.provider === 'deepseek-official', `${channel.provider}/${channel.model}`)
  check('and its preset', channel.agentPreset === 'standard', String(channel.agentPreset))
  channel.releaseContributions()
}

// ── failed open, then /new ────────────────────────────────────────────
{
  const open = deferred()
  const channel = createChannel(ctx, createStartingSession('claude', LAUNCH), launch(open.promise))
  open.reject(new Error('handshake refused'))
  check('a failed open leaves a notice naming the error', await settled(() => notices(channel).some(text => text.includes('handshake refused'))), JSON.stringify(notices(channel)))
  check('and a notice of its own naming /new', notices(channel).some(text => text.startsWith('/new')), JSON.stringify(notices(channel)))
  check('still not ready after the failure', channel.ready === false && channel.agentId === '')
  const before = opened.length
  const ok = await channel.newSession()
  check('/new retries through openSession', ok && opened.length === before + 1)
  check('ready after /new', channel.ready && channel.agentId === opened[before]!.ref.sessionId)
  check('the subagent control follows the /new session', channel.subagentControl.history !== undefined)
  channel.releaseContributions()
}

// ── released mid-open ─────────────────────────────────────────────────
{
  const open = deferred()
  const channel = createChannel(ctx, createStartingSession('claude', LAUNCH), launch(open.promise))
  channel.releaseContributions()
  const late = fakeSession('55555555-5555-4555-8555-555555555555', LAUNCH)
  open.resolve({ session: late, history: [] })
  check('a session arriving after release is closed', await settled(() => late.disposed))
  check('it was never subscribed', late.listenerCount() === 0)
}

// ── /new while the open is still going ────────────────────────────────
{
  const open = deferred()
  const channel = createChannel(ctx, createStartingSession('claude', LAUNCH), launch(open.promise))
  const before = opened.length
  check('/new while starting opens its own session', await channel.newSession() && channel.agentId === opened[before]!.ref.sessionId && channel.ready)
  const late = fakeSession('66666666-6666-4666-8666-666666666666', LAUNCH)
  open.resolve({ session: late, history: [] })
  check('the startup session arriving later is closed', await settled(() => late.disposed))
  check('the /new session stays bound', channel.agentId === opened[before]!.ref.sessionId && late.listenerCount() === 0)
  check('no failure notice for a superseded open', !notices(channel).some(text => text.includes('failed to open')))
  channel.releaseContributions()
}

// ── the real Chat over a not-ready channel ────────────────────────────
// Twice: once in the chat composer, once on the landing page (first boot),
// whose Enter reaches the channel through its own submit path.
const notReady = t('startup-not-ready', { backend: 'Claude' })
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
async function screenCase(surface: 'composer' | 'launchpad' | 'launchpad-failed', sessionId: string): Promise<void> {
  const label = (text: string): string => `${surface}: ${text}`
  const open = deferred()
  const channel = createChannel(ctx, createStartingSession('claude', process.cwd()), { ...launch(open.promise), cwd: process.cwd() })
  const COLS = 100
  const ROWS = 30
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 200, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void { term.write(String(chunk), callback) }
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
      // The composition root's kernel list: the notices name the kernel by its
      // short label ("Claude"), not the backend id.
      kernelEntries: kernelEntriesOf(listBackends()),
      ...(surface !== 'composer' ? { launchpadOnBoot: true } : {}),
    }),
    { stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  for (const value of instances.values()) instances.set(process.stdout, value)
  const toasts = (): string => channel.notifications.map(item => item.text).join(' | ')
  const notReadyCount = (): number => channel.notifications.filter(item => item.text === notReady).length
  const typeLine = async (text: string): Promise<void> => {
    for (const char of text) stdin.write(char)
    // 固定窗:pacing the prompt applies typed characters on its own render tick.
    await sleep(60)
  }
  const clearLine = async (): Promise<void> => {
    // One key per tick: the landing page applies one edit per input batch.
    for (let i = 0; i < 24; i += 1) {
      stdin.write('\x7f')
      // 固定窗:pacing each backspace lands in its own input batch.
      await sleep(surface !== 'composer' ? 15 : 0)
    }
    // 固定窗:pacing backspaces land before the next keystroke batch.
    await sleep(60)
  }
  const real = fakeSession(sessionId, process.cwd())
  try {
    // 固定窗:pacing the key handlers attach after the first frame.
    await sleep(300)
    if (surface === 'launchpad-failed') {
      // A failed open closes the landing page: the failure row and its /new
      // hint are in the transcript it covered; the draft moves along.
      await typeLine('kept draft')
      open.reject(new Error('handshake refused'))
      check(label('the failure row and the /new hint are on screen'), await settled(() => screen().includes('handshake refused') && screen().includes('/new to retry')), screen())
      check(label('the draft moves to the composer'), await settled(() => screen().includes('kept draft')), screen())
      check(label('still not ready'), !channel.ready)
      return
    }
    await typeLine('hello early')
    stdin.write('\r')
    check(label('Enter while starting says the backend is still starting'), await settled(() => toasts().includes(notReady)), toasts())
    // The landing page has no toast area: the notice takes its Tips row.
    check(label('the notice is on screen'), await settled(() => screen().includes(notReady.slice(0, 30))), screen())
    check(label('the draft stays in place'), screen().includes('hello early'), screen())
    check(label('nothing was submitted'), real.submits.length === 0)
    await clearLine()
    await typeLine('/status')
    const beforeStatus = notReadyCount()
    stdin.write('\r')
    check(label('a session command is refused while starting'), await settled(() => notReadyCount() > beforeStatus) && screen().includes('/status'), screen())
    await clearLine()
    await typeLine('/help')
    const beforeHelp = notReadyCount()
    stdin.write('\r')
    // The composer consumes the line; the landing page keeps it under the
    // help overlay it opens.
    const helpRan = surface !== 'composer' ? () => screen().includes('for this help') : () => !screen().includes('/help')
    check(label('a local command runs while starting'), await settled(helpRan) && notReadyCount() === beforeHelp, screen())
    // 固定窗:pacing whatever /help opened settles before Esc closes it.
    await sleep(200)
    stdin.write('\x1b')
    // 固定窗:pacing Esc is a standalone key only after the escape timeout.
    await sleep(200)
    open.resolve({ session: real, history: [] })
    check(label('the channel becomes ready'), await settled(() => channel.ready))
    await clearLine()
    await typeLine('hello ready')
    stdin.write('\r')
    check(label('after the adoption Enter sends to the real session'), await settled(() => real.submits.some(item => item.input.text === 'hello ready')), JSON.stringify(real.submits.map(item => item.input.text)))
    // A refused line must not be queued and forwarded once the session opens.
    check(label('the refused early line never reaches the session'), !real.submits.some(item => item.input.text === 'hello early'), JSON.stringify(real.submits.map(item => item.input.text)))
  } finally {
    instance.unmount()
    channel.releaseContributions()
  }
}
await screenCase('composer', '77777777-7777-4777-8777-777777777777')
await screenCase('launchpad', '88888888-8888-4888-8888-888888888888')
await screenCase('launchpad-failed', '99999999-9999-4999-8999-999999999999')
console.log(`\nverify-startup-adoption: ${passed} checks passed`)
process.exit(0)
