/**
 * Ctrl+T ownership regression.
 *
 * Ctrl+T has one stable meaning throughout the session: open the trajectory
 * scene. The startup loaded-context panel (visible only while the transcript
 * is still empty) owns Ctrl+P instead: the key toggles the collapsed summary
 * between the one-liner and the grouped details. The one-shot `/context`
 * command stays available in both states.
 *
 * These checks pin both empty- and non-empty-transcript states so a
 * context-sensitive shortcut does not creep in the wrong direction.
 *
 * Run: node --import tsx/esm scripts/verify-ctrl-t-scope.tsx
 */
process.env.FORCE_COLOR = '3'
// Asserts Chinese UI copy, so it pins the language rather than inheriting the
// ambient one — `activeLang` resolves at import from env → persisted pref → OS
// locale, none of which a runner is obliged to agree with.
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

/** A short session, so the scene has rows to show in the second case. */
function events(): Record<string, unknown>[] {
  seq = 0
  const out: Record<string, unknown>[] = []
  out.push(ev('turn/start', { turn: 1 }))
  out.push(ev('step/start', { turn: 1, step: 1 }))
  out.push(ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read_file', arguments: '{}' }))
  out.push(ev('tool/result', { turn: 1, step: 1, message: { source: { callId: 'c1' }, content: [] } }))
  out.push(ev('step/end', { turn: 1, step: 1 }))
  out.push(ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  return out
}
const EVENTS = events()

/** Shapes match the LoadedContext contract in dsh-adapter/channel.ts. */
const LOADED_CONTEXT = {
  sections: [
    { name: 'harness:identity', text: '你是 dsh。' },
    { name: 'deployment:persona', text: '简洁作答。' },
  ],
  contexts: [{ name: 'runtime:cwd', text: 'C:/code/x' }],
  files: [{ displayPath: './AGENTS.md' }],
  skills: [{ name: 'audit', description: '代码审计' }],
  tools: [
    { name: 'read', description: '读文件' },
    { name: 'bash', description: '执行命令' },
  ],
}

function makeChannel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 0,
    rows: [],
    status: 'idle',
    sessionTitle: 'ctrl-t probe',
    agentId: 'probe',
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    tokens: { input: 0, output: 0 },
    cwd: 'C:/code/x',
    displayCwd: 'C:/code/x',
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
    commandList: [{ name: 'context', description: '查看上下文' }],
    commandCompletions: () => [{
      name: 'context',
      description: '查看上下文',
      replacement: '/context',
      commandLine: '/context',
    }],
    notifications: [],
    activityEnabled: false,
    contextBarEnabled: true,
    activityFrames: [],
    goal: undefined,
    todos: [],
    loadedContext: LOADED_CONTEXT,
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
    lastUsage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    contextWindow: 1_000_000,
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    tps: undefined,
    tpsSamples: [],
    reasoningEffort: 'high',
    agentPreset: 'standard',
    workspaceLabel: undefined,
    ...overrides,
  }
}

function makeHarness(cols: number, rows: number) {
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
  const stdin = new FakeStdin()
  const screen = (): string => {
    // Read the WHOLE buffer (scrollback + viewport), filtered of blank
    // lines. Content-presence checks must see rows the anchored shrink
    // repaint legitimately left to their scrollback copies (a frame that
    // collapsed below the viewport anchors its tail at the bottom and the
    // viewport's top region goes blank); a viewport-only read mistakes
    // that correct presentation for a lost panel.
    const buffer = term.buffer.active
    return Array.from({ length: buffer.length }, (_, y) =>
      (buffer.getLine(y)?.translateToString(true) ?? '').replace(/\s+$/, ''))
      .filter(line => line !== '')
      .join('\n')
  }
  return { term, stdout: new FakeStdout(), stdin, screen }
}

async function mount(harness: ReturnType<typeof makeHarness>, channel: Record<string, unknown>) {
  const instance = await render(
    React.createElement(Chat, {
      channel: channel as never,
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
  // AlternateScreen resolves its instance through `process.stdout`; alias the
  // fake one so the scene behaves as it does on a real terminal.
  for (const value of instances.values()) instances.set(process.stdout, value)
  return instance
}

const CTRL_T = '\x14'
const CTRL_P = '\x10'
const isScene = (text: string): boolean => /✦\s*轨迹/.test(text)
const panelHeader = (text: string): string =>
  text.split('\n').find(line => line.includes('已加载上下文')) ?? ''

// ── empty transcript: the panel is collapsed; Ctrl+P toggles it, Ctrl+T
//    still opens the trajectory ────────────────────────────────────────────
{
  const harness = makeHarness(100, 30)
  const localReports: Array<{ title: string; lines: readonly string[] }> = []
  const instance = await mount(harness, makeChannel({
    rows: [],
    pushLocal: (title: string, lines: readonly string[]) => { localReports.push({ title, lines }) },
  }))
  await sleep(500)

  const summary = harness.screen()
  check('the startup context panel is on screen', /已加载上下文/.test(summary))
  check('the collapsed panel claims Ctrl+P', panelHeader(summary).includes('Ctrl+P'), panelHeader(summary).trim())

  harness.stdin.write(CTRL_P)
  await sleep(500)
  const expanded = harness.screen()
  check('Ctrl+P expands the panel before the first message', expanded.includes('你是 dsh'),
    expanded.split('\n')[0]?.trim() ?? '')
  check('the expanded details still point to /context', expanded.includes('/context'),
    expanded.split('\n').filter(line => line.includes('/context')).join(' | '))

  harness.stdin.write(CTRL_P)
  await sleep(500)
  check('Ctrl+P collapses the panel again', !harness.screen().includes('你是 dsh'),
    panelHeader(harness.screen()).trim())

  harness.stdin.write(CTRL_T)
  await sleep(500)
  check('Ctrl+T opens the trajectory even before the first message', isScene(harness.screen()),
    harness.screen().split('\n')[0]?.trim())

  harness.stdin.write('q')
  await sleep(400)
  check('q returns to the context summary', /已加载上下文/.test(harness.screen()))

  harness.stdin.write('/context\r')
  await sleep(400)
  const report = localReports.at(-1)
  check('/context emits one local report', report?.title === '/context')
  check('the report contains loaded-context details',
    report?.lines.some(line => line.includes('harness:identity')) === true)

  instance.unmount()
  instances.delete(process.stdout)
  harness.term.dispose()
  await sleep(40)
}

// ── non-empty transcript: the same key still opens the scene ───────────────
{
  const harness = makeHarness(100, 30)
  const instance = await mount(
    harness,
    makeChannel({ rows: [{ id: 1, kind: 'user', text: '第一条消息' }] }),
  )
  await sleep(500)

  const before = harness.screen()
  check('the startup panel is gone once a row exists', !/已加载上下文/.test(before))

  harness.stdin.write(CTRL_T)
  await sleep(500)
  check('Ctrl+T opens the trajectory scene', isScene(harness.screen()), harness.screen().split('\n')[0]?.trim())

  harness.stdin.write('q')
  await sleep(400)
  check('q returns to the conversation', !isScene(harness.screen()))

  instance.unmount()
  instances.delete(process.stdout)
  harness.term.dispose()
}

console.log(failed === 0 ? '\nAll Ctrl+T scope checks passed.' : `\n${failed} check(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
