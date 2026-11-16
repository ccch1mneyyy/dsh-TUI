/**
 * verify-selection-scroll-copy — cross-page selection copy (issues #438/#1272).
 *
 * A. While a mouse drag is live, PgUp/PgDn or the wheel scrolls the
 *    transcript. The anchor must stay text-anchored, the focus must stay
 *    under the pointer, and the copy must include every row that scrolled
 *    out — exactly once, in reading order.
 * B. After the drag is released, scrolling must move BOTH endpoints with the
 *    text. A selection that scrolls fully off-screen stays alive (captured
 *    rows remain copyable) and a reverse scroll restores its coordinates.
 *
 * The renderer used to translate selections by the requested scrollTop while
 * the virtual-scroll clamp held the paint at the mounted-window edge. That
 * captured the same rows across drain frames (duplicates) and dropped the
 * tail once both endpoints clamped. These assertions compare the copied
 * marker sequence, not just scrollTop.
 *
 * Run: node --import tsx/esm scripts/verify-selection-scroll-copy.tsx
 */
export {} // module boundary for the top-level await harness

import './lib/fake-home.mjs'
import './lib/default-lang-zh.mjs'
import type { DOMElement } from '../src/ink/dom.js'
import type { ScrollBoxHandle } from '../src/ink/components/ScrollBox.js'
import type { SelectionState } from '../src/ink/selection.js'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'
process.env.SSH_CONNECTION = 'headless-repro'
delete process.env.TMUX

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, AlternateScreen, Box, Text, ScrollBox, useInput },
  { Chat },
  { QuestionStore },
  { LOCAL_COMMANDS, completeCommands },
  termTest,
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
  import('./lib/term-test.mjs'),
])
const { default: instances } = await import('../src/ink/instances.js')
const { sleep, settle, settled, viewportLines } = termTest

const COLS = 110
const ROWS = 36
const START = 20
const END = 24
const LINE = (i: number) => `LINE_${String(i).padStart(3, '0')}_${'x'.repeat(50)}`

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}

function makeRows(): any[] {
  const rows: any[] = []
  for (let i = 0; i < 80; i++) {
    rows.push({ id: i * 2, kind: 'user', text: `用户 ${i}`, time: 1_700_000_000_000 + i * 8000 })
    rows.push({
      id: i * 2 + 1,
      kind: 'assistant',
      text: LINE(i),
      time: 1_700_000_000_000 + i * 8000 + 3000,
    })
  }
  return rows
}

function makeChannel(rows: any[]): any {
  return {
    whaleIdle: false,
    version: 0,
    rows,
    status: 'idle',
    sessionTitle: 'selection-scroll-copy',
    agentId: 'probe',
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    reasoningEffort: 'max',
    effortLevels: [],
    tokens: { input: 0, output: 0 },
    cwd: '/tmp/demo',
    displayCwd: '/tmp/demo',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting',
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    pending: [],
    commandList: LOCAL_COMMANDS,
    notifications: [],
    mode: { plan: false, sandbox: undefined },
    activityFrames: 'moon8',
    agentPreset: undefined,
    subagents: [],
    subscribe: () => () => {},
    submit: () => {},
    cancel: () => {},
    clear: () => {},
    notify: () => {},
    listModels: () => Promise.resolve([]),
    listSessions: () => Promise.resolve([]),
    deleteSession: () => Promise.resolve(true),
    renameSessionTo: () => Promise.resolve(true),
    setResumeTarget: () => {},
    loadOlder: () => {},
    mcpStatus: () => [],
    pushLocal: () => {},
    commandCompletions: (input: string) => completeCommands(input),
  }
}

class FakeStderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _e: BufferEncoding, cb: () => void): void { cb() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

type ScrollNode = {
  scrollTop?: number
  scrollHeight?: number
  scrollViewportHeight?: number
  scrollViewportTop?: number
  scrollPaintedTop?: number
  scrollFollowPending?: boolean
  childNodes?: ScrollNode[]
}
type SelectionSnapshot = {
  anchor: { col: number; row: number } | null
  focus: { col: number; row: number } | null
}

type Rig = {
  term: InstanceType<typeof XTerm>
  stdin: FakeStdin
  ink: any
  node: ScrollNode
  lines: () => string[]
  find: (marker: string) => { row: number; col: number } | null
  scrollTo: (marker: string) => Promise<void>
  press: (col: number, row: number) => void
  drag: (col: number, row: number) => void
  release: (col: number, row: number) => void
  wheel: (direction: 'up' | 'down', ticks: number) => Promise<void>
  page: (direction: 'up' | 'down') => Promise<void>
  copyMarkers: () => number[]
  copyText: () => string
  state: () => SelectionSnapshot
  unmount: () => Promise<void>
}

function transcriptNode(root: ScrollNode | undefined): ScrollNode | undefined {
  let best: ScrollNode | undefined
  const walk = (node: ScrollNode): void => {
    if (
      (node.scrollViewportHeight ?? 0) > 0 &&
      (best === undefined ||
        (node.scrollViewportHeight ?? 0) > (best.scrollViewportHeight ?? 0))
    ) {
      best = node
    }
    for (const child of node.childNodes ?? []) walk(child)
  }
  if (root) walk(root)
  return best
}

async function mount(): Promise<Rig> {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void {
      term.write(String(chunk), cb)
    }
  }
  const stdout = new FakeStdout()
  const stdin = new FakeStdin()
  const tree = (
    <AlternateScreen>
      <Chat channel={makeChannel(makeRows())} questionStore={new QuestionStore()} fullscreen />
    </AlternateScreen>
  )
  const instance = await render(tree, {
    stdout: stdout as never,
    stdin: stdin as never,
    stderr: new FakeStderr() as never,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  const ink = instances.get(stdout as never)
  if (ink) instances.set(process.stdout, ink)
  // 固定窗:pacing 等首帧铺满与鼠标/选区 hook 挂接，无单一可轮询锚点。
  await sleep(900)
  const node = transcriptNode(ink?.rootNode as ScrollNode | undefined)
  if (!node) throw new Error('transcript ScrollBox not found')

  const lines = (): string[] => viewportLines(term, ROWS)
  const find = (marker: string): { row: number; col: number } | null => {
    const ls = lines()
    for (let row = 0; row < ls.length; row++) {
      const col = ls[row]!.indexOf(marker)
      if (col >= 0) return { row, col }
    }
    return null
  }
  const waitScrollSettled = async (): Promise<void> => {
    let last = node.scrollTop ?? 0
    let stable = 0
    for (let i = 0; i < 80; i++) {
      // 固定窗:pacing 等 drain 的滚动目标落定；scrollTop 连续两次不变
      // 才认为动画结束，单次变化可能只是首帧。
      await sleep(40)
      const now = node.scrollTop ?? 0
      if (now === last) stable++
      else stable = 0
      last = now
      if (stable >= 2) break
    }
    // The request can settle while the virtual-scroll clamp still holds the
    // painted position back; wait for the deferred selection delta too.
    await settle(() => node.scrollFollowPending !== true, { timeoutMs: 3000 })
    // 固定窗:pacing 等选区跟随与 copy 缓冲落在同一帧后。
    await sleep(80)
  }
  const wheel = async (direction: 'up' | 'down', ticks: number): Promise<void> => {
    const button = direction === 'up' ? 64 : 65
    const before = node.scrollTop ?? 0
    for (let i = 0; i < ticks; i++) {
      stdin.write(`\x1b[<${button};${Math.floor(COLS / 2)};${Math.floor(ROWS / 2)}M`)
      // 固定窗:pacing 多格滚轮逐格发送，避免被合并成一次大 delta。
      await sleep(35)
    }
    await settle(() => (node.scrollTop ?? 0) !== before, { timeoutMs: 3000 })
    await waitScrollSettled()
  }
  const page = async (direction: 'up' | 'down'): Promise<void> => {
    const before = node.scrollTop ?? 0
    stdin.write(direction === 'up' ? '\x1b[5~' : '\x1b[6~')
    await settled(() => (node.scrollTop ?? 0) !== before, { timeoutMs: 3000 })
    await waitScrollSettled()
  }
  const scrollTo = async (marker: string): Promise<void> => {
    for (let i = 0; i < 600; i++) {
      const at = find(marker)
      if (at && at.row <= 10) return
      stdin.write(`\x1b[<64;${Math.floor(COLS / 2)};${Math.floor(ROWS / 2)}M`)
      // 固定窗:pacing 轮询步长，条件见循环（每步都要发一次滚轮）。
      await sleep(12)
    }
    await settle(() => Boolean(find(marker)), { timeoutMs: 3000 })
    // 固定窗:pacing 等 pinned header 的挂载/卸载把视口顶边落定。
    await sleep(200)
  }
  const rig: Rig = {
    term,
    stdin,
    ink,
    node,
    lines,
    find,
    scrollTo,
    press: (col, row) => stdin.write(`\x1b[<0;${col + 1};${row + 1}M`),
    drag: (col, row) => stdin.write(`\x1b[<32;${col + 1};${row + 1}M`),
    release: (col, row) => stdin.write(`\x1b[<0;${col + 1};${row + 1}m`),
    wheel,
    page,
    copyMarkers: () => [],
    copyText: () => '',
    state: () => ({ anchor: null, focus: null }),
    unmount: async () => {
      await instance.unmount()
      instances.delete(stdout as never)
      if (ink) instances.delete(process.stdout)
      term.dispose()
    },
  }
  rig.copyText = () => rig.ink.copySelectionNoClear() as string
  rig.copyMarkers = () => {
    const text = rig.copyText()
    return [...text.matchAll(/LINE_(\d{3})/g)].map((m: RegExpMatchArray) =>
      Number(m[1]),
    )
  }
  rig.state = () => ({
    anchor: rig.ink.selection?.anchor ? { ...rig.ink.selection.anchor } : null,
    focus: rig.ink.selection?.focus ? { ...rig.ink.selection.focus } : null,
  })
  return rig
}

// The source marker under/before the settled pointer is the independent end
// oracle. Deriving this from copied markers would bless a truncated tail.
function visibleMarkerEnd(rig: Rig, row: number, col: number): number {
  const markers = rig.lines().slice(0, row + 1).flatMap((line, index) =>
    [...line.matchAll(/LINE_(\d{3})/g)]
      .filter(match => index < row || match.index + match[0].length - 1 <= col)
      .map(match => Number(match[1])),
  )
  if (markers.length === 0) throw new Error('no source marker before the pointer')
  return markers[markers.length - 1]!
}

function contiguous(tag: string, markers: number[], start: number, end: number): number {
  const expected = Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => start + i)
  check(`${tag}: 复制行精确覆盖指针之前的源行`, JSON.stringify(markers) === JSON.stringify(expected), `actual=${markers.join(',')} expected=${expected.join(',')}`)
  return end
}

function exact(tag: string, markers: number[], expected: number[]): void {
  check(`${tag}: 复制内容精确`, JSON.stringify(markers) === JSON.stringify(expected), markers.join(','))
}

async function scenarioA(): Promise<void> {
  const rig = await mount()
  try {
    await rig.scrollTo(`LINE_${String(START).padStart(3, '0')}`)
    const start = rig.find(`LINE_${String(START).padStart(3, '0')}`)
    check('A 前置：起始行可见', start !== null)
    if (!start) return
    const bottom = Math.min(
      ROWS - 1,
      (rig.node.scrollViewportTop ?? 0) + (rig.node.scrollViewportHeight ?? 1) - 1,
    )
    rig.press(start.col, start.row)
    // 固定窗:pacing press→motion 步间。
    await sleep(60)
    rig.drag(start.col + 20, bottom)
    // 固定窗:pacing motion→翻页步间。
    await sleep(100)

    check('A 拖拽中：focus 留在指针对应的下边缘', rig.state().focus?.row === bottom, JSON.stringify(rig.state()))

    await rig.page('down')
    const first = contiguous('A PgDn', rig.copyMarkers(), START, visibleMarkerEnd(rig, bottom, start.col + 20))
    check('A PgDn: 选区扩展到了新页', first >= 30, `end=${first}`)
    check('A PgDn: focus 仍留在下边缘', rig.state().focus?.row === bottom, JSON.stringify(rig.state()))

    await rig.page('down')
    const second = contiguous('A PgDn2', rig.copyMarkers(), START, visibleMarkerEnd(rig, bottom, start.col + 20))
    check('A PgDn2: 继续向下扩展', second > first, `${first} -> ${second}`)

    await rig.page('up')
    const back = contiguous('A PgUp', rig.copyMarkers(), START, visibleMarkerEnd(rig, bottom, start.col + 20))
    check('A PgUp: 反向滚动不重复且回到上一页', back <= second, `${second} -> ${back}`)

    await rig.wheel('down', 8)
    const wheelDown = contiguous('A wheel down', rig.copyMarkers(), START, visibleMarkerEnd(rig, bottom, start.col + 20))
    check('A wheel down: 滚轮也扩展选区', wheelDown > back, `${back} -> ${wheelDown}`)
    await rig.wheel('up', 8)
    const wheelBack = contiguous('A wheel up', rig.copyMarkers(), START, visibleMarkerEnd(rig, bottom, start.col + 20))
    check('A wheel up: 反向滚轮不重复且收回', wheelBack <= wheelDown, `${wheelDown} -> ${wheelBack}`)
  } finally {
    await rig.unmount()
  }
}

async function scenarioB(): Promise<void> {
  const rig = await mount()
  try {
    await rig.scrollTo(`LINE_${String(START).padStart(3, '0')}`)
    const start = rig.find(`LINE_${String(START).padStart(3, '0')}`)
    const end = rig.find(`LINE_${String(END).padStart(3, '0')}`)
    check('B 前置：起止行同屏', start !== null && end !== null)
    if (!start || !end) return
    rig.press(start.col, start.row)
    // 固定窗:pacing press 后 pinned header 可能改变视口顶边，重新定位终点。
    await sleep(100)
    const endNow = rig.find(`LINE_${String(END).padStart(3, '0')}`) ?? end
    rig.drag(Math.min(COLS - 2, endNow.col + 70), endNow.row)
    // 固定窗:pacing motion→release 步间。
    await sleep(80)
    rig.release(Math.min(COLS - 2, endNow.col + 70), endNow.row)
    // 固定窗:pacing 等 copy-on-select 松手轮次结束。
    await sleep(300)
    const original = rig.state()
    const expected = Array.from({ length: END - START + 1 }, (_, i) => START + i)
    exact('B 松手后', rig.copyMarkers(), expected)
    const releasedText = rig.copyText()

    await rig.wheel('down', 8)
    exact('B 滚轮向下（选区已离屏）', rig.copyMarkers(), expected)
    check('B 滚轮向下不追加边缘行', rig.copyText() === releasedText, JSON.stringify(rig.copyText().slice(-60)))
    await rig.wheel('up', 8)
    exact('B 滚轮向上回到原位', rig.copyMarkers(), expected)
    check('B 滚轮向上文本复原', rig.copyText() === releasedText, JSON.stringify(rig.copyText().slice(-60)))
    check(
      'B 反向滚动恢复 anchor/focus',
      JSON.stringify(rig.state()) === JSON.stringify(original),
      `${JSON.stringify(original)} -> ${JSON.stringify(rig.state())}`,
    )

    await rig.page('down')
    exact('B PgDn', rig.copyMarkers(), expected)
    await rig.page('down')
    exact('B PgDn2', rig.copyMarkers(), expected)
    await rig.page('up')
    exact('B PgUp', rig.copyMarkers(), expected)
    await rig.page('up')
    exact('B PgUp2 回到原位', rig.copyMarkers(), expected)
  } finally {
    await rig.unmount()
  }
}


async function scenarioBottomEdge(): Promise<void> {
  const rig = await mount()
  try {
    await rig.scrollTo('LINE_070')
    const start = rig.find('LINE_070')
    const end = rig.find('LINE_074')
    check('B 底部前置：起止行同屏', start !== null && end !== null)
    if (!start || !end) return
    rig.press(start.col, start.row)
    // 固定窗:pacing press 后 pinned header 可能改变视口顶边，重新定位终点。
    await sleep(100)
    const endNow = rig.find('LINE_074') ?? end
    rig.drag(Math.min(COLS - 2, endNow.col + 70), endNow.row)
    // 固定窗:pacing motion→release 步间。
    await sleep(80)
    rig.release(Math.min(COLS - 2, endNow.col + 70), endNow.row)
    // 固定窗:pacing 等 copy-on-select 松手轮次结束。
    await sleep(300)
    const expected = [70, 71, 72, 73, 74]
    exact('B 底部松手后', rig.copyMarkers(), expected)
    const releasedText = rig.copyText()

    await rig.wheel('down', 20)
    check('B 已实际绘制到最底边界', await settled(() => {
      const max = (rig.node.scrollHeight ?? 0) - (rig.node.scrollViewportHeight ?? 0)
      return max > 0 && rig.node.scrollTop === max && rig.node.scrollPaintedTop === max && rig.node.scrollFollowPending !== true
    }), `requested=${rig.node.scrollTop} painted=${rig.node.scrollPaintedTop}`)
    exact('B 滚到最底', rig.copyMarkers(), expected)
    check(
      'B 滚到最底不追加边缘行',
      rig.copyText() === releasedText,
      JSON.stringify(rig.copyText().slice(-80)),
    )
    check(
      'B 滚到最底时 focus 仍指向选区末行',
      rig.lines()[rig.state().focus?.row ?? 0]?.includes('LINE_074') === true,
      `focus=${JSON.stringify(rig.state().focus)} line=${JSON.stringify(rig.lines()[rig.state().focus?.row ?? 0]?.slice(0, 30))}`,
    )
  } finally {
    await rig.unmount()
  }
}

async function scenarioFooterGuard(): Promise<void> {
  const rig = await mount()
  try {
    await rig.scrollTo(`LINE_${String(START).padStart(3, '0')}`)
    const start = rig.find(`LINE_${String(START).padStart(3, '0')}`)
    if (!start) { check('footer guard 前置：起始行可见', false); return }
    rig.press(start.col, start.row)
    // 固定窗:pacing press→motion 步间。
    await sleep(60)
    rig.drag(start.col + 30, ROWS - 1)
    // 固定窗:pacing motion→wheel 步间。
    await sleep(100)
    const before = rig.state()
    await rig.wheel('down', 4)
    check(
      '跨到 footer 的选区不被滚轮硬拉进 ScrollBox',
      rig.state().focus?.row === before.focus?.row,
      `${JSON.stringify(before)} -> ${JSON.stringify(rig.state())}`,
    )
  } finally {
    await rig.unmount()
  }
}

// Small fixtures keep the coordinate oracle independent of Chat's layout and
// virtualization. All mutations still enter the real ScrollBox handle or SGR
// input pipeline; only the terminal streams are fake.
type ProbeInk = {
  readonly rootNode: DOMElement
  readonly selection: SelectionState
  copySelectionNoClear(): string
  clearTextSelection(): void
  setSelectionBgColor(color: string): void
}
type ProbeLayout = { top: number; height: number; prefix: number }
const SOURCE = Array.from({ length: 100 }, (_, i) => `LINE_${String(i).padStart(2, '0')}_abcdefghij`)

function sourceSelection(first: number, last: number, firstCol = 0, lastCol = SOURCE[last]!.length - 1): string {
  return SOURCE.slice(first, last + 1).map((line, index) => {
    const begin = index === 0 ? firstCol : 0
    const end = first + index === last ? lastCol + 1 : line.length
    return line.slice(begin, end)
  }).join('\n')
}

async function ready(label: string, predicate: () => boolean): Promise<void> {
  if (!await settled(predicate)) throw new Error(`fixture did not settle: ${label}`)
}

async function mountProbe(pane = false, source: readonly string[] = SOURCE) {
  const cols = 40
  const rows = 14
  const left = pane ? 10 : 0
  const width = pane ? 20 : cols
  const term = new XTerm({ cols, rows, scrollback: 100, allowProposedApi: true })
  class ProbeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, done: () => void): void { term.write(String(chunk), done) }
  }
  const stdout = new ProbeStdout()
  const stdin = new FakeStdin()
  const scroll = React.createRef<ScrollBoxHandle>()
  const sourceNodes = source.map(() => React.createRef<DOMElement>())
  let inputReady = false
  let layout: ProbeLayout = { top: 0, height: 10, prefix: 0 }
  function Scene() {
    useInput((input, key) => {
      if (input === 'x') inputReady = true
      if (key.pageDown) scroll.current?.scrollBy(8)
      if (key.pageUp) scroll.current?.scrollBy(-8)
    })
    return <Box width={cols} height={rows} flexDirection="row">
      {pane && <Box width={left} flexShrink={0}><Text>LEFT</Text></Box>}
      <Box width={width} height={rows} flexDirection="column"
        selectionPane={pane ? 'selection-regression-right' : undefined}
        selectionPaneViewport={pane || undefined}>
        {layout.top > 0 && <Box height={layout.top} flexShrink={0}><Text>HEADER</Text></Box>}
        <ScrollBox ref={scroll} width={width} height={layout.height} flexDirection="column" flexShrink={0}>
          {Array.from({ length: layout.prefix }, (_, i) => <Box key={`prefix-${i}`} height={1} flexShrink={0}><Text>PREFIX</Text></Box>)}
          {source.map((line, i) => <Box key={i} ref={sourceNodes[i]} height={1} flexShrink={0}><Text>{line}</Text></Box>)}
        </ScrollBox>
        <Text>FOOTER</Text>
      </Box>
    </Box>
  }
  const tree = () => <AlternateScreen><Scene /></AlternateScreen>
  let frames = 0
  const app = await render(tree(), {
    stdout: stdout as never, stdin: stdin as never, stderr: new FakeStderr() as never,
    exitOnCtrlC: false, patchConsole: false, onFrame: () => { frames++ },
  })
  const registered = instances.get(stdout as never)
  if (!registered) throw new Error('probe Ink instance not registered')
  const ink = registered as unknown as ProbeInk
  ink.setSelectionBgColor('rgb(80, 90, 120)')
  await ready('viewport mounted', () => scroll.current?.getViewportHeight() === 10)
  stdin.write('x')
  await ready('input listener mounted', () => inputReady)
  const handle = scroll.current!
  let node: DOMElement | undefined
  const walk = (element: DOMElement): void => {
    if (element.scrollViewportHeight !== undefined) node = element
    for (const child of element.childNodes) if (child.nodeName !== '#text') walk(child)
  }
  walk(ink.rootNode)
  if (!node) throw new Error('probe ScrollBox node missing')
  const scrollNode = node
  const flush = () => new Promise<void>(resolve => term.write('', resolve))
  const lines = () => viewportLines(term, rows)
  const viewport = () => lines().slice(layout.top, layout.top + layout.height).map(line => line.slice(left, left + width).trimEnd())
  const state = (): SelectionSnapshot => ({
    anchor: ink.selection.anchor ? { ...ink.selection.anchor } : null,
    focus: ink.selection.focus ? { ...ink.selection.focus } : null,
  })
  const send = async (data: string): Promise<void> => {
    stdin.write(data)
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  const mouse = (button: number, col: number, row: number, end = 'M') => send(`\x1b[<${button};${left + col + 1};${row + 1}${end}`)
  const highlightedCells = () => {
    const cells: { col: number; row: number; text: string }[] = []
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
      const cell = term.buffer.active.getLine(row)?.getCell(col)
      if (cell && (cell.getBgColor() === 0x505a78 || cell.isInverse() !== 0)) cells.push({ col, row, text: cell.getChars() })
    }
    return cells
  }
  return {
    ink, handle, node: scrollNode, state, sourceNodes, viewport, flush, highlightedCells,
    copy: () => ink.copySelectionNoClear(),
    virtualRows: () => [
      ink.selection.virtualAnchorRow ?? ink.selection.anchor?.row,
      ink.selection.virtualFocusRow ?? ink.selection.focus?.row,
    ],
    async press(col: number, row: number) {
      await mouse(0, col, row)
      await ready('press', () => ink.selection.isDragging && ink.selection.anchor !== null)
    },
    async drag(col: number, row: number) {
      await mouse(32, col, row)
      await ready('drag motion', () => ink.selection.focus?.row === row && ink.selection.focus.col === left + col)
    },
    async release(col: number, row: number) {
      await mouse(0, col, row, 'm')
      await ready('release', () => !ink.selection.isDragging)
    },
    async page(direction: 'up' | 'down') { await send(direction === 'down' ? '\x1b[6~' : '\x1b[5~') },
    async paint(requested: number, painted = requested) {
      const first = painted < layout.prefix ? 'PREFIX' : source[painted - layout.prefix]
      await ready(`scroll ${requested}/${painted}`, () => handle.getScrollTop() === requested && handle.getPendingDelta() === 0 && viewport()[0] === first)
      await flush()
    },
    // Remeasurement corrections run after Yoga's commit, before its scheduled
    // paint, exactly where MessageList publishes fresh bounds + anchorBy.
    relayout(next: Partial<ProbeLayout>) {
      layout = { ...layout, ...next }
      app.rerender(tree())
    },
    async idle() {
      const before = frames
      app.rerender(tree())
      await ready('idle frame', () => frames > before)
      await flush()
    },
    highlightCount: () => highlightedCells().length,
    async unmount() {
      ink.clearTextSelection()
      stdout.isTTY = false // no fd=1 terminal cleanup for an in-memory stream
      await app.unmount()
      await flush()
      instances.delete(stdout as never)
      term.dispose()
    },
  }
}

