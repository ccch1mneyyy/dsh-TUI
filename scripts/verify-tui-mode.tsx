/**
 * `/tui` display-mode regression:
 *   1. `/tui f` completes to `/tui fullscreen `
 *   2. `/tui` writes settings.yaml `dsh-tui.fullscreen` (not a sidecar json)
 *   3. StatusLine leftmost field is inline/fullscreen (zh 常规/全屏)
 *   4. /settings registers each dsh-tui path once (merge leftover guard)
 *
 * Run: node --import tsx/esm scripts/verify-tui-mode.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
process.env.DSH_TUI_THEME = 'dark'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, ThemeProvider, DisplayFrame },
  { Chat },
  { StatusLine },
  { QuestionStore },
  { ApprovalStore },
  { completeCommands, LOCAL_COMMANDS },
  { setLang },
  { default: instances },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/screens/StatusLine.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/approvals.js'),
  import('../src/commands.js'),
  import('../src/i18n.js'),
  import('../src/ink/instances.js'),
])

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

let failures = 0
function check(cond: boolean, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failures++
    console.error(`  ✗ ${msg}`)
  }
}

function makeTerm(cols: number, rows: number) {
  const term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
  }
  class FakeStderr extends Writable {
    isTTY = true
    _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  return { term, stdout: new FakeStdout(), stderr: new FakeStderr(), stdin: new FakeStdin() }
}

function screenText(term: InstanceType<typeof XTerm>, rows: number): string {
  const buf = term.buffer.active
  return Array.from({ length: rows }, (_, y) => buf.getLine(y)?.translateToString(true) ?? '').join('\n')
}

function countNeedle(text: string, needle: string): number {
  let count = 0
  let from = 0
  while (from < text.length) {
    const at = text.indexOf(needle, from)
    if (at < 0) break
    count += 1
    from = at + needle.length
  }
  return count
}

function bindInkToProcessStdout(stdout: { columns: number }): void {
  const ink = instances.get(stdout as never) ?? [...instances.values()].at(-1)
  if (ink) instances.set(process.stdout, ink)
}

/** Product host wraps Chat in DisplayFrame; tests that drive `/tui` must too. */
function ChatHarness({
  channel,
  questionStore,
  approvalStore,
}: {
  channel: Record<string, unknown>
  questionStore: never
  approvalStore: never
}): React.ReactNode {
  React.useSyncExternalStore(
    channel.subscribe as (listener: () => void) => () => void,
    () => channel.version as number,
  )
  return (
    <DisplayFrame active={channel.fullscreen === true}>
      <Chat channel={channel as never} questionStore={questionStore} approvalStore={approvalStore} />
    </DisplayFrame>
  )
}

console.log('settings field paths unique:')
{
  const { readFileSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/dsh-adapter/plugin.ts'), 'utf8')
  const paths = [...source.matchAll(/path:\s*\[([^\]]+)\]/g)].map(match => match[1].replace(/\s+/g, ''))
  const seen = new Set<string>()
  const dupes: string[] = []
  for (const path of paths) {
    if (seen.has(path)) dupes.push(path)
    else seen.add(path)
  }
  check(dupes.length === 0, `dsh-tui settings paths unique (dupes: ${dupes.join(', ') || 'none'})`)
  check(paths.filter(path => path === "'fullscreen'").length === 1, 'exactly one fullscreen settings field')
}

const tuiChildren = (path: readonly string[]) => path.length === 1 && path[0] === 'tui'
  ? [
      { name: 'fullscreen', description: 'Enter fullscreen (alternate screen)' },
      { name: 'default', description: 'Return to inline (default) mode', aliases: ['inline'] as const },
    ]
  : []

console.log('command completion:')
{
  const hit = completeCommands('/tui f', LOCAL_COMMANDS, tuiChildren)
  check(hit[0]?.replacement === '/tui fullscreen ', `completeCommands('/tui f') → /tui fullscreen  (got ${hit[0]?.replacement})`)
  const alias = completeCommands('/tui in', LOCAL_COMMANDS, tuiChildren)
  check(alias[0]?.replacement === '/tui inline ', `completeCommands('/tui in') → /tui inline  (got ${alias[0]?.replacement})`)
  check(LOCAL_COMMANDS.some(command => command.name === 'tui'), 'LOCAL_COMMANDS includes tui')
}

