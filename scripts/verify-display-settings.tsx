/** Lightweight regression checks for display settings and their stable render output. */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [
  { strict: assert },
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, ThemeProvider },
  { StatusLine, formatCacheHitRate },
  { AssistantToolUseMessage },
  { DEFAULT_STATUS_BAR, formatContextUsage, normalizeStatusBar, normalizeToolBackground },
] = await Promise.all([
  import('node:assert'),
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/StatusLine.js'),
  import('../src/components/messages/AssistantToolUseMessage.js'),
  import('../src/tuiDisplayPrefs.js'),
])

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

let checks = 0
function check(name: string, test: () => void): void {
  try {
    test()
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

function makeHarness(columns = 140, rows = 12) {
  const term = new XTerm({ cols: columns, rows, scrollback: 0, allowProposedApi: true })
  const writes: string[] = []

  class FakeOutput extends Writable {
    columns = columns
    rows = rows
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      const text = String(chunk)
      writes.push(text)
      term.write(text, callback)
    }
  }

  const stdout = new FakeOutput()
  const stderr = new FakeOutput()
  const screen = (): string => {
    const buffer = term.buffer.active
    return Array.from({ length: rows }, (_, row) =>
      buffer.getLine(row)?.translateToString(true) ?? '',
    ).join('\n')
  }

  return { term, stdout, stderr, stdin: new FakeStdin(), writes, screen }
}

const baseChannel = {
  statusBar: { ...DEFAULT_STATUS_BAR },
  lastUsage: { input: 200_000, cacheRead: 5_000, cacheWrite: 1_000, output: 6_789 },
  contextWindow: 266_000,
  reasoningEffort: 'max',
  modeIndex: 0,
  mode: { id: 'default', plan: false },
  model: 'display-model-probe',
  tokens: { input: 12_345, output: 6_789 },
  tps: 37,
  tpsSamples: [],
  working: false,
  gitBranch: 'feat/display-settings-probe',
  displayCwd: 'C:/work/display-project',
  sessionTitle: 'display settings title probe',
  workingActivity: undefined,
  activityFrames: [],
  contextBarEnabled: true,
  contextSegments: {
    system: 20_000,
    prompt: 80_000,
    assistant: 40_000,
    thinking: 30_000,
    tools: 36_000,
  },
}

const wake = {
  band: {
    buckets: [
      {
        weight: 1,
        count: 1,
        channels: { input: 0, model: 0, tool: 1 },
        error: false,
        retry: false,
        running: false,
        firstIndex: 0,
      },
    ],
    peak: 1,
    floor: 1,
    turns: [[1, 0]],
  },
  tick: 0,
}

async function renderStatus(
  overrides: Record<string, unknown> = {},
  columns = 140,
  options: { selectionActive?: boolean; helpOpen?: boolean } = {},
): Promise<string> {
  const harness = makeHarness(columns)
  const channel = { ...baseChannel, ...overrides }
  const instance = await render(
    <ThemeProvider theme="dark">
      <StatusLine
        channel={channel as never}
        wake={wake as never}
        selectionActive={options.selectionActive}
        helpOpen={options.helpOpen}
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
  await sleep(180)
  const output = harness.screen()
  await instance.unmount()
  harness.term.dispose()
  return output
}

// Defaults and normalization.
check('DEFAULT_STATUS_BAR keeps the intended compact defaults', () => {
  assert.deepEqual(DEFAULT_STATUS_BAR, {
    compact: true,
    model: true,
    thinking: true,
    cwd: true,
    contextUsage: true,
    cache: true,
    tokens: false,
    tps: false,
    gitBranch: false,
    sessionTitle: false,
    mode: false,
    contextBar: false,
    activity: false,
    trajectory: false,
    shortcutHint: false,
  })
})

check('normalizeStatusBar merges booleans over defaults only', () => {
  assert.deepEqual(normalizeStatusBar({ compact: false, tps: true, model: 'no', unknown: true }), {
    ...DEFAULT_STATUS_BAR,
    compact: false,
    tps: true,
  })
})

check('normalizeStatusBar rejects invalid top-level values', () => {
  for (const invalid of [undefined, null, false, 'compact', 1, [], () => {}]) {
    assert.deepEqual(normalizeStatusBar(invalid), DEFAULT_STATUS_BAR)
  }
})

// Metric formatting.
check('formatContextUsage emits compact percent and token counts', () => {
  const formatted = formatContextUsage(206_000, 266_000, true)
  assert.equal(formatted, '77% (206k/266k)')
})

check('formatContextUsage omits unknown or invalid capacities', () => {
  assert.equal(formatContextUsage(206_000, undefined, true), undefined)
  assert.equal(formatContextUsage(206_000, 0, true), undefined)
  assert.equal(formatContextUsage(206_000, Number.NaN, true), undefined)
})

check('formatCacheHitRate accepts usable snapshots and rejects invalid totals', () => {
  assert.equal(formatCacheHitRate({ input: 200_000, cacheRead: 5_000, cacheWrite: 1_000 }), '2.4%')
  assert.equal(formatCacheHitRate(undefined), undefined)
  assert.equal(formatCacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 }), undefined)
  assert.equal(formatCacheHitRate({ input: Number.NaN, cacheRead: 1, cacheWrite: 0 }), undefined)
})

// StatusLine compact defaults.
const compact = await renderStatus()
check('compact StatusLine shows model, effort, cwd basename, context, and cache', () => {
  for (const marker of ['display-model-probe', 'max', 'display-project', 'ctx 77% (206k/266k)', 'cache 2.4%']) {
    assert.ok(compact.includes(marker), `missing ${JSON.stringify(marker)} in:\n${compact}`)
  }
})

