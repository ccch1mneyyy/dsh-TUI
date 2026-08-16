/**
 * #185 repro probe: 长会话 + 长流式 + 复杂内容, watching for the nested-update
 * counter (React error #185) on the POST-#146 code (queueMicrotask measure).
 *
 * Run instrumented (dev reconciler logs [NESTED++] / [IN-COMMIT-SETSTATE]):
 *   NODE_ENV=development ./node_modules/.bin/tsx scripts/repro-185.tsx
 * Run for the real crash (minified #185):
 *   NODE_ENV=production  ./node_modules/.bin/tsx scripts/repro-185.tsx
 *
 * VARIANT env: base | resize | remount | scroll
 */
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'WezTerm'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
])

const VARIANT = process.env.VARIANT ?? 'base'
const CHUNK_MS = Number(process.env.CHUNK_MS ?? 25)
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
  sessionTitle: 'repro-185',
  agentId: 'repro-185',
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
const instance = await render(
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

// --- live turn: long streamed markdown+code at ~25ms/chunk -------------------
channel.rows.push({ id: id++, kind: 'user', text: '把 AAA 项目的核心模块完整讲一遍，带上代码' }); bump()
await sleep(150)

const think = { id: id++, kind: 'reasoning', text: '', streaming: true, durationMs: undefined as number | undefined }
channel.rows.push(think); bump()
for (const c of ['用户要完整讲解，', '需要覆盖架构、', '关键代码与数据流。']) { think.text += c; bump(); await sleep(120) }
think.streaming = false; think.durationMs = 900; bump()

const finalMsg = { id: id++, kind: 'assistant', text: '', streaming: true }
channel.rows.push(finalMsg); bump()

// Build a big streamed doc: prose + fenced code with long wrapping lines + tables.
const docChunks: string[] = ['好，完整梳理一遍 AAA 项目的核心模块。\n\n']
for (let s = 0; s < 8; s++) {
  docChunks.push(`\n## ${s + 1}. 子系统 ${s + 1}：职责与入口\n\n`)
  docChunks.push(`子系统 ${s + 1} 负责请求生命周期第 ${s + 1} 阶段的编排。`.repeat(2) + '\n\n')
  for (const ln of codeBlock(10 + (s % 3) * 6, 'ts').split('\n')) docChunks.push(ln + '\n')
  docChunks.push('\n| 指标 | 数值 | 说明 |\n| --- | --- | --- |\n')
  for (let r = 0; r < 5; r++) docChunks.push(`| 指标${s}-${r} | ${(s + 1) * (r + 2) * 137} | 这是一行表格说明文字，用来占宽 |\n`)
  docChunks.push('\n')
}

streamStartedAt = Date.now()
let midFired = false
for (let i = 0; i < docChunks.length; i++) {
  finalMsg.text += docChunks[i]!
  bump()

  if (!midFired && i === Math.floor(docChunks.length / 2)) {
    midFired = true
    if (VARIANT === 'resize') {
      stdout.columns = 78
      stdout.emit('resize')
      console.error('[variant] resized columns -> 78 mid-stream')
    } else if (VARIANT === 'remount') {
      console.error('[variant] remounting tree mid-stream (easter-egg style)')
      instance.rerender(<AlternateScreen><></></AlternateScreen>)
      await sleep(1200)
      instance.rerender(<AlternateScreen>{chatTree}</AlternateScreen>)
      console.error('[variant] tree restored')
    } else if (VARIANT === 'scroll') {
      console.error('[variant] wheel-up x6 mid-stream (break sticky)')
      for (let w = 0; w < 6; w++) { stdin.write('\x1b[<65;60;10M'); await sleep(30) }
    }
  }
  await sleep(CHUNK_MS)
}
finalMsg.streaming = false
channel.working = false
bump()
await sleep(1500)
clearInterval(ticker)
clearInterval(ticker2)
await sleep(300)

finish(0)

function finish(code: number): void {
  const allRaw = rawChunks.join('')
  const hit185 = /Maximum update depth|Minified React error #185/.test(allRaw)
  const ics = (globalThis as any).__ics as Map<string, { count: number; stack: string; ctx: number }> | undefined
  console.log('\n==== repro-185 summary ====')
  console.log('variant:', VARIANT, ' chunks:', rawChunks.length, ' elapsed:', Date.now() - startedAt, 'ms stream:', streamStartedAt ? `${Date.now() - streamStartedAt}ms` : 'n/a')
  console.log('crashed:', crashed ? String(crashed).slice(0, 200) : false)
  console.log('error #185 text in output:', hit185)
  console.log('max nested count seen:', (globalThis as any).__maxNested ?? 0)
  console.log('reconciler patch loaded:', Boolean((globalThis as any).__recPatched))
  // nested-count trajectory: longest strictly-increasing runs (consecutive
  // dirty commits on the same root) — the sawtooth peaks that kill at 50.
  const traj = ((globalThis as any).__traj ?? []) as number[]
  let longestRun = 0
  const runs: number[] = []
  {
    let cur = 1
    for (let i = 1; i < traj.length; i++) {
      if (traj[i] === traj[i - 1]! + 1) cur++
      else { if (cur > 1) runs.push(cur); longestRun = Math.max(longestRun, cur); cur = 1 }
    }
    if (cur > 1) { runs.push(cur); longestRun = Math.max(longestRun, cur) }
  }
  runs.sort((a, b) => b - a)
  console.log(`trajectory: ${traj.length} commits, dirty ${traj.filter(v => v > 0).length}, longest consecutive-nested runs: [${runs.slice(0, 8).join(', ')}]`)
  console.log('channel subscribes:', subCount, ' version getter reads:', versionReads, ' version:', _version)
  if (ics && ics.size > 0) {
    console.log('in-render/in-commit setState sources:')
    for (const [name, v] of ics) {
      console.log(`  ${name} x${v.count} ctx=${v.ctx}`)
      console.log('    ' + String(v.stack).split('\n').slice(1, 8).join('\n    '))
    }
  } else {
    console.log('in-render/in-commit setState sources: none')
  }
  process.exit(crashed || hit185 ? 1 : code)
}
