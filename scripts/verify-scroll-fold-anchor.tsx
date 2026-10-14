/**
 * A REAL shrink above a near-bottom manual anchor must not move the reader's rows.
 *
 * The renderer freezes the committed position on a shrink frame (the 9416bba2
 * measurement-artifact guard) while the same frame clamps the PAINT to the new
 * maxScroll. When the shrink is real — a folding thinking card, a settling tool
 * card — the frozen position can sit past the new maxScroll: paint and state
 * disagree, the reader's transcript drops a few rows, and the renderer's own
 * post-shrink clamp carries that offset into the scroll state. #1296 removed
 * the measurement artifact behind the original report (verify-post-shrink-anchor);
 * this is the real-shrink path it does not cover, and it needs no artifact at
 * all — a 12-line card folding to one line reproduces it.
 *
 * Scroll anchoring (MessageList -> ScrollBox.anchorBy) corrects the committed
 * position by the anchor row's own offset delta, so the row owning the viewport
 * top keeps its screen row. Assert exactly that: sticky stays false, the paint
 * never disagrees with the committed position, the committed position stays
 * inside the reachable range, the terminal text anchor is byte-identical frame
 * over frame, and the committed mount window covers the position it is painted
 * at (a window scanned against the PRE-correction position leaves the top
 * `base + topPad - scrollTop` rows of the viewport on the topPad spacer — a
 * blank band across the reader's rows). The run fails unless it actually
 * observed the fold frame, so a vacuous pass is impossible.
 *
 * Run: node --import tsx/esm scripts/verify-scroll-fold-anchor.tsx
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

const TRACE = join(tmpdir(), `dsh-scroll-fold-anchor-${process.pid}.jsonl`)
process.env.DSH_TUI_GEOMETRY_TRACE = TRACE

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { sleep, viewportLines }] = await Promise.all([
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

// History: tall rows (12 lines) so a fold above the window is worth ~11 rows
// and the mount window can hold the viewport plus overscan.
const rows: ChatRow[] = []
let nextId = 1
const TALL_LINES = 12
for (let turn = 1; turn <= 20; turn++) {
  rows.push({ id: nextId++, kind: 'user', text: `问题 ${turn}` })
  rows.push({
    id: nextId++, kind: 'assistant',
    text: Array.from({ length: TALL_LINES }, (_, i) => `回复 ${turn} 第 ${i + 1} 行的正文内容`).join('\n'),
  })
}

const listeners = new Set<() => void>()
const channel = {
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
  // Real default (`dsh-tui.smoothStreaming`): the reveal keeps text lengths
  // moving under the row-height estimates.
  smoothStreaming: true,
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

type GeometryFrame = { frame: number; cause: string; scroll: ScrollGeometryNote[]; list: ListGeometryNote | null }
function traceFrames(): GeometryFrame[] {
  try {
    return readFileSync(TRACE, 'utf8').trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as GeometryFrame)
  } catch { return [] }
}
/** Last frame that actually painted a ScrollBox (trailing frames may be other paints). */
function lastNoteFrame(): GeometryFrame | undefined {
  const frames = traceFrames()
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i]!.scroll.length > 0) return frames[i]
  }
  return undefined
}

const stdin = new FakeStdin()
const stdout = new FakeStdout()
const instance = await render(
  <AlternateScreen>
    <Chat channel={channel as unknown as Channel} questionStore={new QuestionStore()} fullscreen />
  </AlternateScreen>,
  { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, stderr: new FakeStderr() as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false },
)
await sleep(1200) // 固定窗:pacing 首屏就绪（trace 只在滚动几何变化的帧落 note）

// A live turn: the streaming tail keeps the transcript active, like the turn
// whose card folded in the report.
const stream: ChatRow = { id: nextId++, kind: 'assistant', text: 'S-HEAD', streaming: true }
const streamIndex = channel.rows.length
channel.rows.push(stream)
bump()
await sleep(600) // 固定窗:pacing 流式行首次布局落定
for (let i = 0; i < 4; i++) {
  stream.text += `\nS-HEAD body ${i + 1}`
  bump()
  await sleep(150) // 固定窗:pacing prime 阶段每行各自落帧
}
await sleep(400) // 固定窗:pacing prime 阶段收尾

stdin.write('\x1b[1;5F') // Ctrl+End → 回底
await sleep(700) // 固定窗:pacing 等 Ctrl+End 回底生效
stdin.write('\x1b[<64;50;30M') // 一格上翻（3 行）——贴底停住
await sleep(700) // 固定窗:pacing 上滚落定后的静置窗（基线帧取样前）

