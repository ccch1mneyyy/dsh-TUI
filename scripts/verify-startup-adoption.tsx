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
import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES = '1'

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
import type { SessionSummary } from '../src/adapter/ports/channel-session.js'
import type { PromptController } from '../src/components/PromptInput.js'

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

// The DSH attachments service can accept images before the agent opens.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const attachmentId = `sha256:${createHash('sha256').update(png).digest('hex')}`
const hasStartupImage = (input: AgentInput): boolean => input.blocks?.some(block => {
  if (block.type !== 'image' || !('attachment' in block)) return false
  const attachment = block.attachment
  return typeof attachment === 'object' && attachment !== null
    && 'attachmentId' in attachment && attachment.attachmentId === attachmentId
}) === true
const pastedImagePath = join(process.env.HOME!, 'startup.png')
writeFileSync(pastedImagePath, png)
const attachments = {
  imageLimits: {
    maxImageBytes: 1024 * 1024, maxImagesPerMessage: 4, maxMessageImageBytes: 4 * 1024 * 1024,
    maxImageDimension: 8192, maxImagePixels: 64_000_000, mediaTypes: ['image/png'],
  },
  saveImage: async (input: { data: Uint8Array; mediaType: string; name?: string }) => ({
    attachmentId, mediaType: input.mediaType, bytes: input.data.byteLength,
    width: 1, height: 1, name: input.name,
  }),
  readImage: async () => ({ data: png }),
}
const ctx = {
  on: () => () => undefined,
  get: (name: string) => name === 'attachments' ? attachments : undefined,
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

// ── staged image capabilities belong to the startup draft ────────────
{
  const open = deferred()
  const channel = createChannel(ctx, createStartingSession('claude', LAUNCH), launch(open.promise))
  const generation = channel.stagedImageGeneration()
  const handle = await channel.stageComposerImage({ data: png, mediaType: 'image/png', name: 'startup.png' }, generation)
  const view = channel.stagedImage(handle.stageId)
  check('an image can be staged while the session opens', view !== undefined && !channel.ready)
  const real = fakeSession('99999999-9999-4999-8999-999999999990', LAUNCH)
  open.resolve({ session: real, history: [] })
  check('the image draft gets its real session', await settled(() => channel.ready))
  check('startup adoption keeps the image epoch', channel.stagedImageGeneration() === generation)
  check('startup adoption keeps the staged capability and preview', channel.hasStagedImage(handle.stageId) && channel.stagedImage(handle.stageId) === view)
  channel.submit('[Image #1] early image', [{ token: '[Image #1]', stageId: handle.stageId }])
  check('the startup image is delivered as an attachment', await settled(() => real.submits.some(item => hasStartupImage(item.input))), JSON.stringify(real.submits))
  check('/new opens another session after the image draft', await channel.newSession())
  check('a real switch revokes the old image capability', !channel.hasStagedImage(handle.stageId) && channel.stagedImageGeneration() > generation)
  channel.releaseContributions()
}

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

// ── the adoption tail throwing after a successful open ────────────────
// The tail segment runs inside binding.adopt(); its rollback contract
// closes the candidate and releases the channel on any tail throw, which
// trips the failure funnel's "released" early exit. So what must hold for
// a tail throw: no unhandled rejection (the pre-fix crash), the opened
// candidate is closed (no leak), and the channel never reports ready.
{
  const rejections: unknown[] = []
  const onRejection = (reason: unknown): void => { rejections.push(reason) }
  process.on('unhandledRejection', onRejection)
  const open = deferred()
  const channel = createChannel(ctx, createStartingSession('claude', LAUNCH), launch(open.promise))
  const boom = fakeSession('abababab-abab-4aba-8aba-abababababab', LAUNCH)
  // The adoption tail reads candidate.cwd into channel state; a getter
  // that throws fails the tail segment after the open succeeded.
  Object.defineProperty(boom, 'cwd', { get() { throw new Error('tail exploded') } })
  open.resolve({ session: boom, history: [] })
  check('a tail throw closes the opened candidate', await settled(() => boom.disposed))
  // 固定窗:探针 a leaked rejection lands in its own turn: this window is what
  // asserts the failure never flips `ready` nor escapes as a rejection.
  await sleep(50)
  check('the channel never becomes ready', channel.ready === false)
  check('no unhandled rejection escapes the tail', rejections.length === 0, JSON.stringify(rejections.map(String)))
  process.off('unhandledRejection', onRejection)
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
  const generation = channel.stagedImageGeneration()
  const handle = await channel.stageComposerImage({ data: png, mediaType: 'image/png' }, generation)
  const before = opened.length
  check('/new while starting opens its own session', await channel.newSession() && channel.agentId === opened[before]!.ref.sessionId && channel.ready)
  check('/new while starting revokes the replaced draft image', !channel.hasStagedImage(handle.stageId) && channel.stagedImageGeneration() > generation)
  const late = fakeSession('66666666-6666-4666-8666-666666666666', LAUNCH)
  open.resolve({ session: late, history: [] })
  check('the startup session arriving later is closed', await settled(() => late.disposed))
  check('the /new session stays bound', channel.agentId === opened[before]!.ref.sessionId && late.listenerCount() === 0)
  check('no failure notice for a superseded open', !notices(channel).some(text => text.includes('failed to open')))
  channel.releaseContributions()
}

// ── the real Chat over a not-ready channel ────────────────────────────
// Both the composer and landing page, inline/fullscreen and narrow/wide.
// A covered composer also exercises the parked draft's ownership transfer.
const notReady = t('startup-not-ready', { backend: 'Claude' })
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
async function screenCase(surface: 'composer' | 'launchpad' | 'launchpad-failed', sessionId: string, fullscreen = false, columns = 100, covered = false, outcome: 'adoption' | 'new' = 'adoption'): Promise<void> {
  const label = (text: string): string => `${surface}${covered ? ' covered' : ''}${outcome === 'new' ? ' /new' : ''} ${fullscreen ? 'fullscreen' : 'inline'} ${columns} cols: ${text}`
  const open = deferred()
  const channel = createChannel(ctx, createStartingSession('claude', process.cwd()), { ...launch(open.promise), cwd: process.cwd() })
  const COLS = columns
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
  const controllerRef: { current: PromptController | null } = { current: null }
  const chat = React.createElement(Chat, {
    channel: channel as never,
    questionStore: new QuestionStore(),
    approvalStore: new ApprovalStore(),
    onExit: () => undefined,
    fullscreen,
    trajectorySeen: true,
    promptControllerRef: controllerRef,
    // The composition root's kernel list: the notices name the kernel by its
    // short label ("Claude"), not the backend id.
    kernelEntries: kernelEntriesOf(listBackends()),
    ...(surface !== 'composer' ? { launchpadOnBoot: true } : {}),
  })
  const instance = await ui.render(
    fullscreen ? React.createElement(ui.AlternateScreen, null, chat) : chat,
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
    await clearLine()
    stdin.write(`\x1b[200~${pastedImagePath}\x1b[201~`)
    check(label('an image pasted before ready has a token'), await settled(() => screen().includes('[Image #1]')), screen())
    await typeLine('draft loading')
    check(label('typing before ready is visible'), await settled(() => screen().includes('draft loading')), screen())
    stdin.write('\x1b[D')
    // 固定窗:pacing caret movement has no observable text change.
    await sleep(60)
    if (covered) {
      stdin.write('\x01')
      check(label('the composer parks its draft behind the dashboard'), await settled(() => controllerRef.current === null && screen().includes('Subagent Dashboard')), screen())
    }
    if (outcome === 'new') {
      const before = opened.length
      check(label('/new explicitly replaces the placeholder'), await channel.newSession())
      const replacement = opened[before]!
      channel.notify('replacement ready')
      if (covered) stdin.write('\x1b')
      check(label('the explicit replacement is rendered'), await settled(() => screen().includes('replacement ready')), screen())
      check(label('the explicit replacement clears the old text and image token'), !screen().includes('draft loading') && !screen().includes('[Image #1]'), screen())
      if (surface === 'composer') check(label('the composer owns an empty draft'), controllerRef.current?.text?.() === '', controllerRef.current?.text?.())
      await typeLine('after new')
      stdin.write('\r')
      check(label('only new text reaches the replacement session'), await settled(() => replacement.submits.some(item => item.input.text === 'after new')), JSON.stringify(replacement.submits))
      check(label('the replacement inherits no old image'), replacement.submits.every(item => !hasStartupImage(item.input)), JSON.stringify(replacement.submits))
      open.resolve({ session: real, history: [] })
      check(label('the late startup session is closed'), await settled(() => real.disposed))
      check(label('the replacement remains bound'), channel.agentId === replacement.ref.sessionId)
      return
    }
    open.resolve({ session: real, history: [], route: { provider: 'fixture', model: 'READY' } })
    check(label('the channel becomes ready'), await settled(() => channel.ready))
    if (covered) stdin.write('\x1b')
    check(label('the ready session is rendered'), await settled(() => screen().includes('READY')), screen())
    check(label('adoption preserves the unsent draft'), screen().includes('draft loading'), screen())
    check(label('adoption does not submit the draft'), real.submits.length === 0)
    stdin.write('X')
    check(label('typing after adoption preserves the caret'), await settled(() => screen().includes('draft loadinXg')), screen())
    stdin.write('\r')
    check(label('the preserved draft reaches the real session'), await settled(() => real.submits.some(item => item.input.text === '[Image #1] draft loadinXg')), JSON.stringify(real.submits.map(item => item.input.text)))
    check(label('the preserved image reaches the real session'), real.submits.some(item => hasStartupImage(item.input)), JSON.stringify(real.submits))
    await clearLine()
    await typeLine('hello ready')
    stdin.write('\r')
    check(label('after the adoption Enter sends to the real session'), await settled(() => real.submits.some(item => item.input.text === 'hello ready')), JSON.stringify(real.submits.map(item => item.input.text)))
    // A refused line must not be queued and forwarded once the session opens.
    check(label('the refused early line never reaches the session'), !real.submits.some(item => item.input.text === 'hello early'), JSON.stringify(real.submits.map(item => item.input.text)))
    await typeLine('old session draft')
    check(label('a draft in the ready session is visible'), await settled(() => screen().includes('old session draft')), screen())
    check(label('/new replaces the real session'), await channel.newSession())
    check(label('a real session switch clears the draft'), await settled(() => !screen().includes('old session draft')), screen())
  } finally {
    instance.unmount()
    channel.releaseContributions()
  }
}
for (const fullscreen of [false, true]) {
  for (const columns of [100, 42]) {
    await screenCase('composer', '77777777-7777-4777-8777-777777777777', fullscreen, columns)
    await screenCase('launchpad', '88888888-8888-4888-8888-888888888888', fullscreen, columns)
  }
}
await screenCase('composer', '77777777-7777-4777-8777-777777777777', true, 42, true)
await screenCase('launchpad', '88888888-8888-4888-8888-888888888888', true, 42, false, 'new')
await screenCase('composer', '77777777-7777-4777-8777-777777777777', false, 100, false, 'new')
await screenCase('composer', '77777777-7777-4777-8777-777777777777', true, 42, true, 'new')
await screenCase('launchpad-failed', '99999999-9999-4999-8999-999999999999')
// A browser opened while startup is pending follows the first adoption.
for (const fullscreen of [false, true]) {
  for (const changedCwd of [false, true]) {
    const open = deferred()
    const cwd = process.cwd()
    const recorded = changedCwd ? `${cwd}/recorded` : cwd
    const summary = (id: string, directory: string, title: string): SessionSummary => ({
      id, cwd: directory, backendId: 'claude', kind: { kind: 'root' },
      title: { text: title, source: 'prompt' }, createdAt: 1, updatedAt: 2,
      bytes: undefined, hasPrompt: true, childCount: 0, agentPreset: undefined,
    })
    const initial = summary('launch-history', cwd, 'launch list')
    const fresh = summary('recorded-history', recorded, 'recorded list')
    let finishLocal!: (rows: readonly SessionSummary[]) => void
    const local = new Promise<readonly SessionSummary[]>(resolve => { finishLocal = resolve })
    let reads = 0
    const channel = createChannel(ctx, createStartingSession('claude', cwd), {
      ...launch(open.promise), cwd,
      sessionCatalog: {
        list: async (scope, onPartial) => {
          reads++
          if (scope?.cwd === cwd && (!channel.ready || !changedCwd)) {
            onPartial?.([initial])
            return local
          }
          return [fresh]
        },
      },
    })
    const list = channel.listSessions.bind(channel)
    const browserTasks: ReturnType<typeof list>[] = []
    channel.listSessions = (onEnriched, onPartial) => {
      const task = list(onEnriched, onPartial)
      if (onPartial !== undefined) browserTasks.push(task)
      return task
    }
    const term = new XTerm({ cols: 100, rows: 32, scrollback: 200, allowProposedApi: true })
    class FakeStdout extends Writable {
      columns = 100
      rows = 32
      isTTY = true
      _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void { term.write(String(chunk), callback) }
    }
    const stdin = new FakeStdin()
    const stdout = new FakeStdout()
    const screen = (): string => viewportLines(term, 32).join('\n')
    const child = React.createElement(Chat, { channel: channel as never, questionStore: new QuestionStore(), approvalStore: new ApprovalStore(), onExit: () => undefined, fullscreen, trajectorySeen: true })
    const instance = await ui.render(fullscreen ? React.createElement(ui.AlternateScreen, {}, child) : child, {
      stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false,
    })
    const label = `${fullscreen ? 'fullscreen' : 'inline'} ${changedCwd ? 'changed cwd' : 'same cwd'}`
    try {
      check(`${label}: startup preload starts before /resume`, await settled(() => reads === 1))
      stdin.write('/resume')
      await settled(() => screen().includes('/resume'))
      stdin.write('\r')
      check(`${label}: /resume paints preload progress before readiness`, await settled(() => screen().includes('launch list')), screen())
      open.resolve({ session: fakeSession('adopted-real', recorded), history: [] })
      check(`${label}: the open browser rechecks its scope after adoption`, await settled(() => channel.ready && browserTasks.length >= 2))
      if (changedCwd) {
        check(`${label}: the browser follows the recorded workspace`, await settled(() => screen().includes('recorded list') && !screen().includes('launch list')), screen())
      }
      finishLocal([initial])
      await browserTasks[0]
      check(`${label}: an old completion cannot empty the browser`, await settled(() => screen().includes(changedCwd ? 'recorded list' : 'launch list')), screen())
      if (!changedCwd) check(`${label}: readiness reuses the pending preload`, reads === 2, String(reads))
    } finally {
      finishLocal([initial])
      instance.unmount()
      channel.releaseContributions()
    }
  }
}

console.log(`\nverify-startup-adoption: ${passed} checks passed`)
process.exit(0)
