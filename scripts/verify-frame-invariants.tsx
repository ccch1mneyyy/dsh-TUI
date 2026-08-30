/**
 * 三层真相一致性验证（React 状态 / Yoga 布局 / 终端物理层）：
 *
 * 核心不变量：对同一份最终状态，**经过一长串增量帧渲染出来的终端**，
 * 必须与**全新挂载一次渲染出来的终端**逐行一致。任何一层的三相
 * 账本（行高缓存 / nodeCache blit / scrollback viewportY / 光标记账）
 * 漂移，都会在这条断言下现形——这是比"marker 恰好一份"更强的
 * 端到端性质，直接锁定"增量管线最终漂移"这一整类 bug。
 *
 * 场景（共用一个增量实例，对照多个 fresh 实例）：
 *  A. 多轮流式（reasoning 流式→折叠、tool running→ok、assistant 流式
 *     →settle 收缩）后的视口 vs fresh；
 *  B. Ctrl+O 全局展开后的视口 vs fresh（同发按键）；
 *  C. Help 浮层开→关后的视口 vs fresh（浮层关闭恢复底层 cells）；
 *  D. 增量实例整个 buffer（scrollback+视口）中每条内容恰一份。
 *
 * 时间相关文本（耗时/时钟）归一化为 T 后再比较。
 * 运行：node --import tsx/esm scripts/verify-frame-invariants.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'WezTerm'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { Chat }, { QuestionStore }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
])

const COLS = 100
const ROWS = 24
const SCROLLBACK = 2000
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  constructor(private term: XTerm.Terminal) { super() }
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { this.term.write(String(chunk), cb) }
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

interface Harness {
  term: XTerm.Terminal
  stdin: FakeStdin
  instance: { unmount(): Promise<void> | void }
}

function makeChannel(): any {
  const listeners = new Set<() => void>()
  return {
    version: 0, rows: [] as any[], status: 'idle', sessionTitle: 'probe', agentId: 'probe',
    model: 'deepseek-v4-flash',
    mode: { plan: false }, reasoningEffort: 'max', tokens: { input: 120, output: 45 },
    cwd: '/tmp/demo', displayCwd: '/tmp/demo', gitBranch: 'main', working: false, spinnerMode: 'requesting',
    responseChars: 0, activeToolCount: 0, turnStart: Date.now(), lastUserText: '',
    pending: [], commandList: [], notifications: [],
    _ls: listeners,
    subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
    submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
    listModels: () => Promise.resolve([]), listSessions: () => [], setResumeTarget: () => {},
    loadOlder: () => {}, mcpStatus: () => [],
  }
}

/** Notify one channel's subscribers (its mounted Chat re-renders). */
function bumpOf(ch: any): void {
  ch.version++
  for (const cb of ch._ls as Set<() => void>) cb()
}

/** Mount a Chat into its own xterm; returns the harness. */
async function mountChat(channel: any): Promise<Harness> {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK, allowProposedApi: true })
  const stdout = new FakeStdout(term)
  const stdin = new FakeStdin()
  const instance = await render(
    <Chat channel={channel} questionStore={new QuestionStore()} />,
    { stdout: stdout as any, stdin: stdin as any, stderr: new FakeStderr() as any, exitOnCtrlC: false, patchConsole: false },
  )
  return { term, stdin, instance }
}

function viewportLines(term: XTerm.Terminal): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = Math.max(0, buf.length - ROWS); y < buf.length; y++) {
    out.push(buf.getLine(y)?.translateToString(true) ?? '')
  }
  return out
}

function fullBufferLines(term: XTerm.Terminal): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < buf.length; y++) out.push(buf.getLine(y)?.translateToString(true) ?? '')
  return out
}

/** Normalize time-varying tokens (durations, clocks) to T. */
function norm(line: string): string {
  return line
    .replace(/\d+(?:\.\d+)?(?:ms|s)\b/g, 'T')
    .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, 'T')
    .trimEnd()
}

let failed = 0
let driftReported = false
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

/** Compare two viewports after normalization; print up to 8 diff rows.
 * When every diff is explained by a uniform k-row shift (incremental
 * content sits k rows higher, k blanks at the bottom), report it as the
 * known bottom-drift bug instead of listing rows. */
function assertViewportsMatch(name: string, a: XTerm.Terminal, b: XTerm.Terminal): void {
  const va = viewportLines(a).map(norm)
  const vb = viewportLines(b).map(norm)
  const diffs: string[] = []
  for (let i = 0; i < ROWS; i++) {
    if ((va[i] ?? '') !== (vb[i] ?? '')) diffs.push(`行${i}\n  增量|${va[i]}\n  全新|${vb[i]}`)
  }
  if (diffs.length === 0) {
    check(name, true)
    return
  }
  // 已知漂移检测：va[i] === vb[i+k] 且 va 尾部 k 行为空
  for (let k = 1; k <= 6; k++) {
    let shifted = true
    for (let i = 0; i < ROWS - k; i++) {
      if ((va[i] ?? '') !== (vb[i + k] ?? '')) { shifted = false; break }
    }
    const tailBlank = va.slice(ROWS - k).every(l => l === '')
    if (shifted && tailBlank) {
      driftReported = true
      check(`${name} —— 已知底部漂移 bug：增量实例整体上浮 ${k} 行，statusline 下积 ${k} 空行（见审计文档 §14）`, false, '开放 bug，非本次回归')
      return
    }
  }
  check(name, false, `${diffs.length} 行差异`)
  for (const d of diffs.slice(0, 8)) console.log(`  ${d}`)
}

// ---- 增量实例：跑完整流式剧本 ----
const channel = makeChannel()
let id = 0
const inc = await mountChat(channel)
await sleep(3500) // 鲸鱼动画定格

