/**
 * verify-post-shrink-anchor — 上翻停住后，塌陷假象帧不得把视口拽回底部。
 *
 * 背景（opentui #709 同族的另一半）：流式期间虚拟化窗口重挂会让
 * scrollHeight 瞬时收缩一帧（artifact）。渲染器对那一帧的处理是冻结
 * 位置（见 verify-scroll 的 shrink 用例），但**紧跟其后的恢复帧**曾经
 * 把位置钳到「塌陷后的 maxScroll」，于是下一帧的 positional at-bottom
 * 判定读到 `scrollTop >= prevMaxScroll`，把用户主动上滚打断的跟随
 * 重新接上——屏幕表现为「翻上去停住，新内容一来又被推回底部」。
 *
 * 场景（全屏 Chat，20 轮历史 + 尾行流式）：先让尾行长起来撑开窗口，
 * 上翻 2 格停住，再继续流式增长并追加新行。
 *
 * 探针设计：尾行**只增不减**（正文数组只 push，永不改短），所以观测窗里
 * 出现的任何 shrunk 帧都只可能是虚拟化重挂的测量假象，不会是探针自己把
 * 内容改短制造出来的。另加两条非空转断言：整轮必须真的观测到塌陷帧与
 * 恢复帧，否则这次运行什么都没测到，判失败而不是默默通过；单轮是否撞上
 * 假象取决于窗口重挂的时机，所以这两条按整轮合计计，不按单轮。
 *
 * 断言：整段流式期间 sticky 不得被重新置真、committed 位置不得改变
 * （拽底签名）。位置停在原地时屏幕行号仍可能因虚拟化重测而轻微变化，
 * 那不属于本缺陷，不作断言。
 *
 * 运行：node --import tsx/esm scripts/verify-post-shrink-anchor.tsx
 * （需要 tsx：本脚本 import src/，不依赖 lib/）
 */
process.env.NODE_ENV = 'production'
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, rmSync } from 'node:fs'

const TRACE = join(tmpdir(), `dsh-post-shrink-anchor-${process.pid}.jsonl`)
process.env.DSH_TUI_GEOMETRY_TRACE = TRACE

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { sleep }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('./lib/term-test.mjs'),
])

const COLS = 100, ROWS = 40
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })

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

let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const rows: any[] = []
let nextId = 1
for (let turn = 1; turn <= 20; turn++) {
  rows.push({ id: nextId++, kind: 'user', text: `问题 ${turn}` })
  rows.push({
    id: nextId++, kind: 'assistant',
    text: Array.from({ length: 8 }, (_, i) => `回复 ${turn} 第 ${i + 1} 行`).join('\n'),
  })
}

const listeners = new Set<() => void>()
const channel: any = {
  // 探针确定性：鲸鱼欢迎期闲置动画不进本探针的测量窗口。
  whaleIdle: false,
  version: 0,
  rows,
  status: 'idle',
  sessionTitle: 'probe',
  agentId: 'probe',
  model: 'deepseek-v4-flash',
  provider: 'deepseek',
  mode: { plan: false },
  reasoningEffort: 'max',
  effortLevels: [],
  tokens: { input: 0, output: 0 },
  cwd: '/tmp/demo',
  displayCwd: '/tmp/demo',
  gitBranch: 'main',
  working: true,
  spinnerMode: 'requesting',
  responseChars: 0,
  activeToolCount: 0,
  turnStart: Date.now(),
  pending: [],
  commandList: [],
  notifications: [],
  subagents: [],
  lastUserText: '问题 20',
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => Promise.resolve([]),
  setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [], pushLocal: () => {},
  commandCompletions: () => [],
}
const bump = () => { channel.version++; for (const cb of listeners) cb() }

/** 几何 trace 的 scroll note：渲染器逐帧的 follow 决策（仅在有 trace 时可用）。 */
function traceFrames(): any[] {
  try {
    return readFileSync(TRACE, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
      .map(r => r.scroll?.[0])
      .filter(Boolean)
  } catch {
    return []
  }
}
const lastFrame = () => traceFrames().at(-1) ?? null

const stdin = new FakeStdin()
const instance = await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} fullscreen />
  </AlternateScreen>,
  { stdout: new FakeStdout() as any, stdin: stdin as any, stderr: new FakeStderr() as any, exitOnCtrlC: false, patchConsole: false },
)
await sleep(1200) // 固定窗:pacing 首屏就绪的静置窗——完整渲染前无单一可轮询锚点（trace 只在滚动几何变化的帧落 note）

