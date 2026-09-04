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
 *   I5 最小消费者：drag 协议实现的数值滑块（拖动改值）；
 *   I6 手势窗口零协议写入（press 路径探测回归 + 手势闩），松手后探测恢复；
 *   I7 退出 AlternateScreen 时孤儿 drag 会话收尾 dragend。
 *   I8 >5s 空闲后首个输入是 SGR press：resume 重断言延后到批次解析后，
 *      被闩挡住；
 *   I9 DECRQM 在途时按下鼠标、reset 回包手势中到达：闩挡重入，松手后在
 *      安全边界补做；
 *   I10 手势中 resize：几何重置不解除物理闩，resize probe 不得写；
 *   I11 纯鼠标用户的 1049 自愈入口：hover/wheel 触发安全边界 probe，且
 *      只发 DECRQM 查询、不盲写鼠标 DECSET（skipMouseReassert）。
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
  { default: AppCtor, handleMouseEvent },
  { createNode },
  { nodeCache },
  { createSelectionState, hasSelection, updateSelection },
  { dispatchDragEvent, findDragTarget },
  { default: instances },
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
  import('../src/ink/instances.js'),
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
    finishDragSession: AppCtor.prototype.finishDragSession,
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
  // U4b: 锚点格豁免 —— press 后同格 motion（手抖/触控板）不是拖拽：
  // 会话保持 dormant，release 照常走 click 路径（输入框双击自检测的
  // 第一击依赖这次 click 派发）。修复 I-1（复审发现）。
  const { pad } = makeTree()
  const { app, events, clicks } = makeFakeApp(pad)
  handleMouseEvent(app, mouse(0, 'press', 6, 3))
  handleMouseEvent(app, mouse(0x20, 'press', 6, 3)) // 同格 motion
  handleMouseEvent(app, mouse(0, 'release', 6, 3))
  check('U4b 同格 motion 不触发 drag 事件', events.length === 0)
  check('U4b click 照常分发', clicks.length === 2 && clicks[0] === 6 && clicks[1] === 3)
  check('U4b 会话已清理', (app as unknown as { dragSession: unknown }).dragSession === null)
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
  // U5b: legacy/noncanonical release may carry low bits 3. Captured drag
  // sessions must still end, while a dormant one must still click.
  const { pad } = makeTree()
  const started = makeFakeApp(pad)
  handleMouseEvent(started.app, mouse(0, 'press', 4, 3))
  handleMouseEvent(started.app, mouse(0x20, 'press', 8, 3))
  handleMouseEvent(started.app, mouse(3, 'release', 8, 3))
  check(
    'U5b button=3 release 收尾已启动 drag',
    started.events.at(-1)?.type === 'dragend' &&
      (started.app as unknown as { dragSession: unknown }).dragSession === null,
    started.events.map(event => event.type).join(','),
  )
  const dormant = makeFakeApp(pad)
  handleMouseEvent(dormant.app, mouse(0, 'press', 6, 3))
  handleMouseEvent(dormant.app, mouse(3, 'release', 6, 3))
  check(
    'U5b button=3 release 仍回放 dormant click',
    dormant.events.length === 0 && dormant.clicks.join(',') === '6,3',
    JSON.stringify({ events: dormant.events, clicks: dormant.clicks }),
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
  // U6b: 连续两次 Shift+click（500ms/1 格窗口内）不得触发多击链——
  // Shift+click 是选区扩展手势，不是双击选词；误判会让 onMultiClick 的
  // 屏幕词选压制 click 派发并覆盖剪贴板。修复 I-2（复审发现）。
  const { pad } = makeTree()
  const { app, clicks } = makeFakeApp(pad)
  let multiClicks = 0
  ;(app.props as { onMultiClick: () => void }).onMultiClick = () => {
    multiClicks++
  }
  handleMouseEvent(app, mouse(0x04, 'press', 5, 3))
  handleMouseEvent(app, mouse(0x04, 'release', 5, 3))
  handleMouseEvent(app, mouse(0x04, 'press', 5, 3))
  const sel = (app.props as { selection: import('../src/ink/selection.js').SelectionState })
    .selection
  check('U6b 双 Shift+click 不触发 onMultiClick', multiClicks === 0, `multi=${multiClicks}`)
  check('U6b 第二次 Shift press 走选择', sel.anchor !== null && sel.isDragging)
  check(
    'U6b 修饰点击完全不写入多击链',
    (app as unknown as { clickCount: number }).clickCount === 0,
    `clickCount=${(app as unknown as { clickCount: number }).clickCount}`,
  )
  handleMouseEvent(app, mouse(0x04, 'release', 5, 3))
  handleMouseEvent(app, mouse(0, 'press', 5, 3))
  handleMouseEvent(app, mouse(0, 'release', 5, 3))
  check(
    'U6b drag target 上 Shift+click 后普通 click 仍分发',
    multiClicks === 0 && clicks.length >= 2,
    `multi=${multiClicks} clickCount=${(app as unknown as { clickCount: number }).clickCount} clicks=${clicks.length / 2}`,
  )
}

