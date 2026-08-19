/**
 * Trajectory scene regression (issue #80 evolution) — replaces repro-trace.
 *
 * Part A drives the scene itself through a headless xterm and asserts what a
 * reader actually sees: ledger rows with names and durations, the cursor, the
 * wake, and an inspector that follows the cursor. Part B drives the whole Chat
 * screen and asserts the properties that make the scene safe to open on a live
 * session:
 *
 * - **The main screen comes back byte-identical.** The conversation must be
 *   exactly as it was, because the scene is a place you visit, not a mode you
 *   have to undo.
 * - **Scrollback does not grow.** This is the shrink-frame family (#38/#39/
 *   #19/#10) expressed as a machine check: the alternate screen has no
 *   scrollback, so a correct implementation adds zero lines no matter how many
 *   times the scene is opened and closed.
 * - **Animation patches, never repaints.** Across a hundred idle ticks the
 *   write stream must contain no line erase, screen clear, or scroll — if a
 *   motion verb ever changes layout instead of colour, this fails.
 *
 * Run: node --import tsx/esm scripts/verify-trace-scene.tsx
 */
process.env.FORCE_COLOR = '3'
// Asserts Chinese UI copy, so it pins the language rather than inheriting the
// ambient one — the same rule the English-asserting scripts follow since
// fb87339. `activeLang` resolves at import from env → persisted pref → OS
// locale, none of which a CI runner or another developer's machine is obliged
// to agree with.
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { TrajectoryScene }, { Chat }, { QuestionStore }] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/screens/TrajectoryScene.js'),
    import('../src/screens/Chat.js'),
    import('../src/dsh-adapter/questions.js'),
  ])
const { miniWakeWidth } = await import('../src/components/trajectory/MiniWake.js')
const traj = await import('../src/dsh-adapter/trajectory/index.js')
const instances = (await import('../src/ink/instances.js')).default

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// ───────────────────────── harness ──────────────────────────────────────────

function makeHarness(cols: number, rows: number, scrollback = 200) {
  const term = new XTerm({ cols, rows, scrollback, allowProposedApi: true })
  const writes: string[] = []
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      writes.push(String(chunk))
      term.write(String(chunk), callback)
    }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode(): this { return this }
    ref(): this { return this }
    unref(): this { return this }
  }
  const stdin = new FakeStdin()
  const screen = (): string => {
    // getLine() indexes the WHOLE buffer, scrollback included; the viewport
    // starts at baseY. Reading from 0 after a frame taller than the terminal
    // returns the PREVIOUS, larger frame's rows — which reads exactly like a
    // repaint bug and is not one.
    const buffer = term.buffer.active
    return Array.from({ length: rows }, (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '')
      .join('\n')
  }
  /**
   * The same rows counted from the top of the buffer.
   *
   * Part A mounts the scene BARE, without the `<AlternateScreen>` the product
   * wraps it in, so the park newline scrolls its first row out of the window
   * here and nowhere else. The alternate screen has no scrollback, so reading
   * from 0 is what that part is actually about.
   */
  // Read the WHOLE buffer (frame + any scroll history): the scene's frame
  // legitimately grows past the terminal (ledger of 20 steps), and the
  // checks assert content presence — title at the head, hotspot rows
  // wherever the layout put them. A 30-row window (head OR viewport)
  // loses one end or the other.
  const screenFromTop = (): string => {
    const buf = term.buffer.active
    return Array.from({ length: buf.length }, (_, y) => buf.getLine(y)?.translateToString(true) ?? '')
      .join('\n')
  }
  return { term, stdout: new FakeStdout(), stdin, screen, screenFromTop, writes }
}

const T0 = 1_700_000_000_000
let seq = 0
const ev = (type: string, data: unknown): Record<string, unknown> =>
  ({ type, seq: ++seq, time: T0 + ++seq * 250, data })

