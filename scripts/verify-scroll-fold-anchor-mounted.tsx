/**
 * A REAL shrink of a row the render ALREADY has mounted above the viewport must not
 * move the reader's rows.
 *
 * Unlike verify-scroll-fold-anchor.tsx's off-window card, this probe picks
 * `list.start`: already mounted in the previous commit, wholly above the
 * visible top, then really folded. Its fresh Yoga height must correct the
 * position before paint, without consuming a fallback estimate or waiting for
 * another React commit to restore the reader's line.
 *
 * Measured, not assumed: the card must be inside the window reported for the frame
 * BEFORE the fold (that window IS the previous commit's mounted set, which is what the
 * invalidation pass reads) and its own turn marker must be absent from the screen, so a
 * partially visible row — the PR's explicit non-goal — is rejected. Positions that
 * cannot supply such a row are nudged one wheel notch at a time; if none is found the
 * run exits non-zero instead of measuring something it did not mount.
 *
 * Assertions: the fold frame is observed, the committed position absorbs the real
 * shrink with no residual, and every parsed terminal write keeps the reader's line
 * at its original screen row. Sticky stays false, paint agrees with the committed
 * position, the position remains reachable, and no blank band opens above it.
 *
 * The card folds to SIX lines, never to the two-row DEFAULT_ROW_HEIGHT fallback: a fold
 * that lands exactly on the fallback makes any estimate look exact, which is how the
 * first version of this probe passed on the unfixed tree.
 *
 * Run: node --import tsx/esm scripts/verify-scroll-fold-anchor-mounted.tsx
 * Registered in the render-scroll CI group. Imports src/; no compiled lib/ required.
 * DSH_TEST_COLUMNS=60 tests narrow.
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

const TRACE = join(tmpdir(), `dsh-mounted-fold-anchor-${process.pid}.jsonl`)
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

// History: tall rows (12 lines) so the folding card is worth ~11 rows and the mount
// window can hold it entirely above the viewport plus the reader's own rows.
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
async function bail(why: string): Promise<never> {
  console.log(`\n前置条件不成立，未测量：${why}`)
  await instance.unmount()
  rmSync(TRACE, { force: true })
  process.exit(1)
}
await sleep(1200) // 固定窗:pacing 首屏就绪（trace 只在滚动几何变化的帧落 note）

// A live turn: the streaming tail keeps the transcript active, like the turn
// whose card folded in the report. It never grows after the prime phase, so any
// later content change on screen can only come from the fold below.
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
await sleep(700) // 固定窗:pacing 上滚落定后的静置窗（取样前）

const beforeFrame0 = lastNoteFrame()
if (beforeFrame0 === undefined || beforeFrame0.scroll.at(-1) === undefined) {
  await bail('geometry trace 未捕获到任何 scroll note（DSH_TUI_GEOMETRY_TRACE 未生效？）')
}

// Pick a card already mounted and entirely above the visible top. Overscan may
// begin on a partially visible tall row; reject it by its actual screen marker
// and nudge one notch instead of assuming a fixed gap from the window boundary.
let victim: ChatRow | undefined
let victimIndex = -1
let preFrame = beforeFrame0
for (let attempt = 0; attempt < 6 && victim === undefined; attempt++) {
  preFrame = lastNoteFrame() ?? preFrame
  const list = preFrame.list
  const index = list?.start ?? -1
  const candidate = index >= 0 ? channel.rows[index] : undefined
  const turn = (index + 1) / 2
  const visible = viewportLines(term).some(line => line.includes(`回复 ${turn} 第`) || line.includes(`问题 ${turn}`))
  if (candidate !== undefined && candidate.kind === 'assistant' && candidate.text.split('\n').length >= 8 && !visible) {
    victim = candidate
    victimIndex = index
    break
  }
  stdin.write('\x1b[<64;50;30M') // 一格上翻（3 行）
  await sleep(700) // 固定窗:pacing 上翻落定后重新取样挂载窗口
}
check('视口上方存在「已挂载且完全不可见」的待折叠卡片', victim !== undefined,
  victim === undefined
    ? `未找到：6 次取样中第一个挂载行都露在视口里（window ${preFrame.list?.start}..${preFrame.list?.end}）`
    : `index=${victimIndex} window ${preFrame.list?.start}..${preFrame.list?.end}`)
const mountedWindow = preFrame.list
if (victim === undefined || mountedWindow == null || preFrame.scroll.at(-1) === undefined) {
  await bail('找不到满足条件的折叠行')
}
// The previous commit's mounted set is exactly what the invalidation pass reads.
check('折叠行确实在本帧之前的挂载窗口内', victimIndex >= mountedWindow.start && victimIndex < mountedWindow.end,
  `index=${victimIndex} window ${mountedWindow.start}..${mountedWindow.end}`)
check('折叠行完全在视口上方（自身标记不在屏幕上）',
  !viewportLines(term).some(line => line.includes(`回复 ${(victimIndex + 1) / 2} 第`)))

const before = preFrame.scroll.at(-1)!
check('上滚已打断跟随', before.sticky === false)
const baselineScreen = viewportLines(term)
const baselineAnchorRow = baselineScreen.findIndex(line => /回复 \d+ 第|S-HEAD/.test(line))
check('可见正文锚点', baselineAnchorRow >= 0)
// xterm pads lines unevenly (each row's own trailing fill, the scrollbar column),
// so compare the visible text and its screen row — never the padding.
const baselineAnchor = (baselineScreen[baselineAnchorRow] ?? '').trimEnd()
if (baselineAnchorRow < 0) await bail('屏幕上找不到正文锚点行')

const foldBefore = before.scrollHeight
const topBefore = before.scrollTop
const frameMark = traceFrames().length
const screenMark = screens.length
victim.text = Array.from({ length: 6 }, (_, i) => `FOLDED ${i + 1}`).join('\n')
bump()
await sleep(1400) // 固定窗:探针 折叠落帧后的观察窗——「锚点行不动」是不得改变的不变式

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
// The mount window must cover the position it is painted at (the resolved thread's
// invariant — this probe must not reopen it).
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

// The reader's place, in two forms: the lines on screen must end where they started
// (a permanent residual shows up as a moved anchor line), and the committed position
// must have absorbed exactly the real shrink.
const last = frames.at(-1)
const endScreen = viewportLines(term)
const shrink = foldBefore - (last?.scrollHeight ?? foldBefore)
const applied = topBefore - (last?.scrollTop ?? topBefore)
const residual = shrink - applied
check('末帧锚点行复位（读者位置未丢）', (endScreen[baselineAnchorRow] ?? '').trimEnd() === baselineAnchor,
  `row=${baselineAnchorRow} ${baselineAnchor} → ${(endScreen[baselineAnchorRow] ?? '').trimEnd()}`)
check('锚点补偿无残差', residual === 0, `shrink=${shrink} applied=${applied} residual=${residual}`)
const postFoldScreens = screens.slice(screenMark)
const driftFrames = postFoldScreens.filter(frame => (frame[baselineAnchorRow] ?? '').trimEnd() !== baselineAnchor).length
check('绘制帧锚点行逐帧不变', postFoldScreens.length > 0 && driftFrames === 0,
  `drift=${driftFrames}/${postFoldScreens.length}`)

console.log('\n折叠后逐帧：')
for (const frame of observations) {
  for (const note of frame.scroll) {
    const l = frame.list
    console.log(`  f${frame.frame} ${frame.cause} top=${note.scrollTop} render=${note.renderScrollTop} ` +
      `H=${note.scrollHeight} max=${note.maxScroll} sticky=${note.sticky ? 1 : 0} shrunk=${note.shrunk ? 1 : 0}` +
      (l ? ` | list ${l.start}..${l.end}/${l.rowCount} tp=${l.topPad} bp=${l.bottomPad} total=${l.total}` : ''))
  }
}
console.log('\nRendered screen:\n' + viewportLines(term).join('\n'))

await instance.unmount()
rmSync(TRACE, { force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