check('compact StatusLine hides disabled optional fields', () => {
  for (const marker of ['37 t/s', 'feat/display-settings-probe', 'display settings title probe', '12.3k→6.8k', 'system', 'free']) {
    assert.ok(!compact.includes(marker), `unexpected ${JSON.stringify(marker)} in:\n${compact}`)
  }
  assert.ok(!/[▁▂▃▄▅▆▇█▶]/.test(compact), `unexpected trajectory wake in:\n${compact}`)
})

check('compact StatusLine hides the shortcuts hint by default', () => {
  assert.equal((compact.match(/\? for shortcuts/g) ?? []).length, 0)
})

const compactWithShortcutHint = await renderStatus({
  statusBar: { ...DEFAULT_STATUS_BAR, shortcutHint: true },
})
check('compact StatusLine renders the enabled shortcuts hint exactly once', () => {
  assert.equal((compactWithShortcutHint.match(/\? for shortcuts/g) ?? []).length, 1)
})

const working = await renderStatus({ working: true })
check('working StatusLine always renders its Esc interrupt hint', () => {
  assert.equal((working.match(/esc to interrupt/g) ?? []).length, 1)
})

const selecting = await renderStatus({}, 140, { selectionActive: true })
check('selection StatusLine always renders its Esc return hint', () => {
  assert.equal((selecting.match(/esc to return to input/g) ?? []).length, 1)
})

for (const columns of [84, 100, 126]) {
  const narrow = await renderStatus({
    statusBar: {
      ...DEFAULT_STATUS_BAR,
      tokens: true,
      tps: true,
      gitBranch: true,
      sessionTitle: true,
      mode: true,
    },
    modeIndex: 1,
    mode: { id: 'plan', plan: true },
    contextWindow: 1_000_000,
    lastUsage: { input: 9_000, cacheRead: 100, cacheWrite: 0, output: 6_789 },
  }, columns)
  check(`compact context stays at the right edge without overlap at ${columns} cols`, () => {
    const line = narrow.split('\n').find(row => row.includes('ctx 0.9% (9.1k/1.0m)'))
    assert.ok(line, `missing context usage in:\n${narrow}`)
    assert.equal(line?.match(/ctx 0\.9% \(9\.1k\/1\.0m\)/g)?.length, 1)
    assert.ok((line?.replace(/\s+$/, '').length ?? 0) >= columns - 1, `not right-aligned: ${JSON.stringify(line)}`)
  })
}

// Full / all-switches-on scenario. Stable feature markers avoid a whole-screen snapshot.
const fullStatus = {
  ...DEFAULT_STATUS_BAR,
  compact: false,
  tokens: true,
  tps: true,
  gitBranch: true,
  sessionTitle: true,
  contextBar: true,
  trajectory: true,
}
const full = await renderStatus({ statusBar: fullStatus }, 200)
check('full StatusLine exposes tps, git, title, and token totals', () => {
  for (const marker of ['37 t/s', 'feat/display-settings-probe', 'display settings title probe', '12.3k→6.8k']) {
    assert.ok(full.includes(marker), `missing ${JSON.stringify(marker)} in:\n${full}`)
  }
})

check('full StatusLine renders context bar and deterministic trajectory wake', () => {
  assert.ok(full.includes('system') || full.includes('sys'), `missing context-bar segment in:\n${full}`)
  assert.ok(full.includes('77.4%'), `missing context-bar percentage in:\n${full}`)
  assert.ok(/[▁▂▃▄▅▆▇█]/.test(full), `missing trajectory glyph in:\n${full}`)
})

// Tool background normalization and terminal ANSI output.
check('normalizeToolBackground accepts the three modes and falls back to none', () => {
  assert.equal(normalizeToolBackground('none'), 'none')
  assert.equal(normalizeToolBackground('subtle'), 'subtle')
  assert.equal(normalizeToolBackground('strong'), 'strong')
  assert.equal(normalizeToolBackground('loud'), 'none')
  assert.equal(normalizeToolBackground(undefined), 'none')
})

async function renderToolBackground(toolBackground: 'none' | 'subtle' | 'strong'): Promise<string> {
  const harness = makeHarness(80, 6)
  const tool = {
    callId: `background-${toolBackground}`,
    name: 'read',
    argsText: '{"path":"display-settings.txt"}',
    status: 'ok' as const,
    durationMs: 12,
    resultFull: 'background probe output',
  }
  const instance = await render(
    <ThemeProvider theme="dark">
      <AssistantToolUseMessage
        tool={tool as never}
        addMargin={false}
        verbose={false}
        toolBackground={toolBackground}
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
  await sleep(180)
  await instance.unmount()
  harness.term.dispose()
  return harness.writes.join('')
}

const noneAnsi = await renderToolBackground('none')
const subtleAnsi = await renderToolBackground('subtle')
const strongAnsi = await renderToolBackground('strong')
check('tool background modes map to stable dark-theme ANSI backgrounds', () => {
  const subtleBg = '\x1b[48;2;28;35;48m'
  const strongBg = '\x1b[48;2;36;43;58m'
  assert.ok(!noneAnsi.includes(subtleBg) && !noneAnsi.includes(strongBg))
  assert.ok(subtleAnsi.includes(subtleBg), 'subtle background ANSI missing')
  assert.ok(strongAnsi.includes(strongBg), 'strong background ANSI missing')
})

console.log(`\nAll ${checks} display-settings checks passed.`)
