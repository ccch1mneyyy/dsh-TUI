/**
 * Activity-store render regression: the working line is driven by the session
 * projection the plugin publishes, not by the channel's own copy.
 *
 * The store landed behind a live path — a host projection pushes a value into a
 * session-keyed store, a component reads it, and the line follows. These cases
 * render the real components and pin the four behaviours a user would notice:
 *
 * 1. A published value reaches the screen through the hook (subscription works,
 *    not just the initial read).
 * 2. An event for a *background* session does not move the line on screen
 *    (the store is session-keyed; a single "last event wins" tracker is not).
 * 3. Clearing a session takes the line away again.
 * 4. When both seams carry a value, the projection wins over the channel's copy,
 *    which is what makes the read-side migration a no-op for display.
 * @module dsh-tui/scripts/verify-activity-store-render
 */

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [
  { strict: assert },
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, ThemeProvider, Text },
  { StatusLine },
  { DEFAULT_STATUS_BAR },
  { ActivityStore, useActivity },
] = await Promise.all([
  import('node:assert'),
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/StatusLine.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('../src/dsh-adapter/activity-store.js'),
])

type Store = InstanceType<typeof ActivityStore>

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

let checks = 0
async function check(name: string, test: () => Promise<void> | void): Promise<void> {
  try {
    await test()
    checks++
    console.log(`PASS: ${name}`)
  } catch (error) {
    console.error(`FAIL: ${name}`)
    throw error
  }
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

/** Headless terminal harness, same shape the other render fixtures use. */
function makeHarness(columns: number, rows: number) {
  const term = new XTerm({ cols: columns, rows, scrollback: 0, allowProposedApi: true })

  class FakeOutput extends Writable {
    columns = columns
    rows = rows
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      term.write(String(chunk), callback)
    }
  }

  const screen = (): string => {
    const buffer = term.buffer.active
    return Array.from({ length: rows }, (_, row) =>
      buffer.getLine(row)?.translateToString(true) ?? '',
    ).join('\n')
  }

  return { term, stdout: new FakeOutput(), stderr: new FakeOutput(), stdin: new FakeStdin(), screen }
}

/** One complete activity value, with overrides. */
function view(line: string, overrides: Record<string, unknown> = {}) {
  return {
    phase: 'tool',
    line,
    live: true,
    toolCount: 1,
    phaseStartedAt: 1_700_000_000_000,
    turnStartedAt: 1_699_999_999_000,
    updatedAt: 1_700_000_001_000,
    lang: 'zh',
    ...overrides,
  } as never
}

/** Read the line exactly the way Chat does: through the store, per session. */
function Probe({ store, sessionId }: { store: Store; sessionId: string }): React.ReactNode {
  const value = useActivity(store, sessionId)
  return <Text>{value === undefined ? '<none>' : value.line}</Text>
}

async function mountProbe(store: Store, sessionId: string, columns = 120, rows = 4) {
  const harness = makeHarness(columns, rows)
  const instance = await render(
    <ThemeProvider theme="dark">
      <Probe store={store} sessionId={sessionId} />
    </ThemeProvider>,
    {
      stdout: harness.stdout as NodeJS.WriteStream,
      stderr: harness.stderr as NodeJS.WriteStream,
      stdin: harness.stdin as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  await sleep(120) // 固定窗:pacing 首帧上屏，无可轮询的完成条件
  return {
    screen: (): string => harness.screen(),
    /** Let a store change flush into a frame. */
    settle: async (): Promise<string> => {
      await sleep(120) // 固定窗:pacing 一次 store 变更落到一帧，无可轮询的完成条件
      return harness.screen()
    },
    unmount: async (): Promise<void> => {
      await instance.unmount()
      harness.term.dispose()
    },
  }
}

/** The channel a status line renders against; its own activity copy is off. */
const baseChannel = {
  statusBar: { ...DEFAULT_STATUS_BAR, activity: true },
  agentId: 'agent-1',
  sessionId: 'session-A',
  lastUsage: { input: 200_000, cacheRead: 5_000, cacheWrite: 1_000, output: 6_789 },
  contextWindow: 266_000,
  reasoningEffort: 'max',
  modeIndex: 0,
  mode: { id: 'default', plan: false },
  model: 'activity-probe-model',
  cwd: 'C:/work/activity-probe',
  tokens: { input: 12_345, output: 6_789 },
  tps: 37,
  tpsSamples: [],
  working: false,
  displayCwd: 'C:/work/activity-probe',
  sessionTitle: 'activity render probe',
  activityFrames: [],
  contextBarEnabled: false,
  contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
}

async function renderStatus(
  overrides: Record<string, unknown>,
  activity?: unknown,
  columns = 140,
): Promise<string> {
  const harness = makeHarness(columns, 8)
  const instance = await render(
    <ThemeProvider theme="dark">
      <StatusLine
        channel={{ ...baseChannel, ...overrides } as never}
        activity={activity as never}
      />
    </ThemeProvider>,
    {
      stdout: harness.stdout as NodeJS.WriteStream,
      stderr: harness.stderr as NodeJS.WriteStream,
      stdin: harness.stdin as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  await sleep(180) // 固定窗:pacing 状态行整帧上屏，无可轮询的完成条件
  const output = harness.screen()
  await instance.unmount()
  harness.term.dispose()
  return output
}

// 1-3. The store drives the line, keyed by session.
await check('a published value reaches the screen and follows later changes', async () => {
  const store = new ActivityStore()
  const probe = await mountProbe(store, 'session-A')
  try {
    assert.match(probe.screen(), /<none>/, 'nothing published yet → nothing rendered')

    store.update('session-A', view('⏵ 修样式 · 跑测试 · 3s'))
    assert.match(await probe.settle(), /修样式/, 'the published line must render')

    store.update('session-A', view('⏵ 修样式 · 跑测试 · 9s'))
    const next = await probe.settle()
    assert.match(next, /9s/, 'the line must follow the store')
    assert.doesNotMatch(next, /3s/, 'the previous line must be gone, not appended')
  } finally {
    await probe.unmount()
  }
})

await check('a background session cannot move the line on screen', async () => {
  const store = new ActivityStore()
  store.update('session-A', view('⏵ 我正在看的会话'))
  const probe = await mountProbe(store, 'session-A')
  try {
    assert.match(probe.screen(), /我正在看的会话/)
    store.update('session-B', view('⏵ 后台会话在动'))
    const screen = await probe.settle()
    assert.match(screen, /我正在看的会话/)
    assert.doesNotMatch(screen, /后台会话/, 'another session’s value must not leak in')
  } finally {
    await probe.unmount()
  }
})

await check('clearing a session takes its line away', async () => {
  const store = new ActivityStore()
  store.update('session-A', view('⏵ 会话已结束'))
  const probe = await mountProbe(store, 'session-A')
  try {
    assert.match(probe.screen(), /会话已结束/)
    store.clear('session-A')
    assert.match(await probe.settle(), /<none>/, 'a cleared session renders nothing')
  } finally {
    await probe.unmount()
  }
})

// 4. The status line renders the projection and nothing else: the channel has no
// copy of the line any more, so an absent value means an absent row.
await check('the status line renders the projection, and only it', async () => {
  const withoutProjection = await renderStatus({})
  assert.doesNotMatch(withoutProjection, /工具|tool/, 'nothing is projected → no activity text on screen')

  const projected = await renderStatus({}, view('投影来的新行'))
  assert.match(projected, /投影来的新行/, 'the projected value renders')
})

console.log(`verify-activity-store-render: OK (${checks} checks)`)
