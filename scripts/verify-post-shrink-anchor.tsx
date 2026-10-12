/**
 * Streaming tail growth must preserve a manually scrolled fullscreen view.
 *
 * A changing text signature used to discard the last measured row height.
 * If the streaming row left the virtual window before it was re-measured,
 * its spacer collapsed to the two-row fallback. The renderer then clamped
 * the manual position and interpreted that write as a return to the bottom.
 *
 * Drive real Chat/stdin/xterm with append-only text. Assert the committed
 * and painted positions, sticky state, and an actual terminal text anchor.
 * Require painted frames and an unmounted streaming row so the run cannot
 * pass without exercising the virtual-window transition. There is no
 * renderer recovery flag: prevention of the artificial shrink is the fix.
 *
 * Run: node --import tsx/esm scripts/verify-post-shrink-anchor.tsx
 * Imports src/; no compiled lib/ required. DSH_TEST_COLUMNS=60 tests narrow.
 */
process.env.NODE_ENV = 'production'
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, rmSync } from 'node:fs'
import type { Channel, ChatRow } from '../src/dsh-adapter/channel.js'
import type { ListGeometryNote, ScrollGeometryNote } from '../src/ink/geometry-trace.js'

const TRACE = join(tmpdir(), `dsh-post-shrink-anchor-${process.pid}.jsonl`)
process.env.DSH_TUI_GEOMETRY_TRACE = TRACE

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { sleep, settled, viewportLines }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('./lib/term-test.mjs'),
])

const COLS = Number(process.env.DSH_TEST_COLUMNS ?? 100), ROWS = 40
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const screens: string[][] = []

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), () => { screens.push(viewportLines(term)); cb() }) }
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

const rows: ChatRow[] = []
let nextId = 1
for (let turn = 1; turn <= 20; turn++) {
  rows.push({ id: nextId++, kind: 'user', text: `问题 ${turn}` })
  rows.push({
    id: nextId++, kind: 'assistant',
    text: Array.from({ length: 8 }, (_, i) => `回复 ${turn} 第 ${i + 1} 行`).join('\n'),
  })
}

const listeners = new Set<() => void>()
const channel = {
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

type GeometryFrame = { scroll: ScrollGeometryNote[]; list: ListGeometryNote | null }
function traceFrames(): GeometryFrame[] {
  return readFileSync(TRACE, 'utf8').trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as GeometryFrame)
}
const lastFrame = () => traceFrames().flatMap(frame => frame.scroll).at(-1)

const stdin = new FakeStdin()
const stdout = new FakeStdout()
const instance = await render(
  <AlternateScreen>
    <Chat channel={channel as unknown as Channel} questionStore={new QuestionStore()} fullscreen />
  </AlternateScreen>,
  { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, stderr: new FakeStderr() as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false },
)
await sleep(1200) // 固定窗:pacing 首屏就绪的静置窗——完整渲染前无单一可轮询锚点（trace 只在滚动几何变化的帧落 note）

// 尾行流式：正文数组只 push 不改写，整轮下来内容只增不减。
const stream: ChatRow = { id: nextId++, kind: 'assistant', text: 'S-HEAD', streaming: true }
const streamIndex = channel.rows.length
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

