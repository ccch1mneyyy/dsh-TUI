/**
 * beta.3 #185 repro — smoothReveal driver (fourth loop path after #662/#669).
 *
 * Difference from repro-185.tsx: the channel mock sets `smoothStreaming: true`,
 * so MessageList subscribes to the reveal store via useSyncExternalStore. Every
 * advancing 33ms reveal tick then forces a SYNCLANE store rerender
 * (forceStoreRerender hardcodes SyncLane), which preempts/discards the
 * in-flight DefaultLane streaming render; each sync commit ends with Default
 * work pending → the commit-end lane test counts a nested update with no
 * reset → 50 consecutive dirty commits → the next scheduleUpdateOnFiber on
 * the root throws minified #185 from whichever timer happens to fire
 * (ClockContext tick, thinking-spinner setFrame, …) → uncaught → process exit.
 *
 * Run for the real crash (minified #185, exit 1):
 *   NODE_ENV=production node --import tsx/esm scripts/repro-185-reveal.tsx
 * Run instrumented (dev reconciler logs [NESTED++] / [NESTED-THROW]):
 *   node scripts/instr-nested-updates.mjs   # once, patches node_modules dev build
 *   NODE_ENV=development node --import tsx/esm scripts/repro-185-reveal.tsx
 * Expected pre-fix: crash within a few seconds of streaming start.
 * Expected post-fix: runs to completion, exit 0.
 *
 * Env: SMOOTH=0 — control run with the reveal store disabled (same feed);
 *      FEEDERS="4,7,11,17" — feeder timer cadences (the tuning knob);
 *      COLS (default 110).
 */
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'WezTerm'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, reveal] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/components/smoothReveal.js'),
])

const COLS = Number(process.env.COLS ?? 110)
const ROWS = 32
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true })

const rawChunks: string[] = []
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { rawChunks.push(String(chunk)); term.write(String(chunk), cb) }
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
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Initialized BEFORE the crash handlers so finish() can never hit a TDZ
// ReferenceError that would mask the original crash (review P2).
const startedAt = Date.now()
/** Set when the streaming loop starts; 0 = never reached it. */
let streamStartedAt = 0
let crashed: unknown = null
function onCrash(err: unknown): void {
  crashed = err
  console.error('\n!!!! PROCESS CRASH !!!!')
  console.error(err)
  finish(1)
}
process.on('uncaughtException', onCrash)
process.on('unhandledRejection', onCrash)