async function scenarioHardLineEndings(): Promise<void> {
  const rig = await mountProbe(false, ['keep', '', ''])
  try {
    await rig.press(0, 0)
    await rig.drag(0, 2)
    await rig.release(0, 2)
    check('明确选中的源码尾部硬换行保持原样', rig.copy() === 'keep\n\n', JSON.stringify(rig.copy()))
  } finally { await rig.unmount() }
}

async function scenarioMiddleFocus(): Promise<void> {
  const rig = await mountProbe()
  try {
    await rig.press(0, 2)
    await rig.drag(10, 4)
    await rig.page('down')
    await rig.paint(8)
    check('中屏 focus 翻页：LINE_02..12 完整且旧 focus 行不截断', rig.copy() === sourceSelection(2, 12, 0, 10), JSON.stringify(rig.copy()))
    check('中屏 focus 翻页：focus 留在 row4', rig.state().focus?.row === 4)
    await rig.page('up')
    await rig.paint(0)
    check('中屏 focus 反向翻页精确收回', rig.copy() === sourceSelection(2, 4, 0, 10), JSON.stringify(rig.copy()))
  } finally { await rig.unmount() }
}

async function scenarioDirectionFlip(): Promise<void> {
  for (const dy of [3, -3]) {
    const rig = await mountProbe()
    try {
      rig.handle.scrollTo(10)
      await rig.paint(10)
      await rig.press(5, dy > 0 ? 5 : 1)
      await rig.drag(3, dy > 0 ? 1 : 5)
      rig.handle.scrollBy(dy)
      await rig.paint(10 + dy)
      rig.handle.scrollBy(dy)
      await rig.paint(10 + 2 * dy)
      const expected = dy > 0 ? sourceSelection(15, 17, 5, 3) : sourceSelection(9, 11, 3, 5)
      check(`滚动跨过 anchor 后方向翻转 ${dy}：仅保留新选区及原始列`, rig.copy() === expected, JSON.stringify(rig.copy()))
    } finally { await rig.unmount() }
  }
}

