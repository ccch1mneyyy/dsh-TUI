/**
 * Idle repaint regression — a settled, untouched TUI must not push rows into
 * the terminal.
 *
 * An inline (non-alt-screen) TUI parks its cursor one row past the last
 * content row. When that park row is still inside the viewport, reaching it
 * with LF scrolls the terminal one row per LF: the terminal receives a fresh
 * copy of the viewport for a frame that changed nothing visible. Measured on
 * a settled session, that was ~73 LF/s (5 animation frames/s × ~15 LF): a
 * phone-sized 1000-row scrollback window refilled with duplicate frames in
 * ~14s, so scrolling up on mobile showed the same screen repeated instead of
 * history (see the PR body for the raw before/after numbers).
 *
 * This probe mounts the real Chat headlessly, lets the intro settle, clears
 * the probe counters, then measures a quiet window with NO input:
 *   1) stdout carries no LF at all — the terminal is not scrolled;
 *   2) the emulated terminal's scrollback does not grow;
 *   3) the viewport still repaints while the whale idle animation runs, so
 *      the fix cannot pass by freezing the UI (the art must keep moving).
 *
 * Run: node --import tsx/esm scripts/verify-idle-repaint.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'kitty'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'en'

const COLS = 108
const ROWS = 34
const SETTLE_MS = 6000
const WINDOW_MS = 15000

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { PageMargin },
  { Chat },
  { QuestionStore },
  { render },
  { sleep, viewportLines },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/components/PageMargin.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/ui.js'),
  import('./lib/term-test.mjs'),
])

let failed = 0
/** Assert one idle-window invariant and report it. */
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  (' + extra + ')' : ''))
  if (!ok) failed += 1
}

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 20000, allowProposedApi: true })

let frames = 0
let newlines = 0
// 窗口内「内容不同」的写入数：只数写入次数的话，画一帧就卡死的界面也能过。
const distinctWrites = new Set<string>()
let distinctCount = 0
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    const s = String(chunk)
    frames += 1
    if (!distinctWrites.has(s)) {
      distinctWrites.add(s)
      distinctCount += 1
    }
    newlines += (s.match(/\n/g) ?? []).length
    term.write(s, () => cb())
  }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, cb: () => void): void { cb() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

const stdout = new FakeStdout() as never
const stderr = new FakeStderr() as never
const stdin = new FakeStdin() as never

// An empty settled session with the runtime's defaults: inline mode, whale
// idle animation on (dsh-tui.whaleIdle defaults true), default status bar.
// This is the shape that reproduced the churn — nothing is streaming, nothing
// is typing, and the header's idle planner keeps a low-rate frame timer.
const listeners = new Set<() => void>()
const channel = {
  version: 0,
  rows: [] as unknown[],
  status: 'idle',
  sessionTitle: 'idle-repaint',
  agentId: 'x',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'max',
  tokens: { input: 0, output: 0 },
  cwd: '/tmp/demo',
  displayCwd: '/tmp/demo',
  gitBranch: 'main',
  working: false,
  spinnerMode: 'requesting',
  responseChars: 0,
  whale: true,
  whaleIdle: true,
  activeToolCount: 0,
  turnStart: 0,
  lastUserText: '',
  pending: [],
  commandList: [],
  notifications: [],
  mode: { plan: false },
  effortLevels: undefined,
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
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

await render(
  React.createElement(PageMargin, null, React.createElement(Chat, { channel, questionStore: new QuestionStore() })),
  { stdout, stdin, stderr, exitOnCtrlC: false, patchConsole: false },
)

// 固定窗:墙钟 让开场动画（~3.4s 鲸鱼吐水 + 文字微光）落定后再开始计量——
// 被测的是「静置后的空转」，不是挂载动画本身；动画期间帧率本就不均，没有
// 可轮询的完成条件能替代这个窗口。
await sleep(SETTLE_MS)
// 固定窗:pacing 计数窗口从这里开始。
frames = 0
newlines = 0
distinctWrites.clear()
distinctCount = 0
const startBaseY = term.buffer.active.baseY
// 固定窗:墙钟 观察窗本身就是被测语义：一段无输入的静置时间里终端收到了什么。
// 空转重绘不会停止（鲸鱼闲置动画本来就该继续动），因此没有「等到静止」这个
// 可轮询条件——只能量一段时间。
await sleep(WINDOW_MS)

const baseYGrowth = term.buffer.active.baseY - startBaseY
const seconds = WINDOW_MS / 1000

check('静置窗口内没有下泄换行', newlines === 0, `LF=${newlines} (${(newlines / seconds).toFixed(1)}/s)`)
check('终端回滚缓冲没有增长', baseYGrowth === 0, `+${baseYGrowth} rows`)
// The UI itself must still be alive: the whale idle planner repaints a few
// frames per second. A frozen terminal would also score 0 LF, so this check
// is what keeps the assertion honest — and it must count writes with DIFFERENT
// content: a UI that painted once and then froze also has frames > 0.
check(
  '鲸鱼闲置动画仍在重绘（没有靠冻结界面取巧）',
  distinctCount > 1,
  `frames=${frames} (${(frames / seconds).toFixed(1)}/s), distinct=${distinctCount}`,
)

// 从视口（baseY）读屏，不是从缓冲区首行：inline 模式开场绘制可能已把行推进
// scrollback，直扫 getLine(0..) 读到的是滚出去的历史画面（见 lib/term-test.mjs
// 的 viewportLines 说明）。
const screen = viewportLines(term).join('\n')
check('静置后的界面仍然完整', screen.includes('DEEPSEEK') || screen.includes('HARNESS') || screen.trim().length > 50, `bytes=${screen.length}`)

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