const listeners = new Set<() => void>()
let subCount = 0
let versionReads = 0
let _version = 0
const channel: any = {
  get version() { versionReads++; return _version },
  set version(v: number) { _version = v },
  rows: [] as any[],
  status: 'idle',
  sessionTitle: 'repro-185-reveal',
  agentId: 'repro-185-reveal',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'max',
  mode: { plan: false },
  modeIndex: 0,
  displayCwd: '/tmp/demo',
  contextBarEnabled: false,
  contextSegments: undefined,
  contextWindow: undefined,
  lastUsage: undefined,
  tps: undefined,
  tpsSamples: [],
  workingActivity: undefined,
  activityFrames: undefined,
  commandCompletions: [],
  tokens: { input: 120, output: 45 },
  cwd: '/tmp/demo',
  gitBranch: 'main',
  working: true,
  spinnerMode: 'requesting',
  responseChars: 0,
  activeToolCount: 1,
  turnStart: Date.now(),
  lastUserText: '长会话流式压测',
  pending: [],
  commandList: [],
  notifications: [],
  // >>> the beta.3 driver: MessageList subscribes to the reveal store <<<
  // SMOOTH=0 runs the identical scenario with the reveal store off (control
  // group: if only the SMOOTH=1 run crashes, the reveal wakeup is the driver).
  smoothStreaming: process.env.SMOOTH !== '0',
  subscribe(cb: () => void) { subCount++; listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {},
  cancel: () => {},
  clear: () => {},
  notify: () => {},
  listModels: () => Promise.resolve([]),
  listSessions: () => [],
  setResumeTarget: () => {},
  loadOlder: () => {},
  mcpStatus: () => [],
}
const bump = () => { channel.version++; for (const cb of listeners) cb() }

// Reveal-store probe: count advancing ticks (each one forces a SyncLane
// store rerender pre-fix).
let revealTicks = 0
reveal.subscribeReveal(() => { revealTicks++ })

let id = 0
const codeBlock = (n: number, lang: string) =>
  '```' + lang + '\n' + Array.from({ length: n }, (_, i) =>
    `const handleRequest${i} = async (req: Request, res: Response): Promise<void> => { // 第 ${i} 行，故意写得很长，让窄终端里一定折行，从而撑高测量高度`
  ).join('\n') + '\n```'

// --- long session: 10 turns, mixed tool cards + markdown --------------------
for (let turn = 0; turn < 10; turn++) {
  channel.rows.push({ id: id++, kind: 'user', text: `历史问题 ${turn}：分析一下模块 ${turn} 的实现` })
  channel.rows.push({ id: id++, kind: 'reasoning', text: `用户在问模块 ${turn}。`.repeat(4), streaming: false, durationMs: 1500 })
  for (let t = 0; t < 3; t++) {
    channel.rows.push({
      id: id++, kind: 'tool', text: '',
      tool: {
        callId: `h${turn}-${t}`, name: t % 2 ? 'Read' : 'Bash',
        argsText: t % 2 ? `{"file_path": "/tmp/demo/src/mod${turn}/file${t}.ts"}` : `{"command": "rg -n 'export' src/mod${turn} | head -40", "description": "list exports"}`,
        argsFull: '{}',
        status: 'ok', startedAt: Date.now() - 600000, durationMs: 30,
        resultText: Array.from({ length: 12 + ((turn + t) % 5) * 6 }, (_, i) => `export function helper_${turn}_${t}_${i}(input: unknown): Promise<Result<unknown>> { /* 历史结果行 ${i}，长度凑一凑 */ return null }`).join('\n'),
      },
    })
  }
  channel.rows.push({
    id: id++, kind: 'assistant', streaming: false,
    text: `模块 ${turn} 的结论：\n\n- 入口在 \`src/mod${turn}/index.ts\`\n- 关键逻辑如下：\n\n${codeBlock(18 + (turn % 4) * 8, 'ts')}\n\n| 项 | 值 |\n| --- | --- |\n| 行数 | ${300 + turn * 17} |\n| 复杂度 | 高 |\n`,
  })
}

const stdin = new FakeStdin()
const stdout = new FakeStdout()

class Trap extends React.Component<{ children: React.ReactNode }, { err: unknown }> {
  override state = { err: null as unknown }
  static getDerivedStateFromError(err: unknown): { err: unknown } { return { err } }
  override componentDidCatch(err: unknown, info: unknown): void {
    // A boundary-caught error (e.g. #185 thrown inside a commit) never reaches
    // uncaughtException — record it as a crash so the run cannot false-pass.
    crashed = err
    console.error('TRAPPED RENDER ERROR:', err)
    console.error('component stack:', (info as { componentStack?: string })?.componentStack)
    finish(1)
  }
  override render(): React.ReactNode { return this.state.err ? null : this.props.children }
}

const chatTree = (
  <Trap>
    <Chat channel={channel} questionStore={new QuestionStore()} onExit={() => {}} />
  </Trap>
)
await render(
  <AlternateScreen>
    {chatTree}
  </AlternateScreen>,
  { stdout, stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
)

// status metrics ticking ~10/s (channel bumps without row changes)
const ticker = setInterval(() => { channel.responseChars += 7; bump() }, 100)
// second independent bump source (spinner cadence) to crowd the event loop
const ticker2 = setInterval(() => { bump() }, 47)

await sleep(800)

// --- live turn: long streamed markdown+code, fast cadence -------------------
channel.rows.push({ id: id++, kind: 'user', text: '把 AAA 项目的核心模块完整讲一遍，带上代码' }); bump()
await sleep(150)

const think = { id: id++, kind: 'reasoning', text: '', streaming: true, durationMs: undefined as number | undefined }
channel.rows.push(think); bump()
for (const c of ['用户要完整讲解，', '需要覆盖架构、', '关键代码与数据流。']) { think.text += c; bump(); await sleep(120) }
think.streaming = false; think.durationMs = 900; bump()

const finalMsg = { id: id++, kind: 'assistant', text: '', streaming: true }
channel.rows.push(finalMsg); bump()

// Build the streamed doc: prose + fenced code with long wrapping lines + tables.
// DOC_SECTIONS is the second tuning knob: the per-commit render cost grows
// with the streamed row's markdown length, so a longer doc means slower
// late-stream renders — slow enough that a mid-render timer dispatch (clock,
// measure deferral) is guaranteed, making EVERY commit end dirty regardless
// of the reveal store. Keep it short enough that the SMOOTH=0 control
// finishes before renders cross that threshold; the reveal store's 30fps
// forced SyncLane commits climb the counter from the very first seconds.
const sections = Number(process.env.DOC_SECTIONS ?? 24)
const docChunks: string[] = ['好，完整梳理一遍 AAA 项目的核心模块。\n\n']
for (let s = 0; s < sections; s++) {
  docChunks.push(`\n## ${s + 1}. 子系统 ${s + 1}：职责与入口\n\n`)
  docChunks.push(`子系统 ${s + 1} 负责请求生命周期第 ${s + 1} 阶段的编排。`.repeat(2) + '\n\n')
  for (const ln of codeBlock(10 + (s % 3) * 6, 'ts').split('\n')) docChunks.push(ln + '\n')
  docChunks.push('\n| 指标 | 数值 | 说明 |\n| --- | --- | --- |\n')
  for (let r = 0; r < 5; r++) docChunks.push(`| 指标${s}-${r} | ${(s + 1) * (r + 2) * 137} | 这是一行表格说明文字，用来占宽 |\n`)
  docChunks.push('\n')
}

// Feed the doc through several INDEPENDENT timers at staggered cadences — a
// fast SSE burst, not a render-paced loop. A serial `bump(); await sleep()`
// loop alternates with renders (each chunk gets consumed by its own render,
// commits end clean, the nested counter keeps resetting); independent timers
// fire during in-flight renders, so updates land mid-render and the commit
// ends with DefaultLane residue. Cadence is the tuning knob: slow enough that
// WITHOUT the reveal store (SMOOTH=0) plain Default renders frequently end
// clean (control survives), fast enough that the reveal tick's forced SyncLane
// render — every 33ms, preempting/discarding in-flight Default work — keeps
// ending dirty (SMOOTH=1 counter climbs to 50).
const feederMs = (process.env.FEEDERS ?? '4,7,11,17').split(',').map(Number)
streamStartedAt = Date.now()
let ci = 0
const feeders = feederMs.map(ms =>
  setInterval(() => {
    if (ci >= docChunks.length) return
    finalMsg.text += docChunks[ci++]!
    bump()
  }, ms),
)
await new Promise<void>(resolve => {
  const check = setInterval(() => {
    if (ci >= docChunks.length) { clearInterval(check); resolve() }
  }, 100)
})
for (const f of feeders) clearInterval(f)
finalMsg.streaming = false
channel.working = false
bump()
await sleep(3000)
clearInterval(ticker)
clearInterval(ticker2)
await sleep(300)

finish(0)

function finish(code: number): void {
  const allRaw = rawChunks.join('')
  const hit185 = /Maximum update depth|Minified React error #185/.test(allRaw)
  console.log('\n==== repro-185-reveal summary ====')
  console.log('chunks:', rawChunks.length, ' elapsed:', Date.now() - startedAt, 'ms stream:', streamStartedAt ? `${Date.now() - streamStartedAt}ms` : 'n/a')
  console.log('crashed:', crashed ? String(crashed).slice(0, 300) : false)
  console.log('error #185 text in output:', hit185)
  console.log('max nested count seen:', (globalThis as any).__maxNested ?? 0, '(dev patch only; crashes at 51)')
  console.log('reveal advancing ticks:', revealTicks, ' version:', reveal.getRevealVersion(), ' timer running:', reveal.isRevealTimerRunning())
  // lanes profile from the dev-reconciler patch: does the SyncLane bit (the
  // reveal store's forced rerender) carry the dirty commits?
  const laneLog = ((globalThis as any).__lanes ?? []) as string[]
  if (laneLog.length > 0) {
    const dirty = laneLog.filter(s => (Number(s.split(':')[1]) & 42) !== 0)
    const dirtySync = dirty.filter(s => (Number(s.split(':')[0]) & 2) !== 0)
    console.log(`lanes profile: ${laneLog.length} commits, dirty ${dirty.length}, dirty-with-SyncLane ${dirtySync.length}`)
  }
  // residue sources: who dispatched updates into in-flight work
  const residue = (globalThis as any).__residue as Map<string, { count: number; stack: string }> | undefined
  if (residue && residue.size > 0) {
    const top = [...residue.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 8)
    console.log('residue dispatchers (phase:component:lane @site):')
    for (const [k, v] of top) console.log(`  ${k} x${v.count}`)
  }
  console.log('channel subscribes:', subCount, ' version getter reads:', versionReads, ' version:', _version)
  process.exit(crashed || hit185 ? 1 : code)
}