console.log('StatusLine display label:')
{
  const COLS = 100
  const ROWS = 8
  async function renderLine(fullscreen: boolean, lang: 'en' | 'zh'): Promise<string> {
    setLang(lang)
    const { term, stdout, stderr, stdin } = makeTerm(COLS, ROWS)
    const instance = await render(
      <ThemeProvider theme="dark">
        <StatusLine
          fullscreen={fullscreen}
          channel={{
            statusBar: { compact: true, model: true, thinking: false, cwd: false, contextUsage: false, cache: false, tokens: false, tps: false, gitBranch: false, sessionTitle: false, mode: false, contextBar: false, activity: false, trajectory: false, shortcutHint: false },
            model: 'probe-model',
            lastUsage: undefined,
            contextWindow: undefined,
            reasoningEffort: undefined,
            modeIndex: 0,
            mode: { id: 'default', plan: false },
            tokens: { input: 0, output: 0 },
            tps: undefined,
            tpsSamples: [],
            working: false,
            gitBranch: undefined,
            displayCwd: '/tmp',
            sessionTitle: '',
            workingActivity: undefined,
            activityFrames: 'claude',
            contextBarEnabled: false,
            contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
            fullscreen,
          } as never}
        />
      </ThemeProvider>,
      { stdout: stdout as never, stderr: stderr as never, stdin: stdin as never, exitOnCtrlC: false, patchConsole: false },
    )
    await sleep(180)
    const text = screenText(term, ROWS)
    await instance.unmount()
    term.dispose()
    return text
  }

  const inlineEn = await renderLine(false, 'en')
  const firstEn = inlineEn.split('\n').find(row => row.includes('probe-model')) ?? inlineEn
  check(/^\s*inline\b/.test(firstEn), `en inline is leftmost (got ${JSON.stringify(firstEn.trim())})`)

  const fullEn = await renderLine(true, 'en')
  const firstFullEn = fullEn.split('\n').find(row => row.includes('probe-model')) ?? fullEn
  check(/^\s*fullscreen\b/.test(firstFullEn), `en fullscreen is leftmost (got ${JSON.stringify(firstFullEn.trim())})`)

  const inlineZh = await renderLine(false, 'zh')
  const firstZh = inlineZh.split('\n').find(row => row.includes('probe-model')) ?? inlineZh
  check(firstZh.includes('常规'), `zh inline label 常规 (got ${JSON.stringify(firstZh.trim())})`)

  const fullZh = await renderLine(true, 'zh')
  const firstFullZh = fullZh.split('\n').find(row => row.includes('probe-model')) ?? fullZh
  check(firstFullZh.includes('全屏'), `zh fullscreen label 全屏 (got ${JSON.stringify(firstFullZh.trim())})`)
}

