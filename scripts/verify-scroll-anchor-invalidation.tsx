/**
 * A height-cache invalidation that leaves the real layout alone must not scroll
 * the reader.
 *
 * Ctrl+O re-signs every row's height inputs. For a row whose rendered height does
 * not follow `expanded` (a plain prompt) that drops the cached Yoga height while
 * the layout stays byte-identical — so offsets[] and ONLY offsets[] falls back to
 * DEFAULT_ROW_HEIGHT. Anchoring the committed position on that fallback delta
 * carries the reader to earlier content that never moved (PR #1536).
 *
 * The fixture keeps the WHOLE list inside the mount window (start 0, end =
 * rowCount) with nothing above it, so topPad/bottomPad stay 0 and the real Yoga
 * layout cannot move by any other path: the anchor correction is the only thing
 * that can touch the committed position during the toggle. The run asserts that
 * isolation, so a fixture that stops isolating the path fails loudly instead of
 * passing vacuously.
 *
 * Run: node --import tsx/esm scripts/verify-scroll-anchor-invalidation.tsx
 * Imports src/; no compiled lib/ required. DSH_TEST_COLUMNS=60 tests narrow.
 */
process.env.NODE_ENV = 'production'
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, rmSync } from 'node:fs'
import type { ChatRow } from '../src/dsh-adapter/channel.js'
import type { ScrollBoxHandle } from '../src/ui.js'
import type { ListGeometryNote, ScrollGeometryNote } from '../src/ink/geometry-trace.js'
import type { ReactNode } from 'react'

const TRACE = join(tmpdir(), `dsh-anchor-invalidation-${process.pid}.jsonl`)
process.env.DSH_TUI_GEOMETRY_TRACE = TRACE

const [React, { PassThrough, Writable }, { Terminal: XTerm }, ui, { MessageList }, { sleep, viewportLines }] = await Promise.all([
  import('react'),
  import('node:stream'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/MessageList.js'),
  import('./lib/term-test.mjs'),
])
const { Box, Text, ScrollBox, AlternateScreen, render, useInput } = ui

const COLS = Number(process.env.DSH_TEST_COLUMNS ?? 100), ROWS = 35
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

// Fixture: eleven plain prompts, three lines each (4 rows with the block
// margin, 3 for the first). The whole list lands just past the viewport so the
// mount window covers all of it — see the header note.
const rows: ChatRow[] = []
for (let i = 0; i < 11; i++) {
  rows.push({
    id: i + 1,
    kind: 'user',
    text: Array.from({ length: 3 }, (_, k) => `提示 ${i} 第 ${k + 1} 行`).join('\n'),
  })
}

type GeometryFrame = { frame: number; cause: string; scroll: ScrollGeometryNote[]; list: ListGeometryNote | null }
function traceFrames(): GeometryFrame[] {
  try {
    return readFileSync(TRACE, 'utf8').trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as GeometryFrame)
  } catch { return [] }
}
/** Last frame that actually painted a ScrollBox. */
function lastNoteFrame(): GeometryFrame | undefined {
  const frames = traceFrames()
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i]!.scroll.length > 0) return frames[i]
  }
  return undefined
}
/** Last frame whose MessageList render published the mount window. */
function lastListNote(): ListGeometryNote | undefined {
  const frames = traceFrames()
  for (let i = frames.length - 1; i >= 0; i--) {
    const list = frames[i]!.list
    if (list !== null) return list
  }
  return undefined
}

let handle: ScrollBoxHandle | null = null
const noop = (): void => {}
const expandedRows = new Set<number>()

/** The real Ctrl+O path in miniature: the toggle only flips `expanded` (Chat's
 *  setExpanded), and the plain prompts it re-signs do not render differently. */
function Harness(): ReactNode {
  const [expanded, setExpanded] = React.useState(false)
  const [scroll, setScroll] = React.useState<ScrollBoxHandle | null>(null)
  handle = scroll
  useInput((input, key) => {
    if (key.ctrl && input === 'o') setExpanded(previous => !previous)
  })
  return (
    <Box height={ROWS} flexDirection="column">
      <Box height={ROWS - 1} flexDirection="column">
        <ScrollBox ref={setScroll} flexGrow={1} flexShrink={1} flexDirection="column" stickyScroll>
          <MessageList
            rows={rows}
            expanded={expanded}
            expandedRows={expandedRows}
            selectedId={null}
            onToggleRow={noop}
            model="test"
            showAll
            onToggleAll={noop}
            historyPaintEnabled={false}
            scrollHandle={scroll}
          />
        </ScrollBox>
      </Box>
      <Text>{expanded ? 'STATE-EXPANDED' : 'STATE-COLLAPSED'}</Text>
    </Box>
  )
}

