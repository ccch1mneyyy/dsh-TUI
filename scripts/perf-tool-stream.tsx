/**
 * perf-tool-stream — 工具调用流式基准：出工具时每 chunk 的渲染成本。
 *
 * 场景：已有 200 行历史（含代码块），随后流式落 6 个工具调用
 * （running → ok，带 resultText）。模拟真实"出工具"的节奏。
 *
 * 输出：每 chunk 的帧耗时 + 帧数 + 阶段分类（是否每 chunk 全窗口重渲）。
 *
 * 运行：node --import tsx/esm scripts/perf-tool-stream.tsx
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
const stdin = new FakeStdin(), stdout = new FakeStdout(), stderr = new FakeStderr()

// 历史：100 轮 × 2 行 = 200 行（user + assistant 短回复）
const rows: any[] = []
let id = 0
for (let turn = 1; turn <= 100; turn++) {
  rows.push({ id: ++id, kind: 'user', text: `问题 ${turn}` })
  rows.push({ id: ++id, kind: 'assistant', text: `回复 ${turn}：完成。` })
}
const listeners = new Set<() => void>()
const channel: any = {
  version: 0, rows, status: 'idle', sessionTitle: 'probe', agentId: 'probe',
  model: 'deepseek-v4-flash', provider: 'deepseek', reasoningEffort: 'max', effortLevels: [],
  tokens: { input: 0, output: 0 }, cwd: '/tmp/demo', displayCwd: '/tmp/demo', gitBranch: 'main',
  working: false, spinnerMode: 'requesting', responseChars: 0, activeToolCount: 0, turnStart: 0,
  pending: [], commandList: LOCAL_COMMANDS, notifications: [], mode: { plan: false, sandbox: undefined },
  activityFrames: 'claude', agentPreset: undefined, subagents: [], lastUserText: '问题 100',
  scrollGutter: 'timeline',
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => Promise.resolve([]),
  deleteSession: () => Promise.resolve(true), renameSessionTo: () => Promise.resolve(true),
  setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [], pushLocal: () => {},
  commandCompletions: (input: string) => completeCommands(input),
}
const emit = () => { channel.version++; for (const l of listeners) l() }

const frames: Array<{ ms: number; commit: number; yoga: number }> = []
const inst = await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} fullscreen />
  </AlternateScreen>,
  {
    stdout: stdout as any, stdin: stdin as any, stderr: stderr as any,
    exitOnCtrlC: false, patchConsole: false,
    onFrame: (f: any) => frames.push({ ms: f.durationMs, commit: f.phases.commit ?? 0, yoga: f.phases.yoga ?? 0 }),
  },
)
await sleep(1000)
frames.length = 0

// ── 出工具：6 个工具依次 running → ok ──
for (let t = 1; t <= 6; t++) {
  const before = frames.length
  const sumBefore = frames.reduce((a, f) => a + f.ms, 0)
  // running 落地
  rows.push({
    id: ++id, kind: 'tool', text: '',
    tool: {
      callId: `c${t}`, name: t % 2 ? 'Read' : 'Bash',
      argsText: `{"file_path": "/src/file${t}.ts"}`, argsFull: '{}',
      status: 'running', startedAt: Date.now(), durationMs: undefined,
      resultText: undefined,
    },
  })
  emit()
  await sleep(300)
  // 结果落地（同一行 in-place 突变）
  const row = rows[rows.length - 1]
  row.tool.status = 'ok'
  row.tool.durationMs = 120 + t * 30
  row.tool.resultText = `file ${t} line 1\nfile ${t} line 2\nfile ${t} line 3`
  emit()
  await sleep(300)
  const chunkFrames = frames.slice(before)
  const chunkMs = frames.reduce((a, f) => a + f.ms, 0) - sumBefore
  console.log(`工具 ${t}: 帧数=${chunkFrames.length} 帧耗时和=${chunkMs.toFixed(1)}ms max=${chunkFrames.length ? Math.max(...chunkFrames.map(f => f.ms)).toFixed(1) : '-'}ms`)
}

const ms = frames.map(f => f.ms)
console.log(`== 出工具期间: frames=${frames.length} p50=${ms.length ? [...ms].sort((a,b)=>a-b)[Math.floor(ms.length/2)].toFixed(1) : '-'}ms max=${ms.length ? Math.max(...ms).toFixed(1) : '-'}ms`)
console.log(`commit 总=${frames.reduce((a, f) => a + f.commit, 0).toFixed(0)}ms  yoga 总=${frames.reduce((a, f) => a + f.yoga, 0).toFixed(0)}ms`)

await inst.unmount()
process.exit(0)