console.log('/tui writes settings fullscreen:')
{
  setLang('en')
  const COLS = 100
  const ROWS = 24
  const { term, stdout, stderr, stdin } = makeTerm(COLS, ROWS)
  const writes: { ns: string; ops: readonly { op: string; path: readonly string[]; value?: unknown }[]; revision: number | undefined }[] = []
  const listeners = new Set<() => void>()
  const channel: Record<string, unknown> = {
    version: 0,
    fullscreen: false,
    rows: [],
    status: 'idle',
    sessionTitle: '',
    agentId: 'tui-mode',
    model: 'probe-model',
    provider: 'deepseek',
    tokens: { input: 0, output: 0 },
    cwd: '/tmp',
    displayCwd: '/tmp',
    gitBranch: undefined,
    working: false,
    spinnerMode: 'requesting',
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    lastUserText: '',
    pending: [],
    notifications: [],
    contextWindow: undefined,
    reasoningEffort: undefined,
    workingActivity: undefined,
    activityEnabled: false,
    contextBarEnabled: false,
    statusBar: { compact: true, model: true, thinking: false, cwd: false, contextUsage: false, cache: false, tokens: false, tps: false, gitBranch: false, sessionTitle: false, mode: false, contextBar: false, activity: false, trajectory: false, shortcutHint: false },
    diffLayout: 'auto',
    thinkingFold: 'preview',
    toolBackground: 'none',
    lastUsage: undefined,
    loadedContext: undefined,
    tps: undefined,
    tpsSamples: [],
    pluginScene: undefined,
    agentPreset: 'standard',
    goal: undefined,
    todos: [],
    commandList: [{ name: 'tui', description: 'Switch between fullscreen and inline display' }],
    commandCompletions: () => [],
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    mode: { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
    modeIndex: 0,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit() {
      channel.version = (channel.version as number) + 1
      for (const listener of listeners) listener()
    },
    notify() {},
    pushLocal() {},
    setFullscreen(value: boolean) {
      channel.fullscreen = value
      ;(channel.emit as () => void)()
    },
    settingsHost() {
      return {
        listNamespaces: () => [{ ns: 'dsh-tui', revision: 1, applies: 'live' as const, value: {}, user: {} }],
        write(ns: string, ops: readonly { op: string; path: readonly string[]; value?: unknown }[], revision?: number) {
          writes.push({ ns, ops, revision })
          return Promise.resolve()
        },
      }
    },
    settingsSections: () => [],
    subscribeSettingsSections: () => () => {},
    submit() {},
    steer() {},
    removePending: () => true,
    cancel() {},
    interruptAndDeliver: () => 0,
    clear() {},
    loadOlder: () => 0,
    listModels: async () => [],
    listFiles: async () => [],
    listSessions: async () => [],
    setResumeTarget() {},
    setActivityFrames: () => true,
    activityFrames: 'claude',
    runExternalCommand: async () => '',
    mcpStatus: () => [],
    exportSession: () => null,
    initWorkspace: () => null,
    doctorInfo: () => [],
    pluginsInfo: () => [],
    listSubagents: async () => [],
    listPresets: async () => [],
    switchPreset: async () => false,
    switchModel: async () => false,
    rewindTo: async () => null,
    resumeTo: async () => ({ ok: false, reason: 'unavailable' }),
    newSession: async () => false,
    compact() {},
    traceEvents: () => [],
    listWorkspaces: async () => [],
    workspaceCommands: () => [],
  }

  const instance = await render(
    <ChatHarness
      channel={channel}
      questionStore={new QuestionStore() as never}
      approvalStore={new ApprovalStore() as never}
    />,
    { stdout: stdout as never, stderr: stderr as never, stdin: stdin as never, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(400)
  const before = screenText(term, ROWS)
  check(before.includes('inline · probe-model'), `chat status shows inline before /tui (${JSON.stringify(before.split('\n').find(row => row.includes('probe-model') && row.includes('inline')) ?? before.split('\n').find(row => row.includes('probe-model')) ?? before.slice(-80))})`)

  stdin.write('/tui fullscreen')
  await sleep(120)
  stdin.write('\r')
  await sleep(250)

  check(channel.fullscreen === true, 'setFullscreen(true) applied')
  check(writes.length === 1, `one settings write (got ${writes.length})`)
  check(writes[0]?.ns === 'dsh-tui', 'write targets dsh-tui namespace')
  check(JSON.stringify(writes[0]?.ops) === JSON.stringify([{ op: 'set', path: ['fullscreen'], value: true }]), `write path is fullscreen (got ${JSON.stringify(writes[0]?.ops)})`)
  const after = screenText(term, ROWS)
  check(after.includes('fullscreen · probe-model'), `chat status shows fullscreen after /tui (${JSON.stringify(after.split('\n').find(row => row.includes('probe-model') && row.includes('fullscreen')) ?? after.slice(-80))})`)

  await instance.unmount()
  term.dispose()
}

console.log('/tui fullscreen → default does not ghost the logo:')
{
  setLang('en')
  const COLS = 100
  const ROWS = 32
  const { term, stdout, stderr, stdin } = makeTerm(COLS, ROWS)
  const writes: { ns: string; ops: readonly { op: string; path: readonly string[]; value?: unknown }[]; revision: number | undefined }[] = []
  const listeners = new Set<() => void>()
  const TAGLINE = 'Explore the uncharted!'
  const channel: Record<string, unknown> = {
    version: 0,
    fullscreen: false,
    rows: [],
    status: 'idle',
    sessionTitle: '',
    agentId: 'tui-mode-ghost',
    model: 'probe-model',
    provider: 'deepseek',
    tokens: { input: 0, output: 0 },
    cwd: '/tmp',
    displayCwd: '/tmp',
    gitBranch: undefined,
    working: false,
    spinnerMode: 'requesting',
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    lastUserText: '',
    pending: [],
    notifications: [],
    contextWindow: undefined,
    reasoningEffort: undefined,
    workingActivity: undefined,
    activityEnabled: false,
    contextBarEnabled: false,
    statusBar: { compact: true, model: true, thinking: false, cwd: false, contextUsage: false, cache: false, tokens: false, tps: false, gitBranch: false, sessionTitle: false, mode: false, contextBar: false, activity: false, trajectory: false, shortcutHint: false },
    diffLayout: 'auto',
    thinkingFold: 'preview',
    toolBackground: 'none',
    lastUsage: undefined,
    loadedContext: undefined,
    tps: undefined,
    tpsSamples: [],
    pluginScene: undefined,
    agentPreset: 'standard',
    goal: undefined,
    todos: [],
    commandList: [{ name: 'tui', description: 'Switch between fullscreen and inline display' }],
    commandCompletions: () => [],
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    mode: { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
    modeIndex: 0,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit() {
      channel.version = (channel.version as number) + 1
      for (const listener of listeners) listener()
    },
    notify() {},
    pushLocal() {},
    setFullscreen(value: boolean) {
      channel.fullscreen = value
      ;(channel.emit as () => void)()
    },
    settingsHost() {
      return {
        listNamespaces: () => [{ ns: 'dsh-tui', revision: 1, applies: 'live' as const, value: {}, user: {} }],
        write(ns: string, ops: readonly { op: string; path: readonly string[]; value?: unknown }[], revision?: number) {
          writes.push({ ns, ops, revision })
          return Promise.resolve()
        },
      }
    },
    settingsSections: () => [],
    subscribeSettingsSections: () => () => {},
    submit() {},
    steer() {},
    removePending: () => true,
    cancel() {},
    interruptAndDeliver: () => 0,
    clear() {},
    loadOlder: () => 0,
    listModels: async () => [],
    listFiles: async () => [],
    listSessions: async () => [],
    setResumeTarget() {},
    setActivityFrames: () => true,
    activityFrames: 'claude',
    runExternalCommand: async () => '',
    mcpStatus: () => [],
    exportSession: () => null,
    initWorkspace: () => null,
    doctorInfo: () => [],
    pluginsInfo: () => [],
    listSubagents: async () => [],
    listPresets: async () => [],
    switchPreset: async () => false,
    switchModel: async () => false,
    rewindTo: async () => null,
    resumeTo: async () => ({ ok: false, reason: 'unavailable' }),
    newSession: async () => false,
    compact() {},
    traceEvents: () => [],
    listWorkspaces: async () => [],
    workspaceCommands: () => [],
  }

  const instance = await render(
    <ChatHarness
      channel={channel}
      questionStore={new QuestionStore() as never}
      approvalStore={new ApprovalStore() as never}
    />,
    { stdout: stdout as never, stderr: stderr as never, stdin: stdin as never, exitOnCtrlC: false, patchConsole: false },
  )
  bindInkToProcessStdout(stdout)
  await sleep(400)
  const before = screenText(term, ROWS)
  const beforeCount = countNeedle(before, TAGLINE)
  check(beforeCount === 1, `tagline once before /tui (got ${beforeCount})`)

  stdin.write('/tui fullscreen')
  await sleep(120)
  stdin.write('\r')
  await sleep(350)
  const full = screenText(term, ROWS)
  check(channel.fullscreen === true, 'switched to fullscreen')
  check(term.buffer.active.type === 'alternate', `alt-screen after /tui fullscreen (got ${term.buffer.active.type})`)
  const fullCount = countNeedle(full, TAGLINE)
  check(fullCount === 1, `tagline once in fullscreen (got ${fullCount})`)

  stdin.write('/tui default')
  await sleep(120)
  stdin.write('\r')
  await sleep(350)
  const back = screenText(term, ROWS)
  check(channel.fullscreen === false, 'switched back to inline')
  check(term.buffer.active.type === 'normal', `main screen after /tui default (got ${term.buffer.active.type})`)
  const backCount = countNeedle(back, TAGLINE)
  check(backCount === 1, `tagline once after /tui default — no ghost (got ${backCount})`)
  check(back.includes('inline · probe-model'), `status is inline after round-trip (${JSON.stringify(back.split('\n').find(row => row.includes('probe-model')) ?? back.slice(-80))})`)
  check(!back.includes('fullscreen · probe-model'), 'stale fullscreen status did not remain')

  await instance.unmount()
  term.dispose()
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nverify-tui-mode: all checks passed')