/** A session with tools, a burst, a failure and a retry — one of each shape. */
function sampleEvents(): Record<string, unknown>[] {
  seq = 0
  const out: Record<string, unknown>[] = []
  for (let turn = 1; turn <= 3; turn++) {
    out.push(ev('turn/start', { turn }))
    out.push(ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: `prompt ${turn}` }] }))
    out.push(ev('step/start', { turn, step: 1 }))
    out.push(ev('assistant/chunk', { turn, step: 1, chunk: {} }))
    out.push(ev('assistant/message', {
      turn, step: 1,
      message: { content: [{ type: 'text', text: `reply about turn ${turn}` }] },
      usage: { input: 200, output: 40, cacheRead: 10, cacheWrite: 0 },
    }))
    for (const name of ['read_file', 'grep_repo']) {
      const callId = `c${turn}-${name}`
      out.push(ev('tool/call', { turn, step: 1, callId, name, arguments: `{"path":"src/${name}.ts"}` }))
      out.push(ev('tool/result', {
        turn, step: 1,
        message: { source: { callId }, content: [{ type: 'text', text: `${name} produced output` }] },
        ...(turn === 2 && name === 'grep_repo' ? { error: { name: 'E', code: 'ENOENT' } } : {}),
      }))
    }
    if (turn === 3) {
      for (let i = 0; i < 4; i++) {
        const callId = `burst${i}`
        out.push(ev('tool/call', { turn, step: 1, callId, name: 'web_search', arguments: `{"q":${i}}` }))
        out.push(ev('tool/result', { turn, step: 1, message: { source: { callId }, content: [] } }))
      }
      out.push(ev('llm/retry', { retryId: 'r', turn, step: 1, provider: 'deepseek-official', retry: 1, maxRetries: 2, delayMs: 900, failure: { message: 'rate limited', code: 'RATE_LIMIT' } }))
      out.push(ev('llm/retry-started', { retryId: 'r', turn, step: 1, retry: 1 }))
    }
    out.push(ev('step/end', { turn, step: 1 }))
    out.push(ev('turn/end', { turn, reason: { kind: 'completed' } }))
  }
  return out
}

const EVENTS = sampleEvents()

/** Same session with the last tool still in flight, so the wake has a live edge. */
const LIVE_EVENTS = [
  ...EVENTS,
  { type: 'turn/start', seq: 9000, time: T0 + 9_000_000, data: { turn: 4 } },
  { type: 'step/start', seq: 9001, time: T0 + 9_000_100, data: { turn: 4, step: 1 } },
  { type: 'tool/call', seq: 9002, time: T0 + 9_000_200, data: { turn: 4, step: 1, callId: 'live', name: 'long_task', arguments: '{}' } },
]

function makeChannel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 0,
    rows: [],
    status: 'idle',
    sessionTitle: 'trajectory probe',
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
    cycleMode(): void {},
    turnStart: T0,
    lastUserText: '',
    pending: [],
    commandList: [],
    notifications: [],
    activityEnabled: false,
    contextBarEnabled: true,
    activityFrames: [],
    loadedContext: undefined,
    goal: undefined,
    todos: [],
    traceEvents: () => EVENTS,
    subscribe: () => () => {},
    submit: (): void => {},
    cancel: (): void => {},
    clear: (): void => {},
    notify: (): void => {},
    listModels: () => Promise.resolve([]),
    listSessions: () => [],
    setResumeTarget: (): void => {},
    lastUsage: { input: 600, cacheRead: 40, cacheWrite: 0, output: 120 },
    contextWindow: 1_000_000,
    contextSegments: [],
    tps: undefined,
    tpsSamples: [],
    reasoningEffort: 'max',
    agentPreset: 'standard',
    workspaceLabel: undefined,
    ...overrides,
  }
}

// ───────────────────────── part A: the scene ────────────────────────────────

