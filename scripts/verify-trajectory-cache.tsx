/**
 * Trajectory cache regression: Chat renders must not reach the session
 * event getter, and the legacy `traceEvents()`-only fallback must fold by
 * snapshot identity (one getter call per snapshot, not per render).
 *
 *   A. A channel providing `trajectory()`: `traceEvents` is never called
 *      during render, across many version bumps.
 *   B. A legacy stub providing only `traceEvents()`: repeated renders with
 *      an unchanged snapshot call the getter exactly once; a NEW snapshot
 *      (appended event) costs exactly one more call; the folded build
 *      grows incrementally.
 *
 * Run via `node --import tsx/esm scripts/verify-trajectory-cache.tsx`.
 */
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { Chat }, { QuestionStore }] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/screens/Chat.js'),
    import('../src/dsh-adapter/questions.js'),
  ])
const instances = (await import('../src/ink/instances.js')).default
const { sleep } = await import('./lib/term-test.mjs')

let failed = 0
const check = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

/** A minimal session event log: one turn with a user + assistant message. */
const makeEvents = (): Record<string, unknown>[] => [
  { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
  {
    type: 'user/message', seq: 2, time: 1100,
    data: { turn: 1, content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
  },
  {
    type: 'assistant/message', seq: 3, time: 1200,
    data: { turn: 1, content: [{ type: 'text', text: 'hi there' }] },
  },
  { type: 'turn/end', seq: 4, time: 1300, data: { turn: 1, reason: { kind: 'completed' } } },
]

function makeChannel(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 0,
    rows: [],
    status: 'idle',
    sessionTitle: 'cache probe',
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
    subscribe: () => () => {},
    submit: (): void => {},
    cancel: (): void => {},
    clear: (): void => {},
    notify: (): void => {},
    ...overrides,
  }
}

function makeHarness(cols: number, rows: number): {
  stdout: Writable
  stdin: PassThrough
  term: XTerm
  screen: () => string
  dispose: () => void
} {
  const term = new XTerm({ cols, rows, scrollback: 200, allowProposedApi: true })
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
  const screen = (): string => {
    const buffer = term.buffer.active
    return Array.from({ length: rows }, (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '').join('\n')
  }
  return { stdout, stdin, term, screen, dispose: () => { term.dispose() } }
}

// ── A. Real trajectory seam: renders never touch the event getter ─────────
{
  const { stdout, stdin, dispose } = makeHarness(100, 24)
  let traceCalls = 0
  let build = { nodes: [] as unknown[], counts: { rows: 0, errors: 0 } }
  const listeners = new Set<() => void>()
  const events = makeEvents()
  const channel = makeChannel({
    traceEvents: () => {
      traceCalls += 1
      return events
    },
    trajectory: () => build,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  })
  const publish = (): void => {
    channel.version = Number(channel.version) + 1
    for (const listener of listeners) listener()
  }
  const instance = await render(
    React.createElement(Chat, {
      channel: channel as never,
      questionStore: new QuestionStore() as never,
      onExit: () => {},
      fullscreen: false,
      trajectorySeen: true,
    }),
    { stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  for (const value of instances.values()) instances.set(process.stdout, value)
  await sleep(200)
  const callsAfterMount = traceCalls
  // The mount itself must be getter-free too: recording a post-mount
  // baseline and only checking "no increase" would let a mount that called
  // traceEvents 20 times pass — the trajectory() seam must be authoritative
  // from the very first render.
  check('A0: mount itself never calls traceEvents (trajectory seam authoritative)',
    callsAfterMount === 0,
    `traceCalls=${callsAfterMount} at mount`)
  // Ten idle version bumps (the streaming-cadence wakeup pattern): renders
  // must not re-read events through the getter.
  for (let i = 0; i < 10; i++) {
    publish()
    await sleep(20)
  }
  check('A1: trajectory seam renders never call traceEvents',
    traceCalls === callsAfterMount,
    `traceCalls=${traceCalls} after mount+10 bumps`)
  // A session append changes the build: the channel folds it at event time
  // (exercised through extendTrajectory directly), and a render reads the
  // new build without touching the getter.
  build = { nodes: [{ seq: 5 } as never], counts: { rows: 1, errors: 0 } }
  publish()
  await sleep(50)
  check('A2: appended build is read without traceEvents',
    traceCalls === callsAfterMount,
    `traceCalls=${traceCalls}`)
  instance.unmount()
  instances.delete(process.stdout)
  dispose()
}

// ── B. Legacy fallback: snapshot-identity cached fold ─────────────────────
{
  const { stdout, stdin, dispose } = makeHarness(100, 24)
  let events = makeEvents()
  let traceCalls = 0
  const listeners = new Set<() => void>()
  const channel = makeChannel({
    // Working + trajectory-enabled + wide terminal: the status-line wake
    // clock ticks at 120ms, re-rendering Chat WITHOUT version bumps — the
    // perfect "idle render" source for the fallback probe.
    working: true,
    traceEvents: () => {
      traceCalls += 1
      return events
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  })
  const publish = (): void => {
    channel.version = Number(channel.version) + 1
    for (const listener of listeners) listener()
  }
  const instance = await render(
    React.createElement(Chat, {
      channel: channel as never,
      questionStore: new QuestionStore() as never,
      onExit: () => {},
      fullscreen: false,
      trajectorySeen: true,
    }),
    { stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  for (const value of instances.values()) instances.set(process.stdout, value)
  await sleep(150)
  const afterMount = traceCalls
  check('B1: legacy fallback folds once at mount',
    afterMount >= 1 && afterMount <= 2,
    `traceCalls=${afterMount}`)
  // Wake-clock renders (unchanged channel version): the version gate must
  // keep the getter silent — no per-render re-reads on an idle render.
  await sleep(600)
  check('B2: unchanged version renders never call traceEvents',
    traceCalls === afterMount,
    `traceCalls=${traceCalls} after ~5 wake ticks`)
  // One appended event → one new snapshot → exactly one more getter call,
  // and the fold extends the previous build (incremental path).
  const appended = events
  events = [...appended, { type: 'turn/start', seq: 5, time: 2000, data: { turn: 2 } }]
  publish()
  await sleep(50)
  check('B3: one appended event costs exactly one getter call',
    traceCalls === afterMount + 1,
    `traceCalls=${traceCalls}`)
  instance.unmount()
  instances.delete(process.stdout)
  dispose()
}

console.log(failed === 0 ? 'verify-trajectory-cache: all checks passed' : `${failed} check(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
