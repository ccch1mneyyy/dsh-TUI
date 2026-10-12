/**
 * Direct kernel commands through real Chat and channel: every current backend,
 * inline/fullscreen and narrow widths, lazy probing, mid-turn gates, startup,
 * installation guidance and cancellation of a waiting pick. No real backends.
 * Run: node --import tsx/esm scripts/verify-kernel-commands.tsx
 */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import type { AgentEvent, AgentEventMeta } from '../src/agent/events.js'
import type { AgentSession } from '../src/agent/session.js'
import type { KernelStatus } from '../src/components/kernelCatalog.js'
import type { PromptController } from '../src/components/PromptInput.js'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [{ Writable, PassThrough }, React, { Terminal: XTerm }, ui, { Chat }, { QuestionStore }, { PermissionStore }, { createChannel }, { createStartingSession }, { setLang, t }, { kernelEntriesOf }, { listBackends }, { isBootSafeCommand, localizedDescription, LOCAL_COMMANDS }, { settled, sleep, viewportLines }] = await Promise.all([
  import('node:stream'), import('react'), import('@xterm/headless'), import('../src/ui.js'),
  import('../src/screens/Chat.js'), import('../src/channel/questions.js'), import('../src/channel/permissions.js'),
  import('../src/dsh-adapter/channel.js'), import('../src/agent/starting-session.js'), import('../src/i18n.js'),
  import('../src/components/kernelCatalog.js'), import('../src/dsh-adapter/backend-registry.js'),
  import('../src/commands.js'), import('./lib/term-test.mjs'),
])
setLang('en')

const ids = ['dsh', 'codex', 'claude'] as const
type Statuses = Record<string, KernelStatus>
const installed: Statuses = { codex: { installed: true, auth: 'missing', loginInSession: true }, claude: { installed: true } }
let passed = 0
function check(label: string, ok: boolean, detail = ''): void {
  assert.ok(ok, `${label}\n${detail}`)
  passed += 1
  console.log(`PASS ${label}`)
}

async function boot(current: typeof ids[number], fullscreen = false, columns = 100, launchpad = false, starting = false, switchable = true, installable = false) {
  const term = new XTerm({ cols: columns, rows: 32, scrollback: 200, allowProposedApi: true })
  class Out extends Writable {
    columns = columns
    rows = 32
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void { term.write(String(chunk), callback) }
  }
  class In extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const stdin = new In()
  const listeners = new Set<(events: readonly AgentEvent[], meta: AgentEventMeta) => void>()
  let submits = 0
  const session: AgentSession = {
    ...createStartingSession(current, process.cwd()),
    ref: { backendId: current, sessionId: '55555555-5555-4555-8555-555555555555' },
    status: 'idle',
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    submit: () => { submits += 1; return Promise.resolve({ accepted: true }) },
  }
  const ctx = { on: () => () => undefined, get: () => undefined, logger: { warn: () => undefined, info: () => undefined, debug: () => undefined } } as never
  const channel = createChannel(ctx, session, {
    model: 'fixture', provider: '', cwd: process.cwd(), activity: false,
    ...(starting ? { startup: new Promise<never>(() => undefined) } : {}),
  })
  const switches: string[] = []
  let probeCalls = 0
  let resolveProbe!: (statuses: Statuses) => void
  let rejectProbe!: (error: Error) => void
  const probe = new Promise<Statuses>((resolve, reject) => { resolveProbe = resolve; rejectProbe = reject })
  const controller: { current: PromptController | null } = { current: null }
  const view = (): string => viewportLines(term).join('\n')
  const node = <Chat channel={channel as never} questionStore={new QuestionStore()} approvalStore={new PermissionStore()}
    onExit={() => undefined} fullscreen={fullscreen} trajectorySeen launchpadOnBoot={launchpad}
    promptControllerRef={controller} kernelEntries={kernelEntriesOf(listBackends())}
    onProbeKernels={() => { probeCalls += 1; return probe }}
    {...(switchable ? { onSwitchBackend: (id: string) => { switches.push(id) } } : {})}
    {...(installable ? { onResolveSdkInstall: (id: string) => id === 'claude' ? {
      executor: 'pnpm-profile-add', specifier: '@verify/claude@1.0.0', version: '1.0.0',
      resolveTarget: () => ({ kind: 'profile' as const, dir: '/fixture/claude' }),
      preflight: () => Promise.resolve(true),
      start: () => { throw new Error('the command must not start an install itself') },
    } : undefined } : {})}
  />
  const stdout = new Out()
  const app = await ui.render(fullscreen ? <ui.AlternateScreen>{node}</ui.AlternateScreen> : node, {
    stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false,
  })
  // 固定窗:pacing keyboard handlers attach after the first frame.
  await sleep(150)
  const command = async (name: string): Promise<void> => {
    if (controller.current !== null) controller.current.clear()
    stdin.write(`\x1b[200~/${name}\x1b[201~`)
    check(`/${name} enters the prompt`, await settled(() => view().includes(`/${name}`)), view())
    // 固定窗:墙钟 successive command confirmations cross the composer's 80ms Enter debounce.
    await sleep(90)
    stdin.write('\r')
  }
  const notice = async (key: Parameters<typeof t>[0], action: () => Promise<void>): Promise<void> => {
    const before = channel.notifications.length
    await action()
    check(key, await settled(() => channel.notifications.slice(before).some(item => item.text === t(key))), view())
  }
  const emit = (event: AgentEvent): void => { for (const listener of listeners) listener([event], { replay: false }) }
  return {
    channel, switches, command, notice, view, resolveProbe, rejectProbe,
    probeCalls: () => probeCalls, submits: () => submits,
    working: () => emit({ type: 'turn.start', turn: 1, origin: 'user', time: 1 }),
    idle: () => emit({ type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 2 }),
    close: () => { app.unmount(); channel.releaseContributions(); term.dispose() },
  }
}

