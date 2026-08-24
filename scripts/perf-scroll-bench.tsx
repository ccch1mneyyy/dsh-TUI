/**
 * perf-scroll-bench — 全屏转录滚动性能基准（headless）。
 *
 * 重会话（120 轮，含长 prompt 行）× 滚轮突发 + rail 悬停，通过 onFrame
 * 钩子采样每帧 durationMs 与各阶段（renderer/diff/write/yoga/commit），
 * 输出 p50/p95/max 与阶段总量，用于优化前后对比。
 *
 * 运行：node --import tsx/esm scripts/perf-scroll-bench.tsx
 * Env：BENCH_ROUNDS（默认 3）
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
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 3)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
let outBytes = 0
let outWrites = 0
const byteHist: number[] = []
let frameBytes = 0
class FakeStdout extends Writable {
  columns = COLS; rows = ROWS; isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    const s = String(chunk)
    outBytes += s.length; outWrites++; frameBytes += s.length
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

// 120 轮：1/6 的 prompt 是 240 字长行（模拟粘贴），其余短问题；回复 6~12 行。
const rows: any[] = []
for (let turn = 1; turn <= 120; turn++) {
  const long = turn % 6 === 0
  rows.push({
    id: turn * 2 - 1,
    kind: 'user',
    text: long ? `长问题 ${turn} ` + '粘贴内容样板文字。'.repeat(30) : `问题 ${turn}`,
  })
  rows.push({
    id: turn * 2,
    kind: 'assistant',
    text: Array.from({ length: 6 + (turn % 7) }, (_, i) => `回复 ${turn} 第 ${i + 1} 行`).join('\n'),
  })
}

const listeners = new Set<() => void>()
const channel: any = {
  version: 0, rows, status: 'idle', sessionTitle: 'probe', agentId: 'probe',
  model: 'deepseek-v4-flash', provider: 'deepseek', reasoningEffort: 'max', effortLevels: [],
  tokens: { input: 0, output: 0 }, cwd: '/tmp/demo', displayCwd: '/tmp/demo', gitBranch: 'main',
  working: false, spinnerMode: 'requesting', responseChars: 0, activeToolCount: 0, turnStart: 0,
  pending: [], commandList: LOCAL_COMMANDS, notifications: [], mode: { plan: false, sandbox: undefined },
  activityFrames: 'claude', agentPreset: undefined, subagents: [], lastUserText: '问题 120',
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => Promise.resolve([]),
  deleteSession: () => Promise.resolve(true), renameSessionTo: () => Promise.resolve(true),
  setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [], pushLocal: () => {},
  commandCompletions: (input: string) => completeCommands(input),
}

// 帧采样
const frames: Array<{ ms: number; yoga: number; commit: number; renderer: number; write: number; patches: number }> = []
const inst = await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} fullscreen />
  </AlternateScreen>,
  {
    stdout: stdout as any, stdin: stdin as any, stderr: stderr as any,
    exitOnCtrlC: false, patchConsole: false,
    onFrame: (f: any) => {
      frames.push({
        ms: f.durationMs,
        yoga: f.phases.yoga ?? 0,
        commit: f.phases.commit ?? 0,
        renderer: f.phases.renderer ?? 0,
        write: f.phases.write ?? 0,
        patches: f.patches ?? 0,
      })
      byteHist.push(frameBytes)
      frameBytes = 0
    },
  },
)
await sleep(700)
frames.length = 0 // 丢弃启动帧

// 滚轮突发：每轮 40 个 wheel-up（8ms 间隔，模拟高速滚轮），间歇 120ms
for (let r = 0; r < ROUNDS; r++) {
  for (let i = 0; i < 40; i++) {
    stdin.write('\x1b[<64;90;30M')
    await sleep(8)
  }
  await sleep(150)
}
// rail 悬停扫动：40 个 motion 事件沿右缘上下扫
for (let i = 0; i < 40; i++) {
  stdin.write(`\x1b[<35;100;${10 + (i % 20)}M`)
  await sleep(16)
}
// 滚回底部
for (let i = 0; i < 60; i++) {
  stdin.write('\x1b[<65;90;30M')
  await sleep(8)
}
await sleep(400)

// ── 统计 ──
const pct = (arr: number[], p: number) => {
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0
}
const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0)
const ms = frames.map(f => f.ms)
const over33 = ms.filter(m => m > 33.4).length
const over66 = ms.filter(m => m > 66.7).length
console.log('==== perf-scroll-bench ====')
console.log(`frames=${frames.length}  p50=${pct(ms, 50).toFixed(1)}ms  p95=${pct(ms, 95).toFixed(1)}ms  max=${Math.max(...ms).toFixed(1)}ms  >33ms=${over33}  >66ms=${over66}`)
console.log(`yoga 总=${sum(frames.map(f => f.yoga)).toFixed(0)}ms  commit 总=${sum(frames.map(f => f.commit)).toFixed(0)}ms  renderer 总=${sum(frames.map(f => f.renderer)).toFixed(0)}ms  write 总=${sum(frames.map(f => f.write)).toFixed(0)}ms`)
console.log(`yoga max=${Math.max(...frames.map(f => f.yoga)).toFixed(1)}ms  commit max=${Math.max(...frames.map(f => f.commit)).toFixed(1)}ms  renderer max=${Math.max(...frames.map(f => f.renderer)).toFixed(1)}ms`)
console.log(`patches 平均=${(sum(frames.map(f => f.patches)) / frames.length).toFixed(0)}`)
console.log(`输出字节 总=${(outBytes / 1024).toFixed(1)}KB  write调用=${outWrites}  每帧字节 p50=${pct(byteHist, 50)} p95=${pct(byteHist, 95)} max=${Math.max(...byteHist, 0)}`)

await inst.unmount()
process.exit(0)
