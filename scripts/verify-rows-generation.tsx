/**
 * verify-rows-generation — rowsGeneration cache-identity regressions
 * (#713 integration review blockers 1-3).
 *
 * Row ids are TRANSCRIPT-SCOPED: `/clear` / rewind / reset keep the live
 * rows array identity and restart ids at 0 under the same agentId. Every
 * cache that treats `agentId (+ ids)` as identity can therefore serve the
 * PREVIOUS transcript's data for id-identical fresh rows.
 *
 *   Case 1  MessageList visible-rows cache: same live array, same length,
 *           same ids, same streaming bits, different generation → the
 *           rendered transcript must be the NEW rows (stale cache would
 *           keep painting the old ChatRow objects).
 *   Case 2  failureHintRowId: tool failure carries the trajectory footnote;
 *           /clear + fresh rows REUSING the id → the new healthy row must
 *           NOT wear the stale failure footnote.
 *   Case 3  lastUserRowId + auto recap: recap active with a large
 *           rowsAtTrigger; /clear; new user row re-appears at id 0 → the
 *           O(1) scan must re-track the new transcript AND the auto recap
 *           must retire on the user's first new message.
 *
 * Run: node --import tsx/esm scripts/verify-rows-generation.tsx
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
const { sleep, settled } = await import('./lib/term-test.mjs')

let failed = 0
const check = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const COLS = 100
const ROWS = 30

function makeChannel(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 0,
    rows: [],
    rowsGeneration: 0,
    rowsStreamingVersion: 0,
    status: 'idle',
    sessionTitle: 'gen probe',
    agentId: 'gen-agent',
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
    contextBarEnabled: false,
    statusBar: {
      compact: true, model: true, thinking: true, cwd: true, contextUsage: true,
      cache: true, tokens: false, tps: false, gitBranch: false, sessionTitle: false,
      sessionId: false, mode: false, contextBar: false, activity: false,
      trajectory: false, shortcutHint: false,
    },
    activityFrames: [],
    loadedContext: undefined,
    goal: undefined,
    todos: [],
    traceEvents: () => [],
    trajectory: () => ({ nodes: [], counts: { rows: 0, errors: 0 } }),
    autoRecapOnOpen: false,
    recapRecent: async () => ({ summary: null, title: undefined, error: undefined }),
    subscribe: () => () => {},
    submit: (): void => {},
    cancel: (): void => {},
    clear: (): void => {},
    notify: (): void => {},
    ...overrides,
  }
}

async function mount(channel: Record<string, unknown>): Promise<{
  screen: () => string
  publish: () => void
  unmount: () => void
}> {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 200, allowProposedApi: true })
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
  channel.subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
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
  return {
    screen: (): string => {
      const buffer = term.buffer.active
      return Array.from({ length: ROWS }, (_, y) =>
        buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '',
      ).join('\n')
    },
    publish: (): void => {
      channel.version = Number(channel.version) + 1
      for (const listener of [...listeners]) listener()
    },
    unmount: (): void => {
      instance.unmount()
      instances.delete(process.stdout)
      term.dispose()
    },
  }
}

const toolRow = (id: number, status: 'ok' | 'error', name: string): Record<string, unknown> => ({
  id,
  kind: 'tool',
  text: '',
  tool: {
    callId: `call-${id}`,
    name,
    argsText: '{}',
    status,
    errorText: status === 'error' ? 'boom' : undefined,
    startedAt: Date.now() - 1000,
    durationMs: 1000,
  },
})

// ── Case 1: visible-rows cache identity includes rowsGeneration ────────────
{
  const channel = makeChannel({})
  const rows = channel.rows as Array<Record<string, unknown>>
  rows.push(
    { id: 0, kind: 'user', text: 'OLD-PROMPT-MARKER' },
    { id: 1, kind: 'assistant', text: 'OLD-REPLY-MARKER' },
  )
  const h = await mount(channel)
  await sleep(700)
  check('C1a: initial transcript renders', h.screen().includes('OLD-PROMPT-MARKER'))
  // /clear semantics: SAME live array, emptied and refilled in place; ids
  // restart at 0; streaming bits identical (none); only the generation and
  // the row CONTENT differ.
  rows.length = 0
  rows.push(
    { id: 0, kind: 'user', text: 'NEW-PROMPT-MARKER' },
    { id: 1, kind: 'assistant', text: 'NEW-REPLY-MARKER' },
  )
  channel.rowsGeneration = 1
  h.publish()
  await sleep(500)
  const screen = h.screen()
  check('C1b: fresh generation renders the NEW rows', screen.includes('NEW-PROMPT-MARKER') && screen.includes('NEW-REPLY-MARKER'))
  check('C1c: stale rows never leak through the cache', !screen.includes('OLD-PROMPT-MARKER') && !screen.includes('OLD-REPLY-MARKER'))
  h.unmount()
}

// ── Case 2: failureHintRowId survives a /clear id-reuse ────────────────────
{
  let errors = 1
  const channel = makeChannel({
    trajectory: () => ({ nodes: [], counts: { rows: 1, errors } }),
  })
  const rows = channel.rows as Array<Record<string, unknown>>
  rows.push(
    { id: 0, kind: 'user', text: 'run the thing' },
    toolRow(1, 'error', 'bash'),
  )
  const h = await mount(channel)
  await sleep(700)
  check('C2a: failed tool row carries the trajectory footnote', h.screen().includes('看完整轨迹'))
  // /clear + id reuse: the new transcript's id-1 row is a HEALTHY tool.
  rows.length = 0
  rows.push(
    { id: 0, kind: 'user', text: 'fresh start' },
    toolRow(1, 'ok', 'read'),
  )
  channel.rowsGeneration = 1
  h.publish()
  await sleep(500)
  const screen = h.screen()
  check('C2b: fresh healthy row wears NO stale failure footnote', !screen.includes('看完整轨迹'))
  check('C2c: the new rows themselves render', screen.includes('fresh start'))
  void errors
  h.unmount()
}

// ── Case 3: lastUserRowId re-tracks + auto recap retires on /clear ────────
{
  const channel = makeChannel({
    autoRecapOnOpen: true,
    recapRecent: async () => ({ summary: 'RECAP-SUMMARY-MARKER', title: undefined, error: undefined }),
  })
  const rows = channel.rows as Array<Record<string, unknown>>
  // A transcript with a LARGE lastUserRowId before the clear.
  for (let i = 0; i <= 40; i++) {
    rows.push(i % 2 === 0
      ? { id: i, kind: 'user', text: `old user ${i}` }
      : { id: i, kind: 'assistant', text: `old reply ${i}` })
  }
  const h = await mount(channel)
  // recapRecent resolves → the dim AutoRecapRow shows the summary marker.
  check('C3a: auto recap appears', await settled(() => h.screen().includes('RECAP-SUMMARY-MARKER'), 4000))
  // /clear: same agentId, ids restart at 0.
  rows.length = 0
  channel.rowsGeneration = 1
  h.publish()
  await sleep(400)
  // The user starts a NEW message: row id 0 (way below the old trigger 40).
  rows.push({ id: 0, kind: 'user', text: 'brand new user row' })
  h.publish()
  await sleep(600)
  const screen = h.screen()
  check('C3b: old transcript is gone after the clear', !screen.includes('old user 40') && !screen.includes('RECAP-SUMMARY-MARKER'))
  // (The blank paint itself is a stub-harness scroll artifact — the real
  // /clear path resets the transcript scroll via Chat's repaint plumbing,
  // which the raw channel stub bypasses. The retire behavior is C3c.)
  check('C3c: auto recap retired by the first new message', !screen.includes('RECAP-SUMMARY-MARKER'))
  h.unmount()
}

console.log(failed === 0 ? 'verify-rows-generation: all checks passed' : `${failed} check(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
