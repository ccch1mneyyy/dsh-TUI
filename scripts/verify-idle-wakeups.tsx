/**
 * Idle-wakeup regression: static UI states must not hold animation clocks
 * or periodic timers. Asserts, per component, that a quiet window produces
 * ZERO frames (no renderer commits) in the static state and a non-zero
 * frame count in the corresponding live state.
 *
 *   A. Chat idle (working=false, activity off): no frames after settle.
 *   B. Chat working with the mini-wake enabled: frames while wide, no
 *      frames on a narrow terminal (width gate) or with the wake disabled.
 *   C. ActivityLine done: no frames; live phase: frames.
 *   D. JobsPanel all-settled: no frames; with a running job: frames.
 *   E. GoalTodoPanel paused/blocked: no frames; active: frames.
 *
 * Run via `node --import tsx/esm scripts/verify-idle-wakeups.tsx`.
 */
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { Chat }, { QuestionStore }, { Box }] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/screens/Chat.js'),
    import('../src/dsh-adapter/questions.js'),
    import('../src/ui.js'),
  ])
const { ActivityLine } = await import('../src/components/ActivityLine.js')
const { JobsPanel } = await import('../src/components/JobsPanel.js')
const { GoalTodoPanel } = await import('../src/components/GoalTodoPanel.js')
const { AgentView } = await import('../src/screens/AgentView.js')
const instances = (await import('../src/ink/instances.js')).default
const { sleep } = await import('./lib/term-test.mjs')

let failed = 0
const check = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

/** Mount a React node in a headless terminal; counts painted frames. */
async function mountProbe(cols: number, rows: number, node: React.ReactNode): Promise<{
  countFrames: (windowMs: number) => Promise<number>
  unmount: () => void
}> {
  const term = new XTerm({ cols, rows, scrollback: 100, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      term.write(String(chunk), callback)
    }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode(): this { return this }
    ref(): this { return this }
    unref(): this { return this }
  }
  const stdout = new FakeStdout()
  const stdin = new FakeStdin()
  let frames = 0
  const causes: string[] = []
  const instance = await render(node, {
    stdout: stdout as never,
    stdin: stdin as never,
    stderr: stdout as never,
    exitOnCtrlC: false,
    patchConsole: false,
    onFrame: () => { frames += 1 },
  })
  for (const value of instances.values()) instances.set(process.stdout, value)
  // Settle the initial paint (and any one-shot intro animations, plus the
  // MessageList measure cascade / paint-expansion hold).
  await sleep(900)
  const countFrames = async (windowMs: number): Promise<number> => {
    frames = 0
    await sleep(windowMs)
    return frames
  }
  const frameLog = (): void => {
    // eslint-disable-next-line no-console
    console.error(`[probe] frames=${frames}`)
  }
  const unmount = (): void => {
    instance.unmount()
    instances.delete(stdout)
    term.dispose()
  }
  return { countFrames, unmount }
}

function makeChannel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // 40 rows: past the LogoHeader intro threshold (rows.length > 30 skips
  // the ~3.4s whale animation), so the idle probe measures the steady state.
  const rows = Array.from({ length: 40 }, (_, i) => ({
    id: i,
    kind: (i % 3 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    text: `row ${i}`,
  }))
  return {
    version: 0,
    rows,
    status: 'idle',
    sessionTitle: 'idle probe',
    agentId: 'probe',
    model: 'deepseek-v4-flash',
    tokens: { input: 600, output: 120 },
    cwd: 'C:/code/demo',
    displayCwd: 'C:/code/demo',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'idle',
    responseChars: 0,
    activeToolCount: 0,
    mode: { id: 'default', plan: false },
    modeIndex: 0,
    turnStart: Date.now() - 60_000,
    lastUserText: '',
    pending: [],
    commandList: [],
    notifications: [],
    activityEnabled: false,
    contextBarEnabled: true,
    statusBar: {
      compact: true, model: true, thinking: true, cwd: true, contextUsage: true,
      cache: true, tokens: false, tps: false, gitBranch: false, sessionTitle: false,
      sessionId: false, mode: false, contextBar: false, activity: false,
      trajectory: true, shortcutHint: false,
    },
    activityFrames: [],
    loadedContext: undefined,
    goal: undefined,
    todos: [],
    traceEvents: () => [],
    trajectory: () => ({ nodes: [], counts: { rows: 0, errors: 0 } }),
    subscribe: () => () => {},
    submit: (): void => {},
    cancel: (): void => {},
    clear: (): void => {},
    notify: (): void => {},
    ...overrides,
  }
}

