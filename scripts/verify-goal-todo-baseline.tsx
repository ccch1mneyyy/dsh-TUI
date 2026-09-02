/**
 * verify-goal-todo-baseline — GoalTodoPanel elapsed-baseline regression
 * (#713 integration review blocker 5).
 *
 * The elapsed clock's baseline (startRef) may only move in COMMITTED
 * transitions (the useEffect): render-phase ref writes let an abandoned
 * concurrent render pollute the baseline for every later reading. This
 * script behaviorally pins the four contracts:
 *
 *   1. active: elapsed advances (label grows);
 *   2. paused: elapsed frozen AND no animation timer;
 *   3. paused 鈫?active resume: elapsed RE-BASES at the committed transition
 *      (label restarts near 0s — a stale baseline would show the
 *      accumulated total);
 *   4. a new goal id: fresh baseline from its own commit.
 *
 * Purity-by-construction (no render-phase startRef/phase writes remain) is
 * enforced by the effect-only mutation in GoalTodoPanel.tsx.
 *
 * Run: node --import tsx/esm scripts/verify-goal-todo-baseline.tsx
 */
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { GoalTodoPanel }] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/components/GoalTodoPanel.js'),
  ])
const instances = (await import('../src/ink/instances.js')).default
const { sleep } = await import('./lib/term-test.mjs')

let failed = 0
const check = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// 120 cols keeps the goal badge line well clear of the right edge: at 100
// the `· 2s` suffix sits exactly on the wrap boundary and an emoji-width
// measurement hiccup can push the trailing `s` to the next line.
const COLS = 120
const ROWS = 24

async function makeHarness() {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 100, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = COLS
    rows = ROWS
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
  const listeners = new Set<() => void>()
  const channel: Record<string, unknown> = {
    version: 0,
    rows: [],
    status: 'idle',
    sessionTitle: 'goal probe',
    agentId: 'probe',
    model: 'm',
    tokens: { input: 0, output: 0 },
    cwd: 'C:/x',
    displayCwd: 'C:/x',
    gitBranch: 'main',
    working: true,
    spinnerMode: 'idle',
    responseChars: 0,
    activeToolCount: 0,
    mode: { id: 'default', plan: false },
    modeIndex: 0,
    turnStart: Date.now(),
    lastUserText: '',
    pending: [],
    commandList: [],
    notifications: [],
    activityEnabled: false,
    contextBarEnabled: false,
    goal: undefined,
    todos: [],
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const emit = (): void => {
    channel.version = Number(channel.version) + 1
    for (const listener of [...listeners]) listener()
    rerender()
  }
  let frames = 0
  const instance = { unmount(): void { /* set below */ } }
  const makeNode = (): React.ReactNode =>
    React.createElement(GoalTodoPanel, { channel: channel as never })
  const ink = await render(makeNode(), {
    stdout: stdout as never,
    stdin: stdin as never,
    stderr: stdout as never,
    exitOnCtrlC: false,
    patchConsole: false,
    onFrame: () => { frames += 1 },
  })
  instance.unmount = () => ink.unmount()
  // GoalTodoPanel has no subscription of its own — Chat's re-render is what
  // usually drives it. The standalone harness re-renders explicitly: emit()
  // bumps the channel and the rerender below lands the fresh props.
  const rerender = (): void => {
    ink.rerender(makeNode())
  }
  const screen = (): string => {
    const buffer = term.buffer.active
    return Array.from({ length: ROWS }, (_, y) =>
      buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '',
    ).join('\n')
  }
  /** The elapsed label rendered inside the PhaseBadge (`· 12s` / `· 1m03s`). */
  const elapsedLabel = (): string => {
    const match = screen().match(/·\s*(\d+[sm][0-9s]*)/)
    return match?.[1] ?? ''
  }
  const countFrames = async (windowMs: number): Promise<number> => {
    frames = 0
    await sleep(windowMs)
    return frames
  }
  return { channel, emit, elapsedLabel, countFrames, screen, unmount: () => { ink.unmount(); instances.delete(stdout); term.dispose() } }
}

const goalOf = (id: string, phase: 'active' | 'paused' | 'complete') => ({
  id, objective: 'g', roundsStarted: 1, maxGoalRounds: 4, phase, blockedReason: undefined,
})

{
  const h = await makeHarness()
  // 1. active: baseline starts at commit; elapsed advances.
  h.channel.goal = goalOf('g1', 'active')
  h.emit()
  await sleep(300)
  const early = h.elapsedLabel()
  await sleep(2200)
  const later = h.elapsedLabel()
  check('1: active goal elapsed advances', later !== '' && later !== early, `early=${early} later=${later}`)
  check('1: active baseline started near mount (early reading is small)', /^([0-4]s)$/.test(early), `early=${early}`)

  // 2. paused: frozen + no timer.
  const beforePause = h.elapsedLabel()
  h.channel.goal = goalOf('g1', 'paused')
  h.emit()
  // Settle the transition paint first: the paused commit itself renders one
  // frame (that is the phase change, not a timer).
  await sleep(400)
  const settledLabel = h.elapsedLabel()
  const pausedFrames = await h.countFrames(2200)
  const afterPause = h.elapsedLabel()
  check('2: paused goal freezes the elapsed label', afterPause === settledLabel && afterPause === beforePause, `before=${beforePause} after=${afterPause}`)
  check('2: paused goal holds no animation timer', pausedFrames === 0, `frames=${pausedFrames}`)

  // 3. resume: re-base at the COMMITTED transition — the label must restart
  // near 0s, not continue from the pre-pause accumulated total (a stale
  // baseline would read ~5-7s here; the bound stays far below that).
  const pausedFor = 2200
  h.channel.goal = goalOf('g1', 'active')
  h.emit()
  await sleep(400)
  const resumed = h.elapsedLabel()
  const parseMs = (label: string): number => {
    const m = label.match(/^(\d+)s$/)
    if (m) return Number(m[1]) * 1000
    const mm = label.match(/^(\d+)m(\d+)s$/)
    return mm ? (Number(mm[1]) * 60 + Number(mm[2])) * 1000 : Number.NaN
  }
  check(
    '3: resume re-bases the clock at the committed transition',
    resumed !== '' && parseMs(resumed) <= 2600,
    `resumed=${resumed} (pre-pause label was ${beforePause})`,
  )
  void pausedFor

  // 4. a new goal id takes a fresh baseline from its own commit.
  await sleep(1500)
  h.channel.goal = goalOf('g2', 'active')
  h.emit()
  await sleep(300)
  const fresh = h.elapsedLabel()
  check('4: new goal id restarts the baseline', /^([0-3]s)$/.test(fresh), `fresh=${fresh}`)

  h.unmount()
}

console.log(failed === 0 ? 'verify-goal-todo-baseline: all checks passed' : `${failed} check(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
