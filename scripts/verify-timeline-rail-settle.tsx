/**
 * verify-timeline-rail-settle — 布局驱动视口高度变化（不经过滚动、不翻转
 * sticky）后，timeline rail 的几何必须跟随新视口重绘。
 *
 * 被测回归（#render-node-to-output 视口高度通知）：ScrollbarGutter / TimelineRail
 * 在 React 渲染期读 ScrollBox handle 的 getViewportHeight()/getScrollHeight()，
 * 那是上一趟 Yoga 布局的缓存值。凡「本次提交改变视口高度」的渲染都拿旧值画，
 * 而落定新几何的那趟 render pass 原本静默（无 scroll delta、无 sticky 翻转），
 * 没有任何通知能再触发这些组件渲染。修复在 ScrollBox↔renderer 接缝加
 * `onViewportHeightChange`（仅高度变化触发），并接到既有订阅通知面。
 *
 * 断言（headless xterm 100×40，全屏 Chat，8 轮对话；纯净 timeline gutter）：
 *   1. 语义探针：悬停 rail tick（只动轨道本地态、不改布局）时高度信号计数不增；
 *   2. 回顾卡悬停展开（AutoRecapRow 本地 hover 态加 2 行底部 chrome，压缩转录
 *      视口）→ rail 几何跟随压缩后的视口；信号计数 >0（悬停路径零滚动通知）；
 *      取消悬停恢复 → rail 几何跟随恢复后的视口；
 *   3. 终端行 resize 40→30（再 30→40）→ rail 几何跟随 resize 后的视口。
 *
 * 期望行由 `findScrollNode(instances.get(stdout).rootNode)` 的真实
 * scrollViewportTop/scrollViewportHeight 经 src/ink/timeline-rail.ts 的
 * computeRailGeometry 反算；与屏幕右两列实测的 ▲/▼/tick 行比对。8 轮 <
 * 视口 tick 容量，所以窗口恒含全部 tick——期望几何与 active/atBottom 无关，
 * 脚本先校验该前提。
 *
 * 运行：node --import tsx/esm scripts/verify-timeline-rail-settle.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'
process.env.SSH_CONNECTION = 'headless-test'
delete process.env.TMUX

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { LOCAL_COMMANDS, completeCommands }, { default: instances }, { computeRailGeometry, railEligible }, { settled, sleep }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
  import('../src/ink/instances.js'),
  import('../src/ink/timeline-rail.js'),
  import('./lib/term-test.mjs'),
])

const COLS = 100
const ROWS = 40
const TURNS = 8
let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS; rows = ROWS; isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const stdin = new FakeStdin(), stdout = new FakeStdout(), stderr = new FakeStderr()

const rows: any[] = []
for (let turn = 1; turn <= TURNS; turn++) {
  rows.push({ id: turn * 2 - 1, kind: 'user', text: `问题 ${turn}` })
  rows.push({ id: turn * 2, kind: 'assistant', text: Array.from({ length: 8 }, (_, i) => `回复 ${turn} 第 ${i + 1} 行`).join('\n') })
}
const listeners = new Set<() => void>()
const channel: any = {
  // 探针确定性：鲸鱼欢迎期闲置动画（默认开）不进本探针的测量窗口。
  whaleIdle: false,
  version: 0, rows, status: 'idle', sessionTitle: 'probe', agentId: 'probe',
  model: 'deepseek-v4-flash', provider: 'deepseek', reasoningEffort: 'max', effortLevels: [],
  tokens: { input: 0, output: 0 }, cwd: '/tmp/demo', displayCwd: '/tmp/demo', gitBranch: 'main',
  working: false, spinnerMode: 'requesting', responseChars: 0, activeToolCount: 0, turnStart: 0,
  pending: [], commandList: LOCAL_COMMANDS, notifications: [], mode: { plan: false, sandbox: undefined },
  activityFrames: 'moon8', agentPreset: undefined, subagents: [], lastUserText: `问题 ${TURNS}`,
  scrollGutter: 'timeline',
  autoRecapOnOpen: true,
  recapRecent: async (opts?: { onText?: (d: string) => void }) => {
    opts?.onText?.('这是自动总结。')
    return { summary: '这是自动总结。', title: '建议标题' }
  },
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => Promise.resolve([]),
  deleteSession: () => Promise.resolve(true), renameSessionTo: () => Promise.resolve(true),
  setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [], pushLocal: () => {},
  commandCompletions: (input: string) => completeCommands(input),
}

const inst = await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} fullscreen />
  </AlternateScreen>,
  { stdout: stdout as any, stdin: stdin as any, stderr: stderr as any, exitOnCtrlC: false, patchConsole: false },
)
const ink = instances.get(stdout as any) as any

/** 转译区 ScrollBox 的 DOM 节点（渲染期写 scrollViewportHeight 的那个）。 */
function scrollNode(): any {
  const walk = (node: any): any => {
    if (node?.scrollViewportHeight !== undefined) return node
    for (const c of node?.childNodes ?? []) {
      const hit = walk(c)
      if (hit) return hit
    }
    return null
  }
  return walk(ink.rootNode)
}

