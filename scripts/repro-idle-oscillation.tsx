/**
 * Idle re-render storm repro (issue #433) — 打开长历史会话后无交互，底部以
 * ~33fps ±1 行震荡。本脚本无头渲染真实 Chat（alt-screen + 含 ASCII 图的长
 * 历史），落定后以 30ms 间隔打空转重渲染风暴（等价于 #433 日志里的均匀
 * 30ms 驱动源），断言：
 *   1) 风暴期间每帧 trace 的 renderScrollTop 恒定（几何不震荡）；
 *   2) 终端画面逐字节稳定（无 ±1 行视口滚动）；
 *   3) PromptInput 内容行数恒定。
 * 同时产出 DSH_TUI_GEOMETRY_TRACE 逐帧 JSONL，供真机复现 #433 时同一口径
 * 对比（cause 字段定位 30ms 驱动源）。
 * 运行：node --import tsx/esm scripts/repro-idle-oscillation.tsx
 */
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'kitty'
process.env.DSH_TUI_THEME = 'dark'
const TRACE_PATH = join(tmpdir(), 'dsh-geometry-trace.jsonl')
rmSync(TRACE_PATH, { force: true })
process.env.DSH_TUI_GEOMETRY_TRACE = TRACE_PATH

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { default: instances }, { sleep }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/ink/instances.js'),
  import('./lib/term-test.mjs'),
])

const COLS = 108
const ROWS = 34
let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  (' + extra + ')' : ''))
  if (!ok) failed += 1
}

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
let lastFlushed: Promise<void> = Promise.resolve()
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    lastFlushed = new Promise<void>(res => term.write(String(chunk), () => { cb(); res() }))
  }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }
const stdout = new FakeStdout() as any
const stderr = new FakeStderr() as any
const stdin = new FakeStdin() as any

function screenText(): string {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < ROWS; y++) out.push((buf.getLine(y)?.translateToString(true) ?? '').replace(/\s+$/, ''))
  return out.join('\n')
}

// ---- 长历史：普通行 + ASCII 架构图（#433 现场：一条含 ASCII 图的长消息）----
const DIAGRAM = [
  '┌─────────┐      ┌──────────┐      ┌───────────┐',
  '│ gateway │──────│ registry │──────│  worker   │',
  '└─────────┘      └──────────┘      └───────────┘',
  '     │              │   ↑                │',
  '     └──────────────┘   │                │',
  '        (metrics bus)   └── health probe │',
  '',
  '  throughput: ████████████░░░░ 62%   p99: 41ms',
  '  errors:     ██░░░░░░░░░░░░░░░  4%   queue: 0',
].join('\n')

const listeners = new Set<() => void>()
const rows: any[] = []
let id = 0
for (let t = 0; t < 90; t++) {
  rows.push({ id: id++, kind: 'user', text: '问题 ' + t + '：' + '关于模块 ' + t + ' 的行为与边界条件，请给出完整分析，包括失败模式。' })
  rows.push({ id: id++, kind: 'reasoning', text: ('思考 ' + t + '：先验证假设，再检查数据一致性。').repeat(6), streaming: false, durationMs: 1200 })
  rows.push({
    id: id++, kind: 'tool', text: '',
    tool: {
      callId: 't' + t, name: 'Read', argsText: '{"path": "src/mod' + t + '.ts"}', argsFull: '{}',
      status: 'ok', startedAt: 0, durationMs: 20,
      resultText: Array.from({ length: 5 }, (_, i) => 'line ' + t + '-' + i + ' · content').join('\n'),
    },
  })
  rows.push({ id: id++, kind: 'assistant', text: '回答 ' + t + '：\n\n- 结论成立\n- 边界已覆盖\n- 见下图\n\n' + DIAGRAM, streaming: false })
}
const channel: any = {
  version: 0, rows, status: 'idle', sessionTitle: 'idle-osc', agentId: 'x',
  model: 'deepseek-v4-flash', reasoningEffort: 'max',
  tokens: { input: 100, output: 40 }, cwd: '/tmp/demo', displayCwd: '/tmp/demo',
  gitBranch: 'main', working: false, spinnerMode: 'requesting', responseChars: 0,
  activeToolCount: 0, turnStart: 0, lastUserText: rows[rows.length - 4].text,
  pending: [], commandList: [], notifications: [],
  mode: { plan: false }, effortLevels: undefined,
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => [],
  setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [],
}
const bump = () => { channel.version++; for (const cb of listeners) (cb as () => void)() }

await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} />
  </AlternateScreen>,
  { stdout, stdin, stderr, exitOnCtrlC: false, patchConsole: false },
)
const ink: any = instances.get(stdout)
if (!ink) { console.log('FAIL 未找到 Ink 实例'); process.exit(1) }
ink.setAltScreenActive(true, true)
// 基线必须取自不再重绘的稳态帧：「内容非空」不等于「已定格」，无可轮询的
// 完成条件——保留固定稳定窗。
await sleep(1500)
await lastFlushed

// ---- 落定基线 ----
const baseline = screenText()
check('落定后画面非空', baseline.trim().length > 200, 'bytes=' + baseline.length)

// ---- 30ms 空转重渲染风暴（3s ≈ #433 的 100 连续帧）----
const baselineTraceLines = readFileSync(TRACE_PATH, 'utf8').trim().split('\n').length
let screenDriftFrames = 0
const seenScreens = new Set<string>()
// 30ms 间隔本身是被测驱动源（#433 的均匀 30ms 帧源），墙钟语义保留。
for (let i = 0; i < 100; i++) {
  bump()
  await sleep(30)
  await lastFlushed
  const shot = screenText()
  seenScreens.add(shot)
  if (shot !== baseline) screenDriftFrames++
}
// 风暴收尾稳定窗：断言「画面回到基线且不再漂移」是稳定性探针，保留固定窗口。
await sleep(200)
await lastFlushed

check('空转风暴期间画面逐帧稳定', screenDriftFrames === 0, 'drift=' + screenDriftFrames + '/100, variants=' + seenScreens.size)

// ---- trace 校验：renderScrollTop / promptContentRows 恒定 ----
const lines = readFileSync(TRACE_PATH, 'utf8').trim().split('\n').slice(baselineTraceLines)
const stormFrames = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
check('trace 记录到空转帧', stormFrames.length >= 50, 'frames=' + stormFrames.length)
const scrollTops = new Set<number>()
const promptRows = new Set<number>()
for (const f of stormFrames) {
  for (const s of f.scroll ?? []) scrollTops.add(s.renderScrollTop)
  if (f.aux?.promptContentRows !== undefined) promptRows.add(f.aux.promptContentRows)
}
check('空转期间 renderScrollTop 恒定', scrollTops.size <= 1, 'values=' + [...scrollTops].join(','))
check('空转期间 promptContentRows 恒定', promptRows.size <= 1, 'values=' + [...promptRows].join(','))
const causeCount: Record<string, number> = {}
for (const f of stormFrames) causeCount[f.cause] = (causeCount[f.cause] ?? 0) + 1
console.log('  空转帧 cause 分布: ' + JSON.stringify(causeCount))

// 末帧画面仍与基线一致（风暴未留下漂移）
check('风暴后画面回到基线', screenText() === baseline)

console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' 项失败')
rmSync(TRACE_PATH, { force: true })
process.exit(failed === 0 ? 0 : 1)