async function scenarioPressBeforeMotion(): Promise<void> {
  const rig = await mountProbe()
  try {
    rig.handle.scrollTo(10)
    await rig.paint(10)
    await rig.press(0, 3)
    check('首次 motion 前 focus 为空', rig.ink.selection.focus === null)
    rig.handle.scrollBy(2)
    await rig.paint(12)
    check('首次 motion 前滚动仍将 anchor 绑定 ROW_13', rig.state().anchor?.row === 1)
    await rig.drag(7, 6)
    check('press→scroll→motion 不漏起始两行', rig.copy() === sourceSelection(13, 18, 0, 7), JSON.stringify(rig.copy()))
  } finally { await rig.unmount() }
}

async function scenarioAnchorCorrection(): Promise<void> {
  const rig = await mountProbe()
  try {
    rig.handle.scrollTo(20)
    await rig.paint(20)
    rig.handle.setClampBounds(0, 22)
    rig.handle.scrollBy(4)
    await rig.paint(24, 22)
    check('锚定前置：wheel 已排空但仍欠两行绘制', rig.node.scrollFollowPending === true)
    await rig.press(0, 3)
    await rig.drag(8, 4)
    await rig.release(8, 4)
    const before = rig.state()
    const visible = rig.viewport()
    rig.relayout({ prefix: 10 })
    rig.handle.setClampBounds(10, 32)
    rig.handle.anchorBy(10)
    await rig.paint(34, 32)
    check('anchorBy 重基：整个正文不动', JSON.stringify(rig.viewport()) === JSON.stringify(visible))
    check('anchorBy 重基：选区不随纯坐标补偿移动', JSON.stringify(rig.state()) === JSON.stringify(before), JSON.stringify(rig.state()))
    rig.handle.setClampBounds(undefined, undefined)
    await rig.paint(34)
    check('anchorBy 后放开 clamp 只跟随余下两行', JSON.stringify(rig.virtualRows()) === JSON.stringify([1, 2]), JSON.stringify(rig.virtualRows()))
    check('anchorBy 往返复制保持源文本', rig.copy() === sourceSelection(25, 26, 0, 8))
  } finally { await rig.unmount() }
}