const beforeFrame = lastNoteFrame()
const before = beforeFrame?.scroll.at(-1)
if (before === undefined || beforeFrame === undefined) {
  check('geometry trace 可用', false, '未捕获到任何 scroll note（DSH_TUI_GEOMETRY_TRACE 未生效？）')
  await instance.unmount()
  rmSync(TRACE, { force: true })
  process.exit(1)
}
check('上滚已打断跟随', before.sticky === false)
const baselineScreen = viewportLines(term)
const baselineAnchorRow = baselineScreen.findIndex(line => /回复 \d+ 第|S-HEAD/.test(line))
check('可见正文锚点', baselineAnchorRow >= 0)
const baselineAnchor = baselineScreen[baselineAnchorRow]

// The folding card sits ABOVE the viewport (the reported shape: the thinking
// card collapses as the answer streams below it), so the rows the reader is
// looking at keep their content offsets and only the spacer above them moves.
const listStart = beforeFrame.list?.start ?? Math.max(0, streamIndex - 10)
let victim: ChatRow | undefined
for (let i = Math.min(listStart - 1, streamIndex - 1); i >= 0; i--) {
  const candidate = channel.rows[i]!
  if (candidate.kind === 'assistant' && candidate.text.split('\n').length >= 8) { victim = candidate; break }
}
check('视口上方的待折叠卡片存在', victim !== undefined, `window start=${listStart}`)
if (victim === undefined) {
  await instance.unmount()
  rmSync(TRACE, { force: true })
  process.exit(1)
}
const foldBefore = lastNoteFrame()?.scroll.at(-1)?.scrollHeight ?? 0
const frameMark = traceFrames().length
const screenMark = screens.length
victim.text = 'FOLDED'
bump()
await sleep(1200) // 固定窗:探针 折叠落帧后的观察窗——「锚点行原地不动」是不得改变的不变式

const observations = traceFrames().slice(frameMark)
const frames = observations.flatMap(frame => frame.scroll)
check('折叠帧确实观察到', frames.some(note => note.shrunk || note.scrollHeight < foldBefore),
  `frames=${frames.length} H ${foldBefore} → ${frames.at(-1)?.scrollHeight ?? foldBefore}`)
check('折叠期间未重新粘底', !frames.some(note => note.sticky))
const paintDisagreed = frames.find(note => note.renderScrollTop !== note.scrollTop)
check('绘制与 committed 始终一致', paintDisagreed === undefined,
  paintDisagreed ? `top=${paintDisagreed.scrollTop} render=${paintDisagreed.renderScrollTop}` : `frames=${frames.length}`)
const unreachable = frames.find(note => note.scrollTop > note.maxScroll)
check('committed 位置始终可达', unreachable === undefined,
  unreachable ? `top=${unreachable.scrollTop} max=${unreachable.maxScroll}` : `frames=${frames.length}`)
// The mount window must cover the position it is painted at. `base + topPad` is
// the Yoga top of the first mounted row, so a positive band means the viewport
// top sits inside the topPad spacer and that many rows of the reader's view are
// blank. One legitimate exception: a paint pinned to the burst-scroll clamp
// (renderScrollTop === clampMin) is deliberately held at the mounted edge.
let bandFrame: { frame: number; cause: string; band: number } | undefined
for (const frame of observations) {
  const list = frame.list
  if (list === null || list.sticky) continue
  for (const note of frame.scroll) {
    const band = list.base + list.topPad - note.renderScrollTop
    if (band > 0 && !note.sticky && note.renderScrollTop !== note.clampMin && bandFrame === undefined) {
      bandFrame = { frame: frame.frame, cause: frame.cause, band }
    }
  }
}
check('无空白带（窗口覆盖绘制位置）', bandFrame === undefined,
  bandFrame ? `f${bandFrame.frame} ${bandFrame.cause} band=${bandFrame.band}` : `frames=${frames.length}`)
check('xterm 正文锚点逐帧不变', screens.slice(screenMark).every(frame => frame[baselineAnchorRow] === baselineAnchor),
  `row=${baselineAnchorRow} ${baselineAnchor}`)
if (paintDisagreed !== undefined || bandFrame !== undefined) {
  for (const frame of observations) {
    for (const note of frame.scroll) {
      const l = frame.list
      console.log(`    f${frame.frame} ${frame.cause} top=${note.scrollTop} render=${note.renderScrollTop} ` +
        `H=${note.scrollHeight} max=${note.maxScroll} sticky=${note.sticky ? 1 : 0} shrunk=${note.shrunk ? 1 : 0}` +
        (l ? ` | list ${l.start}..${l.end}/${l.rowCount} tp=${l.topPad} bp=${l.bottomPad} total=${l.total}` : ''))
    }
  }
}
console.log('\nRendered screen:\n' + viewportLines(term).join('\n'))

await instance.unmount()
rmSync(TRACE, { force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
