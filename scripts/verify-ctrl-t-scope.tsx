/**
 * Ctrl+T ownership regression.
 *
 * Loaded-context details use the one-shot `/context` command. Ctrl+T has one
 * stable meaning throughout the session: open the trajectory scene.
 *
 * These checks pin both empty- and non-empty-transcript states so another
 * context-sensitive shortcut does not creep back in.
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
    // getLine() indexes the WHOLE buffer, scrollback included; the viewport
    // starts at baseY. Reading from 0 after a frame taller than the terminal
    // returns the PREVIOUS, larger frame's rows — which reads exactly like a
    // repaint bug and is not one.
    const buffer = term.buffer.active
    return Array.from({ length: rows }, (_, y) =>
      (buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '').replace(/\s+$/, ''))
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
const isScene = (text: string): boolean => /✦\s*轨迹/.test(text)
const panelHeader = (text: string): string =>
  text.split('\n').find(line => line.includes('已加载上下文')) ?? ''

// ── empty transcript: summary is informational; Ctrl+T still means trace ───
{
  const harness = makeHarness(100, 30)
  const localReports: Array<{ title: string; lines: readonly string[] }> = []
  const instance = await mount(harness, makeChannel({
    rows: [],
    pushLocal: (title: string, lines: readonly string[]) => { localReports.push({ title, lines }) },
  }))
  await sleep(500)

  const summary = harness.screen()
  check('the startup context summary is on screen', /已加载上下文/.test(summary))
  check('the summary points to /context', panelHeader(summary).includes('/context'), panelHeader(summary).trim())
  check('the summary does not claim Ctrl+T', !panelHeader(summary).includes('Ctrl+T'), panelHeader(summary).trim())

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