async function scenarioPaneResize(): Promise<void> {
  const rig = await mountProbe(true)
  try {
    await rig.press(0, 2)
    await rig.drag(15, 4)
    await rig.page('down')
    await rig.paint(8)
    rig.relayout({ top: 1, height: 9 })
    await ready('right pane header', () => rig.handle.getViewportTop() === 1 && rig.handle.getViewportHeight() === 9)
    await rig.page('down')
    await rig.paint(16)
    check('右 pane 夹边后 resize 仍跟随 anchor', rig.ink.selection.virtualAnchorRow === -13, JSON.stringify(rig.virtualRows()))
    check('右 pane resize 不将有效选区标 stale', !rig.ink.selection.stale)
    check('右 pane resize 后复制仍连续且无 HEADER', rig.copy() === sourceSelection(2, 19, 0, 15), JSON.stringify(rig.copy()))
    check('右 pane box 移动期间 focus 仍在鼠标 row4', rig.state().focus?.row === 4)
  } finally { await rig.unmount() }
}

async function scenarioViewportCapture(): Promise<void> {
  const rig = await mountProbe()
  try {
    await rig.press(0, 7)
    await rig.drag(17, 9)
    await rig.release(17, 9)
    rig.relayout({ top: 1, height: 9 })
    await ready('header moved the box', () => rig.handle.getViewportTop() === 1)
    await rig.flush()
    check('box 移动捕获的是旧屏坐标下的离开行', rig.copy() === sourceSelection(7, 9), JSON.stringify(rig.copy()))
  } finally { await rig.unmount() }
}

