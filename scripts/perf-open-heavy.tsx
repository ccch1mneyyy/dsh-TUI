/**
 * perf-open-heavy — 长会话「打开 + 滚动」真实形态基准。
 *
 * 与 perf-long-session 的差别：行内容是 markdown 代码块（走 lexer +
 * 语法高亮路径，绕开 looksLikePlainText 快路），并单独计量「打开」
 * 阶段（render() 到静息）的帧数/耗时——用户报「打开长会话就卡」。
 *
 * 运行：node --import tsx/esm scripts/perf-open-heavy.tsx
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

// 240 轮 × (user + 2 工具 + assistant 代码块回复) ≈ 3 行/轮 → 720 行，
// 代码块每个 ~18 行 → 打开时折叠窗口 300 行全挂载 + 高亮。
const codeReply = (turn: number) => `实现说明 ${turn}：\n\n\`\`\`ts\n// 模块 ${turn}：解析器 + 高亮路径压力\nexport function parse${turn}(input: string): Ast {\n  const tokens = lexer.scan(input, { mode: 'full', trace: false })\n  if (tokens.length === 0) return { kind: 'empty', span: [0, 0] }\n  const nodes: Node[] = []\n  for (const tok of tokens) {\n    if (tok.type === 'kw') nodes.push(transformKeyword(tok))\n    else if (tok.type === 'str') nodes.push(literal(tok.value, tok.span))\n    else nodes.push(identifier(tok))\n  }\n  return { kind: 'program', body: nodes, span: [0, input.length] }\n}\n\`\`\`\n\n后续按上述结构执行。`
const rows: any[] = []
let id = 0
for (let turn = 1; turn <= 240; turn++) {
  rows.push({ id: ++id, kind: 'user', text: `问题 ${turn}：帮我实现第 ${turn} 号模块的解析器` })
  for (let t = 0; t < 2; t++) {
    rows.push({
      id: ++id, kind: 'tool', text: '',
      tool: {
        callId: `t${turn}-${t}`, name: t ? 'Bash' : 'Read',
        argsText: t ? '{"command": "node --check mod.js"}' : `{"file_path": "/src/mod${turn}.ts"}`,
        argsFull: '{}',
        status: 'ok', startedAt: 0, durationMs: 30,
        resultText: `checking mod${turn}.ts\nno syntax errors\ndone`,
      },
    })
  }
  rows.push({ id: ++id, kind: 'assistant', text: codeReply(turn) })
}
console.log(`fixture: ${rows.length} 行（含 markdown 代码块 + 高亮）`)

const listeners = new Set<() => void>()
const channel: any = {
  version: 0, rows, status: 'idle', sessionTitle: 'probe', agentId: 'probe',
  model: 'deepseek-v4-flash', provider: 'deepseek', reasoningEffort: 'max', effortLevels: [],
  tokens: { input: 0, output: 0 }, cwd: '/tmp/demo', displayCwd: '/tmp/demo', gitBranch: 'main',
  working: false, spinnerMode: 'requesting', responseChars: 0, activeToolCount: 0, turnStart: 0,
  pending: [], commandList: LOCAL_COMMANDS, notifications: [], mode: { plan: false, sandbox: undefined },
  activityFrames: 'claude', agentPreset: undefined, subagents: [], lastUserText: '问题 240',
  scrollGutter: 'timeline',
  whale: process.env.BENCH_WHALE !== '0',
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => Promise.resolve([]),
  deleteSession: () => Promise.resolve(true), renameSessionTo: () => Promise.resolve(true),
  setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [], pushLocal: () => {},
  commandCompletions: (input: string) => completeCommands(input),
}

// ── 阶段 A：打开（render → 静息 500ms 无新帧）──
const frames: Array<{ ms: number; commit: number; yoga: number; at: number }> = []
let openBytes = 0
const t0 = performance.now()
const inst = await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} fullscreen />
  </AlternateScreen>,
  {
    stdout: stdout as any, stdin: stdin as any, stderr: stderr as any,
    exitOnCtrlC: false, patchConsole: false,
    onFrame: (f: any) => {
      frames.push({ ms: f.durationMs, commit: f.phases.commit ?? 0, yoga: f.phases.yoga ?? 0, at: performance.now() - t0 })
    },
  },
)
// 静息探测：每 100ms 查帧数，连续 5 次不增 = 打开完成
let lastCount = -1, settledRounds = 0, openMs = 0
while (settledRounds < 5) {
  await sleep(100)
  if (frames.length === lastCount) settledRounds++
  else { settledRounds = 0; lastCount = frames.length }
  openMs = performance.now() - t0
  if (openMs > 30000) break
}
const openFrames = frames.length
const openTotal = frames.reduce((a, f) => a + f.ms, 0)
const openMax = Math.max(...frames.map(f => f.ms))
console.log(`==== 打开阶段 ====`)
console.log(`render→静息: ${openMs.toFixed(0)}ms  帧数=${openFrames}  帧耗时总和=${openTotal.toFixed(0)}ms  最长单帧=${openMax.toFixed(1)}ms`)
console.log(`帧时刻与间隔: ${frames.map(f => `${f.at.toFixed(0)}ms(+${(f.at - (frames[frames.indexOf(f) - 1]?.at ?? 0)).toFixed(0)})`).join(' ')}`)
console.log(`打开期 commit 总=${frames.reduce((a, f) => a + f.commit, 0).toFixed(0)}ms  yoga 总=${frames.reduce((a, f) => a + f.yoga, 0).toFixed(0)}ms`)

// ── 阶段 B：滚动（代码块行，滚入新行 = lexer + 高亮 + yoga）──
frames.length = 0
outBytes = 0
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
console.log(`==== 滚动阶段（markdown/高亮行）====`)
console.log(`frames=${frames.length}  p50=${pct(ms, 50).toFixed(1)}ms  p95=${pct(ms, 95).toFixed(1)}ms  max=${Math.max(...ms).toFixed(1)}ms`)
console.log(`commit 总=${sum(frames.map(f => f.commit)).toFixed(0)}ms max=${Math.max(...frames.map(f => f.commit)).toFixed(1)}ms`)
console.log(`yoga 总=${sum(frames.map(f => f.yoga)).toFixed(0)}ms max=${Math.max(...frames.map(f => f.yoga)).toFixed(1)}ms`)
console.log(`输出 ${(outBytes / 1024).toFixed(1)}KB`)
const heap = process.memoryUsage()
console.log(`heap used=${(heap.heapUsed / 1048576).toFixed(0)}MB rss=${(heap.rss / 1048576).toFixed(0)}MB`)

await inst.unmount()
process.exit(0)
