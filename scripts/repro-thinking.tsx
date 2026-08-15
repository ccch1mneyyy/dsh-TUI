/**
 * thinking spinner 残影回归（issue #72 症状之一）。
 *
 * 背景：spinner 动画字符 ✳（U+2733）是 text-default emoji，终端画 1 格，
 * 但 stringWidth 的 JS 回退实现曾把 emoji-regex 匹配到的字符一律量 2 格。
 * 于是 spinner 行每次动画切到 ✳ 就整体错位 1 列，thinking 文字的残影
 * （"tthinking"、孤立 t）在屏幕上堆积不消失。
 *
 * 本脚本 headless 渲染 Chat 全屏：working=true、spinnerMode='thinking'、
 * 助手文本持续流式增长（强制内容增长 + stickyScroll），捕获全部帧字节，
 * 用 xterm-headless 回放后断言可见区干净：
 *
 * - 恰有 1 行含 'thinking'（spinner 行本身；灌入文本刻意不含该词）
 * - 无 'tthinking' 叠字
 * - 无孤立残影 't'（任意列，两侧为空白或行尾）
 *
 * 运行：node --import tsx/esm scripts/repro-thinking.tsx
 * 可选：COLS/ROWS 环境变量控制终端尺寸。失败以非零退出。
 */
process.env.FORCE_COLOR = '3'

const [{ PassThrough, Writable }, React, { render }, { Chat }, { QuestionStore }, { Terminal: XTerm }, fs] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('../src/ui.js'),
    import('../src/screens/Chat.js'),
    import('../src/dsh-adapter/questions.js'),
    import('@xterm/headless'),
    import('node:fs'),
  ])

const COLS = Number(process.env.COLS ?? 100)
const ROWS = Number(process.env.ROWS ?? 28)

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  frames: string[] = []
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    this.frames.push(String(chunk))
    callback()
  }
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

// ── 可变 channel：模拟一轮 thinking + 流式输出 ──
const rows: any[] = [
  { id: 0, kind: 'user', text: '帮我分析一下这个渲染问题的可能原因' },
]
let version = 0
const listeners = new Set<() => void>()
const channel = {
  get version() { return version },
  rows,
  status: 'working',
  sessionTitle: 'repro',
  agentId: 'repro',
  model: 'deepseek-v4-flash',
  tokens: { input: 120, output: 45 },
  cwd: '/tmp/repro',
  displayCwd: '/tmp/repro',
  gitBranch: 'main',
  working: true,
  spinnerMode: 'thinking',
  get responseChars() { return currentText.length },
  activeToolCount: 0,
  mode: { id: 'default', plan: false },
  modeIndex: 0,
  cycleMode() {},
  turnStart: Date.now(),
  lastUserText: '帮我分析一下这个渲染问题的可能原因',
  pending: [],
  commandList: [],
  notifications: [],
  activityEnabled: false, // 强制走 WorkingSpinner（而非 ActivityLine）
  contextBarEnabled: false,
  subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) },
  submit: () => {},
  cancel: () => {},
  clear: () => {},
  notify: () => {},
  listModels: () => Promise.resolve([]),
  listSessions: () => [],
  setResumeTarget: () => {},
} as never

let currentText = ''
let nextId = 1
function pushChunk(chunk: string) {
  currentText += chunk
  // 更新流式中的 assistant 行
  const last = rows[rows.length - 1]
  if (last && last.kind === 'assistant' && last.streaming) {
    last.text = currentText
  } else {
    rows.push({ id: nextId++, kind: 'assistant', text: currentText, streaming: true })
  }
  version++
  for (const fn of listeners) fn()
}

const stdout = new FakeStdout()
const instance = await render(
  React.createElement(Chat, { channel, questionStore: new QuestionStore(), onExit: () => {} }),
  {
    stdout,
    stdin: new FakeStdin(),
    stderr: new FakeStderr(),
    exitOnCtrlC: false,
    patchConsole: false,
  },
)

// 启动稳定
await new Promise(r => setTimeout(r, 500))

// 流式灌文本 ~6 秒（thinking 状态保持）。内容刻意全为中文、不含 'thinking'
// 与孤立 ASCII 't'，让残影断言无歧义。
const CHUNKS = [
  '好的，', '让我来分析', '这个问题。', '首先，', '渲染器', '使用相对', '光标移动',
  '来重绘', '变化的单元格。', '如果虚拟', '光标与真实', '终端光标', '失步，',
  '写入就会', '落在错误的', '位置。', '具体来说，', '动画行', '每 50ms',
  '重绘一次，', '微光颜色', '每帧都在变化。', '这就导致', '该行所有单元格',
  '每帧都被重写。', '如果光标模型', '偏差了一行，', '重写就会', '落在下一行，',
  '留下残影。', '这就是', '多个字符', '堆积的原因。', '分析完毕。',
]
for (const chunk of CHUNKS) {
  pushChunk(chunk)
  await new Promise(r => setTimeout(r, 120))
}

// 再让 spinner 空转几帧
await new Promise(r => setTimeout(r, 800))

const byteStream = stdout.frames.join('')
try { instance.unmount() } catch {}

// ── xterm-headless 回放 ──
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 500, allowProposedApi: true })
term.write(byteStream)
await new Promise(r => setTimeout(r, 1200))

const buf = term.buffer.active
const lines: string[] = []
for (let y = 0; y < ROWS; y++) {
  lines.push(buf.getLine(y)?.translateToString(true) ?? '')
}

// ── 残影检测 ──
const problems: string[] = []
let thinkingRows = 0
lines.forEach((line, y) => {
  if (line.includes('thinking')) thinkingRows++
  if (/tthinking/.test(line)) problems.push(`row ${y}: 叠字残影 "tthinking" → ${JSON.stringify(line)}`)
  // 孤立 't'：两侧为空白/行首行尾（灌入文本不含 ASCII 't'，出现即残影）
  const m = line.match(/(?:^|\s)t(?=\s|$)/)
  if (m) problems.push(`row ${y}: 孤立残影 't' → ${JSON.stringify(line)}`)
})
if (thinkingRows !== 1) {
  problems.push(`含 'thinking' 的行数为 ${thinkingRows}（期望 1，即 spinner 行本身）`)
}

if (problems.length > 0) {
  const dump = '/tmp/repro-thinking-frames.bin'
  fs.writeFileSync(dump, byteStream)
  console.error(`FAIL: thinking spinner 残影回归（帧字节已存 ${dump}）`)
  console.error(`=== xterm-headless replay: ${COLS}x${ROWS} (viewport baseY=${buf.baseY}) ===`)
  lines.forEach((line, y) => console.error(`${String(y).padStart(3)}|${line}`))
  for (const p of problems) console.error(`- ${p}`)
  process.exit(1)
}

console.log(`PASS: thinking spinner 无残影（${COLS}x${ROWS}，spinner 行恰 1 处 'thinking'）`)
process.exit(0)