async function scenarioRetainedGeometry(): Promise<void> {
  for (const side of ['above', 'below'] as const) {
    const rig = await mountProbe()
    try {
      rig.handle.scrollTo(10)
      await rig.paint(10)
      const first = side === 'above' ? 13 : 16
      const from = first - 10
      const delta = side === 'above' ? 6 : -8
      await rig.press(2, from)
      await rig.drag(8, from + 1)
      await rig.release(8, from + 1)
      await rig.flush()
      const expected = sourceSelection(first, first + 1, 2, 8)
      check(`${side}: 高亮 oracle 在可见选区确实生效`, rig.highlightCount() > 0)
      rig.handle.scrollBy(delta)
      await rig.paint(10 + delta)
      check(`${side}: 完全离屏只保留复制缓冲`, rig.copy() === expected)
      check(`${side}: 完全离屏不高亮无关边缘字符`, rig.highlightCount() === 0, JSON.stringify({ offScreen: rig.ink.selection.offScreen, virtualRows: rig.virtualRows(), cells: rig.highlightedCells() }))
      for (const next of [{ height: 9 }, { height: 11 }, { top: 1 }, { top: 0, height: 10 }]) {
        rig.relayout(next)
        await ready('retained geometry', () => rig.handle.getViewportTop() === (next.top ?? 0) && rig.handle.getViewportHeight() === (next.height ?? 11))
        await rig.flush()
        check(`${side}: shrink/grow/translate 保留已离屏文本 ${JSON.stringify(next)}`, rig.copy() === expected)
        check(`${side}: geometry 不制造可见高亮 ${JSON.stringify(next)}`, rig.highlightCount() === 0)
      }
      rig.handle.scrollBy(-delta)
      await rig.paint(10)
      check(`${side}: 滚回恢复原始端点和列`, JSON.stringify(rig.state()) === JSON.stringify({ anchor: { col: 2, row: from }, focus: { col: 8, row: from + 1 } }), JSON.stringify(rig.state()))
      check(`${side}: 滚回复制保持精确源文本`, rig.copy() === expected)
    } finally { await rig.unmount() }
  }
}

