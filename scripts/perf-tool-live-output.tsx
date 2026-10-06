/**
 * perf-tool-live-output — 运行中工具实时输出（tool.output，N4）的渲染成本探针。
 *
 * 场景（与 perf-tool-stream 同一套假 channel + 真 Chat，全屏 100×40）：
 * 历史 200 行对话 + 40 张已落定的工具卡，随后一张运行中的终端卡以 10 Hz
 * 收到输出（每片 3 行，共 60 片 = 180 行，超过 5/8 行窗口后尾部饱和）。
 * 对照组：同一张运行中的卡 6 秒内只走 1 秒的耗时 tick、不收输出。
 *
 * 输出：两组的帧数、帧耗时 p50/p95/max、commit 合计、每帧 yoga 测量调用
（measureFunc，文本排版——只有变化的那张卡重排时它应保持很小）与补丁数；以及前 10 片与
 * 后 10 片的帧耗时均值（尾部饱和后每片成本应持平，不随累计输出增长）。
 * 不是有界测试，不进 CI。
 *
 * 运行：node --import tsx/esm scripts/perf-tool-live-output.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'
process.env.NODE_ENV ??= 'production'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { LOCAL_COMMANDS, completeCommands }, { appendLiveOutput }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
  import('../src/channel/live-output.js'),
])

const COLS = 100, ROWS = 40
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) // 固定窗:pacing 探针按 10 Hz 节奏喂输出
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS; rows = ROWS; isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

const rows: any[] = []
let id = 0
for (let turn = 1; turn <= 100; turn++) {
  rows.push({ id: ++id, kind: 'user', text: `问题 ${turn}` })
  rows.push({ id: ++id, kind: 'assistant', text: `回复 ${turn}：完成。` })
  if (turn % 2 === 0) {
    rows.push({
      id: ++id, kind: 'tool', text: '',
      tool: { callId: `h${turn}`, name: 'shell', argsText: '{}', status: 'ok', startedAt: 0, durationMs: 300,
        callView: { card: 'terminal', title: `make step-${turn}` }, resultView: { card: 'terminal', output: `step ${turn} ok\nwarnings: 0` } },
    })
  }
}
const listeners = new Set<() => void>()
const channel: any = {
  whaleIdle: false,
  version: 0, rows, status: 'running', sessionTitle: 'probe', agentId: 'probe',
  model: 'gpt-test', provider: 'test', reasoningEffort: 'low', effortLevels: [],
  tokens: { input: 0, output: 0 }, cwd: '/tmp/demo', displayCwd: '/tmp/demo', gitBranch: 'main',
  working: true, spinnerMode: 'tool-use', responseChars: 0, activeToolCount: 1, turnStart: Date.now(),
  pending: [], commandList: LOCAL_COMMANDS, notifications: [], mode: { plan: false, sandbox: undefined },
  activityFrames: 'moon8', agentPreset: undefined, subagents: [], lastUserText: '问题 100',
  scrollGutter: 'timeline',
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => () => {},
  listModels: () => Promise.resolve([]), listSessions: () => Promise.resolve([]),
  deleteSession: () => Promise.resolve(true), renameSessionTo: () => Promise.resolve(true),
  setResumeTarget: () => {}, loadOlder: () => 0, mcpStatus: () => [], pushLocal: () => {},
  commandCompletions: (input: string) => completeCommands(input),
}
const emit = () => { channel.version++; for (const listener of listeners) listener() }

const frames: Array<{ ms: number; commit: number; yoga: number; measured: number; patches: number }> = []
const inst = await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} fullscreen />
  </AlternateScreen>,
  {
    stdout: new FakeStdout() as any, stdin: new FakeStdin() as any, stderr: new FakeStderr() as any,
    exitOnCtrlC: false, patchConsole: false,
    onFrame: (frame: any) => frames.push({ ms: frame.durationMs, commit: frame.phases.commit ?? 0, yoga: frame.phases.yoga ?? 0, measured: frame.phases.yogaMeasured ?? 0, patches: frame.phases.patches ?? 0 }),
  },
)
const running: any = {
  id: ++id, kind: 'tool', text: '',
  tool: { callId: 'live', name: 'shell', argsText: '{}', status: 'running', startedAt: Date.now(), callView: { card: 'terminal', title: 'npm test' } },
}
rows.push(running)
emit()
await sleep(1500)

const summary = (label: string, list: typeof frames): void => {
  const ms = list.map(frame => frame.ms).sort((a, b) => a - b)
  const pick = (q: number) => ms.length === 0 ? '-' : ms[Math.min(ms.length - 1, Math.floor(ms.length * q))]!.toFixed(2)
  console.log(`${label}: frames=${list.length} p50=${pick(0.5)}ms p95=${pick(0.95)}ms max=${ms.length ? ms.at(-1)!.toFixed(2) : '-'}ms commit=${list.reduce((a, f) => a + f.commit, 0).toFixed(1)}ms 平均 yogaMeasured=${(list.reduce((a, f) => a + f.measured, 0) / Math.max(1, list.length)).toFixed(1)} 最大=${Math.max(0, ...list.map(f => f.measured))} 平均 patches=${(list.reduce((a, f) => a + f.patches, 0) / Math.max(1, list.length)).toFixed(1)}`)
}

// Baseline: the running card only ticks its elapsed clock.
frames.length = 0
await sleep(6000)
summary('对照（运行中、无输出，6 s）', frames.slice())

// Live output at 10 Hz: 60 chunks × 3 lines.
frames.length = 0
const perChunk: number[] = []
let tail: ReturnType<typeof appendLiveOutput> | undefined
let n = 0
for (let chunk = 0; chunk < 60; chunk++) {
  const before = frames.length
  const text = [1, 2, 3].map(() => `  ✓ test case ${++n} passes (${(n * 7) % 90} ms)`).join('\n') + '\n'
  tail = appendLiveOutput(tail, text)
  running.tool = { ...running.tool, liveOutput: tail.text, ...(tail.dropped > 0 ? { liveOutputDropped: tail.dropped } : {}) }
  emit()
  await sleep(100)
  perChunk.push(frames.slice(before).reduce((a, f) => a + f.ms, 0))
}
summary('实时输出（10 Hz，6 s，60 片）', frames.slice())
const mean = (list: number[]) => (list.reduce((a, b) => a + b, 0) / Math.max(1, list.length)).toFixed(2)
console.log(`每片帧耗时：前 10 片均值=${mean(perChunk.slice(0, 10))}ms 后 10 片均值=${mean(perChunk.slice(-10))}ms`)

await inst.unmount()
process.exit(0)
