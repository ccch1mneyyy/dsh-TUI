/**
 * inline ⇄ fullscreen 热切换 + 全屏内滚动的渲染错位复现。
 *
 * 复现路径（用户报告）：
 *   1. inline 下堆出超过一屏的长对话（sticky 贴底）
 *   2. /tui fullscreen 切全屏
 *   3. 在全屏里滚一下屏（SGR 滚轮）→ stickyScroll=false，scrollTop>0
 *   4. /tui default 切回 inline → inline 展示错位
 *
 * 第 1 步必须是「流式增长」而不是预置数据挂载：冷挂载走全量重绘，
 * LogUpdate 的帧高水位不会累积误差，怎么切都复现不出来。真实会话里每轮
 * 收尾都有一次收缩帧，正是那里把行映射一点点挪偏的。
 *
 * 预言机取终态等价（同 verify-resize-reflow / repro-collapse-shrink 的口径，
 * 无需任何关于 bug 的理论）：切回 inline 并继续流式后的可见屏，必须与
 * 「同一份终态全新挂载 inline」逐行一致；另加屏内自洽（唯一标记至多一份、
 * 顺序符合文档序）与整个 buffer 的唯一性扫描。
 *
 * 运行：node --import tsx/esm scripts/repro-tui-toggle-scroll.tsx
 * 环境变量（均为可选诊断开关）：
 *   TICKS=<n>  全屏内上滚的滚轮格数（默认 6）
 *   TURNS=<n>  inline 阶段流式的轮数（默认 8）
 *   DUMP=1     打印两侧可见屏，用于肉眼比对
 *   TRACE=1    写出逐帧几何取证 JSONL 到 /tmp（DSH_TUI_GEOMETRY_TRACE）
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
process.env.DSH_TUI_THEME = 'dark'
const TRACE_PATH = '/tmp/dsh-toggle-scroll-trace.jsonl'
if (process.env.TRACE === '1') {
  const { rmSync } = await import('node:fs')
  try { rmSync(TRACE_PATH) } catch {}
  process.env.DSH_TUI_GEOMETRY_TRACE = TRACE_PATH
}

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, ThemeProvider, DisplayFrame },
  { Chat },
  { QuestionStore },
  { ApprovalStore },
  { default: instances },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/approvals.js'),
  import('../src/ink/instances.js'),
])

const COLS = 100
const ROWS = 30
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

function makeTerm() {
  return new XTerm({ cols: COLS, rows: ROWS, scrollback: 4000, allowProposedApi: true })
}
function makeStreams(term: InstanceType<typeof XTerm>) {
  class FakeStdout extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
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
  return { stdout: new FakeStdout(), stderr: new FakeStderr(), stdin: new FakeStdin() }
}
/** 可见屏（viewport）文本行。 */
function screenLines(term: InstanceType<typeof XTerm>): string[] {
  const buf = term.buffer.active
  const top = buf.baseY
  const out: string[] = []
  for (let y = 0; y < ROWS; y++) {
    out.push((buf.getLine(top + y)?.translateToString(true) ?? '').replace(/\s+$/, ''))
  }
  return out
}
/** 整个 buffer（scrollback + 视口）。 */
function bufferLines(term: InstanceType<typeof XTerm>): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < buf.length; y++) {
    out.push((buf.getLine(y)?.translateToString(true) ?? '').replace(/\s+$/, ''))
  }
  return out
}

function bindInkToProcessStdout(stdout: { columns: number }): void {
  const ink = instances.get(stdout as never) ?? [...instances.values()].at(-1)
  if (ink) instances.set(process.stdout, ink)
}

/** SGR 滚轮注入：64=上滚 65=下滚。 */
function wheel(stdin: { write: (s: string) => void }, dir: 'up' | 'down', ticks: number) {
  const btn = dir === 'up' ? 64 : 65
  for (let i = 0; i < ticks; i++) stdin.write(`\x1b[<${btn};50;12M`)
}

const TURNS = Number(process.env.TURNS ?? '8')
/** 每个标记在整份对话里只出现一次（正文行是 `- SEC-n item k`，不整行等于标题）。 */
const MARKERS = Array.from({ length: TURNS }, (_, i) => `SEC-${i} head`)
const matchesMarker = (line: string, m: string) => line.trim() === m

