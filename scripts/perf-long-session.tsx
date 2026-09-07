/**
 * perf-long-session — 长会话滚动基准（用户报告：打开长会话哪怕滑动都卡）。
 *
 * 场景：800 轮混合会话（user + 工具行 + assistant ≈ 2400 行），滚轮突发。
 * 对比 120 轮（perf-scroll-bench）找出随行数超线性增长的成本。
 *
 * 输出：帧耗时分位、阶段总量（重点 commit——React 提交 = 组件树遍历）、
 * 输出字节。若 commit/yoga 随行数暴涨 → 挂载窗口或全量循环泄漏。
 *
 * 运行：node --import tsx/esm scripts/perf-long-session.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { LOCAL_COMMANDS, completeCommands }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
])

const COLS = 100, ROWS = 40
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
let outBytes = 0
class FakeStdout extends Writable {
  columns = COLS; rows = ROWS; isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    const s = String(chunk)
    outBytes += s.length
    term.write(s, cb)
  }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const stdin = new FakeStdin(), stdout = new FakeStdout(), stderr = new FakeStderr()

// 800 轮：每轮 user + 2 工具行 + assistant(4 行) ≈ 3 行/轮 → 2400 行。
// 全部在 300 行折叠窗口之上 → timeline 走全量 rows 循环。
const rows: any[] = []
let id = 0
for (let turn = 1; turn <= 800; turn++) {
  rows.push({ id: ++id, kind: 'user', text: `问题 ${turn}` })
  for (let t = 0; t < 2; t++) {
    rows.push({
      id: ++id, kind: 'tool', text: '',
      tool: {
        callId: `t${turn}-${t}`, name: 'Read',
        argsText: `{"file_path": "/tmp/f${t}.ts"}`, argsFull: '{}',
        status: 'ok', startedAt: 0, durationMs: 30,
        resultText: `内容行 1\n内容行 2`,
      },
    })
  }
  rows.push({ id: ++id, kind: 'assistant', text: Array.from({ length: 4 }, (_, i) => `回复 ${turn} 第 ${i + 1} 行`).join('\n') })
}
console.log(`fixture: ${rows.length} 行, 800 轮 user`)

const listeners = new Set<() => void>()
const channel: any = {
  // 探针确定性：鲸鱼欢迎期闲置动画（默认开）不进本探针的测量窗口。
  whaleIdle: false,
  version: 0, rows, status: 'idle', sessionTitle: 'probe', agentId: 'probe',
  model: 'deepseek-v4-flash', provider: 'deepseek', reasoningEffort: 'max', effortLevels: [],
  tokens: { input: 0, output: 0 }, cwd: '/tmp/demo', displayCwd: '/tmp/demo', gitBranch: 'main',
  working: false, spinnerMode: 'requesting', responseChars: 0, activeToolCount: 0, turnStart: 0,
  pending: [], commandList: LOCAL_COMMANDS, notifications: [], mode: { plan: false, sandbox: undefined },
  activityFrames: 'claude', agentPreset: undefined, subagents: [], lastUserText: '问题 800',
  scrollGutter: 'timeline',
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => Promise.resolve([]),
  deleteSession: () => Promise.resolve(true), renameSessionTo: () => Promise.resolve(true),
  setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [], pushLocal: () => {},
  commandCompletions: (input: string) => completeCommands(input),
}

const frames: Array<{ ms: number; yoga: number; commit: number; renderer: number }> = []
const inst = await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} fullscreen />
  </AlternateScreen>,
  {
    stdout: stdout as any, stdin: stdin as any, stderr: stderr as any,
    exitOnCtrlC: false, patchConsole: false,
    onFrame: (f: any) => {
      frames.push({ ms: f.durationMs, yoga: f.phases.yoga ?? 0, commit: f.phases.commit ?? 0, renderer: f.phases.renderer ?? 0 })
    },
  },
)
await sleep(1500)
frames.length = 0
outBytes = 0

// 滚轮突发：3 轮 × 30 事件
for (let r = 0; r < 3; r++) {
  for (let i = 0; i < 30; i++) {
    stdin.write('\x1b[<64;90;30M')
    await sleep(8)
  }
  await sleep(200)
}
await sleep(400)

const pct = (arr: number[], p: number) => {
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0
}
const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0)
const ms = frames.map(f => f.ms)
console.log('==== perf-long-session (800 轮 / 2400 行) ====')
console.log(`frames=${frames.length}  p50=${pct(ms, 50).toFixed(1)}ms  p95=${pct(ms, 95).toFixed(1)}ms  max=${Math.max(...ms).toFixed(1)}ms`)
console.log(`yoga 总=${sum(frames.map(f => f.yoga)).toFixed(0)}ms max=${Math.max(...frames.map(f => f.yoga)).toFixed(1)}ms`)
console.log(`commit 总=${sum(frames.map(f => f.commit)).toFixed(0)}ms max=${Math.max(...frames.map(f => f.commit)).toFixed(1)}ms`)
console.log(`renderer 总=${sum(frames.map(f => f.renderer)).toFixed(0)}ms max=${Math.max(...frames.map(f => f.renderer)).toFixed(1)}ms`)
console.log(`输出 ${(outBytes / 1024).toFixed(1)}KB`)
const heap = process.memoryUsage()
console.log(`heap used=${(heap.heapUsed / 1048576).toFixed(0)}MB rss=${(heap.rss / 1048576).toFixed(0)}MB`)

await inst.unmount()
process.exit(0)