const stdin = new FakeStdin()
const stdout = new FakeStdout()
const instance = await render(
  <AlternateScreen>
    <Harness />
  </AlternateScreen>,
  {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  },
)
await sleep(600) // 固定窗:pacing 首屏与首次测量落定（无单一可轮询的完成锚点）

const scroll = handle as ScrollBoxHandle | null
if (scroll === null) {
  check('ScrollBox 句柄可用', false)
  await instance.unmount()
  rmSync(TRACE, { force: true })
  process.exit(1)
}

// Park the reader ONE row above the bottom: sticky off, pending drained, and
// (asserted below) still inside the fully-mounted window.
scroll.scrollToBottom()
await sleep(300) // 固定窗:pacing 回底落定
scroll.scrollBy(-1)
await sleep(400) // 固定窗:pacing 上滚 drain 落定

const beforeFrame = lastNoteFrame()
const before = beforeFrame?.scroll.at(-1)
const list = lastListNote() ?? null
if (before === undefined || list === null) {
  check('geometry trace 可用', false,
    `frames=${traceFrames().length} scrollNote=${before !== undefined} listNote=${list !== null}`)
  await instance.unmount()
  rmSync(TRACE, { force: true })
  process.exit(1)
}
// Isolation: everything mounted (topPad/bottomPad 0) and following already off.
check('窗口覆盖整个列表（隔离锚定路径）',
  list.start === 0 && list.end >= list.rowCount && list.topPad === 0 && list.bottomPad === 0,
  `list ${list.start}..${list.end}/${list.rowCount} tp=${list.topPad} bp=${list.bottomPad} total=${list.total}`)
check('上滚已打断跟随', before.sticky === false, `sticky=${before.sticky ? 1 : 0}`)
const scrollBefore = scroll.getScrollTop()
check('读者停在列表中部（未贴底）', scrollBefore > 0, `scrollTop=${scrollBefore}`)
const screenBefore = viewportLines(term)
const anchor = screenBefore.find(line => /提示 \d+ 第 1 行/.test(line))
check('可见正文锚点', anchor !== undefined)
check('展开前界面处于收起态', screenBefore.some(line => line.includes('STATE-COLLAPSED')))

const mark = traceFrames().length
const screenMark = screens.length
stdin.write('\x0f') // Ctrl+O
await sleep(900) // 固定窗:探针 失效与重测期间的观察窗——「位置不得被估算差改动」是不得改变的不变量

const observed = traceFrames().slice(mark)
const notes = observed.flatMap(frame => frame.scroll)
const after = screens.slice(screenMark)
check('Ctrl+O 确实生效', after.some(frame => frame.some(line => line.includes('STATE-EXPANDED'))),
  `screens=${after.length}`)
// Read the committed position off the handle: a corrected anchor writes through
// anchorBy (and leaves a scroll note), a suppressed one writes nothing at all —
// the absence of notes is the expected shape here, so the handle is the oracle.
const scrollAfter = scroll.getScrollTop()
const moved = notes.find(note => note.scrollTop !== scrollBefore)
check('失效高度未改动 committed 位置', scrollAfter === scrollBefore && moved === undefined,
  moved ? `${scrollBefore} → ${moved.scrollTop} @H=${moved.scrollHeight}`
    : `scrollTop=${scrollBefore} → ${scrollAfter} notes=${notes.length}`)
check('转录正文逐帧不变', anchor !== undefined && after.every(frame => frame.includes(anchor)),
  `anchor="${anchor}"`)
if (moved !== undefined) {
  for (const frame of observed) {
    const l = frame.list
    for (const note of frame.scroll) {
      console.log(`    f${frame.frame} ${frame.cause} top=${note.scrollTop} render=${note.renderScrollTop} ` +
        `H=${note.scrollHeight} max=${note.maxScroll} sticky=${note.sticky ? 1 : 0}` +
        (l ? ` | list ${l.start}..${l.end}/${l.rowCount} tp=${l.topPad} bp=${l.bottomPad} total=${l.total}` : ''))
    }
  }
}
console.log('\nRendered screen:\n' + viewportLines(term).join('\n'))

await instance.unmount()
rmSync(TRACE, { force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