for (const fullscreen of [false, true]) for (const columns of [100, 42]) for (const current of ids) {
  const h = await boot(current, fullscreen, columns)
  const tag = `${current} ${fullscreen ? 'fullscreen' : 'inline'} ${columns}`
  try {
    for (const id of ids) {
      check(`${tag}: /${id} offered in completion`, h.channel.commandCompletions(`/${id}`).some(command => command.name === id))
    }
    const target = current === 'codex' ? 'claude' : 'codex'
    await h.command(target)
    check(`${tag}: waits for lazy detection`, await settled(() => h.probeCalls() === 1) && h.switches.length === 0)
    h.resolveProbe(installed)
    check(`${tag}: signed-out target can switch after probing`, await settled(() => h.switches.join() === target), h.view())
    for (const id of ids) {
      const before = h.switches.length
      if (id === current) await h.notice('kernel-already-current', () => h.command(id))
      else {
        await h.command(id)
        check(`${tag}: /${id} uses host switch`, await settled(() => h.switches.length === before + 1 && h.switches.at(-1) === id))
      }
    }
    const before = h.switches.length
    h.working()
    await h.notice('kernel-switch-while-working', () => h.command(target))
    check(`${tag}: running turn stays on its kernel and no command reaches the model`, h.channel.working && h.switches.length === before && h.submits() === 0)
  } finally { h.close() }
}

// Landing page + startup: the shortcuts remain local and boot-safe.
for (const launchpad of [false, true]) {
  const h = await boot('codex', true, 42, launchpad, true)
  try {
    check('startup channel is not ready', !h.channel.ready)
    await h.command('dsh')
    check('DSH switches without waiting for optional detection', await settled(() => h.switches.join() === 'dsh'), h.view())
    await h.command('claude')
    h.resolveProbe(installed)
    check('Claude switches from the startup screen', await settled(() => h.switches.join() === 'dsh,claude'), h.view())
  } finally { h.close() }
}

for (const outcome of ['missing', 'old', 'failed', 'busy', 'was-busy', 'unmounted', 'superseded', 'install', 'no-host'] as const) {
  const h = await boot('dsh', false, 100, false, false, outcome !== 'no-host', outcome === 'install')
  let closed = false
  try {
    if (outcome === 'was-busy') h.working()
    await h.command(outcome === 'install' ? 'claude' : 'codex')
    check(`${outcome}: detection started`, await settled(() => h.probeCalls() === 1))
    if (outcome === 'busy') h.working()
    if (outcome === 'was-busy') h.idle()
    if (outcome === 'unmounted') { h.close(); closed = true }
    if (outcome === 'superseded') await h.notice('kernel-already-current', () => h.command('dsh'))
    if (outcome === 'failed') h.rejectProbe(new Error('detection failed'))
    else h.resolveProbe(outcome === 'missing' || outcome === 'install' ? { codex: { installed: false }, claude: { installed: false } }
      : outcome === 'old' ? { codex: { installed: false, stale: true, hint: 'upgrade fixture codex' } } : installed)
    if (outcome === 'install') check('missing Claude opens its install wizard', await settled(() => h.view().includes('/fixture/claude')), h.view())
    else if (outcome !== 'unmounted' && outcome !== 'superseded') {
      const expected = outcome === 'old' ? 'upgrade fixture codex' : t(outcome === 'busy' || outcome === 'was-busy' ? 'kernel-switch-while-working' : outcome === 'no-host' ? 'kernel-switch-unavailable' : 'kernel-unavailable-not-installed')
      check(`${outcome}: picker guidance reused`, await settled(() => h.channel.notifications.some(item => item.text === expected)), h.view())
    } else {
      // 固定窗:探针 a cancelled probe completion must not invoke the host switch.
      await sleep(150)
    }
    check(`${outcome}: no switch or model submission`, h.switches.length === 0 && h.submits() === 0)
  } finally { if (!closed) h.close() }
}

for (const id of ids) {
  check(`/${id} is boot-safe`, isBootSafeCommand(id))
  const command = LOCAL_COMMANDS.find(command => command.name === id)!
  setLang('zh')
  check(`/${id} has a Chinese description`, localizedDescription(command).includes('切换到'))
  setLang('en')
  check(`/${id} has an English description`, localizedDescription(command).startsWith('Switch to'))
}
console.log(`verify-kernel-commands OK (${passed} checks)`)