const ROUNDS = 3
let observedUnmount = false
for (let round = 1; round <= ROUNDS; round++) {
  stdin.write('\x1b[1;5F') // Ctrl+End → 回底
  await sleep(700) // 固定窗:pacing 等 Ctrl+End 回底生效——随后才取基线帧
  for (let i = 0; i < 2; i++) { stdin.write('\x1b[<64;50;30M'); await sleep(200) } // 固定窗:pacing 滚轮事件步间（逐格上翻）
  await sleep(700) // 固定窗:pacing 上滚落定后的静置窗——基线帧取样前等残余渲染排空

  if (round === 3) {
    // Read old history with the streaming tail entirely outside the window.
    for (let page = 0; page < 20; page++) stdin.write('\x1b[5~')
    check('远处历史就绪且尾行已卸载', await settled(() => {
      const list = traceFrames().map(frame => frame.list).findLast(list => list !== null)
      const frame = lastFrame()
      // Geometry is written synchronously; xterm consumes stdout later.
      // At the logical head an earlier drain frame can still show a clipped
      // logo. Wait for the full header and parsed output before freezing a
      // text anchor, so that navigation's final paint is outside the probe.
      return frame?.scrollTop === 0 && frame.renderScrollTop === 0 &&
        list !== null && list !== undefined && list.pending === 0 && list.end <= streamIndex &&
        stdout.writableLength === 0 && viewportLines(term).some(line => line.includes('dsh-TUI'))
    }))
  }

  const before = lastFrame()
  if (before === undefined) {
    check(`round ${round}: geometry trace 可用`, false, '未捕获到任何 scroll note（DSH_TUI_GEOMETRY_TRACE 未生效？）')
    break
  }
  check(`round ${round}: 上滚已打断跟随`, before.sticky === false)
  const screen = viewportLines(term)
  const anchorRow = screen.findIndex(line => /回复 \d+ 第|prime body|r\d body|S-HEAD/.test(line))
  check(`round ${round}: 可见正文锚点`, anchorRow >= 0)
  const anchor = screen[anchorRow]
  const screenMark = screens.length
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

  const observations = traceFrames().slice(mark)
  const frames = observations.flatMap(frame => frame.scroll)
  observedUnmount ||= observations.some(({ list }) =>
    list !== null && (list.start > streamIndex || list.end <= streamIndex))
  check(`round ${round}: 流式观察窗实际绘制过`, frames.length > 0 && screens.length > screenMark)
  const stickyBack = frames.find(frame => frame.sticky)
  const moved = frames.find(frame => frame.scrollTop !== before.scrollTop)
  const paintedMoved = frames.find(frame => frame.renderScrollTop !== before.renderScrollTop)
  check(`round ${round}: 流式期间未重新粘底`, stickyBack === undefined,
    stickyBack ? `sticky=true @H=${stickyBack.scrollHeight}` : `frames=${frames.length}`)
  check(`round ${round}: committed 位置不变`, moved === undefined,
    moved ? `${before.scrollTop} → ${moved.scrollTop}` : `scrollTop=${before.scrollTop}`)
  check(`round ${round}: 实际绘制位置不变`, paintedMoved === undefined,
    paintedMoved ? `${before.renderScrollTop} → ${paintedMoved.renderScrollTop}` : `renderScrollTop=${before.renderScrollTop}`)
  check(`round ${round}: xterm 正文锚点逐帧不变`, anchorRow >= 0 &&
    screens.slice(screenMark).every(frame => frame[anchorRow] === anchor), `row=${anchorRow} ${anchor}`)
}
check('流式行确实离开过虚拟窗口', observedUnmount)

stdin.write('\x1b[1;5F')
check('尾行重新挂载并恢复跟随', await settled(() => lastFrame()?.sticky === true &&
  viewportLines(term).some(line => line.includes('新消息 r3-8 一行'))))
stdin.write('\x1b[<64;50;30M')
check('真实收缩前已手动上滚', await settled(() => lastFrame()?.sticky === false))
const heightBeforeRemoval = lastFrame()?.scrollHeight ?? 0
stream.streaming = false
stream.text = 'SETTLED TAIL'
bump()
check('真实高度收缩已落帧', await settled(() =>
  (lastFrame()?.scrollHeight ?? heightBeforeRemoval) < heightBeforeRemoval))
// A shrink frame intentionally freezes once. Change a one-line sibling to
// produce a subsequent paint at the same content height, even if the rest
// of the ScrollBox tree is cached and the app would otherwise stay idle.
channel.rows.at(-1)!.text += '!'
bump()
check('同宽真实收缩会收敛到可达底部', await settled(() => {
  const frame = lastFrame()
  return frame !== undefined && frame.scrollHeight < heightBeforeRemoval &&
    frame.scrollTop <= frame.maxScroll && frame.sticky &&
    viewportLines(term).some(line => line.includes('SETTLED TAIL'))
}))
console.log('\nRendered screen:\n' + viewportLines(term).join('\n'))

await instance.unmount()
rmSync(TRACE, { force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