// 尾行流式：正文数组只 push 不改写，整轮下来内容只增不减。
const stream = { id: nextId++, kind: 'assistant', text: 'S-HEAD', streaming: true }
const body: string[] = []
const paint = () => { stream.text = ['S-HEAD', ...body].join('\n') }
channel.rows.push(stream)
bump()
await sleep(600) // 固定窗:pacing 流式行首次布局落定——虚拟化窗口重挂后该行才进入测量
for (let i = 1; i <= 6; i++) {
  for (let k = 0; k < 3; k++) body.push(`prime body ${body.length + 1}`)
  paint()
  bump()
  await sleep(160) // 固定窗:pacing 每步增长各自落帧的步间（prime 阶段不承载断言）
}
await sleep(400) // 固定窗:pacing 撑开窗口后的静置窗——等最后一次测量的渲染帧排空

const ROUNDS = 2
let totalShrunk = 0
let totalRecovering = 0
for (let round = 1; round <= ROUNDS; round++) {
  stdin.write('\x1b[1;5F') // Ctrl+End → 回底
  await sleep(700) // 固定窗:pacing 等 Ctrl+End 回底生效——随后才取基线帧
  for (let i = 0; i < 2; i++) { stdin.write('\x1b[<64;50;30M'); await sleep(200) } // 固定窗:pacing 滚轮事件步间（逐格上翻）
  await sleep(700) // 固定窗:pacing 上滚落定后的静置窗——基线帧取样前等残余渲染排空

  const before = lastFrame()
  if (before === null) {
    check(`round ${round}: geometry trace 可用`, false, '未捕获到任何 scroll note（DSH_TUI_GEOMETRY_TRACE 未生效？）')
    break
  }
  const mark = traceFrames().length

  for (let i = 1; i <= 8; i++) {
    for (let k = 0; k < 4; k++) body.push(`r${round} body ${body.length + 1}`)
    if (i % 4 === 0) {
      channel.rows.push({ id: nextId++, kind: 'assistant', text: `新消息 r${round}-${i} 一行`, streaming: false })
    }
    paint()
    bump()
    await sleep(160) // 固定窗:探针 每步增长的观察窗——随后断言的是「整段流式期间」的不变量，轮询已成立的条件等于没测
  }
  await sleep(500) // 固定窗:探针 收尾观察窗——「sticky 不得被置真、位置不得被改写」是不得改变的不变式

  // 拽底签名：sticky 被重新置真（跟随被悄悄接回），或 committed 位置被改写。
  const frames = traceFrames().slice(mark)
  const shrunkFrames = frames.filter(f => f.shrunk === true)
  const recoveringFrames = frames.filter(f => f.recovering === true)
  const stickyBack = frames.find(f => f.sticky === true)
  const moved = before.renderScrollTop === undefined
    ? undefined
    : frames.find(f => f.scrollTop !== undefined && f.scrollTop !== before.scrollTop)
  totalShrunk += shrunkFrames.length
  totalRecovering += recoveringFrames.length
  check(`round ${round}: 流式期间未重新粘底（sticky 保持 false）`, stickyBack === undefined,
    stickyBack ? `sticky=true @H=${stickyBack.scrollHeight} max=${stickyBack.maxScroll}` : `frames=${frames.length}`)
  check(`round ${round}: 流式期间 committed 位置未被改写`, moved === undefined,
    moved ? `scrollTop ${before.scrollTop} → ${moved.scrollTop} (max ${moved.maxScroll})` : `scrollTop=${before.scrollTop}`)
}

// 非空转：内容只增不减，窗口里的收缩帧只可能是虚拟化重挂的假象。
// 单轮是否撞上它取决于重挂时机，所以按整轮合计判。
check('整轮观测到塌陷假象帧（否则本轮没测到目标路径）', totalShrunk > 0, `shrunk=${totalShrunk}`)
check('整轮观测到恢复帧（冻结态确实接管过）', totalRecovering > 0, `recovering=${totalRecovering}`)

await instance.unmount()
rmSync(TRACE, { force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