// ── 通知语义探针：包装渲染器→React 的视口高度回调，计数触发次数 ──
// 修复前该字段不存在（undefined），包装后渲染器永不调用 → 计数恒 0。
let heightSignals = 0
let counterInstalled = false
function installSignalCounter(): void {
  const n = scrollNode()
  if (!n) return
  const original = n.onViewportHeightChange
  n.onViewportHeightChange = (): void => {
    heightSignals += 1
    if (typeof original === 'function') original()
  }
  counterInstalled = true
}

function viewportTopRow(): number {
  return scrollNode()?.scrollViewportTop ?? 0
}
/** 屏幕实测的 rail 快照：只在真实视口行范围内扫右两列（排除总结行分隔线
 *  与输入框占用的底簇行）。 */
function railOnScreen(): { ticks: number[]; activeRow: number | null; upRow: number | null; downRow: number | null } {
  const buf = term.buffer.active
  const cell = (y: number, col: number): string => buf.getLine(buf.baseY + y)?.getCell(col)?.getChars() ?? ''
  const top = viewportTopRow()
  const bottom = top + (scrollNode()?.scrollViewportHeight ?? 0)
  const ticks: number[] = []
  let activeRow: number | null = null
  let upRow: number | null = null
  let downRow: number | null = null
  for (let y = top; y < bottom; y++) {
    const two = cell(y, COLS - 2) + cell(y, COLS - 1)
    if (two.includes('▴')) upRow = y
    else if (two.includes('▾')) downRow = y
    else if (two === '━━') { ticks.push(y); activeRow = y }
    else if (two === '──' || two === ' ─') ticks.push(y)
  }
  return { ticks, activeRow, upRow, downRow }
}
/** 从真实 ScrollBox 几何经 computeRailGeometry 反算的期望屏幕行。 */
function expectedRail(): { up: number; down: number; ticks: number[] } | null {
  const n = scrollNode()
  if (!n) return null
  const viewport = n.scrollViewportHeight ?? 0
  const geo = computeRailGeometry(TURNS, viewport, null, true)
  if (!geo) return null
  const top = n.scrollViewportTop ?? 0
  const shown = geo.windowEnd - geo.windowStart
  const ticks: number[] = []
  for (let k = 0; k < shown; k++) ticks.push(top + geo.tickTop + k)
  return { up: top + geo.upRow, down: top + geo.downRow, ticks }
}
/** 屏幕 rail 是否与「当前真实视口」反算的几何一致（修复前后即在此分叉）。 */
function railFollowsViewport(): boolean {
  const n = scrollNode()
  if (!n) return false
  const exp = expectedRail()
  if (!exp) return false
  const obs = railOnScreen()
  if (obs.upRow !== exp.up || obs.downRow !== exp.down || obs.ticks.length !== exp.ticks.length) return false
  for (let k = 0; k < exp.ticks.length; k++) if (obs.ticks[k] !== exp.ticks[k]) return false
  return true
}
/** 实测 rail 行集合的签名（up/down/ticks 全部屏行）。用于「恢复帧确实换过
 *  几何」的独立判据：A→B→A 往返回到旧高度后，若恢复帧从未重绘，残留的
 *  陈旧画面与恢复后的期望全等——只有「与压缩帧不同」能证明发生过重绘。 */