const chatNode = (channel: Record<string, unknown>): React.ReactNode =>
  React.createElement(Chat, {
    channel: channel as never,
    questionStore: new QuestionStore() as never,
    onExit: () => {},
    fullscreen: false,
    trajectorySeen: true,
  })

// ── A. Idle Chat: no periodic Chat-level renders ──────────────────────────
{
  const probe = await mountProbe(120, 30, chatNode(makeChannel()))
  const frames = await probe.countFrames(1500)
  check('A: idle Chat produces no periodic frames', frames === 0, `frames=${frames} over 1.5s`)
  probe.unmount()
}

// ── B. MiniWake clock gating (wide/narrow/disabled) ───────────────────────
{
  // Wide + working + wake enabled: the 120ms wake clock ticks → frames.
  const wide = await mountProbe(120, 30, chatNode(makeChannel({ working: true })))
  const wideFrames = await wide.countFrames(1000)
  check('B1: working Chat with wake enabled renders periodically',
    wideFrames > 0, `frames=${wideFrames} over 1s`)
  wide.unmount()

  // The working spinner is a separate, legitimate animation (~17fps); the
  // wake clock adds its own 120ms ticks on top. The gate assertions below
  // therefore compare against the enabled baseline: when the wake is gated
  // off (narrow terminal / disabled status-bar field), the frame rate must
  // drop back to the spinner-only level.
  // Narrow (<84 cols): miniWakeWidth()=0 → wake clock off despite working.
  const narrow = await mountProbe(80, 30, chatNode(makeChannel({ working: true })))
  const narrowFrames = await narrow.countFrames(1000)
  check('B2: narrow terminal stops the wake clock',
    narrowFrames > 0 && narrowFrames < wideFrames,
    `frames=${narrowFrames} vs enabled=${wideFrames}`)
  narrow.unmount()

  // Wake disabled in the status bar: same gate, no clock.
  const disabled = await mountProbe(120, 30, chatNode(makeChannel({
    working: true,
    statusBar: {
      compact: true, model: true, thinking: true, cwd: true, contextUsage: true,
      cache: true, tokens: false, tps: false, gitBranch: false, sessionTitle: false,
      sessionId: false, mode: false, contextBar: false, activity: false,
      trajectory: false, shortcutHint: false,
    },
  })))
  const disabledFrames = await disabled.countFrames(1000)
  check('B3: wake-disabled status bar stops the clock',
    disabledFrames > 0 && disabledFrames < wideFrames,
    `frames=${disabledFrames} vs enabled=${wideFrames}`)
  disabled.unmount()
}

// ── C. ActivityLine static-done branch ────────────────────────────────────
{
  const done = {
    phase: 'done' as const, line: '3 tools · thought 2s worked 1s', toolCount: 3, turnElapsedMs: 4000,
  }
  const doneProbe = await mountProbe(100, 20, React.createElement(ActivityLine, { activity: done }))
  const doneFrames = await doneProbe.countFrames(1000)
  check('C1: ActivityLine(done) holds no animation clock', doneFrames === 0, `frames=${doneFrames}`)
  doneProbe.unmount()

  const live = {
    phase: 'thinking' as const, line: 'thinking · total 3s', toolCount: 0, turnElapsedMs: 3000,
  }
  const liveProbe = await mountProbe(100, 20, React.createElement(ActivityLine, { activity: live }))
  const liveFrames = await liveProbe.countFrames(1000)
  check('C2: ActivityLine(live) animates', liveFrames > 0, `frames=${liveFrames}`)
  liveProbe.unmount()
}