function assertScreenCoherent(tag: string, lines: string[]) {
  const seen: Array<{ marker: string; row: number }> = []
  for (const m of MARKERS) {
    const rows = lines.map((l, i) => (matchesMarker(l, m) ? i : -1)).filter(i => i >= 0)
    check(`[${tag}] "${m}" 至多一次`, rows.length <= 1, `行 ${rows.join(',')}`)
    if (rows.length === 1) seen.push({ marker: m, row: rows[0]! })
  }
  const byRow = [...seen].sort((a, b) => a.row - b.row).map(s => s.marker)
  const expect = MARKERS.filter(m => seen.some(s => s.marker === m))
  check(`[${tag}] 标记顺序符合文档序`, JSON.stringify(byRow) === JSON.stringify(expect), `实际 ${byRow.join('>')}`)
}

function makeChannel(rows: unknown[], fullscreen: boolean) {
  const listeners = new Set<() => void>()
  const channel: Record<string, unknown> = {
    version: 0,
    fullscreen,
    rows,
    status: 'idle',
    sessionTitle: '',
    agentId: 'toggle-scroll',
    model: 'probe-model',
    provider: 'deepseek',
    tokens: { input: 120, output: 45 },
    cwd: '/tmp/demo',
    displayCwd: '/tmp/demo',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting',
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    lastUserText: 'give me an overview',
    pending: [],
    notifications: [],
    contextWindow: undefined,
    reasoningEffort: undefined,
    workingActivity: undefined,
    activityEnabled: false,
    contextBarEnabled: false,
    statusBar: { compact: true, model: true, thinking: false, cwd: false, contextUsage: false, cache: false, tokens: false, tps: false, gitBranch: false, sessionTitle: false, mode: false, contextBar: false, activity: false, trajectory: false, shortcutHint: false },
    diffLayout: 'auto',
    thinkingFold: 'preview',
    toolBackground: 'none',
    lastUsage: undefined,
    loadedContext: undefined,
    tps: undefined,
    tpsSamples: [],
    pluginScene: undefined,
    agentPreset: 'standard',
    goal: undefined,
    todos: [],
    commandList: [],
    commandCompletions: () => [],
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    mode: { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
    modeIndex: 0,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
    emit() {
      channel.version = (channel.version as number) + 1
      for (const l of listeners) l()
    },
    notify() {},
    pushLocal() {},
    setFullscreen(value: boolean) {
      channel.fullscreen = value
      ;(channel.emit as () => void)()
    },
    settingsHost: () => undefined,
    settingsSections: () => [],
    subscribeSettingsSections: () => () => {},
    submit() {}, steer() {}, removePending: () => true, cancel() {},
    interruptAndDeliver: () => 0, clear() {}, loadOlder: () => 0,
    listModels: async () => [], listFiles: async () => [], listSessions: async () => [],
    setResumeTarget() {}, setActivityFrames: () => true, activityFrames: 'claude',
    runExternalCommand: async () => '', mcpStatus: () => [], exportSession: () => null,
    initWorkspace: () => null, doctorInfo: () => [], pluginsInfo: () => [],
    listSubagents: async () => [], listPresets: async () => [], switchPreset: async () => false,
    switchModel: async () => false, rewindTo: async () => null,
    resumeTo: async () => ({ ok: false, reason: 'unavailable' }), newSession: async () => false,
    compact() {}, traceEvents: () => [], listWorkspaces: async () => [], workspaceCommands: () => [],
  }
  return channel
}

function Harness({ channel }: { channel: Record<string, unknown> }): React.ReactNode {
  React.useSyncExternalStore(
    channel.subscribe as (l: () => void) => () => void,
    () => channel.version as number,
  )
  return (
    <ThemeProvider theme="dark">
      <DisplayFrame active={channel.fullscreen === true}>
        <Chat
          channel={channel as never}
          questionStore={new QuestionStore() as never}
          approvalStore={new ApprovalStore() as never}
        />
      </DisplayFrame>
    </ThemeProvider>
  )
}

/**
 * 真实"在 inline 里对话到超过一屏"的流式序列：每轮都经历
 * reasoning 流式→折叠、tool running→ok、assistant 流式→settle 的
 * 增长/收缩循环，让 LogUpdate 的 peakHeight / anchoredPad 真正累积。
 */
async function streamTurns(
  channel: Record<string, unknown>,
  turns: number,
  idRef: { v: number },
): Promise<void> {
  const rows = channel.rows as Record<string, unknown>[]
  const bump = () => { (channel.emit as () => void)() }
  for (let turn = 0; turn < turns; turn++) {
    channel.working = true
    channel.activeToolCount = 1
    rows.push({ id: idRef.v++, kind: 'user', text: `turn ${turn}: check the build config` })
    bump(); await sleep(60)

    const think = { id: idRef.v++, kind: 'reasoning', text: '', streaming: true, durationMs: undefined as number | undefined }
    rows.push(think); bump()
    for (const chunk of ['reading configs', ', comparing versions', ', summarizing.']) {
      think.text += chunk; bump(); await sleep(60)
    }

    const tool = {
      id: idRef.v++, kind: 'tool', text: '',
      tool: {
        callId: `c${turn}`, name: 'Bash', argsText: '{"command": "git log --oneline -15"}', argsFull: '{}',
        status: 'running' as string, resultText: undefined as string | undefined,
        startedAt: 0, durationMs: undefined as number | undefined,
      },
    }
    rows.push(tool); bump(); await sleep(80)

    const answer = { id: idRef.v++, kind: 'assistant', text: '', streaming: true }
    rows.push(answer); bump()
    const chunks = [
      `SEC-${turn} head\n`,
      `- SEC-${turn} item 1: assembly, theming, sync and packaging\n`,
      `- SEC-${turn} item 2: assembly, theming, sync and packaging\n`,
      `- SEC-${turn} item 3: assembly, theming, sync and packaging\n`,
      `- SEC-${turn} item 4: assembly, theming, sync and packaging\n`,
    ]
    for (let i = 0; i < chunks.length; i++) {
      answer.text += chunks[i]
      // 中途 reasoning 折叠（中部收缩）+ tool 落定（中部增长）
      if (i === 1) { think.streaming = false; think.durationMs = 2000 }
      if (i === 2) {
        tool.tool.status = 'ok'
        tool.tool.durationMs = 42
        tool.tool.resultText = Array.from({ length: 8 }, (_, k) => `result line ${turn}-${k}`).join('\n')
        channel.activeToolCount = 0
      }
      bump(); await sleep(70)
    }
    // 回合结束：spinner / esc 提示卸载 —— 触发 anchored shrink repaint
    answer.streaming = false
    channel.working = false
    bump(); await sleep(160)
  }
}

// ═══════════ 运行 A：inline 里对话到超一屏 → fullscreen → 滚动 → inline ═══════════
const termA = makeTerm()
const sA = makeStreams(termA)
const chA = makeChannel([], false)
const instA = await render(<Harness channel={chA} />, {
  stdout: sA.stdout as never, stdin: sA.stdin as never, stderr: sA.stderr as never,
  exitOnCtrlC: false, patchConsole: false,
})
bindInkToProcessStdout(sA.stdout)
await sleep(300)
// 1) 在 inline 里流式对话到超过一屏
await streamTurns(chA, TURNS, { v: 1 })
await sleep(500)
console.log('--- A: inline 稳态 ---')
assertScreenCoherent('A:inline初始', screenLines(termA))

// 2) 切全屏
;(chA.setFullscreen as (v: boolean) => void)(true)
await sleep(600)
check('A: 进入 alt screen', termA.buffer.active.type === 'alternate', `type=${termA.buffer.active.type}`)
console.log('--- A: fullscreen 稳态 ---')
assertScreenCoherent('A:fullscreen', screenLines(termA))

// 3) 全屏里滚一下屏
const TICKS = Number(process.env.TICKS ?? '6')
wheel(sA.stdin, 'up', TICKS)
await sleep(600)
console.log('--- A: fullscreen 上滚后 ---')
assertScreenCoherent('A:fullscreen上滚', screenLines(termA))
if (process.env.DUMP === '1') {
  console.log('=== A: fullscreen 上滚后的屏 ===')
  screenLines(termA).forEach((l, i) => console.log(`F${String(i).padStart(2)}|${l}`))
}

// 4) 切回 inline —— 过渡期逐帧采样，任何一帧错位都算失败
;(chA.setFullscreen as (v: boolean) => void)(false)
for (let step = 0; step < 20; step++) {
  await sleep(50)
  if (termA.buffer.active.type !== 'normal') continue
  assertScreenCoherent(`A:过渡+${(step + 1) * 50}ms`, screenLines(termA))
}
await sleep(400)
check('A: 回到主屏', termA.buffer.active.type === 'normal', `type=${termA.buffer.active.type}`)
const snapA = screenLines(termA)
console.log('--- A: 切回 inline 后 ---')
assertScreenCoherent('A:回到inline', snapA)

// 5) 切回后继续有新内容（真实使用：切回来继续对话）
const rowsA = chA.rows as Record<string, unknown>[]
const tail = { id: 9001, kind: 'assistant', text: '', streaming: true }
rowsA.push(tail)
;(chA.emit as () => void)()
for (let k = 0; k < 12; k++) {
  tail.text += `TAILMARK-${k} streaming chunk of the follow-up answer\n`
  ;(chA.emit as () => void)()
  await sleep(90)
  assertScreenCoherent(`A:切回后流式${k}`, screenLines(termA))
}
tail.streaming = false
;(chA.emit as () => void)()
await sleep(600)
const snapAafter = screenLines(termA)
assertScreenCoherent('A:流式终态', snapAafter)

// 整个 buffer（含 scrollback）里每条唯一标记恰好一份
{
  const all = bufferLines(termA)
  for (const m of MARKERS) {
    const n = all.filter(l => matchesMarker(l, m)).length
    check(`[A:全 buffer] "${m}" 至多一份`, n <= 1, `${n} 份`)
  }
  for (let k = 0; k < 12; k++) {
    const needle = `TAILMARK-${k} `
    const n = all.filter(l => l.includes(needle)).length
    check(`[A:全 buffer] "TAILMARK-${k}" 恰一份`, n === 1, `${n} 份`)
  }
}
if (process.env.DUMP === '1') {
  console.log('\n=== A: 流式结束后的可见屏 ===')
  snapAafter.forEach((l, i) => console.log(`A${String(i).padStart(2)}|${l}`))
}
const finalRows = structuredClone(chA.rows) as unknown[]
await instA.unmount()

// ═══════════ 运行 B：同一终态全新挂载 inline（黄金基准） ═══════════
const termB = makeTerm()
const sB = makeStreams(termB)
const chB = makeChannel(finalRows, false)
const instB = await render(<Harness channel={chB} />, {
  stdout: sB.stdout as never, stdin: sB.stdin as never, stderr: sB.stderr as never,
  exitOnCtrlC: false, patchConsole: false,
})
bindInkToProcessStdout(sB.stdout)
await sleep(900)
const snapB = screenLines(termB)
await instB.unmount()

// ═══════════ 终态等价 ═══════════
const normalize = (l: string) => l.replace(/\d+(\.\d+)?/g, '#')
const diffs: string[] = []
for (let y = 0; y < ROWS; y++) {
  if (normalize(snapAafter[y] ?? '') !== normalize(snapB[y] ?? '')) {
    diffs.push(`  行${String(y).padStart(2)} A|${snapAafter[y]}`)
    diffs.push(`      B|${snapB[y]}`)
  }
}
check('终态等价：切换往返 == 全新挂载 inline', diffs.length === 0, `${diffs.length / 2} 行不同`)
if (diffs.length > 0) {
  console.log('=== 终态差异（A=往返 B=全新 inline） ===')
  console.log(diffs.join('\n'))
}

if (process.env.DUMP === '1') {
  console.log('\n=== A: 切回 inline 后的可见屏 ===')
  snapA.forEach((l, i) => console.log(`A${String(i).padStart(2)}|${l}`))
  console.log('\n=== B: 全新挂载 inline 的可见屏 ===')
  snapB.forEach((l, i) => console.log(`B${String(i).padStart(2)}|${l}`))
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
