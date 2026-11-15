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

import './lib/default-lang-zh.mjs'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'
process.env.SSH_CONNECTION = 'headless-repro'
delete process.env.TMUX

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, AlternateScreen },
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
    anchor: rig.ink.selection?.anchor ?? null,
    focus: rig.ink.selection?.focus ?? null,
  })
  return rig
}

function contiguous(tag: string, markers: number[], start: number): number {
  const unique = new Set(markers)
  check(`${tag}: 复制行无重复`, unique.size === markers.length, markers.join(','))
  check(`${tag}: 复制从 LINE_${String(start).padStart(3, '0')} 开始`, markers[0] === start, markers.join(','))
  const end = markers[markers.length - 1] ?? start - 1
  const expected = Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => start + i)
  check(`${tag}: 复制行连续无跳号`, JSON.stringify(markers) === JSON.stringify(expected), markers.join(','))
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
    const first = contiguous('A PgDn', rig.copyMarkers(), START)
    check('A PgDn: 选区扩展到了新页', first >= 30, `end=${first}`)
    check('A PgDn: focus 仍留在下边缘', rig.state().focus?.row === bottom, JSON.stringify(rig.state()))

    await rig.page('down')
    const second = contiguous('A PgDn2', rig.copyMarkers(), START)
    check('A PgDn2: 继续向下扩展', second > first, `${first} -> ${second}`)

    await rig.page('up')
    const back = contiguous('A PgUp', rig.copyMarkers(), START)
    check('A PgUp: 反向滚动不重复且回到上一页', back <= second, `${second} -> ${back}`)

    await rig.wheel('down', 8)
    const wheelDown = contiguous('A wheel down', rig.copyMarkers(), START)
    check('A wheel down: 滚轮也扩展选区', wheelDown > back, `${back} -> ${wheelDown}`)
    await rig.wheel('up', 8)
    const wheelBack = contiguous('A wheel up', rig.copyMarkers(), START)
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

await scenarioA()
await scenarioB()
await scenarioBottomEdge()
await scenarioFooterGuard()

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
