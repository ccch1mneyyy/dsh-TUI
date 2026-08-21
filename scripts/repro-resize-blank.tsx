/**
 * 全屏 resize 风暴复现（issue #421）——Orca OCKL terminal-history 取证：用户 pane 宽度
 * 反复抖动（232→231→232→235），空白复现窗口与 resize burst 重合。
 * 本脚本无头渲染真实 Chat（alt-screen），打 resize 事件风暴，断言每次
 * 落定后消息区不得空白（空白 = 用户报告症状）。
 * 运行：node --import tsx/esm scripts/repro-resize-blank.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'Orca'
process.env.DSH_TUI_THEME = 'dark'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { default: instances }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/ink/instances.js'),
])

let COLS = 232
const ROWS = 71
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
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
    // xterm 异步分块处理写入：密度测量必须等本帧 flush 完，
    // 否则会量到"已擦除未重绘"的中间态（测量误差，非应用行为）。
    lastFlushed = new Promise<void>(res => term.write(String(chunk), () => { cb(); res() }))
  }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }
const stdout = new FakeStdout() as any
const stderr = new FakeStderr() as any
const stdin = new FakeStdin() as any

function screenLines(): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < ROWS; y++) out.push((buf.getLine(y)?.translateToString(true) ?? '').replace(/\s+$/, ''))
  return out
}
function density(): number {
  const body = screenLines().slice(0, ROWS - 7)
  return body.filter(l => l.trim()).length
}
function dump(tag: string) {
  console.log('--- 屏幕快照 ' + tag + ' ---')
  screenLines().forEach((l, i) => console.log(String(i).padStart(2) + '|' + l.slice(0, 70)))
}
function assertVisible(tag: string) {
  const d = density()
  check('[' + tag + '] 消息区非空', d >= 3, 'density=' + d)
  if (d < 3) dump(tag)
}

// ---- 400 行历史（重度会话） ----
const listeners = new Set<() => void>()
const rows: any[] = []
let id = 0
for (let t = 0; t < 200; t++) {
  rows.push({ id: id++, kind: 'user', text: '问题 ' + t + '：分析因子 ' + t + ' 的表现与回撤' })
  rows.push({ id: id++, kind: 'reasoning', text: ('思考 ' + t + '：先检查数据。').repeat(12), streaming: false, durationMs: 900 })
  rows.push({
    id: id++, kind: 'tool', text: '',
    tool: {
      callId: 't' + t, name: 'Bash', argsText: '{"command": "analyze ' + t + '"}', argsFull: '{}',
      status: 'ok', startedAt: 0, durationMs: 30,
      resultText: Array.from({ length: 8 }, (_, i) => '结果 ' + t + '-' + i).join('\n'),
    },
  })
  rows.push({ id: id++, kind: 'assistant', text: '回答 ' + t + '：\n\n- 因子 IC 稳定\n- 回撤可控\n- 与动量低相关', streaming: false })
}
const channel: any = {
  version: 0, rows, status: 'idle', sessionTitle: 'resize-stress', agentId: 'x',
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
// AlternateScreen 用 instances.get(process.stdout) 找实例（本无头环境注册在
// FakeStdout 下），手动补上 alt-screen 激活，走真实全屏渲染路径。
const ink: any = instances.get(stdout)
if (!ink) { console.log('FAIL 未找到 Ink 实例'); process.exit(1) }
ink.setAltScreenActive(true, true)
await sleep(1200)
check('alt-screen 已激活', ink.isAltScreenActive === true)
assertVisible('启动落定 400 行')

function doResize(w: number, h: number) {
  stdout.columns = w
  stdout.rows = h
  term.resize(w, h)
  stdout.emit('resize')
}

// ---- 现场形态的 burst ----
const bursts: Array<Array<[number, number]>> = [
  [[231, 71], [232, 71]],
  [[235, 71]],
  [[234, 71], [233, 71], [235, 71], [232, 71]],
  [[200, 71], [232, 71]],
  [[232, 40], [232, 71]],
  [[150, 50], [180, 60], [232, 71]],
]
for (let b = 0; b < bursts.length; b++) {
  for (const [w, h] of bursts[b]) {
    doResize(w, h)
    await sleep(8)
    await lastFlushed
    const d = density()
    if (d < 3) {
      check('burst#' + b + ' resize(' + w + 'x' + h + ') +8ms 空白帧', false, 'density=' + d)
      dump('burst#' + b + '-' + w + 'x' + h)
    }
  }
  await sleep(150)
  await lastFlushed
  assertVisible('burst#' + b + ' 落定')
  await sleep(500)
  await lastFlushed
  assertVisible('burst#' + b + ' 闲置后')
}

console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' 项失败')
process.exit(failed === 0 ? 0 : 1)