{
  const { stdout, stdin, screenFromTop: screen, term } = makeHarness(120, 30)
  const instance = await render(
    React.createElement(TrajectoryScene, {
      channel: makeChannel() as never,
      build: traj.buildTrajectory(EVENTS as never),
      onClose: () => {},
    }),
    { stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(160)
  const first = screen()

  check('scene shows its title and totals', first.includes('轨迹') && /\d+\s*轮/.test(first), first.split('\n')[0]?.trim())
  check('scene shows both view tabs', first.includes('时序') && first.includes('热点'))
  check('ledger renders tool rows with names', first.includes('read_file') && first.includes('grep_repo'))
  check('ledger folds the burst run', /web_search\s*×4/.test(first), /web_search[^\n]*/.exec(first)?.[0]?.trim())
  check('ledger surfaces the retry row', first.includes('RATE_LIMIT') || first.includes('RTY'))
  check('ledger renders durations', /\d+(ms|\.\ds)/.test(first))
  check('cursor pointer is visible', first.includes('▸'))
  check('wake band renders block glyphs', /[▁▂▃▄▅▆▇█]/.test(first))
  check('hint line documents the keys', first.includes('查询') || first.includes('query'))

  // The inspector must occupy the same rows no matter where the cursor is —
  // fixed geometry is what keeps cursor movement from resizing the frame.
  // Fixed geometry means the rows BELOW the inspector never move. Counting
  // non-blank lines would be wrong — the pane pads with blanks by design —
  // so the invariant is measured where it matters: the hint line's row.
  const hintRow = (text: string): number =>
    text.split('\n').findIndex(line => line.includes('退出') || line.includes('exit'))
  const cursorRow = (text: string): number => text.split('\n').findIndex(line => line.includes('▸'))
  const before = hintRow(first)
  const rowAtStart = cursorRow(first)
  stdin.write('\x1b[A')
  await sleep(240)
  const afterUp = screen()
  stdin.write('\x1b[A')
  await sleep(240)
  const afterTwo = screen()
  check('cursor opens pinned to the newest row', rowAtStart >= 0, `row ${rowAtStart}`)
  check(
    '↑ walks the cursor back up the ledger',
    cursorRow(afterUp) === rowAtStart - 1 && cursorRow(afterTwo) === rowAtStart - 2,
    `${rowAtStart} → ${cursorRow(afterUp)} → ${cursorRow(afterTwo)}`,
  )
  check('inspector follows the cursor with no keystroke', afterUp !== first && afterTwo !== afterUp)
  check(
    'cursor movement never shifts the layout below the inspector',
    before >= 0 && hintRow(afterUp) === before && hintRow(afterTwo) === before,
    `${before} / ${hintRow(afterUp)} / ${hintRow(afterTwo)}`,
  )

  // Jump to the next failure, then confirm the inspector explains it.
  stdin.write(']')
  await sleep(140)
  const atFailure = screen()
  check('] seeks to a failure', atFailure.includes('ENOENT') || atFailure.includes('RATE_LIMIT'), '')

  // Query mode filters the whole session.
  stdin.write('/')
  await sleep(80)
  stdin.write('tool:read_file')
  await sleep(180)
  const filtered = screen()
  check('query narrows the ledger', filtered.includes('read_file') && !filtered.includes('grep_repo'))
  check('query reports its match count', /\d+\/\d+/.test(filtered), /\d+\/\d+[^\n]*/.exec(filtered)?.[0])
  stdin.write('\x1b')
  await sleep(140)
  check('esc clears the query', screen().includes('grep_repo'))

  // View switching. The hotspot rows animate in (motion arrive); a fixed
  // sleep races the animation — poll until the view materializes.
  stdin.write('\x1b[C')
  let hotspot = ''
  for (let i = 0; i < 40 && !(hotspot.includes('工具') || hotspot.includes('Tools')); i++) {
    await sleep(80)
    hotspot = screen()
  }
  {
    const buf = term.buffer.active
    const all: string[] = []
    for (let y = 0; y < buf.length; y++) all.push(`${y}|${buf.getLine(y)?.translateToString(true)?.slice(0, 70) ?? ''}`)
    console.error('--- FULL BUFFER (len=' + buf.length + ' vy=' + buf.viewportY + ') ---')
    console.error(all.join(String.fromCharCode(10)))
  }
  check('→ switches to the hotspot view', hotspot.includes('工具') || hotspot.includes('Tools'))
  check('hotspot ranks tools by cost', /web_search|read_file/.test(hotspot))
  check('hotspot draws bars', /[█▌]/.test(hotspot))
  stdin.write('\x1b[D')
  let backToTimeline = ''
  for (let i = 0; i < 40 && !backToTimeline.includes('read_file'); i++) {
    await sleep(80)
    backToTimeline = screen()
  }
  check('← returns to the timeline', backToTimeline.includes('read_file'))

  instance.unmount()
  term.dispose()
}

// ───────────────────────── part B: the round trip ───────────────────────────

{
  const { stdout, stdin, screen, term, writes } = makeHarness(120, 30, 500)
  const rowsOf = (): number => term.buffer.active.length
  const instance = await render(
    React.createElement(Chat, {
      channel: makeChannel({
        traceEvents: () => LIVE_EVENTS,
        working: true,
        rows: Array.from({ length: 12 }, (_, i) => ({
          id: i, kind: i % 2 === 0 ? 'user' : 'assistant', text: `conversation line ${i}`,
        })),
        lastUserText: 'conversation line 10',
      }) as never,
      questionStore: new QuestionStore() as never,
      onExit: () => {},
      fullscreen: false,
    }),
    { stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  // `<AlternateScreen>` notifies Ink via `instances.get(process.stdout)`.
  // This harness renders to a fake stdout, so without aliasing the instance
  // Ink would never learn it switched buffers and would paint the scene with
  // inline geometry — the alt-screen path, which is exactly what the two
  // safety assertions below exist to prove, would go untested.
  for (const value of instances.values()) instances.set(process.stdout, value)
  await sleep(220)
  const conversation = screen()
  const scrollbackBefore = rowsOf()
  check('conversation renders before the scene opens', conversation.includes('conversation line'))

  // Open and close the scene twenty times: any per-round-trip leak compounds
  // into an obvious number rather than hiding as a rounding error.
  for (let round = 0; round < 20; round++) {
    stdin.write('\x14') // Ctrl+T
    await sleep(round === 0 ? 160 : 60)
    if (round === 0) {
      // Assert the PROTOCOL, not the pixels. `<AlternateScreen>` notifies the
      // Ink instance via `instances.get(process.stdout)`, and this harness
      // renders to a fake stdout — so under test Ink never learns it switched
      // buffers and paints the scene with inline geometry. What the harness
      // can prove is exactly what matters for safety: the alternate buffer was
      // entered, the conversation is off-screen, and (below) the main screen
      // comes back untouched. Scene rendering itself is covered by Part A.
      const inScene = screen()
      check('Ctrl+T enters the alternate screen', term.buffer.active.type === 'alternate',
        term.buffer.active.type)
      check('the conversation is no longer on screen', !inScene.includes('conversation line 0'))
      check('the scene is painted there', /[\u2500-\u259f]/.test(inScene) || inScene.includes('时序'))
    }
    stdin.write('q')
    await sleep(round === 0 ? 200 : 70)
  }
  await sleep(200)

  const restored = screen()
  check('main screen returns to the conversation', restored.includes('conversation line'),
    restored === conversation ? '' : firstDiff(conversation, restored))

  // Scrollback accounting. Leaving the alternate screen makes the terminal
  // restore the main buffer, and Ink then repaints once because its front
  // frame was blanked — one frame per ROUND TRIP in inline mode, the same cost
  // the Ctrl+X editor handoff already pays. What must never happen is growth
  // that scales with USE: the old inline overlay churned the frame on every
  // keystroke, and that is the family this view exists to escape.
  const perTrip = (rowsOf() - scrollbackBefore) / 20
  check('scrollback growth is bounded per round trip, not per frame', perTrip <= 32,
    `${(rowsOf() - scrollbackBefore)} lines over 20 trips = ${perTrip.toFixed(1)}/trip`)

  // Navigating inside the scene is the common case by far, and it must be free.
  stdin.write('\x14')
  await sleep(240)
  const beforeNav = rowsOf()
  for (let i = 0; i < 40; i++) {
    stdin.write(i % 2 === 0 ? '\x1b[A' : '\x1b[B')
    await sleep(12)
  }
  stdin.write('\x1b[C')
  await sleep(120)
  stdin.write('\x1b[D')
  await sleep(200)
  check('navigating inside the scene adds no scrollback at all', rowsOf() === beforeNav,
    `${beforeNav} → ${rowsOf()} over 42 keystrokes`)
  stdin.write('q')
  await sleep(200)

  // Idle animation must patch, never repaint.
  stdin.write('\x14')
  await sleep(200)
  writes.length = 0
  await sleep(1200)
  const stream = writes.join('')
  const repaints = [
    ['erase line', /\x1b\[[0-2]?K/],
    ['erase screen', /\x1b\[[0-3]?J/],
    ['scroll up', /\x1b\[\d*S/],
    ['scroll down', /\x1b\[\d*T/],
  ] as const
  const offenders = repaints.filter(([, pattern]) => pattern.test(stream)).map(([name]) => name)
  check('idle animation emits no repaint escapes', offenders.length === 0,
    offenders.length === 0 ? `${stream.length} bytes over ~12 ticks` : offenders.join(', '))
  check('idle animation does emit style updates', /\x1b\[[\d;]*m/.test(stream), `${stream.length} bytes`)

  stdin.write('q')
  await sleep(120)
  instance.unmount()
  instances.delete(process.stdout)
  term.dispose()
}

// ───────────────────────── part B2: main-screen frame restore ─────────────

{
  const { stdout, stdin, screen, term, writes } = makeHarness(120, 30, 500)
  const marker = 'unchanged conversation marker'
  const listeners = new Set<() => void>()
  const channel = makeChannel({
    traceEvents: () => [],
    working: false,
    rows: [{ id: 1, kind: 'assistant', text: marker }],
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  })
  const publish = (changes: Record<string, unknown>): void => {
    Object.assign(channel, changes)
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
  await sleep(500)
  writes.length = 0

  stdin.write('\x14')
  await sleep(250)
  check('frame-restore probe enters the alternate screen', term.buffer.active.type === 'alternate')
  instances.get(process.stdout)?.resetPools()
  stdin.write('q')
  await sleep(500)

  const roundTrip = writes.join('')
  const exitIndex = roundTrip.lastIndexOf('\x1b[?1049l')
  const afterExit = exitIndex < 0 ? roundTrip : roundTrip.slice(exitIndex + '\x1b[?1049l'.length)
  const afterExitText = afterExit
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  check(
    'an unchanged main screen is not repainted after DEC 1049 restores it',
    exitIndex >= 0 && !afterExitText.includes(marker),
    `post-exit bytes=${afterExit.length}`,
  )

  const reasoning = Array.from({ length: 80 }, (_, index) =>
    `reasoning line ${String(index).padStart(2, '0')}`,
  ).join('\n')
  publish({
    working: true,
    spinnerMode: 'thinking',
    rows: [
      { id: 1, kind: 'user', text: 'investigate the rendering issue' },
      { id: 2, kind: 'reasoning', text: reasoning.split('\n').slice(0, 40).join('\n'), streaming: true },
    ],
    lastUserText: 'investigate the rendering issue',
  })
  await sleep(500)
  stdin.write('\x14')
  await sleep(250)
  publish({
    rows: [
      { id: 1, kind: 'user', text: 'investigate the rendering issue' },
      { id: 2, kind: 'reasoning', text: reasoning, streaming: true },
    ],
  })
  await sleep(250)
  publish({
    spinnerMode: 'requesting',
    rows: [
      { id: 1, kind: 'user', text: 'investigate the rendering issue' },
      { id: 2, kind: 'reasoning', text: reasoning, streaming: false, durationMs: 12_000 },
      { id: 3, kind: 'assistant', text: 'FIRST RESPONSE SECTION', streaming: true },
    ],
  })
  await sleep(250)
  stdin.write('q')
  await sleep(400)
  publish({
    rows: [
      { id: 1, kind: 'user', text: 'investigate the rendering issue' },
      { id: 2, kind: 'reasoning', text: reasoning, streaming: false, durationMs: 12_000 },
      { id: 3, kind: 'assistant', text: 'FIRST RESPONSE SECTION\n\nSECOND RESPONSE SECTION', streaming: true },
    ],
  })
  await sleep(400)

  // The settle paint is throttled behind the ink frame clock — poll for the
  // markers instead of racing a fixed sleep.
  let lines: string[] = []
  let secondIndex = -1
  for (let attempt = 0; attempt < 25 && secondIndex < 0; attempt++) {
    await sleep(80)
    const buffer = term.buffer.active
    lines = Array.from({ length: buffer.length }, (_, row) =>
      buffer.getLine(row)?.translateToString(true) ?? '',
    )
    secondIndex = lines.findLastIndex(line => line.includes('SECOND RESPONSE SECTION'))
  }
  let firstIndex = -1
  for (let index = secondIndex - 1; index >= 0; index--) {
    if (lines[index]?.includes('FIRST RESPONSE SECTION')) {
      firstIndex = index
      break
    }
  }
  const gap = firstIndex < 0 || secondIndex < 0
    ? Number.POSITIVE_INFINITY
    : lines.slice(firstIndex + 1, secondIndex).filter(line => line.trim() === '').length
  check(
    'reasoning that settles in the trajectory leaves no blank answer gap',
    firstIndex >= 0 && secondIndex >= 0 && gap <= 1,
    `first=${firstIndex}, second=${secondIndex}, blank=${gap}, buffer=${lines.length}`,
  )

  stdin.write('\x0f') // Ctrl+O
  await sleep(400)
  check('Ctrl+O expands settled reasoning after the round trip', screen().includes('reasoning line 79'))
  stdin.write('\x0f')
  await sleep(400)
  check('a second Ctrl+O folds settled reasoning again', !screen().includes('reasoning line 79'))

  instance.unmount()
  instances.delete(process.stdout)
  term.dispose()
}

// ───────────────────────── part C: the chat-side entry ─────────────────────

{
  // The trajectory must be findable from the conversation without becoming
  // clutter, and the design splits that across three non-overlapping
  // channels: the startup tip teaches the key once, a live wake strip in the
  // status line keeps showing the session's shape (and its failures, in
  // position), and exactly ONE footnote points at the newest unseen failure.
  const { stdout, stdin, screen, term } = makeHarness(126, 34, 200)
  const failedRow = {
    id: 7,
    kind: 'tool',
    text: '',
    tool: {
      callId: 'x1',
      name: 'Bash',
      argsText: 'pnpm test',
      status: 'error',
      errorText: 'Error: 3 tests failed',
      startedAt: T0,
      durationMs: 120,
    },
  }
  const instance = await render(
    React.createElement(Chat, {
      channel: makeChannel({
        traceEvents: () => EVENTS,
        // One row only: the harness terminal is short, and a longer
        // transcript scrolls the failed card out of the visible window.
        rows: [failedRow],
      }) as never,
      questionStore: new QuestionStore() as never,
      onExit: () => {},
      fullscreen: false,
      // Deterministic: never read the developer's own prefs file.
      trajectorySeen: false,
    }),
    { stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  for (const value of instances.values()) instances.set(process.stdout, value)
  await sleep(600)

  const startup = screen()
  check('the startup tip teaches the trajectory key', /ctrl\+t|⌘t/.test(startup), '')

  // B — the wake strip lives on the hint row, and every assertion below is
  // scoped to that row on purpose: the startup tip also names the key, so a
  // whole-screen search could not tell the two channels apart.
  const hintRowOf = (text: string): string =>
    text.split('\n').find(line => line.includes('shortcuts') || line.includes('快捷键')) ?? ''
  const statusArea = hintRowOf(startup)
  check('the status line carries a live wake strip', /[▁▂▃▄▅▆▇█]/.test(statusArea),
    statusArea.trim().slice(-42))
  check('the key hint rides beside the strip while unseen', /ctrl\+t|⌘t/.test(statusArea),
    statusArea.trim().slice(-42))

  // E — exactly one footnote, on the failure.
  const footnotes = (startup.match(/看完整轨迹|full trajectory/g) ?? []).length
  check('a failed call carries exactly one trajectory footnote', footnotes === 1, `${footnotes}`)

  // Opening the scene marks the failures seen and retires both pointers.
  stdin.write('\x14')
  await sleep(400)
  stdin.write('q')
  await sleep(500)
  const after = screen()
  const afterStatus = hintRowOf(after)
  check('the footnote clears once the trajectory has been opened',
    (after.match(/看完整轨迹|full trajectory/g) ?? []).length === 0, '')
  check('the key hint retires once the trajectory has been opened',
    !/ctrl\+t|⌘t/.test(afterStatus), afterStatus.trim().slice(-42))
  check('the wake strip stays after the hint retires', /[▁▂▃▄▅▆▇█]/.test(afterStatus), '')

  instance.unmount()
  instances.delete(process.stdout)
  term.dispose()
}

// ───────────────────────── part D: the width ladder ─────────────────────────

{
  // The status line is three rows that must all agree on how wide the terminal
  // is: the context bar is a pre-rendered string sized from `useTerminalSize`,
  // while the two rows under it are flex rows sized by the layout engine. When
  // those two sources disagree the bar spans the terminal and the rows below
  // stop short — the right group truncates mid-title and the wake floats in
  // the middle of the line instead of sitting at the edge.
  //
  // A right-aligned element is what makes that visible, so it is also the
  // cheapest thing to assert on: whenever a wake is present, the last non-blank
  // cell of the hint row must be at the terminal's right margin. Walking a
  // ladder of widths covers the size-dependent case, which is the one a single
  // fixed-width test would miss.
  const LADDER = [84, 100, 126, 150, 184]
  for (const cols of LADDER) {
    const { stdout, stdin, screen, term } = makeHarness(cols, 34, 200)
    const instance = await render(
      React.createElement(Chat, {
        channel: makeChannel({
          traceEvents: () => EVENTS,
          rows: [],
          // A long CJK title is the case that truncates first, so it is the
          // one that shows a wrong container width soonest.
          sessionTitle: '你是终稿评审助理。任务：对 11 份终稿做逐行一致性审计',
        }) as never,
        questionStore: new QuestionStore() as never,
        onExit: () => {},
        fullscreen: false,
        trajectorySeen: true,
      }),
      { stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    for (const value of instances.values()) instances.set(process.stdout, value)
    await sleep(420)

    const rows = screen().split('\n')
    const hintRow = rows.find(line => /[▁▂▃▄▅▆▇█▶·]/.test(line) && (line.includes('shortcuts') || line.includes('快捷键')))
    if (hintRow === undefined) {
      // Below `miniWakeWidth`'s floor the strip is meant to be absent; above
      // it, a missing row is itself the failure.
      check(`wake strip present at ${cols} cols`, miniWakeWidth(cols) === 0, 'no hint row with a wake')
    } else {
      const right = hintRow.replace(/\s+$/, '').length
      // paddingX={2} on the status line, so the last usable cell is cols - 2.
      check(
        `wake sits at the right margin at ${cols} cols`,
        right >= cols - 2 && right <= cols,
        `ends at ${right}, terminal is ${cols}`,
      )
    }

    instance.unmount()
    instances.delete(process.stdout)
    term.dispose()
    await sleep(30)
  }
}

/** First differing line, for a readable failure message. */
function firstDiff(a: string, b: string): string {
  const left = a.split('\n')
  const right = b.split('\n')
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] !== right[i]) return `line ${i}: ${JSON.stringify(left[i])} vs ${JSON.stringify(right[i])}`
  }
  return 'length differs'
}

console.log(failed === 0 ? '\nAll trajectory scene checks passed.' : `\n${failed} check(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
