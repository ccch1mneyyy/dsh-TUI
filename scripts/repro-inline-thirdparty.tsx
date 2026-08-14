/**
 * inline 模式第三方输出污染 + 视口重锚自愈回归（issue #16/#10/#17）：
 * main-screen 的 diff 引擎用相对光标记账（无 alt-screen 的每帧 CSI H
 * 自愈），前提是"没有第三方触碰光标"。而 #17 证明真机上存在子进程直写
 * tty（mcp-client 的 stderr 打进 UI）——静止期注入后，后续增量写入整体
 * 错位（#16 "label 整行消失/description 错位" 的形态）。
 *
 * 三段断言：
 *  1. 注入前后基准一致（环境无噪声）；
 *  2. 注入后污染确实发生（错误行叠在 UI 上）——这是前置条件而非失败，
 *     污染不发生说明场景没搭对；
 *  3. 触发 stdin-gap 重锚（reassertTerminalModes → requestViewportReanchor
 *     → 视口就地重画）后，视口内容恢复与干净基准一致（自愈）。
 * 运行：node --import tsx/esm scripts/repro-inline-thirdparty.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'WezTerm'
process.env.CC_TUI_THEME = 'dark'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { Chat }, { QuestionStore }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/questions.js'),
])

const COLS = 100
const ROWS = 40
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 500, allowProposedApi: true })

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    term.write(String(chunk), cb)
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
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
function viewportLines(): string[] {
  const buf = term.buffer.active
  const start = Math.max(0, buf.length - ROWS)
  const out: string[] = []
  for (let y = start; y < buf.length; y++) out.push((buf.getLine(y)?.translateToString(true) ?? '').replace(/\s+$/, ''))
  return out
}

let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const listeners = new Set<() => void>()
const channel: any = {
  version: 0, rows: [] as any[], status: 'idle', sessionTitle: 'probe', agentId: 'probe',
  model: 'deepseek-v4-flash', reasoningEffort: 'max', tokens: { input: 120, output: 45 },
  cwd: '/tmp/demo', gitBranch: 'main', working: true, spinnerMode: 'requesting',
  responseChars: 0, activeToolCount: 0, turnStart: Date.now(), lastUserText: '概览',
  pending: [], commandList: [], notifications: [],
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => [], setResumeTarget: () => {},
  loadOlder: () => {}, mcpStatus: () => [],
}
const bump = () => { channel.version++; for (const cb of listeners) cb() }

let id = 0
channel.rows.push({ id: id++, kind: 'user', text: '给我一个项目概览' })

const stdoutObj = new FakeStdout()
const instance = await render(
  <Chat channel={channel} questionStore={new QuestionStore()} />,
  { stdout: stdoutObj as any, stdin: new FakeStdin() as any, stderr: new FakeStderr() as any, exitOnCtrlC: false, patchConsole: false },
)
// 等鲸鱼启动动画播完定格（眨眼→喷水→摆尾后静态不再重绘）——golden 与
// 自愈后快照相隔约 1 秒，动画未定格会造成时间敏感的假差异。
await sleep(3500)

// 流式短回复并定格（保持帧高 < 视口，隔离"第三方输出"变量）。
const msg = { id: id++, kind: 'assistant', text: '', streaming: true }
channel.rows.push(msg); bump()
for (let i = 0; i < 12; i++) {
  msg.text += `- 概览要点第 ${i + 1} 条：模块划分与构建流程说明\n`
  bump(); await sleep(80)
}
msg.streaming = false
channel.working = false
bump()
await sleep(600)

// 对照基准：定格后的干净视口。
const golden = viewportLines()

// ★ 静止期注入第三方输出（真机 #17 场景：mcp 子进程 stderr 直写 tty，
//   打在空闲时的输入框下方——之后没有大重绘来自愈）。
term.write('\r\n[5764] Error: Non-HTTPS URLs are only allowed for localhost\r\n[35540] Usage: npx tsx proxy.ts <https://server-url>\r\n')
await sleep(100)

// 之后只有轻微 UI 活动（通知/指标 tick 级别的小 diff）——真实空闲场景。
channel.responseChars += 7; bump()
await sleep(300)
channel.responseChars += 7; bump()
await sleep(500)

const after = viewportLines()
// 前置条件：污染必须实际发生（错误行留在视口）——否则场景没搭对，
// 后面的自愈断言无意义。
const strayVisible = after.some(l => l.includes('[5764] Error') || l.includes('[35540] Usage'))
check('前置：注入的第三方行留在视口（污染成立）', strayVisible)

// ★ 触发自愈：stdin-gap 重锚（App 层 >5s 间隙判定是简单算术，这里直接
//   调 ink 实例的 reassertTerminalModes —— 与按键触发同一条链路）。
const { default: instances } = await import('../src/ink/instances.js')
const ink: any = instances.get(stdoutObj as any)
check('前置：取到 ink 实例', !!ink)
ink?.reassertTerminalModes?.()
await sleep(400)

const healed = viewportLines()
console.log('=== 自愈后对照（G=干净基准 H=重锚后） ===')
let diffRows = 0
for (let y = 0; y < ROWS; y++) {
  if ((golden[y] ?? '') !== (healed[y] ?? '')) {
    diffRows++
    if (diffRows <= 10) {
      console.log(`行${String(y).padStart(2)} G|${golden[y]}`)
      console.log(`     H|${healed[y]}`)
    }
  }
}
const strayAfterHeal = healed.some(l => l.includes('[5764] Error') || l.includes('[35540] Usage'))
check('自愈：视口无第三方残留行', !strayAfterHeal)
check('自愈：全部 12 条要点回到视口', Array.from({ length: 12 }, (_, i) => `概览要点第 ${i + 1} 条`).every(t => healed.some(l => l.includes(t))))
// 内容序列比较（strip 空行）：注入造成的 2 行物理滚动不可逆——那 2 行
// 已进 scrollback——自愈后的视口内容正确但整体位置平移。用户看到的是
// 非空行序列，平移无感；断言序列一致即自愈完成。
const seq = (ls: string[]) => ls.filter(l => l.trim() !== '')
const goldenSeq = seq(golden)
const healedSeq = seq(healed)
const seqEqual = goldenSeq.length === healedSeq.length && goldenSeq.every((l, i) => l === healedSeq[i])
if (!seqEqual) {
  console.log('=== 序列差异 ===')
  for (let i = 0; i < Math.max(goldenSeq.length, healedSeq.length); i++) {
    if ((goldenSeq[i] ?? '') !== (healedSeq[i] ?? '')) {
      console.log(`序${String(i).padStart(2)} G|${goldenSeq[i]}`)
      console.log(`     H|${healedSeq[i]}`)
    }
  }
}
check('自愈：视口内容序列与干净基准一致', seqEqual, `G=${goldenSeq.length} 行 H=${healedSeq.length} 行（绝对行位可平移）`)

console.log(failed === 0 ? '\nALL PASS（第三方污染经 stdin-gap 重锚自愈）' : `\n${failed} 项失败`)
await instance.unmount()
process.exit(failed === 0 ? 0 : 1)