async function scenarioJumpCancellation(): Promise<void> {
  for (const jump of ['scrollTo', 'scrollToElement', 'scrollToBottom'] as const) {
    for (const timing of ['none', 'same-batch', 'later'] as const) for (const heldClamp of [false, true]) {
      if (timing === 'later' && !heldClamp) continue
      const wheel = timing !== 'none'
      const rig = await mountProbe()
      const tag = `${jump}${wheel ? `+wheel(${timing})` : ''}${heldClamp ? ' held-clamp' : ''}`
      try {
        rig.handle.scrollTo(20)
        await rig.paint(20)
        rig.handle.setClampBounds(0, 22)
        rig.handle.scrollBy(4)
        await rig.paint(24, 22)
        await rig.press(0, 3)
        await rig.drag(8, 4)
        await rig.release(8, 4)
        if (!heldClamp) rig.handle.setClampBounds(undefined, undefined)
        const dy = jump === 'scrollToBottom' ? -3 : 3
        if (jump === 'scrollTo') rig.handle.scrollTo(60)
        else if (jump === 'scrollToElement') rig.handle.scrollToElement(rig.sourceNodes[60]!.current!)
        else rig.handle.scrollToBottom()
        // scrollBy deliberately cancels a pending element seek in the same
        // batch. A later wheel starts at the already-resolved seek target.
        const target = jump === 'scrollToBottom' ? 90 : jump === 'scrollToElement' && timing === 'same-batch' ? 24 : 60
        if (timing === 'later') {
          await rig.paint(target, 22)
          await rig.idle()
        }
        if (wheel) rig.handle.scrollBy(dy)
        const requested = target + (wheel ? dy : 0)
        await rig.paint(requested, heldClamp ? 22 : requested)
        if (heldClamp) {
          check(`${tag}: jump 尚未绘制不反向消费旧 wheel`, JSON.stringify(rig.virtualRows()) === JSON.stringify([3, 4]), JSON.stringify(rig.virtualRows()))
          rig.handle.setClampBounds(undefined, undefined)
          await rig.paint(requested)
        }
        const shift = wheel ? -dy : 0
        check(`${tag}: 只跟随新 wheel，不含 jump 或旧欠账`, JSON.stringify(rig.virtualRows()) === JSON.stringify([3 + shift, 4 + shift]), JSON.stringify(rig.virtualRows()))
        check(`${tag}: 旧 deferred follow 已结束`, rig.node.scrollFollowPending !== true)
      } finally { await rig.unmount() }
    }
  }
}

for (const [name, scenario] of [
  ['Chat drag', scenarioA], ['Chat retained', scenarioB], ['Chat bottom', scenarioBottomEdge], ['footer', scenarioFooterGuard],
  ['source hard newlines', scenarioHardLineEndings],
  ['middle focus', scenarioMiddleFocus], ['direction flip', scenarioDirectionFlip], ['press before motion', scenarioPressBeforeMotion],
  ['anchor correction', scenarioAnchorCorrection], ['pane resize', scenarioPaneResize],
  ['viewport capture', scenarioViewportCapture], ['retained geometry', scenarioRetainedGeometry],
  ['jump cancellation', scenarioJumpCancellation],
] as const) {
  try { await scenario() }
  catch (error) { check(name, false, error instanceof Error ? error.message : String(error)) }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
