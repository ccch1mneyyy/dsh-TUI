/**
 * Resize reflow regression — the inline frame after a resize must equal a
 * fresh render at the new size.
 *
 * Reported from a real terminal: open a long conversation, then maximize the
 * window. The context bar repaints at the new width while the two status rows
 * under it stay laid out for the old one — the session title truncates
 * mid-word and right-aligned content stops in the middle of the line.
 *
 * Two independent mechanisms turned out to sit behind that, one per axis of
 * the resize, and this file caught both:
 *
 * 1. **Stale measurements.** A resize invalidates every cached measurement in
 *    the tree, because each was taken against a width that no longer exists —
 *    yet nothing is dirty in the reconciler's sense, since no props changed.
 *    `markDirty` walks *upward* from a changed node, so it cannot express
 *    this; the invalidation has to run down to the leaves. Without it the text
 *    nodes keep answering with their old sizes and any row that distributes
 *    space by flex arbitration comes out assembled from two layouts.
 * 2. **A top-anchored repaint that overflows.** The full reset blanks the
 *    viewport, homes the cursor and paints downward, but painted the whole
 *    frame regardless of height. Every row ends in CR+LF and the bottom row is
 *    reserved for the cursor park, so once the frame is as tall as the
 *    viewport the last row is carried off the bottom. Narrowing at a fixed row
 *    count is what makes a frame reach full height — content wraps onto more
 *    rows while the row count stays put — which is why that direction lost the
 *    status hint and widening never did.
 *
 * The oracle is final-state equivalence, which needs no theory of the bug and
 * is why both were found rather than only the one that was being looked for:
 * drive a resize, then build the same state fresh at the new size, and demand
 * the two screens match. Anything the resize path forgot shows up as a diff.
 *
 * It also disproved a third, very plausible theory — that `renderNodeToOutput`
 * was blitting cells out of a previous screen laid out at the old geometry.
 * Disabling the blit source entirely left every case failing exactly as before.
 *
 * The earlier version of this check passed while the bug was live, because it
 * sized the emulator to the widest case up front — so no line ever reflowed.
 * The emulator must be resized for real, which is why `term.resize` is called
 * here with the same dimensions handed to the app.
 *
 * Run: node --import tsx/esm scripts/verify-resize-reflow.tsx
 */
process.env.FORCE_COLOR = '3'
// Asserts Chinese UI copy, so it pins the language rather than inheriting the
// ambient one — the same rule the English-asserting scripts follow since
// fb87339. `activeLang` resolves at import from env → persisted pref → OS
// locale, none of which a CI runner or another developer's machine is obliged
// to agree with.
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

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const T0 = 1_700_000_000_000
let seq = 0
const ev = (type: string, data: unknown): Record<string, unknown> =>
  ({ type, seq: ++seq, time: T0 + ++seq * 250, data })

function sampleEvents(): Record<string, unknown>[] {
  seq = 0
  const out: Record<string, unknown>[] = []
  for (let turn = 1; turn <= 4; turn++) {
    out.push(ev('turn/start', { turn }))
    out.push(ev('step/start', { turn, step: 1 }))
    for (const name of ['read_file', 'grep_repo', 'bash']) {
      const callId = `c${turn}-${name}`
      out.push(ev('tool/call', { turn, step: 1, callId, name, arguments: '{}' }))
      out.push(ev('tool/result', {
        turn, step: 1,
        message: { source: { callId }, content: [] },
        ...(turn === 2 && name === 'bash' ? { error: { name: 'E', code: 'ENOENT' } } : {}),
      }))
    }
    out.push(ev('step/end', { turn, step: 1 }))
    out.push(ev('turn/end', { turn, reason: { kind: 'completed' } }))
  }
  return out
}
const EVENTS = sampleEvents()

/**
 * Transcript rows long enough to wrap at the narrow width and unwrap at the
 * wide one — reflow is the whole point, so the content has to be reflowable.
 */
const ROWS = [
  {
    id: 1, kind: 'user',
    text: '深度思考，全面分析当前实现的每一处细节，并给出可以逐条验证的结论与最小复现路径。',
  },
  {
    id: 2, kind: 'assistant',
    text: '结论：骨架层一致，实体层存在合并裂缝。以下逐条说明每一处的触发条件、影响范围，以及可以独立验证的最小实验，便于分别处置。',
  },
]

function makeChannel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 0,
    rows: ROWS,
    status: 'idle',
    // A long CJK title is the first thing to truncate when the container width
    // is wrong, so it is the most sensitive payload for this check.
    sessionTitle: '你是终稿评审助理。任务：对 11 份终稿做逐行一致性审计',
    agentId: 'probe',
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    tokens: { input: 600, output: 120 },
    cwd: 'C:/code/orca',
    displayCwd: 'C:/code/orca',
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
    stageImage: () => Promise.resolve(''),
    lastUsage: { input: 99_700, cacheRead: 40_300, cacheWrite: 0, output: 120 },
    contextWindow: 1_000_000,
    contextSegments: { system: 42_000, prompt: 18_000, assistant: 26_000, thinking: 21_000, tools: 17_000 },
    tps: 69,
    tpsSamples: [],
    reasoningEffort: 'high',
    agentPreset: 'standard',
    workspaceLabel: 'orca',
    ...overrides,
  }
}

