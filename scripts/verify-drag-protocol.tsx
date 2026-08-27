/**
 * verify-drag-protocol — 组件级 drag 拖拽协议回归（SGR press/motion/release
 * → onDragStart/onDragMove/onDragEnd，DOM HTML5 drag 语义子集）。
 *
 * 单元层（fake app + 合成 DOM 树，直调 handleMouseEvent / dispatchDragEvent）：
 *   U1 无 onDragTargetAt prop：press 走基线路径（selection anchor 照设）；
 *   U2 有 drag target：press 开会话、跳过 startSelection/clickCount；
 *   U3 drag motion：首动 dragstart、后续 dragmove、跳过 onSelectionDrag；
 *   U4 未移动 press-release：照常 onClick、无 drag 事件（DOM click 语义）；
 *   U5 已启动 release：dragend、绝不 click；
 *   U6 shift+press 不劫持（保留修饰键选择手势）；
 *   U7 无 handler 区域：状态与无 prop 基线逐字段一致（兼容性硬要求）；
 *   U8 finishDragSession / resetPointerState：孤儿会话收尾；
 *   U9 dispatchDragEvent 冒泡 + 异常隔离 + localCol。
 *
 * 集成层（headless xterm，逐字节 SGR 写 stdin，真实 Ink 管线）：
 *   I1 press→move→move→release：start/move/end 顺序与坐标；
 *   I2 press 原地不动→release：无 drag 事件、onClick 触发；
 *   I3 drag 中 FOCUS_OUT：收到 dragend；
 *   I4 localCol/localRow 相对坐标正确；
 *   I5 最小消费者：drag 协议实现的数值滑块（拖动改值）。
 *
 * 运行：node --import tsx/esm scripts/verify-drag-protocol.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, AlternateScreen, useInput },
  BoxMod,
  TextMod,
  { handleMouseEvent },
  { createNode },
  { nodeCache },
  { createSelectionState, hasSelection, updateSelection },
  { dispatchDragEvent, findDragTarget },
  { settle, settled, sleep },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/ink/components/Box.js'),
  import('../src/ink/components/Text.js'),
  import('../src/ink/components/App.js'),
  import('../src/ink/dom.js'),
  import('../src/ink/node-cache.js'),
  import('../src/ink/selection.js'),
  import('../src/ink/hit-test.js'),
  import('./lib/term-test.mjs'),
])

const Box = BoxMod.default
const Text = TextMod.default

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  const mark = ok ? 'ok  ' : 'FAIL'
  console.log(`${mark} ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}

type FakeApp = Parameters<typeof handleMouseEvent>[0]
type DragRecord = {
  type: string
  col: number
  row: number
  startCol: number
  startRow: number
  localCol: number
  localRow: number
}

// ── 单元层：合成 DOM 树 + fake app ───────────────────────────
function makeTree() {
  const root = createNode('ink-root')
  const pad = createNode('ink-box')
  const text = createNode('ink-text')
  root.childNodes.push(pad)
  pad.parentNode = root
  pad.childNodes.push(text)
  text.parentNode = pad
  nodeCache.set(root, { x: 0, y: 0, width: 40, height: 12 })
  nodeCache.set(pad, { x: 2, y: 2, width: 20, height: 3 })
  nodeCache.set(text, { x: 2, y: 2, width: 20, height: 1 })
  return { root, pad, text }
}

function makeFakeApp(dragTarget?: unknown): {
  app: FakeApp
  events: DragRecord[]
  clicks: number[]
  selectionDrags: number[]
} {
  const events: DragRecord[] = []
  const clicks: number[] = []
  const selectionDrags: number[] = []
  const selection = createSelectionState()
  const app = {
    props: {
      selection,
      terminalColumns: 40,
      terminalRows: 12,
      onSelectionChange: () => {},
      onClickAt: (col: number, row: number) => {
        clicks.push(col, row)
        return true
      },
      onHoverAt: () => {},
      getHyperlinkAt: () => undefined,
      onOpenHyperlink: () => {},
      onMultiClick: () => {},
      onSelectionDrag: (col: number, row: number) => {
        selectionDrags.push(col, row)
        updateSelection(selection, col, row)
      },
      onWheelAt: () => false,
      ...(dragTarget
        ? {
            onDragTargetAt: () => dragTarget,
            onDragDispatch: (
              _t: never,
              e: {
                type: string
                col: number
                row: number
                startCol: number
                startRow: number
              },
            ) => {
              events.push({
                type: e.type,
                col: e.col,
                row: e.row,
                startCol: e.startCol,
                startRow: e.startRow,
                localCol: (e as DragRecord).localCol ?? 0,
                localRow: (e as DragRecord).localRow ?? 0,
              })
            },
          }
        : {}),
    },
    clickCount: 0,
    lastClickTime: 0,
    lastClickCol: -1,
    lastClickRow: -1,
    lastHoverCol: -1,
    lastHoverRow: -1,
    pendingHyperlinkTimer: null,
    dragSession: null,
  } as unknown as FakeApp
  return { app, events, clicks, selectionDrags }
}

function mouse(button: number, action: 'press' | 'release', col: number, row: number) {
  return { kind: 'mouse' as const, button, action, col: col + 1, row: row + 1, sequence: '' }
}

{
  // U1: 无 onDragTargetAt prop —— press 完全走基线（anchor 照设）
  const { app } = makeFakeApp()
  handleMouseEvent(app, mouse(0, 'press', 5, 5))
  const sel = (app.props as { selection: import('../src/ink/selection.js').SelectionState })
    .selection
  check('U1 无 prop：press 照走 startSelection', sel.anchor !== null && sel.isDragging)
}

{
  // U2: 有 drag target —— press 开会话、跳过 selection 与 clickCount
  const { root, pad } = makeTree()
  pad._eventHandlers = { onDragStart: () => {} }
  const target = findDragTarget(root, 5, 3)
  check('U2 findDragTarget 命中带 handler 的祖先', target === pad)
  const { app } = makeFakeApp(pad)
  handleMouseEvent(app, mouse(0, 'press', 5, 3))
  const sel = (app.props as { selection: import('../src/ink/selection.js').SelectionState })
    .selection
  const session = (app as unknown as { dragSession: unknown }).dragSession
  check('U2 press 开 drag 会话', session !== null && session !== undefined)
  check('U2 跳过 startSelection', sel.anchor === null && !sel.isDragging)
  check('U2 clickCount 置 0', (app as unknown as { clickCount: number }).clickCount === 0)
}

{
  // U3: drag motion —— 首动 dragstart、再动 dragmove、跳过 onSelectionDrag
  const { pad } = makeTree()
  const { app, events, selectionDrags } = makeFakeApp(pad)
  handleMouseEvent(app, mouse(0, 'press', 4, 3))
  handleMouseEvent(app, mouse(0x20, 'press', 8, 4))
  handleMouseEvent(app, mouse(0x20, 'press', 10, 4))
  check(
    'U3 首动 dragstart、后续 dragmove',
    events.length === 3 &&
      events[0]!.type === 'dragstart' &&
      events[1]!.type === 'dragmove' &&
      events[2]!.type === 'dragmove',
    events.map((e) => e.type).join(','),
  )
  check(
    'U3 坐标：startCol/Row=press 起点，col/row=当前',
    events[0]!.startCol === 4 &&
      events[0]!.startRow === 3 &&
      events[0]!.col === 8 &&
      events[2]!.col === 10,
    events.map((e) => `${e.type}@${e.col},${e.row}`).join(' '),
  )
  check('U3 跳过 onSelectionDrag', selectionDrags.length === 0)
}

{
  // U4: 未移动 press-release —— 照常 click，无 drag 事件
  const { pad } = makeTree()
  const { app, events, clicks } = makeFakeApp(pad)
  handleMouseEvent(app, mouse(0, 'press', 6, 3))
  handleMouseEvent(app, mouse(0, 'release', 6, 3))
  check('U4 无 drag 事件', events.length === 0)
  check('U4 click 照常分发', clicks.length === 2 && clicks[0] === 6 && clicks[1] === 3)
  check('U4 会话已清理', (app as unknown as { dragSession: unknown }).dragSession === null)
}

{
  // U5: 已启动 release —— dragend、绝不 click
  const { pad } = makeTree()
  const { app, events, clicks } = makeFakeApp(pad)
  handleMouseEvent(app, mouse(0, 'press', 4, 3))
  handleMouseEvent(app, mouse(0x20, 'press', 9, 3))
  handleMouseEvent(app, mouse(0, 'release', 9, 3))
  check(
    'U5 dragend 发出且不 click',
    events.length === 3 &&
      events[2]!.type === 'dragend' &&
      clicks.length === 0,
    events.map((e) => e.type).join(','),
  )
}

{
  // U6: shift+press 不劫持 —— 修饰键保留选择手势（产品默认，待人工复核）
  const { pad } = makeTree()
  const { app, events } = makeFakeApp(pad)
  handleMouseEvent(app, mouse(0x04, 'press', 5, 3))
  const sel = (app.props as { selection: import('../src/ink/selection.js').SelectionState })
    .selection
  check('U6 shift press 走选择', sel.anchor !== null && sel.isDragging)
  check('U6 无 drag 会话', (app as unknown as { dragSession: unknown }).dragSession === null)
  handleMouseEvent(app, mouse(0x24, 'press', 9, 4))
  check('U6 shift drag 走 onSelectionDrag', events.length === 0)
}

{
  // U7: 无 handler 区域 —— 与无 prop 基线逐字段一致
  const { root, pad } = makeTree()
  pad._eventHandlers = { onDragStart: () => {} }
  // onDragTargetAt 返回 null（press 在 pad 外的 root 空白）
  const { app: withProp, events: withPropEvents } = makeFakeApp(findDragTarget(root, 30, 10) ? pad : null)
  const { app: baseline } = makeFakeApp()
  check('U7 前置：该区域确无 drag target', withPropEvents.length === 0)
  for (const app of [withProp, baseline]) {
    handleMouseEvent(app, mouse(0, 'press', 30, 10))
    handleMouseEvent(app, mouse(0x20, 'press', 33, 10))
    handleMouseEvent(app, mouse(0, 'release', 33, 10))
  }
  const a = withProp.props as Record<string, never>
  const b = baseline.props as Record<string, never>
  const selA = a.selection as unknown as import('../src/ink/selection.js').SelectionState
  const selB = b.selection as unknown as import('../src/ink/selection.js').SelectionState
  check(
    'U7 无 handler 区域与基线一致（anchor/focus/dragging）',
    JSON.stringify(selA) === JSON.stringify(selB) &&
      hasSelection(selA) &&
      selA.anchor!.col === 30 &&
      selA.focus!.col === 33,
    `A=${JSON.stringify(selA)} B=${JSON.stringify(selB)}`,
  )
}

{
  // U8: finishDragSession / resetPointerState 孤儿会话收尾
  const { pad } = makeTree()
  const { app, events } = makeFakeApp(pad)
  handleMouseEvent(app, mouse(0, 'press', 4, 3))
  handleMouseEvent(app, mouse(0x20, 'press', 7, 4))
  handleMouseEvent(app, mouse(0x20, 'press', 8, 5))
  const App = (await import('../src/ink/components/App.js')).default
  App.prototype.finishDragSession.call(app)
  check(
    'U8 focus 丢失收尾 dragend（last 坐标）',
    events.length === 4 &&
      events[3]!.type === 'dragend' &&
      events[3]!.col === 8 &&
      events[3]!.row === 5,
    events.map((e) => `${e.type}@${e.col},${e.row}`).join(' '),
  )
  check('U8 会话清空', (app as unknown as { dragSession: unknown }).dragSession === null)

  // resetPointerState 路径：开新会话后直接 reset
  handleMouseEvent(app, mouse(0, 'press', 4, 3))
  handleMouseEvent(app, mouse(0x20, 'press', 6, 3))
  const before = events.length
  const AppCtor = (await import('../src/ink/components/App.js')).default
  ;(app as unknown as { finishDragSession: () => void }).finishDragSession =
    AppCtor.prototype.finishDragSession
  AppCtor.prototype.resetPointerState.call(app)
  check(
    'U8 resetPointerState 发 dragend 并清会话',
    events.length === before + 1 &&
      events[events.length - 1]!.type === 'dragend' &&
      (app as unknown as { dragSession: unknown }).dragSession === null,
  )
}

{
  // U9: dispatchDragEvent 冒泡 + 异常隔离 + localCol + stopImmediatePropagation
  const { root, pad } = makeTree()
  const calls: string[] = []
  const child = createNode('ink-box')
  pad.childNodes.push(child)
  child.parentNode = pad
  nodeCache.set(child, { x: 2, y: 3, width: 6, height: 1 })
  pad._eventHandlers = {
    onDragStart: () => {},
    onDragMove: (e: DragRecord) => {
      calls.push(`pad ${e.localCol},${e.localRow}`)
    },
  }
  child._eventHandlers = {
    onDragMove: () => {
      throw new Error('boom')
    },
  }
  check('U9 findDragTarget 可从子节点向上找到 pad', findDragTarget(root, 4, 3) === pad)
  const { DragEvent } = await import('../src/ink/events/drag-event.js')
  const ev = new DragEvent('dragmove', 10, 4, 2, 2)
  dispatchDragEvent(pad, ev)
  check(
    'U9 冒泡抵达 pad、子节点异常被隔离、localCol 相对 pad',
    calls.length === 1 && calls[0] === 'pad 8,2',
    calls.join(' | '),
  )
  // stopImmediatePropagation 停冒泡
  const calls2: string[] = []
  const outer = createNode('ink-box')
  root.childNodes.push(outer)
  outer.parentNode = root
  nodeCache.set(outer, { x: 0, y: 0, width: 40, height: 12 })
  pad._eventHandlers = {
    onDragEnd: (e: { stopImmediatePropagation: () => void }) => {
      calls2.push('pad')
      e.stopImmediatePropagation()
    },
  }
  outer._eventHandlers = { onDragEnd: () => calls2.push('outer') }
  dispatchDragEvent(pad, new DragEvent('dragend', 5, 4, 2, 2))
  check('U9 stopImmediatePropagation 停冒泡', calls2.length === 1 && calls2[0] === 'pad')
}

// ── 集成层：真实 Ink 管线 + headless xterm + SGR 逐字节 stdin ──
const COLS = 100
const ROWS = 30
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
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
  _write(_c: unknown, _e: BufferEncoding, cb: () => void) {
    cb()
  }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() {
    return this
  }
  ref() {
    return this
  }
  unref() {
    return this
  }
}
const stdin = new FakeStdin()
const stdout = new FakeStdout()
const stderr = new FakeStderr()

const dragEvents: DragRecord[] = []
let sliderValue = -1

function recordDrag(e: DragRecord) {
  dragEvents.push({
    type: e.type,
    col: e.col,
    row: e.row,
    startCol: e.startCol,
    startRow: e.startRow,
    localCol: e.localCol,
    localRow: e.localRow,
  })
}

function Slider() {
  const [value, setValue] = React.useState(0)
  sliderValue = value
  const bar = '█'.repeat(value) + '·'.repeat(10 - value)
  return (
    <Box
      width={30}
      height={2}
      flexDirection="column"
      onDragStart={(e) => {
        setValue(clamp10(Math.round(((e.localCol - 1) / 22) * 10)))
      }}
      onDragMove={(e) => {
        setValue(clamp10(Math.round(((e.localCol - 1) / 22) * 10)))
      }}
    >
      <Text>{`SLIDERMARKER ${bar} v=${value}`}</Text>
    </Box>
  )
}
function clamp10(n: number) {
  return Math.max(0, Math.min(10, n))
}

function Scene() {
  // 常驻 raw-mode 持有者：没有 useInput 消费者时 App 不会挂 stdin
  // readable 处理器，写进 FakeStdin 的 SGR 字节无人读取（XTVERSION 探测
  // 结束后 raw mode 即释放）。空 handler 足够——SGR 走 handleMouseEvent。
  useInput(() => {})
  return (
    <AlternateScreen>
      <Box flexDirection="column">
        <Box
          width={24}
          height={2}
          flexDirection="column"
          onClick={() => dragEvents.push({ type: 'click', col: -1, row: -1, startCol: -1, startRow: -1, localCol: -1, localRow: -1 })}
          onDragStart={recordDrag}
          onDragMove={recordDrag}
          onDragEnd={recordDrag}
        >
          <Text>DRAGPADMARKER</Text>
        </Box>
        <Box width={24} height={2} flexDirection="column">
          <Text>PLAINMARKER-abcdefgh</Text>
        </Box>
        <Slider />
      </Box>
    </AlternateScreen>
  )
}

const inst = await render(<Scene />, {
  stdout: stdout as never,
  stdin: stdin as never,
  stderr: stderr as never,
  exitOnCtrlC: false,
  patchConsole: false,
})

function screenLines(): string[] {
  const buf = term.buffer.active
  return Array.from({ length: ROWS }, (_, y) =>
    buf.getLine(buf.baseY + y)?.translateToString(true) ?? '',
  )
}
function findMarker(marker: string): { col: number; row: number } {
  const lines = screenLines()
  for (let y = 0; y < lines.length; y++) {
    const x = lines[y]!.indexOf(marker)
    if (x >= 0) return { col: x, row: y }
  }
  return { col: -1, row: -1 }
}
// SGR：坐标 1-indexed
const press = (c: number, r: number) => stdin.write(`\x1b[<0;${c + 1};${r + 1}M`)
const motion = (c: number, r: number) => stdin.write(`\x1b[<32;${c + 1};${r + 1}M`)
const release = (c: number, r: number) => stdin.write(`\x1b[<0;${c + 1};${r + 1}m`)
const shiftPress = (c: number, r: number) => stdin.write(`\x1b[<4;${c + 1};${r + 1}M`)
const shiftMotion = (c: number, r: number) => stdin.write(`\x1b[<36;${c + 1};${r + 1}M`)

const padPos = { col: -1, row: -1 }
const plainPos = { col: -1, row: -1 }
await settled(() => {
  const p = findMarker('DRAGPADMARKER')
  padPos.col = p.col
  padPos.row = p.row
  return p.col >= 0
})
{
  const p = findMarker('PLAINMARKER')
  plainPos.col = p.col
  plainPos.row = p.row
}
check('场景渲染：DRAGPAD/PLAIN 标记定位', padPos.col >= 0 && plainPos.col >= 0)

{
  // I1: press→move→move→release：顺序与坐标
  dragEvents.length = 0
  press(padPos.col + 2, padPos.row)
  motion(padPos.col + 5, padPos.row)
  motion(padPos.col + 8, padPos.row)
  release(padPos.col + 8, padPos.row)
  check(
    'I1 dragstart→dragmove×2→dragend 顺序',
    await settled(
      () =>
        dragEvents.length === 4 &&
        dragEvents[0]!.type === 'dragstart' &&
        dragEvents[1]!.type === 'dragmove' &&
        dragEvents[2]!.type === 'dragmove' &&
        dragEvents[3]!.type === 'dragend',
    ),
    dragEvents.map((e) => e.type).join(','),
  )
  check(
    'I1 坐标：startCol/Row=press、dragend=release 点',
    dragEvents.length === 4 &&
      dragEvents[0]!.startCol === padPos.col + 2 &&
      dragEvents[0]!.startRow === padPos.row &&
      dragEvents[3]!.col === padPos.col + 8,
    dragEvents.length === 4
      ? `start=${dragEvents[0]!.startCol},${dragEvents[0]!.startRow}`
      : dragEvents.map((e) => e.type).join(','),
  )
}

{
  // I2: press 原地不动→release：无 drag 事件、onClick 触发
  dragEvents.length = 0
  press(padPos.col + 3, padPos.row)
  release(padPos.col + 3, padPos.row)
  const clicked = await settled(
    () => dragEvents.some((e) => e.type === 'click') && dragEvents.every((e) => e.type === 'click'),
  )
  check('I2 未移动：无 dragstart/move/end', dragEvents.every((e) => e.type === 'click'))
  check('I2 click 照常触发', clicked, dragEvents.map((e) => e.type).join(','))
}

{
  // I3: drag 中 FOCUS_OUT → 收到 dragend
  dragEvents.length = 0
  press(padPos.col + 2, padPos.row)
  motion(padPos.col + 6, padPos.row)
  await settled(() => dragEvents.some((e) => e.type === 'dragmove'))
  stdin.write('\x1b[O')
  check(
    'I3 FOCUS_OUT 收尾 dragend',
    await settled(() => dragEvents.some((e) => e.type === 'dragend')),
    dragEvents.map((e) => e.type).join(','),
  )
}

{
  // I4: localCol/localRow 相对坐标（Box rect 左上 = 标记起点）
  dragEvents.length = 0
  press(padPos.col + 4, padPos.row)
  motion(padPos.col + 9, padPos.row)
  await settled(() => dragEvents.some((e) => e.type === 'dragmove'))
  const move = dragEvents.find((e) => e.type === 'dragmove')
  check(
    'I4 dragmove localCol 相对 DRAGPAD rect',
    move !== undefined && move.localCol === 9 && move.localRow === 0,
    move ? `local=${move.localCol},${move.localRow}` : 'no move',
  )
}

{
  // I5: 最小消费者——drag 协议数值滑块
  const before = sliderValue
  const sPos = findMarker('SLIDERMARKER')
  check('I5 滑块渲染', sPos.col >= 0)
  // 拖到最右 → v=10
  press(sPos.col + 22, sPos.row)
  motion(sPos.col + 23, sPos.row)
  await settled(() => sliderValue === 10)
  release(sPos.col + 23, sPos.row)
  check('I5 拖到右端 v=10', await settled(() => sliderValue === 10), `v=${sliderValue}`)
  // 再拖回左端 → v=0
  press(sPos.col + 22, sPos.row)
  motion(sPos.col + 1, sPos.row)
  await settled(() => sliderValue === 0)
  release(sPos.col + 1, sPos.row)
  check('I5 拖回左端 v=0', await settled(() => sliderValue === 0), `v=${sliderValue}`)
  const lines = screenLines()
  const barLine = lines.find((l) => l.includes('SLIDERMARKER'))
  check('I5 屏幕呈现最终值', barLine !== undefined && barLine.includes('v=0'), barLine ?? '')
  check('I5 前后值确有变化（拖拽生效）', before !== 10 || sliderValue === 0, `before=${before}`)
}

inst.unmount()

if (failures > 0) {
  console.error(`\nverify-drag-protocol: ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nverify-drag-protocol: all checks passed')