// ── D. JobsPanel settled vs live ──────────────────────────────────────────
{
  const settledJobs = [
    { id: 'j1', kind: 'shell', label: 'done job', status: 'completed' as const, startedAt: Date.now() - 5000, finishedAt: Date.now() - 1000, outputLines: [], command: undefined, detail: undefined, lastOutputAt: undefined, exitCode: 0 },
  ]
  const settledProbe = await mountProbe(100, 24, React.createElement(JobsPanel, {
    jobs: settledJobs, onClose: () => {}, onKill: () => {},
  }))
  const settledFrames = await settledProbe.countFrames(1000)
  check('D1: all-settled JobsPanel holds no clock', settledFrames === 0, `frames=${settledFrames}`)
  settledProbe.unmount()

  const emptyProbe = await mountProbe(100, 24, React.createElement(JobsPanel, {
    jobs: [], onClose: () => {}, onKill: () => {},
  }))
  const emptyFrames = await emptyProbe.countFrames(1000)
  check('D2: empty JobsPanel holds no clock', emptyFrames === 0, `frames=${emptyFrames}`)
  emptyProbe.unmount()

  const runningJobs = [
    { id: 'j2', kind: 'shell', label: 'live job', status: 'running' as const, startedAt: Date.now() - 2000, finishedAt: undefined, outputLines: [], command: undefined, detail: undefined, lastOutputAt: Date.now() - 100, exitCode: undefined },
  ]
  const liveProbe = await mountProbe(100, 24, React.createElement(JobsPanel, {
    jobs: runningJobs, onClose: () => {}, onKill: () => {},
  }))
  const liveFrames = await liveProbe.countFrames(1500)
  check('D3: running job ticks the clock', liveFrames > 0, `frames=${liveFrames}`)
  liveProbe.unmount()
}

// ── E. GoalTodoPanel paused/blocked vs active ─────────────────────────────
{
  const goalBase = {
    id: 'g1', objective: 'build the thing', roundsStarted: 1, maxGoalRounds: 4,
    phase: 'paused' as const, blockedReason: undefined,
  }
  const channel = (phase: 'paused' | 'blocked' | 'active'): Record<string, unknown> => {
    const base = makeChannel()
    base.goal = { ...goalBase, phase }
    base.todos = [{ id: 't1', content: 'step one', status: 'pending' }]
    return base
  }
  const pausedProbe = await mountProbe(100, 24, React.createElement(GoalTodoPanel, { channel: channel('paused') as never }))
  const pausedFrames = await pausedProbe.countFrames(1200)
  check('E1: paused goal holds no elapsed clock', pausedFrames === 0, `frames=${pausedFrames}`)
  pausedProbe.unmount()

  const blockedProbe = await mountProbe(100, 24, React.createElement(GoalTodoPanel, { channel: channel('blocked') as never }))
  const blockedFrames = await blockedProbe.countFrames(1200)
  check('E2: blocked goal holds no elapsed clock', blockedFrames === 0, `frames=${blockedFrames}`)
  blockedProbe.unmount()

  const activeProbe = await mountProbe(100, 24, React.createElement(GoalTodoPanel, { channel: channel('active') as never }))
  const activeFrames = await activeProbe.countFrames(1500)
  check('E3: active goal ticks the elapsed clock', activeFrames > 0, `frames=${activeFrames}`)
  activeProbe.unmount()
}

// ── F. AgentView static list: bucket-boundary clock, not a 1s poll ────────
{
  const agentViewChannel = makeChannel()
  agentViewChannel.agentViewRows = () => [
    { id: 's1', status: 'completed', title: 'done session', summary: '', cwd: '/tmp', createdAt: Date.now() - 3600_000, updatedAt: Date.now() - 3600_000, current: false, needsInput: false },
    { id: 's2', status: 'stopped', title: 'old session', summary: '', cwd: '/tmp', createdAt: Date.now() - 7200_000, updatedAt: Date.now() - 7200_000, current: false, needsInput: false },
  ]
  agentViewChannel.subscribeAgentView = () => () => {}
  const probe = await mountProbe(120, 30, React.createElement(AgentView, {
    channel: agentViewChannel as never,
    home: '/home',
    approval: null,
    onApprove: () => {},
    onClose: () => {},
  }))
  // Rows aged 1-2h: the next display bucket (minute/half-hour boundary) is
  // minutes away, so a 2s window must contain NO clock-driven frames — a
  // 1s polling clock would produce 1-2.
  const frames = await probe.countFrames(2000)
  check('F: static AgentView list holds no 1s clock', frames === 0, `frames=${frames} over 2s`)
  probe.unmount()
}

console.log(failed === 0 ? 'verify-idle-wakeups: all checks passed' : `${failed} check(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