function makeHarness(cols: number, rows: number) {
  const term = new XTerm({ cols, rows, scrollback: 400, allowProposedApi: true })
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
  /**
   * The bottom chrome — the divider under the transcript and everything below
   * it — as its sequence of non-blank rows.
   *
   * Two things above it are legitimately not comparable and would drown the
   * signal if included. A full reset re-anchors the frame to the top of the
   * viewport while a cold start grows up from the bottom, so vertical
   * placement differs by design; and growing a terminal pulls real scrollback
   * back down into the viewport, which a cold start has none of. The chrome
   * has neither problem: it is always the tail of the frame, it never
   * animates, and it is exactly the surface that carries the reported
   * defect — the context bar, the status fields, and the hint row must all
   * agree with each other about how wide the terminal is.
   */
  const screen = (): string => {
    // getLine() indexes the WHOLE buffer, scrollback included; the viewport
    // starts at baseY. Reading from 0 after a frame taller than the terminal
    // returns the PREVIOUS, larger frame's rows — which reads exactly like a
    // repaint bug and is not one.
    const buffer = term.buffer.active
    const lines = Array.from({ length: term.rows }, (_, y) =>
      (buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '').replace(/\s+$/, ''))
    const divider = lines.findLastIndex(line => /^─{8,}$/.test(line.trim()))
    return lines.slice(divider === -1 ? 0 : divider)
      .filter(line => line !== '')
      .join('\n')
  }
  return { term, stdout, stdin: new FakeStdin(), screen }
}

async function mount(harness: ReturnType<typeof makeHarness>) {
  const instance = await render(
    React.createElement(Chat, {
      channel: makeChannel() as never,
      questionStore: new QuestionStore() as never,
      onExit: () => {},
      fullscreen: false,
      trajectorySeen: true,
    }),
    {
      stdout: harness.stdout as never,
      stdin: harness.stdin as never,
      stderr: harness.stdout as never,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  // The alternate-screen component looks its instance up by `process.stdout`;
  // alias the fake one so the harness behaves like a real terminal.
  for (const value of instances.values()) instances.set(process.stdout, value)
  return instance
}

/**
 * A readable failure message: the first differing row plus the rows around it
 * on both screens. A single differing line is rarely enough to tell a wrong
 * layout apart from a wrong scroll window or a row the terminal joined during
 * reflow — the neighbourhood is what makes those distinguishable at a glance.
 */
function firstDiff(a: string, b: string): string {
  const left = a.split('\n')
  const right = b.split('\n')
  const total = Math.max(left.length, right.length)
  for (let i = 0; i < total; i++) {
    if (left[i] === right[i]) continue
    const from = Math.max(0, i - 3)
    const to = Math.min(total, i + 4)
    const side = (rows: string[], label: string): string =>
      [`     ── ${label} (${rows.length} rows)`]
        .concat(Array.from({ length: to - from }, (_, k) =>
          `     ${from + k === i ? '»' : ' '} ${String(from + k).padStart(2)} ${JSON.stringify(rows[from + k] ?? null)}`))
        .join('\n')
    return `first differing row ${i} of ${total}\n${side(left, 'after resize')}\n${side(right, 'fresh render')}`
  }
  return 'identical'
}

/**
 * Render at `from`, resize the emulator *and* the app to `to`, and compare
 * against a fresh render at `to`.
 */
async function equivalence(from: [number, number], to: [number, number]): Promise<void> {
  const [fromCols, fromRows] = from
  const [toCols, toRows] = to

  const live = makeHarness(fromCols, fromRows)
  const liveInstance = await mount(live)
  await sleep(420)

  // The emulator reflows exactly as a real terminal does; the app learns about
  // it through the same 'resize' event Node emits on SIGWINCH.
  live.term.resize(toCols, toRows)
  live.stdout.columns = toCols
  live.stdout.rows = toRows
  live.stdout.emit('resize')
  await sleep(520)
  const resized = live.screen()
  liveInstance.unmount()
  instances.delete(process.stdout)
  live.term.dispose()
  await sleep(40)

  const cold = makeHarness(toCols, toRows)
  const coldInstance = await mount(cold)
  await sleep(420)
  const fresh = cold.screen()
  coldInstance.unmount()
  instances.delete(process.stdout)
  cold.term.dispose()
  await sleep(40)

  check(
    `${fromCols}x${fromRows} → ${toCols}x${toRows} matches a fresh render`,
    resized === fresh,
    resized === fresh ? '' : firstDiff(resized, fresh),
  )
}

// Both directions on both axes. Widening is the reported case (maximizing the
// window) and the one that reflows previously wrapped lines back onto fewer
// physical rows. Narrowing at a FIXED row count is the one that makes the
// frame reach full viewport height — content wraps onto more rows while the
// row count stays put — which is the case a top-anchored repaint overflows.
await equivalence([90, 30], [150, 30])
await equivalence([150, 30], [90, 30])
await equivalence([150, 30], [110, 30])
await equivalence([150, 30], [90, 36])
await equivalence([100, 24], [170, 40])
await equivalence([170, 40], [100, 24])

console.log(failed === 0 ? '\nAll resize reflow checks passed.' : `\n${failed} check(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