{
  // U6c: on a non-drag region, a modified click must not seed App's global
  // click chain and turn the following plain click into a double-click.
  const { app, clicks } = makeFakeApp()
  let multiClicks = 0
  ;(app.props as { onMultiClick: () => void }).onMultiClick = () => { multiClicks++ }
  handleMouseEvent(app, mouse(0x04, 'press', 5, 3))
  handleMouseEvent(app, mouse(0x04, 'release', 5, 3))
  handleMouseEvent(app, mouse(0, 'press', 5, 3))
  handleMouseEvent(app, mouse(0, 'release', 5, 3))
  check(
    'U6c 非 drag 区 Shift+click 后普通 click 不误判双击',
    multiClicks === 0 && (app as unknown as { clickCount: number }).clickCount === 1 && clicks.length === 4,
    `multi=${multiClicks} clickCount=${(app as unknown as { clickCount: number }).clickCount} clicks=${clicks.length / 2}`,
  )
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
  // U8b: X10 has no release sequence. The next fresh press must settle the
  // captured drag before replacing it with a new dormant session.
  const { pad } = makeTree()
  const { app, events } = makeFakeApp(pad)
  handleMouseEvent(app, mouse(0, 'press', 4, 3))
  handleMouseEvent(app, mouse(0x20, 'press', 8, 3))
  handleMouseEvent(app, mouse(0, 'press', 12, 3))
  const session = (app as unknown as {
    dragSession: { startCol: number; started: boolean } | null
  }).dragSession
  check(
    'U8b X10 下一次 press 先发旧 dragend 再开新会话',
    events.at(-1)?.type === 'dragend' && session?.startCol === 12 && session.started === false,
    JSON.stringify({
      events: events.map(event => event.type),
      session: session === null ? null : { startCol: session.startCol, started: session.started },
    }),
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
  let childMetadata = ''
  child._eventHandlers = {
    onDragMove: (e: InstanceType<typeof import('../src/ink/events/drag-event.js').DragEvent>) => {
      childMetadata = `${e.target === child}/${e.currentTarget === child}/${e.eventPhase}/${e.localCol},${e.localRow}`
      throw new Error('boom')
    },
  }
  check('U9 findDragTarget 可从子节点向上找到 pad', findDragTarget(root, 4, 3) === pad)
  const { DragEvent } = await import('../src/ink/events/drag-event.js')
  const ev = new DragEvent('dragmove', 10, 4, 2, 2)
  dispatchDragEvent(child, ev)
  check(
    'U9 子节点异常隔离后继续冒泡、localCol 按当前 target 更新',
    calls.length === 1 && calls[0] === 'pad 8,2' && childMetadata === 'true/true/at_target/8,1',
    `${childMetadata} | ${calls.join(' | ')}`,
  )
  check('U9 派发后保留 target、清 currentTarget/eventPhase',
    ev.target === child && ev.currentTarget === null && ev.eventPhase === 'none')
  // stopPropagation stops the next node in the real ancestor chain.
  const calls2: string[] = []
  pad._eventHandlers = {
    onDragEnd: (e: { stopPropagation: () => void }) => {
      calls2.push('pad')
      e.stopPropagation()
    },
  }
  root._eventHandlers = { onDragEnd: () => calls2.push('root') }
  dispatchDragEvent(pad, new DragEvent('dragend', 5, 4, 2, 2))
  check('U9 stopPropagation 停止向 root 冒泡', calls2.length === 1 && calls2[0] === 'pad')
}

// ── 集成层：真实 Ink 管线 + headless xterm + SGR 逐字节 stdin ──
const COLS = 100
const ROWS = 30
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
// 全量 stdout 记录：I6 据此断言手势窗口内的协议写入为零。
// 在公共 write() 入口同步记录，而非 _write()——Writable 的内部队列会把
// 已调用的 write() 缓冲到 _write 回调之后，快照可能漏掉在途写入。
// 单调序号：每条写入递增，用于跨事件 timeline 断言（如 I9b 的 re-entry
// 必须在 click 之后）。
const stdoutWrites: string[] = []
let stdoutSeq = 0
const stdoutSeqs: number[] = [] // 与 stdoutWrites 平行，记录每条写入的序号
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  write(chunk: any, encodingOrCb?: BufferEncoding | ((error: Error | null | undefined) => void), cb?: (error: Error | null | undefined) => void): boolean {
    stdoutWrites.push(String(chunk))
    stdoutSeqs.push(stdoutSeq++)
    return super.write(chunk, encodingOrCb as BufferEncoding, cb)
  }
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
const dragEventSeqs: number[] = [] // 与 dragEvents 平行，记录每个事件的序号
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
  dragEventSeqs.push(stdoutSeq) // 事件发生时的 stdout 序号（近似时序锚点）
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

function PlainScene() {
  useInput(() => {})
  return <Text>MAINSCREENMARKER</Text>
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
          onClick={() => recordDrag({ type: 'click', col: -1, row: -1, startCol: -1, startRow: -1, localCol: -1, localRow: -1 })}
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
const x10 = (button: number, c: number, r: number) => stdin.write(
  `\x1b[M${String.fromCharCode(button + 32)}${String.fromCharCode(c + 1 + 32)}${String.fromCharCode(r + 1 + 32)}`,
)

// 直达 Ink 内部 App 实例（测试专用）：戳 lastStdinTime 伪造 stdin 空闲间隔、
// 清空 querier 在途队列。
type AppInternals = {
  lastStdinTime: number
  querier?: {
    queue: Array<
      | { kind: 'query'; resolve: (r: unknown) => void; releaseRawMode: () => void }
      | { kind: 'sentinel'; resolve: () => void; releaseRawMode: () => void }
    >
  }
}
type InkInternals = {
  pendingProbeRequest: { skipMouseReassert?: boolean } | undefined
  pendingAltScreenReentry: boolean
  pointerGestureActive: boolean
  protocolCandidateActive: boolean
}
function appInternals(): AppInternals {
  const ink = instances.get(stdout) as unknown as { app: AppInternals | null }
  if (!ink?.app) throw new Error('App instance not reachable')
  return ink.app
}
function inkInternals(): InkInternals {
  const ink = instances.get(stdout) as unknown as InkInternals
  if (!ink) throw new Error('Ink instance not reachable')
  return ink
}
// headless xterm 的查询应答不会被喂回 stdin，历史 probe 的在途 query/sentinel
// 永不到期；本用例注入的 DECRPM/DA1 回包按 FIFO 会先被它们吃掉。测试前清空
// （语义同 querier.dispose()，但不置 disposed 标记），让回包精确落位。
function drainQuerier(): void {
  const q = appInternals().querier
  if (!q) return
  for (const p of q.queue.splice(0)) {
    if (p.kind === 'query') p.resolve(undefined)
    else p.resolve()
    p.releaseRawMode()
  }
}

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
  dragEvents.length = 0; dragEventSeqs.length = 0
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
  dragEvents.length = 0; dragEventSeqs.length = 0
  press(padPos.col + 3, padPos.row)
  release(padPos.col + 3, padPos.row)
  const clicked = await settled(
    () => dragEvents.some((e) => e.type === 'click') && dragEvents.every((e) => e.type === 'click'),
  )
  check('I2 未移动：无 dragstart/move/end', dragEvents.every((e) => e.type === 'click'))
  check('I2 click 照常触发', clicked, dragEvents.map((e) => e.type).join(','))
}

{
  // I2b: classic X10 uses low bits 3 as a generic release. Both a dormant
  // component click and a started drag must complete through the real parser.
  dragEvents.length = 0; dragEventSeqs.length = 0
  x10(0, padPos.col + 3, padPos.row)
  x10(3, padPos.col + 3, padPos.row)
  check('I2b X10 press→release 触发 click',
    await settled(() => dragEvents.length === 1 && dragEvents[0]?.type === 'click'),
    dragEvents.map(event => event.type).join(','))
  dragEvents.length = 0; dragEventSeqs.length = 0
  x10(0, padPos.col + 2, padPos.row)
  x10(0x20, padPos.col + 6, padPos.row)
  x10(3, padPos.col + 6, padPos.row)
  check('I2b X10 press→motion→release 收尾 dragend',
    await settled(() => dragEvents.map(event => event.type).join(',') === 'dragstart,dragmove,dragend'),
    dragEvents.map(event => event.type).join(','))
}

{
  // I3: drag 中 FOCUS_OUT → 收到 dragend
  dragEvents.length = 0; dragEventSeqs.length = 0
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
  dragEvents.length = 0; dragEventSeqs.length = 0
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

{
  // I6: 手势窗口零协议写入（beta.1 现场回归的硬断言）+ 手势闩。
  // 背景：beta.1 的 #611 把 probeAltScreenHealth 挂上了 press 路径
  // （findDragTargetAt），按下瞬间盲写鼠标 DECSET 重断言
  // （\x1b[?1000h?1002h?1003h?1006h）+ DECRQM 查询（\x1b[?1049$p）。
  // WezTerm/xterm.js 系终端在按键按住期间收到 DECSET 重断言会重置按键
  // 跟踪，该次拖拽的 motion 流被静默掐断——用户表现为"拖好多次才选中
  // 一次"。探测本身有 250ms 节流，所以是否写入取决于按下距上次探测的
  // 间隔——这正是"时灵时不灵"的竞态来源。
  // 本用例：先静默 300ms 让节流冷却（press 时探测必发——修复前），再
  // press→FOCUS_IN（探测的另一触发源，检验手势闩）→motion→release，
  // 断言整个手势窗口 stdout 无任何探测写入，且 drag 事件流完整。
  // 窗口在 release 写入【之前】截断：release 处理后闩解除，此后 probe 在
  // 安全边界恢复属正确行为（I6b 专门验证），不能计入禁止窗口——否则修复
  // 在 release 后立即做安全 probe 的正确实现反而会被判 FAIL。
  await sleep(300) // 让 250ms 探测节流彻底冷却
  dragEvents.length = 0; dragEventSeqs.length = 0
  const gestureStart = stdoutWrites.length
  press(padPos.col + 2, padPos.row)
  await sleep(30)
  stdin.write('\x1b[I') // FOCUS_IN：平时必触发探测；按住期间必须被闩挡住
  await sleep(30)
  motion(padPos.col + 5, padPos.row)
  await sleep(30)
  motion(padPos.col + 8, padPos.row)
  await sleep(30)
  const beforeRelease = stdoutWrites.length
  release(padPos.col + 8, padPos.row)
  check(
    'I6 手势期间 drag 事件流完整（精确序列+终点坐标）',
    await settled(
      () =>
        dragEvents.map((e) => e.type).join(',') ===
          'dragstart,dragmove,dragmove,dragend' &&
        dragEvents[3]!.col === padPos.col + 8 &&
        dragEvents[3]!.row === padPos.row,
    ),
    dragEvents.map((e) => `${e.type}@${e.col},${e.row}`).join(' '),
  )
  const duringGesture = stdoutWrites.slice(gestureStart, beforeRelease).join('')
  check(
    'I6 手势窗口（press→release 前）零探测写入（无 DECSET 重断言 / DECRQM）',
    !/\[\?(1000|1002|1003|1006)h/.test(duringGesture) && !duringGesture.includes('[?1049$p'),
    JSON.stringify(duringGesture.match(/\[\?\d+[$hl][a-z]?/g) ?? []),
  )
}
{
  // I6b: 松手后闩解除——FOCUS_IN 探测恢复盲写（证明闩不是永久禁用探测，
  // conpty 自愈路径仍然可用）。
  await sleep(300) // 再次冷却节流，确保本次 focus 必触发
  const mark = stdoutWrites.length
  stdin.write('\x1b[I')
  await settled(() => /\[\?1006h|\[\?1049\$p/.test(stdoutWrites.slice(mark).join('')))
  const afterRelease = stdoutWrites.slice(mark).join('')
  check(
    'I6b 松手后 FOCUS_IN 探测恢复',
    /\[\?1006h/.test(afterRelease) || afterRelease.includes('[?1049$p'),
    JSON.stringify(afterRelease.match(/\[\?\d+[$hl][a-z]?/g) ?? []),
  )
}

{
  // I8: >5s 空闲后的首个输入就是 SGR press —— 物理按键已经按下，但闩只有
  // 在该批次被解析后才上锁。旧代码在读循环【之前】触发 onStdinResume，
  // 盲写 ENABLE_MOUSE_TRACKING 正落在 press 与首个 motion 之间
  // （WezTerm/xterm.js 系终端的 motion 流就此静默丢失）。修复：resume 延到
  // 批次解析之后，此时闩已上锁，probe 被挡住。lastStdinTime 是 public
  // 字段，直接戳回 6s 前，省一次真实的 5s 睡眠。
  drainQuerier()
  await sleep(300) // 节流冷却：resume 若没被闩挡住，probe 必发
  appInternals().lastStdinTime = Date.now() - 6000
  dragEvents.length = 0; dragEventSeqs.length = 0
  const gapStart = stdoutWrites.length
  press(padPos.col + 2, padPos.row)
  await sleep(30)
  motion(padPos.col + 5, padPos.row)
  await sleep(30)
  motion(padPos.col + 8, padPos.row)
  await sleep(30)
  const gapBeforeRelease = stdoutWrites.length
  release(padPos.col + 8, padPos.row)
  check(
    'I8 空闲-gap 后 press 起的手势 drag 事件流完整',
    await settled(
      () =>
        dragEvents.map((e) => e.type).join(',') ===
        'dragstart,dragmove,dragmove,dragend',
    ),
    dragEvents.map((e) => e.type).join(','),
  )
  const gapWindow = stdoutWrites.slice(gapStart, gapBeforeRelease).join('')
  check(
    'I8 gap→press 窗口零探测写入（resume 延到批次后被闩挡住）',
    !/\[\?(1000|1002|1003|1006)h/.test(gapWindow) && !gapWindow.includes('[?1049$p'),
    JSON.stringify(gapWindow.match(/\[\?\d+[$hl][a-z]?/g) ?? []),
  )
}

{
  // I8b: 分段 press（SSH/ConPTY 拆段）+ idle gap —— 首段 `ESC[<0;18` 先到达，
  // 尚未形成完整 press，但 P1-1 修复在 parser 捕获 SGR 前缀时即上闩。
  // 旧代码 resume probe 在未上闩状态写入，motion 流死在拖拽中。
  drainQuerier()
  await sleep(300)
  appInternals().lastStdinTime = Date.now() - 6000
  dragEvents.length = 0; dragEventSeqs.length = 0
  const splitStart = stdoutWrites.length
  // SGR 是 1-based：padPos 是 0-based，+1 转换。press(c, r) 内部也 +1，
  // 这里直接写 stdin 需要手动对齐。
  const pressCol = padPos.col + 2 + 1 // 0-based padPos.col+2 → 1-based SGR col
  const pressRow = padPos.row + 1 // 0-based row → 1-based SGR row
  const pressSeq = `\x1b[<0;${pressCol};${pressRow}M`
  const cut = Math.floor(pressSeq.length / 2)
  stdin.write(pressSeq.slice(0, cut)) // 首段：ESC[<0;18（未形成 ParsedMouse）
  await sleep(120) // >50ms flush 窗口，hold 捕获
  stdin.write(pressSeq.slice(cut)) // 尾段：;34M → 完整 press
  await sleep(30)
  motion(padPos.col + 5, padPos.row)
  await sleep(30)
  motion(padPos.col + 8, padPos.row)
  await sleep(30)
  const splitBeforeRelease = stdoutWrites.length
  release(padPos.col + 8, padPos.row)
  check(
    'I8b 分段 press + gap 后 drag 事件流完整（含起点坐标）',
    await settled(
      () =>
        dragEvents.map((e) => e.type).join(',') ===
          'dragstart,dragmove,dragmove,dragend' &&
        dragEvents[0]!.startCol === padPos.col + 2 &&
        dragEvents[0]!.startRow === padPos.row,
    ),
    dragEvents.map((e) => `${e.type}@${e.col},${e.row} start=${e.startCol},${e.startRow}`).join(' '),
  )
  const splitWindow = stdoutWrites.slice(splitStart, splitBeforeRelease).join('')
  check(
    'I8b 分段 press 窗口零探测写入（首段 hold 即上闩）',
    !/\[\?(1000|1002|1003|1006)h/.test(splitWindow) && !splitWindow.includes('[?1049$p'),
    JSON.stringify(splitWindow.match(/\[\?\d+[$hl][a-z]?/g) ?? []),
  )
}

{
  // I9: DECRQM 在途时按下鼠标，reset 回包在手势【中】到达 —— 旧代码的
  // Promise 回调无条件 reenterAltScreen()，?1049h + 2J 直接清屏并重置按键
  // 跟踪。修复：回调复检闩锁，手势中只登记 pendingAltScreenReentry，松手后
  // 在安全边界补做。drainQuerier 先清掉历史 probe 的在途 query（headless
  // xterm 不应答查询，它们会按 FIFO 抢走本用例注入的回包）。
  drainQuerier()
  await sleep(300) // 节流冷却，确保 FOCUS_IN 必发 probe
  const probeStart = stdoutWrites.length
  stdin.write('\x1b[I')
  check(
    'I9 FOCUS_IN 探测照常发出 DECRQM 1049 查询',
    await settled(() => stdoutWrites.slice(probeStart).join('').includes('[?1049$p')),
    JSON.stringify(stdoutWrites.slice(probeStart).join('').match(/\[\?\d+[$hl][a-z]?/g) ?? []),
  )
  dragEvents.length = 0; dragEventSeqs.length = 0
  press(padPos.col + 2, padPos.row)
  await sleep(30)
  const replyStart = stdoutWrites.length
  stdin.write('\x1b[?1049;2$y') // DECRPM 回包：1049 = reset
  stdin.write('\x1b[?1;2c') // DA1 哨兵应答：让 probe 的 flush() 完成
  await sleep(60) // 给 promise 回调（微任务+settled）落的时间
  const midGesture = stdoutWrites.slice(replyStart).join('')
  check(
    'I9 手势中收到 reset 回包不重入（无 ?1049h / 2J / 鼠标重断言）',
    !midGesture.includes('[?1049h') &&
      !midGesture.includes('[2J') &&
      !/\[\?(1000|1002|1003|1006)h/.test(midGesture),
    JSON.stringify(midGesture.match(/\[\?\d+[$hl][a-z]?|\[2J/g) ?? []),
  )
  motion(padPos.col + 5, padPos.row)
  await sleep(30)
  motion(padPos.col + 8, padPos.row)
  release(padPos.col + 8, padPos.row)
  await sleep(100) // 给 release 尾部的 drainReleaseTail 落的时间
  check(
    'I9 松手后在安全边界补做延期重入（?1049h + 清屏）',
    await settled(() => {
      const w = stdoutWrites.slice(replyStart).join('')
      return w.includes('[?1049h') && w.includes('[2J')
    }),
    JSON.stringify(stdoutWrites.slice(replyStart).join('').match(/\[\?\d+[$hl][a-z]?|\[2J/g) ?? []),
  )
  check(
    'I9 手势期间 drag 事件流完整',
    dragEvents.map((e) => e.type).join(',') === 'dragstart,dragmove,dragmove,dragend',
    dragEvents.map((e) => e.type).join(','),
  )
}

{
  // I9b: dormant drag（press→无 motion→release→click）场景下，延期 re-entry
  // 必须在 dispatchClick 之后执行——reenterAltScreen 同步清空 frontFrame，
  // 若提前执行，dispatchClick 的 cellIsBlank / getHyperlinkAt 读到空帧。
  drainQuerier()
  await sleep(300)
  const clickProbeStart = stdoutWrites.length
  stdin.write('\x1b[I')
  await settled(() => stdoutWrites.slice(clickProbeStart).join('').includes('[?1049$p'))
  dragEvents.length = 0; dragEventSeqs.length = 0
  press(padPos.col + 2, padPos.row)
  await sleep(30)
  const clickReplyStart = stdoutWrites.length
  stdin.write('\x1b[?1049;2$y') // DECRPM: 1049 = reset
  stdin.write('\x1b[?1;2c') // DA1 哨兵
  await sleep(60)
  release(padPos.col + 2, padPos.row) // 无 motion → dormant → click 路径
  await sleep(100)
  // re-entry 必须在 click 之后发生（统一 timeline：click 事件的 stdout 序号
  // 必须小于 re-entry 的 stdout 序号——若 re-entry 先执行，frontFrame 被清空，
  // dispatchClick 读到空帧，click 事件不会发出或读到错误坐标）。
  const clickHeal = stdoutWrites.slice(clickReplyStart).join('')
  const clickHealWrites = stdoutWrites.slice(clickReplyStart)
  const clickHealSeqs = stdoutSeqs.slice(clickReplyStart)
  // 找包含 [?1049h 的写入的数组索引（不是字符索引——clickHeal 是拼接字符串）
  const reentryWriteIdx = clickHealWrites.findIndex((w) => w.includes('[?1049h'))
  const reentrySeq = reentryWriteIdx >= 0 ? clickHealSeqs[reentryWriteIdx]! : -1
  const clickSeq = dragEventSeqs.length > 0 ? dragEventSeqs[dragEventSeqs.length - 1]! : -1
  check(
    'I9b dormant click release 后补做延期重入（?1049h + 清屏）',
    clickHeal.includes('[?1049h') && clickHeal.includes('[2J'),
    JSON.stringify(clickHeal.match(/\[\?\d+[$hl][a-z]?|\[2J/g) ?? []),
  )
  check(
    'I9b re-entry 在 click 之后（统一 timeline）',
    reentrySeq >= clickSeq && clickSeq >= 0,
    `clickSeq=${clickSeq} reentrySeq=${reentrySeq}`,
  )
  // dormant press→release 无 motion → click 事件（非 drag）
  check(
    'I9b dormant 触发 click 而非 drag（press→release 无 motion）',
    dragEvents.length === 1 && dragEvents[0]!.type === 'click',
    dragEvents.map((e) => e.type).join(','),
  )
}

{
  // I10: 手势中 resize —— 几何重置把逻辑拖拽收尾（dragend），但物理按键
  // 并未松开：闩必须保持，resize handler 自己的 health probe 不得写。
  // 旧代码 resetPointerState 顺带解闩，同一 handleResize 尾部的 probe
  // 立刻漏写。
  drainQuerier()
  await sleep(300)
  dragEvents.length = 0; dragEventSeqs.length = 0
  press(padPos.col + 2, padPos.row)
  await sleep(30)
  motion(padPos.col + 5, padPos.row)
  await settled(() => dragEvents.some((e) => e.type === 'dragmove'))
  const resizeStart = stdoutWrites.length
  stdout.columns = COLS + 12
  stdout.emit('resize')
  await sleep(100)
  const duringResize = stdoutWrites.slice(resizeStart).join('')
  check(
    'I10 resize 期间零探测写入（闩不因几何重置解除）',
    !/\[\?(1000|1002|1003|1006)h/.test(duringResize) && !duringResize.includes('[?1049$p'),
    JSON.stringify(duringResize.match(/\[\?\d+[$hl][a-z]?/g) ?? []),
  )
  check(
    'I10 resize 把进行中的 drag 收尾为 dragend',
    await settled(() => dragEvents.at(-1)?.type === 'dragend'),
    dragEvents.map((e) => e.type).join(','),
  )
  // I10c 前置：resize 的 probe 必须已被闩挡住并记入 pendingProbeRequest —
  // 否则 release 后的"有 probe 输出 + pending 为空"不能证明 drain 发生。
  check(
    'I10c 前置：resize probe 已被闩挡住并记入 pendingProbeRequest',
    inkInternals().pendingProbeRequest !== undefined,
    `pendingProbeRequest=${JSON.stringify(inkInternals().pendingProbeRequest)}`,
  )
  const beforeRelease = stdoutWrites.length
  release(padPos.col + 5, padPos.row) // 物理松手 → 解闩
  // drainPendingProbe 可能被 250ms 节流（release 后 renderer 帧完成触发的
  // dispatchKeyboardEvent probe 更新了 lastHealthProbeAt），setTimeout 安排
  // 冷却重试。等重试窗口过完再断言 pendingProbeRequest 排空。
  await sleep(300)
  // I10c: release 尾部排空被 gesture 挡住的 resize probe —— P1-3 修复。
  // resize 在按住期间被闩挡住并记入 pendingProbeRequest；release 后
  // drainReleaseTail 重试它，probe 正常发出（可能发现 1049 丢失并补做
  // re-entry）。窗口从 release 写入【之前】开始，包含 drainReleaseTail 的
  // 同步写入。直接断言 pendingProbeRequest 被排空，证明输出来自被 resize
  // 阻塞的 pending probe 而非其他路径。
  const afterReleaseProbe = stdoutWrites.slice(beforeRelease).join('')
  check(
    'I10c release 后排空被挡的 resize probe（P1-3 恢复）',
    /\[\?(1000|1002|1003|1006)h/.test(afterReleaseProbe) || afterReleaseProbe.includes('[?1049$p'),
    JSON.stringify(afterReleaseProbe.match(/\[\?\d+[$hl][a-z]?/g) ?? []),
  )
  check(
    'I10c pendingProbeRequest 已排空（证明输出来自被挡 probe）',
    inkInternals().pendingProbeRequest === undefined,
    `pendingProbeRequest=${JSON.stringify(inkInternals().pendingProbeRequest)}`,
  )
  // 还原几何并重新定位标记，后续用例不受影响
  stdout.columns = COLS
  stdout.emit('resize')
  await settled(() => findMarker('DRAGPADMARKER').col >= 0)
  const p = findMarker('DRAGPADMARKER')
  padPos.col = p.col
  padPos.row = p.row
}

{
  // I11: 纯鼠标用户的 1049 自愈入口。收到鼠标事件只证明 tracking 活着，
  // 证明不了 1049 还在（conpty 可独立丢 1049）；而鼠标输入不断刷新
  // lastStdinTime，>5s gap 路径对纯鼠标用户永不触发。修复：在安全边界
  // （无按钮 hover、wheel、click release）恢复 probe，但只发 DECRQM 1049
  // 查询、不盲写鼠标 DECSET（事件本身已证明 tracking 存活，
  // skipMouseReassert）。无按钮 motion 在 dispatch 前已解闩，不在手势内。
  drainQuerier()
  await sleep(400) // 冷却 250ms 节流：I10c 的 probe 在 release 后发出，
  // 需要确保 hover 的 probe 不在同一节流窗口内被吞
  const hoverStart = stdoutWrites.length
  stdin.write(`\x1b[<35;${padPos.col + 4};${padPos.row + 1}M`)
  check(
    'I11 无按钮 hover 触发 DECRQM 1049 查询',
    await settled(() => stdoutWrites.slice(hoverStart).join('').includes('[?1049$p')),
    JSON.stringify(stdoutWrites.slice(hoverStart).join('').match(/\[\?\d+[$hl][a-z]?/g) ?? []),
  )
  const hoverWrites = stdoutWrites.slice(hoverStart).join('')
  check(
    'I11 hover probe 不盲写鼠标 DECSET（skipMouseReassert）',
    !/\[\?(1000|1002|1003|1006)h/.test(hoverWrites),
    JSON.stringify(hoverWrites.match(/\[\?\d+[$hl][a-z]?/g) ?? []),
  )
}

{
  // I11b: wheel 是同类安全边界，且是 1002-only 终端（无 hover motion）上
  // 纯鼠标用户的唯一恢复入口：SGR wheel 报告不携带按住状态、从不上闩。
  drainQuerier()
  await sleep(300)
  const wheelStart = stdoutWrites.length
  stdin.write(`\x1b[<64;${padPos.col + 4};${padPos.row + 1}M`)
  check(
    'I11b wheel 触发 DECRQM 1049 查询',
    await settled(() => stdoutWrites.slice(wheelStart).join('').includes('[?1049$p')),
    JSON.stringify(stdoutWrites.slice(wheelStart).join('').match(/\[\?\d+[$hl][a-z]?/g) ?? []),
  )
  const wheelWrites = stdoutWrites.slice(wheelStart).join('')
  check(
    'I11b wheel probe 不盲写鼠标 DECSET（skipMouseReassert）',
    !/\[\?(1000|1002|1003|1006)h/.test(wheelWrites),
    JSON.stringify(wheelWrites.match(/\[\?\d+[$hl][a-z]?/g) ?? []),
  )
}

{
  // I10b: 无手势时的 resize —— 正向对照：probe 正常发出（闩未上锁时
  // handleResize 尾部的 health probe 必须写，否则 P1-1 的"resize 不解闩"
  // 修复会把 resize 自愈也禁掉）。
  drainQuerier()
  await sleep(300)
  const idleResizeStart = stdoutWrites.length
  stdout.columns = COLS + 8
  stdout.emit('resize')
  check(
    'I10b 无手势时 resize probe 正常发出（正向对照）',
    await settled(() => {
      const w = stdoutWrites.slice(idleResizeStart).join('')
      return /\[\?(1000|1002|1003|1006)h/.test(w) || w.includes('[?1049$p')
    }),
    JSON.stringify(stdoutWrites.slice(idleResizeStart).join('').match(/\[\?\d+[$hl][a-z]?/g) ?? []),
  )
  stdout.columns = COLS
  stdout.emit('resize')
  await settled(() => findMarker('DRAGPADMARKER').col >= 0)
  const p = findMarker('DRAGPADMARKER')
  padPos.col = p.col
  padPos.row = p.row
}

{
  // I11c: hover 安全边界喂入 reset 回包 —— 纯鼠标路径的完整自愈闭环：
  // hover 触发 DECRQM 1049 查询 → 终端回 1049=reset → re-enter alt-screen。
  // 这是 conpty 丢 1049 但 mouse tracking 存活的场景：hover 事件证明 tracking
  // 活着（skipMouseReassert 不重写 DECSET），但 1049 查询发现 alt-screen 丢失，
  // 必须补做 re-entry。
  drainQuerier()
  await sleep(300)
  const hoverHealStart = stdoutWrites.length
  stdin.write(`\x1b[<35;${padPos.col + 4};${padPos.row + 1}M`)
  await settled(() => stdoutWrites.slice(hoverHealStart).join('').includes('[?1049$p'))
  // query 已创建，reply 前无 re-entry
  const beforeReply = stdoutWrites.slice(hoverHealStart).join('')
  check(
    'I11c query 已创建且 reply 前无 re-entry',
    beforeReply.includes('[?1049$p') && !beforeReply.includes('[?1049h') && !beforeReply.includes('[2J'),
    JSON.stringify(beforeReply.match(/\[\?\d+[$hl][a-z]?|\[2J/g) ?? []),
  )
  stdin.write('\x1b[?1049;2$y') // DECRPM: 1049 = reset
  stdin.write('\x1b[?1;2c') // DA1 哨兵：让 probe 的 flush() 完成
  check(
    'I11c hover probe 收到 reset 回包后 re-enter alt-screen',
    await settled(() => {
      const w = stdoutWrites.slice(hoverHealStart).join('')
      return w.includes('[?1049h') && w.includes('[2J')
    }),
    JSON.stringify(stdoutWrites.slice(hoverHealStart).join('').match(/\[\?\d+[$hl][a-z]?|\[2J/g) ?? []),
  )
}

{
  // I11d: wheel 安全边界喂入 reset 回包 —— 同类闭环，wheel 路径。
  drainQuerier()
  await sleep(300)
  const wheelHealStart = stdoutWrites.length
  stdin.write(`\x1b[<64;${padPos.col + 4};${padPos.row + 1}M`)
  await settled(() => stdoutWrites.slice(wheelHealStart).join('').includes('[?1049$p'))
  // query 已创建，reply 前无 re-entry
  const beforeReplyWheel = stdoutWrites.slice(wheelHealStart).join('')
  check(
    'I11d query 已创建且 reply 前无 re-entry',
    beforeReplyWheel.includes('[?1049$p') && !beforeReplyWheel.includes('[?1049h') && !beforeReplyWheel.includes('[2J'),
    JSON.stringify(beforeReplyWheel.match(/\[\?\d+[$hl][a-z]?|\[2J/g) ?? []),
  )
  stdin.write('\x1b[?1049;2$y')
  stdin.write('\x1b[?1;2c')
  check(
    'I11d wheel probe 收到 reset 回包后 re-enter alt-screen',
    await settled(() => {
      const w = stdoutWrites.slice(wheelHealStart).join('')
      return w.includes('[?1049h') && w.includes('[2J')
    }),
    JSON.stringify(stdoutWrites.slice(wheelHealStart).join('').match(/\[\?\d+[$hl][a-z]?|\[2J/g) ?? []),
  )
}

{
  // I12: 同一 stdin batch 的 release → next press —— release 的批次尾 drain
  // 在 next press 已上闩后执行，probe/re-entry 被闩挡住（不写入）。旧代码在
  // release 的单事件 finally 里 drain，probe 字节落进下一次手势的开口窗口。
  drainQuerier()
  await sleep(400) // 节流冷却
  dragEvents.length = 0; dragEventSeqs.length = 0
  // 第一次手势：press → motion → release
  press(padPos.col + 2, padPos.row)
  await sleep(30)
  motion(padPos.col + 5, padPos.row)
  await settled(() => dragEvents.some((e) => e.type === 'dragmove'))
  // 同一 batch：release + 立即 next press（一个 stdin write 携带两个事件）
  const batchStart = stdoutWrites.length
  stdin.write(`\x1b[<0;${padPos.col + 5 + 1};${padPos.row + 1}m\x1b[<0;${padPos.col + 2 + 1};${padPos.row + 1}M`)
  await sleep(50)
  // next press 已上闩，批次尾 drain 被挡住——窗口内零 probe 写入
  const batchWindow = stdoutWrites.slice(batchStart).join('')
  check(
    'I12 同 batch release→press：批次尾 drain 被 next press 闩挡住',
    !/\[\?(1000|1002|1003|1006)h/.test(batchWindow) &&
      !batchWindow.includes('[?1049$p') &&
      !batchWindow.includes('[?1049h') &&
      !batchWindow.includes('[2J'),
    JSON.stringify(batchWindow.match(/\[\?\d+[$hl][a-z]?|\[2J/g) ?? []),
  )
  // 第二次手势完成
  motion(padPos.col + 5, padPos.row)
  await sleep(30)
  motion(padPos.col + 8, padPos.row)
  await sleep(30)
  release(padPos.col + 8, padPos.row)
  check(
    'I12 两次手势的 drag 事件流完整',
    await settled(
      () =>
        dragEvents.map((e) => e.type).join(',') ===
        'dragstart,dragmove,dragend,dragstart,dragmove,dragmove,dragend',
    ),
    dragEvents.map((e) => e.type).join(','),
  )
}

{
  // I12b: 同一 stdin batch 的 FOCUS_IN → press —— focus probe 延迟到批次尾，
  // 此时 press 闩已建立，probe 被挡住。
  drainQuerier()
  await sleep(400)
  dragEvents.length = 0; dragEventSeqs.length = 0
  const focusBatchStart = stdoutWrites.length
  stdin.write(`\x1b[I\x1b[<0;${padPos.col + 2 + 1};${padPos.row + 1}M`)
  await sleep(50)
  const focusBatchWindow = stdoutWrites.slice(focusBatchStart).join('')
  check(
    'I12b 同 batch FOCUS_IN→press：focus probe 被 press 闩挡住',
    !/\[\?(1000|1002|1003|1006)h/.test(focusBatchWindow) &&
      !focusBatchWindow.includes('[?1049$p'),
    JSON.stringify(focusBatchWindow.match(/\[\?\d+[$hl][a-z]?/g) ?? []),
  )
  motion(padPos.col + 5, padPos.row)
  await sleep(30)
  release(padPos.col + 5, padPos.row)
  check(
    'I12b 手势 drag 事件流完整',
    await settled(
      () => dragEvents.map((e) => e.type).join(',') === 'dragstart,dragmove,dragend',
    ),
    dragEvents.map((e) => e.type).join(','),
  )
}

{
  // I12c: X10 多按钮重叠——左键按住时右键 press + generic release（X10 不携带
  // 按钮身份），probe 必须保持 blocked（ambiguous-held）直到可靠的终止信号。
  drainQuerier()
  await sleep(400)
  dragEvents.length = 0; dragEventSeqs.length = 0
  // X10 press（ESC M + 3字节）：左键
  stdin.write(`\x1b[M${String.fromCharCode(32 + 0)}${String.fromCharCode(32 + padPos.col + 3)}${String.fromCharCode(32 + padPos.row + 1)}`)
  await sleep(30)
  const x10PressStart = stdoutWrites.length
  // X10 press：右键（button=2）
  stdin.write(`\x1b[M${String.fromCharCode(32 + 2)}${String.fromCharCode(32 + padPos.col + 4)}${String.fromCharCode(32 + padPos.row + 1)}`)
  await sleep(30)
  // X10 generic release（button=3）——不携带按钮身份
  stdin.write(`\x1b[M${String.fromCharCode(32 + 3)}${String.fromCharCode(32 + padPos.col + 4)}${String.fromCharCode(32 + padPos.row + 1)}`)
  await sleep(50)
  const x10Window = stdoutWrites.slice(x10PressStart).join('')
  check(
    'I12c X10 generic release 后 probe 保持 blocked（ambiguous-held）',
    !/\[\?(1000|1002|1003|1006)h/.test(x10Window) &&
      !x10Window.includes('[?1049$p') &&
      !x10Window.includes('[?1049h'),
    JSON.stringify(x10Window.match(/\[\?\d+[$hl][a-z]?/g) ?? []),
  )
  // 可靠终止：no-button motion 清除 ambiguous-held
  stdin.write(`\x1b[<35;${padPos.col + 4};${padPos.row + 1}M`)
  await sleep(50)
}

{
  // I7: leaving AlternateScreen settles dragend before the active-screen gate
  // closes. The consumer must not be left with a captured gesture.
  dragEvents.length = 0; dragEventSeqs.length = 0
  press(padPos.col + 2, padPos.row)
  motion(padPos.col + 7, padPos.row)
  await settled(() => dragEvents.some(event => event.type === 'dragmove'))
  inst.rerender(<PlainScene />)
  check(
    'I7 AlternateScreen 退出仍派发 cleanup dragend',
    await settled(() => dragEvents.at(-1)?.type === 'dragend'),
    dragEvents.map(event => event.type).join(','),
  )
}

await inst.unmount()

if (failures > 0) {
  console.error(`\nverify-drag-protocol: ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nverify-drag-protocol: all checks passed')