function railSignature(): string {
  const obs = railOnScreen()
  return `up${obs.upRow}/down${obs.downRow}/ticks${obs.ticks.join(',')}`
}
function railSummary(): string {
  const obs = railOnScreen()
  const exp = expectedRail()
  const n = scrollNode()
  return `vp=${n?.scrollViewportHeight} vpTop=${n?.scrollViewportTop} paint=up${obs.upRow}/down${obs.downRow}/ticks${obs.ticks.length} expect=up${exp?.up}/down${exp?.down}/ticks${exp?.ticks.length} signals=${heightSignals}`
}
const recapHintVisible = (): boolean => {
  const buf = term.buffer.active
  return Array.from({ length: ROWS }, (_, y) => buf.getLine(buf.baseY + y)?.translateToString(true) ?? '')
    .some(l => l.includes('点击展开查看/应用'))
}
const bottomPillVisible = (): boolean => {
  const buf = term.buffer.active
  return Array.from({ length: ROWS }, (_, y) => buf.getLine(buf.baseY + y)?.translateToString(true) ?? '')
    .some(l => l.includes('回到底部') || l.includes('条新消息'))
}
function recapRow(): number {
  const buf = term.buffer.active
  for (let y = 0; y < ROWS; y++) {
    if ((buf.getLine(buf.baseY + y)?.translateToString(true) ?? '').includes('回顾')) return y
  }
  return -1
}
/** 总结行分隔线所在屏行（视口里最后一条整行 ─ 线）。 */
function recapDividerRow(): number {
  const buf = term.buffer.active
  for (let y = ROWS - 1; y >= 0; y--) {
    const t = (buf.getLine(buf.baseY + y)?.translateToString(true) ?? '').trimEnd()
    if (t.length > 50 && /^─+$/.test(t)) return y
  }
  return -1
}
const hoverAt = (col: number, row: number): void => { stdin.write(`\x1b[<35;${col};${row + 1}M`) }

// ── 就绪前提：rail 已渲染且与真实视口一致、总结行可见、贴底 ──
{
  const ready = await settled(() => {
    const n = scrollNode()
    return n !== null &&
      railEligible({ turnCount: TURNS, terminalWidth: COLS, viewportRows: n.scrollViewportHeight ?? 0, scrollable: true }) &&
      recapRow() >= 0 && !bottomPillVisible() && railFollowsViewport()
  })
  const n = scrollNode()
  check('就绪：rail 出现且几何跟随真实视口（前提）', ready, railSummary())
  check('就绪：全部 tick 在窗口内（期望几何与 active 无关的前提）',
    (n?.scrollViewportHeight ?? 0) - 2 >= TURNS, `viewport=${n?.scrollViewportHeight} turns=${TURNS}`)
}

// ── 1. 语义探针：高度不变的重渲染（悬停 rail tick 只动轨道本地态）不发信号 ──
// 修复前该字段不存在，包装后计数恒 0——此断言对两态都成立，是语义护栏：
// 它证明新版回调不会在「仅本地态变化」的渲染上误触发。
{
  installSignalCounter()
  check('语义探针：视口高度回调已挂到 ScrollBox DOM 节点', counterInstalled)
  const base = heightSignals
  const tickRow = railOnScreen().ticks[1] ?? railOnScreen().ticks[0]
  if (tickRow === undefined) {
    check('悬停轨道 tick 存在', false, railSummary())
  } else {
    hoverAt(COLS, tickRow)
    // 等 dwell 弹卡证明这确实经过了一次 React 本地态提交 + Ink 渲染 pass。
    await settled(() => {
      const buf = term.buffer.active
      return Array.from({ length: ROWS }, (_, y) => buf.getLine(buf.baseY + y)?.translateToString(true) ?? '')
        .some(l => l.slice(55, 97).includes('╭') || l.slice(55, 97).includes('╮'))
    })
    // 固定窗:探针 断言「高度信号不得增加」——对已成立的否定条件轮询会立即返回，
    // 只能等一个观察窗再断言不变量。
    await sleep(250)
    check('语义探针：悬停轨道 tick（高度不变重渲染）不触发高度信号', heightSignals === base,
      `signals=${heightSignals} base=${base}`)
    hoverAt(30, 20)
    await settled(() => railFollowsViewport())
  }
}

