/**
 * Ctrl+T scope regression.
 *
 * Two things in this UI can be "expanded", and they never share the screen:
 * the startup loaded-context panel renders only while the transcript is empty,
 * which is exactly the window where the trajectory — folded from the session's
 * own events — has nothing in it yet.
 *
 * The trajectory feature claimed Ctrl+T outright on the reasoning that the
 * panel binding was dead. It was not: the panel prints its own
 * `（Ctrl+T 展开）` hint, so the key carried a visible promise, and the scene
 * it opened instead was necessarily empty at that moment. The panel was left
 * reachable only by clicking its header — no keyboard path at all.
 *
 * These checks pin both halves, because fixing one half by hand is how the
 * halves drift apart:
 *
 * - while the panel is up, Ctrl+T expands the panel and does NOT open a scene;
 * - once the transcript has rows, Ctrl+T opens the scene;
 * - the panel's own hint still names the key it actually triggers.
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

/** Shapes match the LoadedContext contract in dsh-adapter/channel.ts: the
 *  collapsed header only counts array lengths, so a fixture of bare strings
 *  renders fine until the panel is expanded and reads the fields. */
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
    commandList: [],
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
/** The panel's own header line, so the open/closed marker is read where it
 *  belongs instead of searched for anywhere on screen. */
const panelHeader = (text: string): string =>
  text.split('\n').find(line => line.includes('已加载上下文')) ?? ''

// ── the panel is up (empty transcript): Ctrl+T belongs to the panel ─────────
{
  // Tall enough that the EXPANDED panel is actually on screen. At an ordinary
  // height the expanded frame exceeds the viewport, so the terminal shows its
  // bottom (prompt + status line) and the panel's own rows sit above the
  // window — nothing to assert on. This says nothing about correctness at
  // smaller sizes; the collapse below is checked either way.
  const harness = makeHarness(100, 60)
  const instance = await mount(harness, makeChannel({ rows: [] }))
  await sleep(500)

  const collapsed = harness.screen()
  check('the startup panel is on screen', /已加载上下文/.test(collapsed))
  check(
    'and it advertises Ctrl+T',
    collapsed.includes('Ctrl+T'),
    collapsed.split('\n').find(line => line.includes('Ctrl+T'))?.trim(),
  )
  check('collapsed to begin with', panelHeader(collapsed).includes('▶'), panelHeader(collapsed).trim())

  harness.stdin.write(CTRL_T)
  await sleep(700)
  const expanded = harness.screen()
  check('Ctrl+T expands the panel', /系统提示词 · 2 段/.test(expanded),
    expanded.split('\n').find(line => line.includes('系统提示词'))?.trim())
  check('and does NOT open the scene', !isScene(expanded))

  harness.stdin.write(CTRL_T)
  await sleep(700)
  const recollapsed = harness.screen()
  check('Ctrl+T collapses it again', panelHeader(recollapsed).includes('▶'),
    panelHeader(recollapsed).trim())
  check('and the expanded body is gone', !/系统提示词 · 2 段/.test(recollapsed))

  instance.unmount()
  instances.delete(process.stdout)
  harness.term.dispose()
  await sleep(40)
}

// ── the transcript has rows: the panel is gone, the key is the scene's ──────
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
