/**
 * perf-real-open — 贴近用户报告的形态：「打开长会话，还没流式输出，
 * 连滚动都卡」。
 *
 * 与 perf-open-heavy 的差别：
 *  1. 行内容是真实尺寸 —— thinking ~2KB、tool result ~4KB、assistant
 *     ~1.5KB markdown（现有 bench 全是十几行小内容，滚入成本被低估）；
 *  2. INLINE（主屏）模式 —— 本基准显式以 inline 挂载（组件默认 false），
 *     historyPaintEnabled 生效，打开时折叠窗口 300 行全挂载；现有 bench
 *     全传 fullscreen。（注：应用出厂配置已默认 fullscreen；这里测的是
 *     inline 形态本身的成本。）
 *
 * 输出：打开阶段（render→静息）总时长 / 帧数 / 帧耗时 / 输出字节，
 * 以及打开后第一批滚轮事件的帧滞后（交互延迟体感来源）。
 *
 * 运行：node --import tsx/esm scripts/perf-real-open.tsx
 * Env：INLINE=0 强制 fullscreen 对照组
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
const INLINE = process.env.INLINE !== '0'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
let outBytes = 0
let frameBytes = 0
const byteHist: number[] = []
class FakeStdout extends Writable {
  columns = COLS; rows = ROWS; isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    const s = String(chunk)
    outBytes += s.length; frameBytes += s.length
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

// 真实尺寸行：每轮 = user + thinking(2KB) + 2×tool(result 4KB) + assistant(1.5KB md)
const mdPara = (n: number) => `#### 第 ${n} 段\n\n这是正文段落，包含 **加粗**、\`code\` 与列表：\n\n- 要点一：解析输入并构建 AST\n- 要点二：遍历节点做常量折叠\n- 要点三：回写 source map\n\n\`\`\`ts\nexport function fold${n}(node: Node): Node {\n  if (node.kind === 'num') return node\n  const lhs = fold${n}(node.lhs)\n  const rhs = fold${n}(node.rhs)\n  if (lhs.kind === 'num' && rhs.kind === 'num') return { kind: 'num', value: lhs.value + rhs.value, span: node.span }\n  return { ...node, lhs, rhs }\n}\n\`\`\`\n\n结论：该模块可以安全内联。`
const rows: any[] = []
let id = 0
for (let turn = 1; turn <= 160; turn++) {
  rows.push({ id: ++id, kind: 'user', text: `帮我实现第 ${turn} 号模块的解析器，要求覆盖边界情况并给出测试。` })
  rows.push({ id: ++id, kind: 'reasoning', text: `思考过程 ${turn}：`.padEnd(2048, '先分析输入的结构，再决定遍历顺序；对每个节点检查类型约束；边界包括空输入、深层嵌套与循环引用。') })
  for (let t = 0; t < 2; t++) {
    rows.push({
      id: ++id, kind: 'tool', text: '',
      tool: {
        callId: `t${turn}-${t}`, name: t ? 'Bash' : 'Read',
        argsText: t ? '{"command": "node --check mod.js && node --test"}' : `{"file_path": "/src/mod${turn}.ts"}`,
        argsFull: '{}', status: 'ok', startedAt: 0, durationMs: 30,
        resultText: Array.from({ length: 48 }, (_, i) => `  line ${i}: checking module ${turn}-${t} … ok  depth=${i} tokens=${i * 37}`).join('\n'),
      },
    })
  }
  rows.push({ id: ++id, kind: 'assistant', text: mdPara(turn) + '\n\n' + mdPara(turn + 1000) })
}
console.log(`fixture: ${rows.length} 行（thinking 2KB / tool result 4KB / assistant md 3KB）  mode=${INLINE ? 'INLINE(主屏)' : 'FULLSCREEN'}`)

const listeners = new Set<() => void>()
const channel: any = {
  version: 0, rows, status: 'idle', sessionTitle: 'probe', agentId: 'probe',
  model: 'deepseek-v4-flash', provider: 'deepseek', reasoningEffort: 'max', effortLevels: [],
  tokens: { input: 0, output: 0 }, cwd: '/tmp/demo', displayCwd: '/tmp/demo', gitBranch: 'main',
  working: false, spinnerMode: 'requesting', responseChars: 0, activeToolCount: 0, turnStart: 0,
  pending: [], commandList: LOCAL_COMMANDS, notifications: [], mode: { plan: false, sandbox: undefined },
  activityFrames: 'claude', agentPreset: undefined, subagents: [], lastUserText: '问题 160',
  scrollGutter: 'timeline', whale: true,
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => Promise.resolve([]),
  deleteSession: () => Promise.resolve(true), renameSessionTo: () => Promise.resolve(true),
  setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [], pushLocal: () => {},
  commandCompletions: (input: string) => completeCommands(input),
}

// ── 阶段 A：打开（render → 静息）──
const frames: Array<{ ms: number; at: number; commit: number; yoga: number }> = []
const t0 = performance.now()
const tree = <Chat channel={channel} questionStore={new QuestionStore()} fullscreen={!INLINE} />
const inst = await render(INLINE ? tree : <AlternateScreen>{tree}</AlternateScreen>, {
  stdout: stdout as any, stdin: stdin as any, stderr: stderr as any,
  exitOnCtrlC: false, patchConsole: false,
  onFrame: (f: any) => {
    frames.push({ ms: f.durationMs, at: performance.now() - t0, commit: f.phases.commit ?? 0, yoga: f.phases.yoga ?? 0 })
    byteHist.push(frameBytes); frameBytes = 0
  },
})
let lastCount = -1, settledRounds = 0, openMs = 0
while (settledRounds < 5) {
  await sleep(100)
  if (frames.length === lastCount) settledRounds++
  else { settledRounds = 0; lastCount = frames.length }
  openMs = performance.now() - t0
  if (openMs > 60000) break
}
const sum = (a: number[], f: (x: any) => number) => a.reduce((s, x) => s + f(x), 0)
const pct = (arr: number[], p: number) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0 }
console.log(`==== 打开阶段 ====`)
console.log(`render→静息: ${openMs.toFixed(0)}ms  帧数=${frames.length}  帧耗时总和=${sum(frames, f => f.ms).toFixed(0)}ms  最长单帧=${Math.max(...frames.map(f => f.ms)).toFixed(1)}ms`)
console.log(`  commit 总=${sum(frames, f => f.commit).toFixed(0)}ms  yoga 总=${sum(frames, f => f.yoga).toFixed(0)}ms  输出=${(outBytes / 1024).toFixed(0)}KB`)
console.log(`  打开后 1s/2s/3s 内帧数: ${frames.filter(f => f.at < 1000).length} / ${frames.filter(f => f.at < 2000).length} / ${frames.filter(f => f.at < 3000).length}`)

// ── 阶段 B：滚轮（fullscreen 才有应用侧滚动；主屏滚动是终端原生的）──
if (!INLINE) {
  frames.length = 0; byteHist.length = 0
  const wheelTimes: number[] = []
  for (let r = 0; r < 3; r++) {
    for (let i = 0; i < 30; i++) {
      stdin.write('\x1b[<64;90;30M')
      wheelTimes.push(performance.now())
      await sleep(8)
    }
    await sleep(200)
  }
  await sleep(400)
  const ms = frames.map(f => f.ms)
  console.log(`==== 滚动阶段（大内容行滚入 = markdown+highlight）====`)
  console.log(`frames=${frames.length}  p50=${pct(ms, 50).toFixed(1)}ms  p95=${pct(ms, 95).toFixed(1)}ms  max=${Math.max(...ms).toFixed(1)}ms`)
  console.log(`  commit 总=${sum(frames, f => f.commit).toFixed(0)}ms max=${Math.max(...frames.map(f => f.commit)).toFixed(1)}ms`)
  console.log(`  yoga 总=${sum(frames, f => f.yoga).toFixed(0)}ms max=${Math.max(...frames.map(f => f.yoga)).toFixed(1)}ms`)
  console.log(`  输出=${(outBytes / 1024).toFixed(1)}KB  每帧字节 p50=${pct(byteHist, 50)} p95=${pct(byteHist, 95)} max=${Math.max(...byteHist, 0)}`)

  // ── 阶段 C：滚回底部再滚上 —— 行二次挂载，验证 wrap 跨挂载缓存命中 ──
  frames.length = 0; byteHist.length = 0
  for (let i = 0; i < 80; i++) {
    stdin.write('\x1b[<65;90;30M')
    await sleep(8)
  }
  await sleep(300)
  for (let i = 0; i < 80; i++) {
    stdin.write('\x1b[<64;90;30M')
    await sleep(8)
  }
  await sleep(400)
  const ms2 = frames.map(f => f.ms)
  console.log(`==== 二次滚动（重挂载行 = LRU 命中验证）====`)
  console.log(`frames=${frames.length}  p50=${pct(ms2, 50).toFixed(1)}ms  p95=${pct(ms2, 95).toFixed(1)}ms  max=${Math.max(...ms2).toFixed(1)}ms`)
  console.log(`  yoga 总=${sum(frames, f => f.yoga).toFixed(0)}ms max=${Math.max(...frames.map(f => f.yoga)).toFixed(1)}ms`)
  // ── 阶段 D：上滚阅读 + 流式输出并发（经典卡顿组合）──
  // 先上滚打破 sticky（视口停在中部历史），再让尾部行以 streaming=true
  // （走 StreamingMarkdown 前缀稳定路径）持续 text += chunk + version++。
  frames.length = 0; byteHist.length = 0
  for (let i = 0; i < 40; i++) {
    stdin.write('\x1b[<64;90;30M')
    await sleep(8)
  }
  await sleep(300)
  frames.length = 0; byteHist.length = 0
  const streamRow = rows[rows.length - 1]!
  streamRow.streaming = true
  const origText = streamRow.text
  const chunk = '流式增量段落：继续分析模块边界与常量折叠的正确性，覆盖深层嵌套与循环引用的边界情况。\n\n'
  let streamed = 0
  const streamStart = performance.now()
  while (performance.now() - streamStart < 3000) {
    streamRow.text = origText + chunk.repeat(++streamed)
    channel.version++ // useSyncExternalStore 的快照就是 version
    listeners.forEach(l => l())
    await sleep(33)
  }
  streamRow.streaming = undefined
  await sleep(400)
  const msD = frames.map(f => f.ms)
  console.log(`==== 上滚阅读 + 流式并发 ====`)
  console.log(`frames=${frames.length}  p50=${pct(msD, 50).toFixed(1)}ms  p95=${pct(msD, 95).toFixed(1)}ms  max=${Math.max(...msD).toFixed(1)}ms`)
  console.log(`  commit 总=${sum(frames, f => f.commit).toFixed(0)}ms max=${Math.max(...frames.map(f => f.commit)).toFixed(1)}ms`)
  console.log(`  yoga 总=${sum(frames, f => f.yoga).toFixed(0)}ms max=${Math.max(...frames.map(f => f.yoga)).toFixed(1)}ms`)
  const heap = process.memoryUsage()
  console.log(`heap used=${(heap.heapUsed / 1048576).toFixed(0)}MB rss=${(heap.rss / 1048576).toFixed(0)}MB`)
}

await inst.unmount()
process.exit(0)