// ── 2. 回顾卡悬停展开/收回：底部 chrome 变高压缩转录视口，rail 必须跟随 ──
{
  // 防真空门槛：展开必须真的撑高总结行（提示行出现）并把分隔线上抬 ≥2 行，
  // 否则「跟随」是空断言。
  const preDivider = recapDividerRow()
  const preRow = recapRow()
  const before = heightSignals
  const vpBefore = scrollNode()?.scrollViewportHeight ?? 0
  check('回顾卡悬停：展开前 rail 跟随视口（基准）', railFollowsViewport(), railSummary())
  hoverAt(10, preRow)
  // 等待条件必须包含「真实视口高度已变 + rail 几何跟随」：通知驱动的再渲染在
  // 悬停展开之后才提交，只等「提示行出现 + 分隔线上抬」会在 rail 追上之前就
  // 返回（等待与断言分叉，且旧视口下 railFollowsViewport 会假成立）。
  let divider = recapDividerRow()
  const expanded = await settled(() => {
    divider = recapDividerRow()
    return recapHintVisible() && divider <= preDivider - 2 &&
      (scrollNode()?.scrollViewportHeight ?? 0) !== vpBefore && railFollowsViewport()
  })
  check('回顾卡悬停：展开确实压缩转录视口（提示行 + 分隔线上抬 ≥2 行）',
    recapHintVisible() && divider <= preDivider - 2, `divider=${divider} preDivider=${preDivider}`)
  check('回顾卡悬停展开：rail 几何跟随压缩后的视口', expanded, railSummary())
  check('回顾卡悬停展开：高度变化信号计数增加（悬停路径零滚动通知）', heightSignals > before,
    `signals=${heightSignals} before=${before}`)

  // 收回：分隔线回落，rail 必须贴回恢复后的视口底。
  // 恢复方向是 A→B→A 往返：陈旧未重绘的画面恰好等于恢复后的期望几何（压缩
  // 帧的残留行与恢复帧全等），单比期望会在通知缺失时假绿。先记下压缩帧的
  // 实测行集合，要求恢复帧与之不同，再比期望。
  const beforeCollapse = heightSignals
  const vpHover = scrollNode()?.scrollViewportHeight ?? 0
  const midRail = railSignature()
  hoverAt(10, 2)
  const collapsed = await settled(() => {
    divider = recapDividerRow()
    return !recapHintVisible() && divider >= preDivider &&
      (scrollNode()?.scrollViewportHeight ?? 0) !== vpHover &&
      railSignature() !== midRail && railFollowsViewport()
  })
  check('回顾卡取消悬停：转录视口恢复', !recapHintVisible() && divider >= preDivider,
    `divider=${divider} preDivider=${preDivider}`)
  check('回顾卡取消悬停：rail 几何跟随恢复后的视口', collapsed,
    `${railSummary()} mid=${midRail}`)
  check('回顾卡取消悬停：高度变化信号计数再次增加', heightSignals > beforeCollapse,
    `signals=${heightSignals} before=${beforeCollapse}`)
}

// ── 3. 终端行 resize 40→30→40：视口高度随终端行数变化，rail 必须跟随 ──
// 等待条件包含「真实视口高度已离开 resize 前的值 + rail 几何跟随」：resize
// 处理前 DOM 与已画笔的 rail 都停在旧值，单等 railFollowsViewport 会假成立。
{
  const vpBefore = scrollNode()?.scrollViewportHeight ?? 0
  ;(stdout as any).rows = 30
  stdout.emit('resize')
  term.resize(COLS, 30)
  const followed = await settled(() =>
    (scrollNode()?.scrollViewportHeight ?? 0) !== vpBefore && railFollowsViewport(), { timeoutMs: 8000 })
  // 固定窗:探针 断言 resize 后「几何不得回到旧值」——重绘是瞬态的，
  // settled 对已成立条件立即返回，需给错误帧留一个观察窗。
  await sleep(300)
  check('终端行 resize 40→30：rail 几何跟随新视口', followed && railFollowsViewport(), railSummary())

  const vpSmall = scrollNode()?.scrollViewportHeight ?? 0
  // 同 §2：记下小视口帧的实测 rail 行集合，恢复帧必须与之不同（陈旧画面
  // 等于恢复后期望，只有行集合变化能证明重绘）。
  const midRail = railSignature()
  ;(stdout as any).rows = ROWS
  stdout.emit('resize')
  term.resize(COLS, ROWS)
  const restored = await settled(() =>
    (scrollNode()?.scrollViewportHeight ?? 0) !== vpSmall &&
    railSignature() !== midRail && railFollowsViewport(), { timeoutMs: 8000 })
  // 固定窗:探针 同上，恢复方向也要留观察窗。
  await sleep(300)
  check('终端行 resize 30→40：rail 几何跟随恢复后的视口', restored && railFollowsViewport(),
    `${railSummary()} mid=${midRail}`)
}

await inst.unmount()
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