const TURNS = 2
for (let turn = 0; turn < TURNS; turn++) {
  channel.rows.push({ id: id++, kind: 'user', text: `不变量问题 ${turn}：审一下渲染管线` })
  channel.working = true
  channel.lastUserText = `不变量 ${turn}`
  bumpOf(channel); await sleep(150)

  const reasoning = { id: id++, kind: 'reasoning', text: '', streaming: true }
  channel.rows.push(reasoning); bumpOf(channel)
  for (let i = 0; i < 6; i++) {
    reasoning.text += `推理段 ${turn}-${i}：增量帧与新鲜帧必须逐行一致，账本不能漂。`
    bumpOf(channel); await sleep(60)
  }
  reasoning.streaming = false
  reasoning.durationMs = 800
  bumpOf(channel); await sleep(120)

  const tool = {
    id: id++, kind: 'tool', text: '',
    tool: {
      callId: `v${turn}`, name: 'Grep', argsText: '{"pattern":"viewportY"}', argsFull: '{}',
      status: 'running', startedAt: Date.now(), durationMs: undefined as number | undefined,
      resultText: undefined as string | undefined,
    },
  }
  channel.rows.push(tool); bumpOf(channel); await sleep(180)
  tool.tool.status = 'ok'
  tool.tool.durationMs = 25
  tool.tool.resultText = Array.from({ length: 6 }, (_, i) => `命中 ${turn}-${i}`).join('\n')
  bumpOf(channel); await sleep(140)

  const answer = { id: id++, kind: 'assistant', text: '', streaming: true }
  channel.rows.push(answer); bumpOf(channel)
  for (let i = 0; i < 10; i++) {
    answer.text += `- 不变量结论 ${turn}-${i}：三层账本一致才放行。\n`
    bumpOf(channel); await sleep(70)
  }
  answer.streaming = false
  channel.working = false
  channel.activeToolCount = 0
  bumpOf(channel); await sleep(400)
}
await sleep(600)

// ---- fresh 对照 A：同一最终状态全新挂载 ----
const freshChannelA = makeChannel()
freshChannelA.rows = channel.rows.map(r => ({ ...r, tool: r.tool ? { ...r.tool } : undefined }))
freshChannelA.lastUserText = channel.lastUserText
freshChannelA.version = channel.version
const freshA = await mountChat(freshChannelA)
await sleep(3500 + 500)
if (process.env.DIAG) {
  const buf = freshA.term.buffer.active
  console.log(`[DIAG] freshA buffer=${buf.length}`)
  for (let y = Math.max(0, buf.length - 30); y < buf.length; y++) {
    console.log(`  ${String(y).padStart(3)} |${(buf.getLine(y)?.translateToString(true) ?? '').trimEnd().slice(0, 60)}`)
  }
  const ibuf = inc.term.buffer.active
  console.log(`[DIAG] incremental buffer=${ibuf.length}`)
  for (let y = Math.max(0, ibuf.length - 30); y < ibuf.length; y++) {
    console.log(`  i${String(y).padStart(3)} |${(ibuf.getLine(y)?.translateToString(true) ?? '').trimEnd().slice(0, 60)}`)
  }
}
assertViewportsMatch('A 流式剧本后：增量视口 == 全新挂载视口', inc.term, freshA.term)

// ---- B：Ctrl+O 全局展开（两边同发） ----
inc.stdin.write('\x0f'); await sleep(400)
freshA.stdin.write('\x0f'); await sleep(500)
assertViewportsMatch('B Ctrl+O 展开后：增量视口 == 全新挂载视口', inc.term, freshA.term)
inc.stdin.write('\x0f'); await sleep(400) // 折回，为 C 做准备
freshA.stdin.write('\x0f'); await sleep(400)

// ---- C：Help 浮层开→关（增量侧 exercised；fresh 保持关闭） ----
inc.stdin.write('?'); await sleep(400)
const helpOpenVisible = viewportLines(inc.term).some(l => l.includes('ctrl') || l.includes('命令'))
check('C 前置：Help 浮层确实打开', helpOpenVisible)
inc.stdin.write('\x1b'); await sleep(500)
assertViewportsMatch(driftReported
  ? 'C 浮层关闭恢复（前置 A 的漂移未修时连带失败，见 §14）'
  : 'C 浮层关闭恢复：增量视口 == 全新挂载视口', inc.term, freshA.term)

// ---- D：增量实例整个 buffer 中每条可见内容恰一份 ----
// 注意：折叠掉的行（工具结果 … +N lines、reasoning 折叠）本就不在
// buffer 里，×0 是预期——只检查可见 marker。
{
  const lines = fullBufferLines(inc.term)
  let bad = 0
  for (let t = 0; t < TURNS; t++) {
    for (let i = 0; i < 10; i++) {
      const marker = `不变量结论 ${t}-${i}：`
      const n = lines.filter(l => l.includes(marker)).length
      if (n !== 1) { bad++; console.log(`  内容异常 ${marker} ×${n}`) }
    }
    for (let i = 0; i < 3; i++) { // 工具结果折叠为 3 行（0..2 可见）
      const marker = `命中 ${t}-${i}`
      const n = lines.filter(l => l.includes(marker)).length
      if (n !== 1) { bad++; console.log(`  内容异常 ${marker} ×${n}`) }
    }
  }
  check('D scrollback+视口中每条可见内容恰一份', bad === 0, `${bad} 处异常`)
}

console.log(failed === 0 ? '\nALL PASS（三层账本一致：增量 == 全新）' : `\n${failed} 项失败`)
await inc.instance.unmount()
await freshA.instance.unmount()
process.exit(failed === 0 ? 0 : 1)
