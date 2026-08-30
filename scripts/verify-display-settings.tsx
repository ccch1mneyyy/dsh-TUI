/** Lightweight regression checks for display settings and their stable render output. */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [
  { strict: assert },
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, ThemeProvider, Box, Text },
  { StatusLine, formatCacheHitRate, parseStatusChip },
  { CockpitHud },
  { AutoRecapRow },
  { LogoV2 },
  { AssistantToolUseMessage },
  { AssistantTextMessage },
  { UserPromptMessage },
  { AssistantThinkingMessage },
  { ActivityLine },
  { DEFAULT_STATUS_BAR, formatContextUsage, mergeStatusBar, normalizeStatusBar, normalizeToolBackground },
  { homeDir },
  { pickRandomTip },
  { getTheme, isPaintedColor, resolvePane },
  { THINKING_SETTLED_MARKER, ACTIVITY_TOKEN_MARK, GROUP_RULE },
  { chooseLabel, USED_SEGMENTS },
] = await Promise.all([
  import('node:assert'),
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/StatusLine.js'),
  import('../src/components/CockpitHud.js'),
  import('../src/components/AutoRecapRow.js'),
  import('../src/components/LogoV2.js'),
  import('../src/components/messages/AssistantToolUseMessage.js'),
  import('../src/components/messages/AssistantTextMessage.js'),
  import('../src/components/messages/UserPromptMessage.js'),
  import('../src/components/messages/AssistantThinkingMessage.js'),
  import('../src/components/ActivityLine.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('../src/utils/paths.js'),
  import('../src/tips.js'),
  import('../src/theme.js'),
  import('../src/cc/figures.js'),
  import('../src/screens/StatusMetrics.js'),
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
  provider: 'probe-provider',
  cockpit: false,
  agentId: 'd5a3b7c9-e1f2-4a6b-8c3d-0123456789ab',
  lastUsage: { input: 200_000, cacheRead: 5_000, cacheWrite: 1_000, output: 6_789 },
  contextWindow: 266_000,
  reasoningEffort: 'max',
  modeIndex: 0,
  mode: { id: 'default', plan: false },
  model: 'display-model-probe',
  cwd: 'C:/work/display-project',
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
  options: { selectionActive?: boolean; helpOpen?: boolean; statusChips?: readonly string[] } = {},
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
        statusChips={options.statusChips}
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

async function renderHud(
  overrides: Record<string, unknown> = {},
  columns = 140,
): Promise<string> {
  const harness = makeHarness(columns, 6)
  const channel = { ...baseChannel, ...overrides }
  const instance = await render(
    <ThemeProvider theme="dark">
      <CockpitHud channel={channel as never} />
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

async function renderChrome(
  overrides: Record<string, unknown> = {},
  columns = 140,
): Promise<string> {
  const harness = makeHarness(columns)
  const channel = { ...baseChannel, ...overrides }
  const showHud = channel.cockpit === true && channel.minimal !== true
  const instance = await render(
    <ThemeProvider theme="dark">
      <>
        {showHud ? <CockpitHud channel={channel as never} /> : null}
        <StatusLine
          channel={channel as never}
          wake={wake as never}
        />
      </>
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
    cost: true,
    tps: false,
    gitBranch: false,
    sessionTitle: false,
    sessionId: false,
    goal: true,
    mode: false,
    contextBar: false,
    activity: false,
    trajectory: false,
    pluginChips: true,
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

check('mergeStatusBar keeps a profile overlay when the settings layer is unset', () => {
  const profile = {
    ...DEFAULT_STATUS_BAR,
    compact: false,
    tokens: true,
    tps: true,
    contextBar: true,
    gitBranch: true,
    sessionId: true,
    activity: true,
    cost: false,
  }
  assert.equal(mergeStatusBar(profile, undefined).tokens, true)
  assert.equal(mergeStatusBar(profile, undefined).tps, true)
  assert.equal(mergeStatusBar(profile, {}).tokens, true)
  assert.equal(mergeStatusBar(profile, { tokens: false }).tokens, false)
  assert.equal(mergeStatusBar(profile, { tokens: false }).tps, true)
})

check('schema-filled statusBar defaults would wipe the profile (do not pass them as overlay)', () => {
  const profile = { ...DEFAULT_STATUS_BAR, tokens: true, tps: true }
  const wiped = mergeStatusBar(profile, DEFAULT_STATUS_BAR)
  assert.equal(wiped.tokens, false)
  assert.equal(wiped.tps, false)
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

const home = homeDir()
const homeRoot = await renderStatus({ displayCwd: home, cwd: home })
check('compact StatusLine collapses the home directory to a tilde', () => {
  assert.ok(homeRoot.includes('~'), `missing home marker in:\n${homeRoot}`)
  assert.ok(!homeRoot.includes(home), `raw home path leaked in:\n${homeRoot}`)
})

const homeRootWithSeparator = await renderStatus({ displayCwd: `${home}/`, cwd: `${home}/` })
check('compact StatusLine collapses the home directory with a trailing separator', () => {
  assert.ok(homeRootWithSeparator.includes('~'), `missing home marker in:\n${homeRootWithSeparator}`)
  assert.ok(!homeRootWithSeparator.includes(home), `raw home path leaked in:\n${homeRootWithSeparator}`)
})

const homeChild = await renderStatus({
  displayCwd: `${home}/dev/display-project`,
  cwd: `${home}/dev/display-project`,
  statusBar: { ...DEFAULT_STATUS_BAR, compact: false },
})
check('full StatusLine collapses paths below home', () => {
  assert.ok(homeChild.includes('~/dev/display-project'), `missing collapsed home child in:\n${homeChild}`)
  assert.ok(!homeChild.includes(home), `raw home path leaked in:\n${homeChild}`)
})

const external = await renderStatus({
  displayCwd: '/opt/display-project',
  cwd: '/opt/display-project',
  statusBar: { ...DEFAULT_STATUS_BAR, compact: false },
})
check('full StatusLine keeps local paths outside home unchanged', () => {
  assert.ok(external.includes('/opt/display-project'), `missing external cwd in:\n${external}`)
  assert.ok(!external.includes('~/display-project'), `external cwd was collapsed:\n${external}`)
})

const providerDisplay = await renderStatus({
  displayCwd: `${home}/remote-project`,
  cwd: '/tmp/provider-alias',
  statusBar: { ...DEFAULT_STATUS_BAR, compact: false },
})
check('full StatusLine preserves provider-owned display paths', () => {
  assert.ok(providerDisplay.includes(`${home}/remote-project`), `missing provider cwd in:\n${providerDisplay}`)
  assert.ok(!providerDisplay.includes('~/remote-project'), `provider cwd was collapsed:\n${providerDisplay}`)
})

check('compact StatusLine hides disabled optional fields', () => {
  for (const marker of ['37 tps', 'feat/display-settings-probe', 'display settings title probe', '#d5a3b7c9', '12.3k→6.8k', 'system', 'free']) {
    assert.ok(!compact.includes(marker), `unexpected ${JSON.stringify(marker)} in:\n${compact}`)
  }
  assert.ok(!/[▁▂▃▄▅▆▇█▶]/.test(compact), `unexpected trajectory wake in:\n${compact}`)
})

const withSessionId = await renderStatus({
  statusBar: { ...DEFAULT_STATUS_BAR, sessionId: true },
})
check('session id switch shows the # + 8-char short id', () => {
  assert.ok(withSessionId.includes('#d5a3b7c9'), `missing short session id in:\n${withSessionId}`)
  assert.ok(!withSessionId.includes('d5a3b7c9-e1f2'), `full id leaked in:\n${withSessionId}`)
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

const probeGoal = {
  id: 'g-probe',
  revision: 1,
  objective: 'probe goal objective',
  phase: 'active',
  maxGoalRounds: 5,
  roundsStarted: 2,
} as const

const withGoal = await renderStatus({ goal: probeGoal })
check('compact StatusLine renders the goal chip when a goal exists', () => {
  assert.ok(withGoal.includes('● 2/5'), `missing goal chip in:\n${withGoal}`)
})

const withGoalHidden = await renderStatus({
  goal: probeGoal,
  statusBar: { ...DEFAULT_STATUS_BAR, goal: false },
})
check('goal chip respects the statusBar.goal switch', () => {
  assert.ok(!withGoalHidden.includes('2/5'), `unexpected goal chip in:\n${withGoalHidden}`)
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
  sessionId: true,
  contextBar: true,
  trajectory: true,
}
const full = await renderStatus({ statusBar: fullStatus }, 200)
check('full StatusLine exposes tps, git, title, and token totals', () => {
  for (const marker of ['37 tps', 'feat/display-settings-probe', 'display settings title probe', '#d5a3b7c9', '12.3k→6.8k']) {
    assert.ok(full.includes(marker), `missing ${JSON.stringify(marker)} in:\n${full}`)
  }
})

check('full StatusLine renders context bar and deterministic trajectory wake', () => {
  assert.ok(full.includes('system') || full.includes('sys'), `missing context-bar segment in:\n${full}`)
  assert.ok(full.includes('77.4%'), `missing context-bar percentage in:\n${full}`)
  assert.ok(/[▁▂▃▄▅▆▇█]/.test(full), `missing trajectory glyph in:\n${full}`)
})

// Cockpit HUD: identity row above the transcript, footer drops duplicated route chips.
const cockpitOff = await renderChrome({ cockpit: false })
check('cockpit off leaves the HUD unmounted and still shows the footer model', () => {
  assert.ok(!/\bprov\b/.test(cockpitOff), `unexpected HUD label in:\n${cockpitOff}`)
  assert.ok(cockpitOff.includes('display-model-probe'), `missing footer model in:\n${cockpitOff}`)
})

const cockpitHud = await renderHud({ cockpit: true })
const cockpitFooter = await renderStatus({ cockpit: true })
check('cockpit on pins provider, model, and effort in the HUD', () => {
  for (const marker of ['prov', 'probe-provider', 'display-model-probe', 'eff', 'max']) {
    assert.ok(cockpitHud.includes(marker), `missing ${JSON.stringify(marker)} in:\n${cockpitHud}`)
  }
})
check('cockpit on drops model from the footer', () => {
  assert.ok(!cockpitFooter.includes('display-model-probe'), `footer still shows model in:\n${cockpitFooter}`)
  assert.ok(!cockpitFooter.includes('max'), `footer still shows thinking/effort in:\n${cockpitFooter}`)
})

const visionHud = await renderHud({ cockpit: true, inputModalities: ['image', 'text'] })
check('image modality renders the vision io chip', () => {
  assert.ok(visionHud.includes('vision'), `missing vision chip in:\n${visionHud}`)
  assert.ok(!/\bio\s+vision\b/.test(visionHud), `io still dumps as a field in:\n${visionHud}`)
})

const textHud = await renderHud({ cockpit: true, inputModalities: ['text'] })
check('text-only known modalities render the text io chip', () => {
  assert.ok(textHud.includes('text'), `missing text chip in:\n${textHud}`)
  assert.ok(!/\bio\s+text\b/.test(textHud), `io still dumps as a field in:\n${textHud}`)
  assert.ok(!textHud.includes('vision'), `unexpected vision chip in:\n${textHud}`)
})

const unknownHud = await renderHud({ cockpit: true })
check('unknown modalities omit the io chip', () => {
  assert.ok(!unknownHud.includes(' text '), `unexpected text chip in:\n${unknownHud}`)
  assert.ok(!unknownHud.includes(' vision '), `unexpected vision chip in:\n${unknownHud}`)
})

check('missing llm modalities do not throw', () => {
  assert.ok(unknownHud.includes('probe-provider'), `HUD failed to render without modalities:\n${unknownHud}`)
})

const cockpitMinimal = await renderChrome({ cockpit: true, minimal: true })
check('minimal mode hides the cockpit HUD', () => {
  assert.ok(!/\bprov\b/.test(cockpitMinimal), `HUD leaked in minimal mode:\n${cockpitMinimal}`)
})

check('HUD is a value-first instrument strip with group rules', () => {
  const line = cockpitHud.split('\n').find(row => row.includes('probe-provider'))
  assert.ok(line, `missing HUD identity row in:\n${cockpitHud}`)
  assert.match(line ?? '', /probe-provider\s+prov/)
  assert.match(line ?? '', new RegExp(GROUP_RULE))
  assert.doesNotMatch(line ?? '', /prov\s+probe-provider/)
})

check('HUD is an identity strip with a brand tick, not a version line', () => {
  const line = cockpitHud.split('\n').find(row => row.includes('probe-provider'))
  assert.ok(line?.includes('▍'), `missing brand tick in:\n${cockpitHud}`)
  assert.ok(!cockpitHud.includes('dsh-TUI'), `HUD still carries the splash wordmark:\n${cockpitHud}`)
})

const fullModeHud = await renderHud({
  cockpit: true,
  modeIndex: 2,
  mode: { id: 'full', plan: false, sandbox: 'danger-full-access', approval: 'never' },
})
check('HUD hides full-access mode as daily-driver permission noise', () => {
  assert.ok(!fullModeHud.includes('full access'), `full access leaked in:\n${fullModeHud}`)
})

const planHud = await renderHud({
  cockpit: true,
  modeIndex: 1,
  mode: { id: 'plan', plan: true },
})
check('HUD still shows a non-default plan mode', () => {
  assert.ok(planHud.includes('plan mode'), `missing plan mode in:\n${planHud}`)
})

const longModelHud = await renderHud({
  cockpit: true,
  provider: 'genspark',
  model: 'deepseek-v4-pro-0813-extra-long-model-id',
  reasoningEffort: undefined,
  inputModalities: ['text'],
}, 42)
check('HUD truncates the model, not the provider', () => {
  const line = longModelHud.split('\n').find(row => row.includes('genspark'))
  assert.ok(line, `missing provider in:\n${longModelHud}`)
  assert.ok(line?.includes('genspark'), `provider was dropped in:\n${line}`)
  assert.ok(
    !line?.includes('extra-long-model-id'),
    `model was not truncated in:\n${line}`,
  )
})

const sparseCockpit = {
  cockpit: true,
  gitBranch: '',
  sessionTitle: '',
  agentId: '',
  tps: undefined,
  statusBar: {
    ...DEFAULT_STATUS_BAR,
    compact: true,
    cwd: false,
    tokens: false,
    tps: false,
    gitBranch: false,
    sessionId: false,
    sessionTitle: false,
    goal: false,
    model: false,
  },
} as const
const sparseFooter = await renderStatus(sparseCockpit, 140)
check('cockpit footer keeps cache and ctx in a tight group', () => {
  const line = sparseFooter.split('\n').find(row => row.includes('cache') && row.includes('ctx'))
  assert.ok(line, `missing cache/ctx row in:\n${sparseFooter}`)
  const cacheAt = line?.indexOf('cache') ?? -1
  const ctxAt = line?.indexOf('ctx') ?? -1
  const gap = ctxAt - cacheAt
  assert.ok(gap >= 0 && gap < 40, `cavern between cache and ctx (${gap} cells): ${JSON.stringify(line)}`)
})

const chipFooter = await renderStatus(
  { cockpit: true, statusBar: { ...DEFAULT_STATUS_BAR, compact: false, cwd: false } },
  140,
  { statusChips: ['canvas http://127.0.0.1:9'] },
)
check('cockpit footer parks plugin chips in the instrument row', () => {
  assert.ok(chipFooter.includes('canvas'), `missing canvas chip in:\n${chipFooter}`)
  assert.ok(chipFooter.includes('127.0.0.1:9'), `missing canvas host in:\n${chipFooter}`)
  assert.ok(!chipFooter.includes('canvas http://'), `canvas still dumps the raw URL in:\n${chipFooter}`)
})

check('parseStatusChip turns a canvas URL into a label plus host', () => {
  assert.deepEqual(parseStatusChip('canvas http://127.0.0.1:9'), {
    label: 'canvas',
    detail: '127.0.0.1:9',
  })
  assert.deepEqual(parseStatusChip('ready'), { label: 'ready' })
})

const profileStatusBar = {
  ...DEFAULT_STATUS_BAR,
  compact: false,
  tokens: true,
  tps: true,
  contextBar: true,
  gitBranch: true,
  sessionId: true,
  activity: true,
  cost: false,
}
const denseCockpit = await renderStatus({
  cockpit: true,
  tps: undefined,
  tokens: { input: 0, output: 0 },
  lastUsage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  statusBar: profileStatusBar,
}, 200)
check('cockpit dense footer shows zero readings, a tps placeholder, git, and session', () => {
  for (const marker of ['cache 0.0%', '0→0', '— tps', 'ctx', 'feat/display-settings-probe', '#d5a3b7c9']) {
    assert.ok(denseCockpit.includes(marker), `missing ${JSON.stringify(marker)} in:\n${denseCockpit}`)
  }
  assert.ok(!denseCockpit.includes('¥'), `fake spend leaked in:\n${denseCockpit}`)
})

check('cockpit dense footer renders the context bar when the window is known', () => {
  assert.ok(
    denseCockpit.includes('system') || denseCockpit.includes('sys') || denseCockpit.includes('free'),
    `missing context-bar segment in:\n${denseCockpit}`,
  )
})

check('cockpit dense footer groups metrics from ctx with a box rule', () => {
  const line = denseCockpit.split('\n').find(row => row.includes('cache') && row.includes('ctx'))
  assert.ok(line?.includes(GROUP_RULE), `missing group rule in:\n${line}`)
})

async function renderFrame(
  node: React.ReactNode,
  columns = 80,
  rows = 8,
): Promise<string> {
  const harness = makeHarness(columns, rows)
  const instance = await render(
    <ThemeProvider theme="dark">{node}</ThemeProvider>,
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

const recapCard = await renderFrame(
  <AutoRecapRow summary="Session just started" streaming={false} onExpand={() => {}} onDismiss={() => {}} />,
)
check('auto recap is a quiet card without a full-width rule', () => {
  assert.ok(recapCard.includes('Recap:'), `missing recap copy in:\n${recapCard}`)
  assert.ok(
    !recapCard.split('\n').some(row => /^─{8,}/.test(row.trim()) || /─{8,}.*─{8,}/.test(row)),
    `recap still uses a full-width rule:\n${recapCard}`,
  )
})

const logoRouted = await renderFrame(
  <LogoV2
    model="deepseek-v4-pro-0813"
    effort="max"
    cwd="/home/ujji"
    skipIntro
    hideRoute
    tip={pickRandomTip(() => 0)}
    drift={null}
  />,
  100,
  20,
)
check('cockpit splash hides the route line the HUD already shows', () => {
  assert.match(logoRouted, /v\d+\.\d+/)
  assert.ok(!logoRouted.includes('✦'), `splash wordmark still fights the HUD:\n${logoRouted}`)
  assert.ok(!logoRouted.includes('dsh-TUI'), `splash still dumps the package name:\n${logoRouted}`)
  assert.ok(!logoRouted.includes('deepseek-v4-pro-0813'), `splash still dumps the model in:\n${logoRouted}`)
  assert.ok(!logoRouted.includes('Max effort'), `splash still dumps effort in:\n${logoRouted}`)
  assert.ok(logoRouted.includes('/home/ujji'), `cwd was dropped from the splash in:\n${logoRouted}`)
})

const framedAssistant = await renderFrame(
  <AssistantTextMessage text="Hey! What are we building?" addMargin={false} cockpit />,
)
check('cockpit assistant uses a left rule, not a bullet', () => {
  assert.ok(framedAssistant.includes('Hey!'), `missing body in:\n${framedAssistant}`)
  assert.ok(framedAssistant.includes('│'), `missing left rule in:\n${framedAssistant}`)
  assert.ok(!framedAssistant.includes('●'), `CC bullet leaked in cockpit frame:\n${framedAssistant}`)
})

const defaultAssistant = await renderFrame(
  <AssistantTextMessage text="Hey! What are we building?" addMargin={false} />,
)
check('default assistant keeps the CC bullet', () => {
  assert.ok(defaultAssistant.includes('●') || defaultAssistant.includes('⏺'), `missing CC bullet in:\n${defaultAssistant}`)
  assert.ok(!defaultAssistant.includes('│'), `cockpit rule leaked off-switch:\n${defaultAssistant}`)
})

const framedUser = await renderFrame(
  <UserPromptMessage text="Hello" addMargin={false} cockpit />,
)
check('cockpit user keeps the pointer marker', () => {
  assert.ok(framedUser.includes('Hello'), `missing user text in:\n${framedUser}`)
  assert.ok(framedUser.includes('❯'), `missing user pointer in:\n${framedUser}`)
})

const framedThinking = await renderFrame(
  <AssistantThinkingMessage thinking="quiet reasoning" addMargin={false} verbose={false} cockpit />,
)
check('cockpit thinking is quiet: chevron, no expand shout', () => {
  assert.ok(framedThinking.includes('Thinking'), `missing thinking label in:\n${framedThinking}`)
  assert.ok(framedThinking.includes(THINKING_SETTLED_MARKER), `missing › marker in:\n${framedThinking}`)
  assert.ok(!framedThinking.includes('ctrl+o'), `expand hint leaked into cockpit thinking:\n${framedThinking}`)
  assert.ok(!framedThinking.includes('❯'), `user pointer leaked into thinking:\n${framedThinking}`)
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

function toSgrAnsi(color: string, plane: '38' | '48'): string {
  const rgbMatch = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/)
  if (rgbMatch) return `\x1b[${plane};2;${rgbMatch[1]};${rgbMatch[2]};${rgbMatch[3]}m`
  const ansiMatch = color.match(/[34]8;2;(\d+);(\d+);(\d+)m/)
  if (ansiMatch) return `\x1b[${plane};2;${ansiMatch[1]};${ansiMatch[2]};${ansiMatch[3]}m`
  if (color.startsWith('#')) {
    const r = parseInt(color.slice(1, 3), 16)
    const g = parseInt(color.slice(3, 5), 16)
    const b = parseInt(color.slice(5, 7), 16)
    return `\x1b[${plane};2;${r};${g};${b}m`
  }
  return ''
}

const toBgAnsi = (color: string) => toSgrAnsi(color, '48')
const toFgAnsi = (color: string) => toSgrAnsi(color, '38')

const noneAnsi = await renderToolBackground('none')
const subtleAnsi = await renderToolBackground('subtle')
const strongAnsi = await renderToolBackground('strong')
check('tool background modes map to stable dark-theme ANSI backgrounds', () => {
  const dark = getTheme('dark')
  const subtleBg = toBgAnsi(dark.toolCardBackgroundDim)
  const strongBg = toBgAnsi(dark.toolCardBackground)
  assert.ok(subtleBg !== '', 'subtleBg derived empty')
  assert.ok(strongBg !== '', 'strongBg derived empty')
  assert.ok(!noneAnsi.includes(subtleBg) && !noneAnsi.includes(strongBg))
  assert.ok(subtleAnsi.includes(subtleBg), 'subtle background ANSI missing')
  assert.ok(strongAnsi.includes(strongBg), 'strong background ANSI missing')
})

check('dark pane token is a painted fill, not the badge background', () => {
  const dark = getTheme('dark')
  assert.ok(isPaintedColor(dark.pane), 'dark pane is empty or transparent')
  assert.notEqual(dark.pane, dark.background)
  assert.equal(resolvePane(dark), dark.pane)
  assert.equal(isPaintedColor('#00000000'), false)
})

async function renderWrites(node: React.ReactNode, columns = 40, rows = 6): Promise<{ screen: string; writes: string }> {
  const harness = makeHarness(columns, rows)
  const instance = await render(
    <ThemeProvider theme="dark">{node}</ThemeProvider>,
    {
      stdout: harness.stdout as NodeJS.WriteStream,
      stderr: harness.stderr as NodeJS.WriteStream,
      stdin: harness.stdin as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  await sleep(180)
  const screen = harness.screen()
  const writes = harness.writes.join('')
  await instance.unmount()
  harness.term.dispose()
  return { screen, writes }
}

const panePaint = await renderWrites(
  <Box width={20} height={4} backgroundColor="pane">
    <Text>opaque</Text>
  </Box>,
)
check('chrome pane emits a non-empty truecolor background', () => {
  const dark = getTheme('dark')
  assert.ok(panePaint.screen.includes('opaque'), `missing pane copy in:\n${panePaint.screen}`)
  assert.ok(
    panePaint.writes.includes(toBgAnsi(dark.pane)),
    'dark pane SGR missing from writes',
  )
})

const ioChipPaint = await renderWrites(
  <CockpitHud channel={{ ...baseChannel, cockpit: true, inputModalities: ['text'] } as never} />,
  80,
  4,
)
check('HUD io chip paints a claude fill', () => {
  const dark = getTheme('dark')
  assert.ok(ioChipPaint.screen.includes('text'), `missing io chip in:\n${ioChipPaint.screen}`)
  assert.ok(
    ioChipPaint.writes.includes(toBgAnsi(dark.claude)),
    'io chip claude background SGR missing from writes',
  )
})
check('HUD hairline uses mist-blue promptBorder', () => {
  const dark = getTheme('dark')
  assert.ok(
    ioChipPaint.writes.includes(toFgAnsi(dark.promptBorder)),
    'promptBorder SGR missing from writes',
  )
})
check('context-bar used segments stay in the DeepSeek mist-blue family', () => {
  assert.deepEqual(
    USED_SEGMENTS.map(segment => segment.color),
    ['#22305F', '#2B3D78', '#344A92', '#4D6BFE', '#5A7CFF'],
  )
})

const thinkingChrome = await renderWrites(
  <AssistantThinkingMessage thinking="quiet reasoning" addMargin={false} verbose={false} />,
)
check('thinking line uses a chevron, not the anchor emoji', () => {
  assert.ok(thinkingChrome.screen.includes('Thinking'), `missing thinking label in:\n${thinkingChrome.screen}`)
  assert.ok(thinkingChrome.screen.includes(THINKING_SETTLED_MARKER), `missing › marker in:\n${thinkingChrome.screen}`)
  assert.ok(!thinkingChrome.screen.includes('⚓'), `anchor emoji leaked in:\n${thinkingChrome.screen}`)
  assert.ok(!thinkingChrome.writes.includes('\u2693'), 'anchor codepoint leaked into writes')
})

const activityChrome = await renderWrites(
  <ActivityLine
    activity={{
      phase: 'done',
      line: 'Done and dusted · 0 tools · thought 5s worked 0s · 🔥 34.9k',
      toolCount: 0,
      turnElapsedMs: 5000,
      phaseStartedAt: 0,
    }}
    activityFrames={undefined}
  />,
  80,
  4,
)
check('activity line replaces the fire emoji with a geometric mark', () => {
  assert.ok(activityChrome.screen.includes('Done and dusted'), `missing activity copy in:\n${activityChrome.screen}`)
  assert.ok(activityChrome.screen.includes(ACTIVITY_TOKEN_MARK), `missing ▸ token mark in:\n${activityChrome.screen}`)
  assert.ok(activityChrome.screen.includes('34.9k'), `missing token count in:\n${activityChrome.screen}`)
  assert.ok(!activityChrome.screen.includes('🔥'), `fire emoji leaked in:\n${activityChrome.screen}`)
  assert.ok(!activityChrome.writes.includes('\u{1F525}'), 'fire codepoint leaked into writes')
})

check('assistant context-bar label uses asst before truncating to ast', () => {
  assert.equal(chooseLabel(['assistant', 'asst', 'ast', 'a'], 4), 'asst')
  assert.equal(chooseLabel(['assistant', 'asst', 'ast', 'a'], 3), 'ast')
})

console.log(`\nAll ${checks} display-settings checks passed.`)
