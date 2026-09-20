/**
 * verify-scrollbar-gutter — `dsh-tui.scrollGutter` 设置三态：timeline（默认）
 * / scrollbar（比例滚动条）/ hidden（无边栏），以及 scrollbar 形态的滑块
 * 几何与轨道点击。
 *
 * 断言（headless xterm 100×40，全屏 Chat，8 轮对话）：
 *   1. 默认 timeline：rail 出现（▴/tick/▾）；
 *   2. setScrollGutter('scrollbar')：██ 滑块出现，钉底时贴底；无 ▴▾ tick；
 *   3. 上滚：滑块上移且仍在轨道内；
 *   4. 点击轨道顶部：滚到顶（问题 1 可见），滑块贴顶；
 *   4b. 拖拽轨道到底部：连续滚动到末期内容，且不建立选区、不触发
 *       copy-on-select（全屏 alt-screen 拖拽不再落入选字路径）；
 *   4c. 拖到底落定后滑块仍贴底：回底卸载收缩槽位的 chrome 后，渲染器
 *       重钉 scrollTop 的 pass 不发订阅通知，组件必须补一次落定后再渲染；
 *   4d. End/回到底部落定后同样贴底（pill 点击走同一条 scrollToBottom）；
 *   5. setScrollGutter('hidden')：右缘无任何 gutter glyph，转译区占满宽；
 *   6. 切回 timeline：rail 恢复；
 *   7. 记录型 handle 直接挂载 ScrollbarGutter：绝对映射语义（拖到哪滚到哪，
 *       与轨道点击同一 trackScrollTop）、未移动 press+release 回放点击、
 *       Shift+拖动仍走选区路径；
 *   8. 真实 Chat + recapOnOpen：悬停展开底部总结行压缩转录视口、取消后恢复，
 *       沟槽几何两个方向都必须跟随（悬停展开只改布局，不发滚动通知也不翻
 *       sticky，组件若只靠订阅面重渲染，滑块会停在压缩位置且缺块不回来）。
 *
 * 运行：node --import tsx/esm scripts/verify-scrollbar-gutter.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'
// 强制 OSC 52 复制路径：拖拽若意外落入选字路径，复制会写进假 stdout，
// 断言可据此发现回归（见 4b）。
process.env.SSH_CONNECTION = 'headless-test'
delete process.env.TMUX

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen, Box, useInput }, { Chat }, { QuestionStore }, { LOCAL_COMMANDS, completeCommands }, { ScrollbarGutter }, { default: instances }, { settle, settled, sleep }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
  import('../src/components/ScrollbarGutter.js'),
  import('../src/ink/instances.js'),
  import('./lib/term-test.mjs'),
])

const COLS = 100, ROWS = 40
let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const rawChunks: string[] = []
const osc52Count = (): number => rawChunks.join('').match(/\x1b\]52;c;/g)?.length ?? 0
class FakeStdout extends Writable {
  columns = COLS; rows = ROWS; isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    rawChunks.push(String(chunk))
    term.write(String(chunk), cb)
  }
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
for (let turn = 1; turn <= 8; turn++) {
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
  activityFrames: 'moon8', agentPreset: undefined, subagents: [], lastUserText: '问题 8',
  scrollGutter: 'timeline',
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => Promise.resolve([]),
  deleteSession: () => Promise.resolve(true), renameSessionTo: () => Promise.resolve(true),
  setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [], pushLocal: () => {},
  commandCompletions: (input: string) => completeCommands(input),
}
const emitChannel = () => { channel.version++; for (const l of listeners) l() }
// 切换后由各调用点 settle 到断言条件出现（./lib/term-test.mjs）。
const setGutter = (mode: string) => {
  channel.scrollGutter = mode
  emitChannel()
}

const inst = await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} fullscreen />
  </AlternateScreen>,
  { stdout: stdout as any, stdin: stdin as any, stderr: stderr as any, exitOnCtrlC: false, patchConsole: false },
)
function screenLines(): string[] {
  const buf = term.buffer.active
  return Array.from({ length: ROWS }, (_, y) => buf.getLine(buf.baseY + y)?.translateToString(true) ?? '')
}
function cellAt(y: number, col: number): string {
  const buf = term.buffer.active
  return buf.getLine(buf.baseY + y)?.getCell(col)?.getChars() ?? ''
}
/**
 * gutter 区域：置顶头之下、prompt 输入框 margin 之上。返回 [top, bottom)。
 *
 * Anchored on the prompt BOX's top border (`╭`), not on a `❯` row: the input
 * row now leads with the session-entry affordance (`⌸ ❯ …`) while transcript
 * user rows start with `❯`, so that glyph identifies neither end reliably.
 */
function gutterRange(): [number, number] {
  const lines = screenLines()
  const top = /^❯/.test(lines[0]!.trimEnd()) ? 1 : 0
  let boxTop = -1
  for (let y = ROWS - 1; y >= 0; y--) {
    if (lines[y]!.trimEnd().endsWith('╭') || lines[y]!.trimStart().startsWith('╭')) { boxTop = y; break }
  }
  return [top, boxTop >= 0 ? boxTop - 2 : ROWS - 4]
}
/** gutter 快照：{ thumbs: ██ 行, ticks: ─/━ 行, chevrons: ▴/▾ 行 }。
 *  whale 图案的 █ 会落在 gutter 列——只把「两列均 █ 且同行左侧 20 列
 *  内无 whale 图形字符」的行认作滑块。 */
function gutterSnapshot(): { thumbs: number[]; ticks: number[]; chevrons: number[] } {
  const [top, bottom] = gutterRange()
  const thumbs: number[] = [], ticks: number[] = [], chevrons: number[] = []
  for (let y = top; y < bottom; y++) {
    const two = cellAt(y, COLS - 2) + cellAt(y, COLS - 1)
    if (two.includes('██')) {
      let whale = false
      for (let x = COLS - 24; x < COLS - 4; x++) {
        const c = cellAt(y, x)
        if (c === '█' || c === '▀' || c === '▄' || c === '▀▀') { whale = true; break }
      }
      if (!whale) thumbs.push(y)
    }
    else if (two.includes('▴') || two.includes('▾')) chevrons.push(y)
    else if (two === '━━' || two === '──' || two === ' ─') ticks.push(y)
  }
  return { thumbs, ticks, chevrons }
}
/** 「回到底部 / N 条新消息」pill（= !isSticky chrome）是否在屏上。它与
 *  钉住的提示头一起在回底那一帧卸载：断言滑块「贴底」必须先等它消失，
 *  否则拖拽中途更矮的转录行会让这个结论假成立（滑块当时确实贴着那个
 *  矮行的底）。 */
const bottomPillVisible = (): boolean =>
  screenLines().some(l => l.includes('回到底部') || l.includes('条新消息'))
// 逐事件 pacing sleep 保留：滚轮事件需要逐个进入 hover/scroll 路径，
// 每步之间没有可区分新旧帧的屏幕条件可轮询。
const wheel = async (up: boolean, times: number) => {
  for (let i = 0; i < times; i++) {
    stdin.write(`\x1b[<${up ? 64 : 65};90;30M`)
    await sleep(150) // 固定窗:pacing 滚轮事件步间，无可区分新旧帧的屏幕条件
  }
}
const clickAt = (col: number, row: number) => {
  stdin.write(`\x1b[<0;${col};${row}M`)
  stdin.write(`\x1b[<0;${col};${row}m`)
}
// SGR 拖拽序列（1-based 坐标）：button 32 = motion bit。
const dragAt = (col: number, row: number) => stdin.write(`\x1b[<0;${col};${row}M`)
const dragMotion = (col: number, row: number) => stdin.write(`\x1b[<32;${col};${row}M`)
const dragRelease = (col: number, row: number) => stdin.write(`\x1b[<0;${col};${row}m`)

// ── 1. 默认 timeline ──
// 各块断言均在 settle 捕获的同一快照 snap 上求值：等待条件与断言共用快照，无分叉。
{
  let snap = gutterSnapshot()
  await settled(() => {
    snap = gutterSnapshot()
    return snap.ticks.length > 0 && snap.chevrons.length === 2 && snap.thumbs.length === 0
  })
  check('默认 timeline：rail tick + chevron 存在', snap.ticks.length > 0 && snap.chevrons.length === 2,
    `ticks=${snap.ticks.length} chevrons=${snap.chevrons.length}`)
  check('默认 timeline：无 ██ 滑块', snap.thumbs.length === 0, `thumbs=${snap.thumbs.length}`)
}

// ── 2. 切 scrollbar：██ 贴底，无 chevron/tick ──
// The transcript must actually overflow first: the gutter is permanent while
// scrollable and absent when the content fits (`content <= viewport` returns
// null), so a scrollbar assertion on a fitting transcript is asserting a
// scrollbar that must not be there. One long assistant message pushes the
// content past the viewport while leaving the terminal pinned to the bottom.
setGutter('scrollbar')
{
  channel.rows.push({
    id: 1000, kind: 'assistant',
    text: Array.from({ length: 30 }, (_, i) => `滚条前置填充行 ${i}：滑块需要可滚内容才会出现`).join('\n'),
  })
  emitChannel()
}
{
  let snap = gutterSnapshot()
  let bottom = gutterRange()[1]
  await settle(() => {
    snap = gutterSnapshot()
    bottom = gutterRange()[1]
    return snap.thumbs.length >= 2 && snap.chevrons.length === 0 && snap.ticks.length === 0 &&
      snap.thumbs[snap.thumbs.length - 1] === bottom - 1
  })
  check('scrollbar：██ 滑块出现', snap.thumbs.length >= 2, `thumbs=${snap.thumbs.length}`)
  check('scrollbar：无 timeline glyph', snap.chevrons.length === 0 && snap.ticks.length === 0,
    `chevrons=${snap.chevrons.length} ticks=${snap.ticks.length}`)
  check('scrollbar：钉底滑块贴底', snap.thumbs[snap.thumbs.length - 1] === bottom - 1,
    `last=${snap.thumbs[snap.thumbs.length - 1]} bottom=${bottom}`)
}

// ── 3. 上滚（whale 滚出视口）：滑块在轨道内且离开底端 ──
await wheel(true, 16)
{
  let snap = gutterSnapshot()
  let range = gutterRange()
  await settle(() => {
    snap = gutterSnapshot()
    range = gutterRange()
    if (snap.thumbs.length < 2) return false
    const first = snap.thumbs[0]!, last = snap.thumbs[snap.thumbs.length - 1]!
    return first >= range[0] && last < range[1] - 1
  })
  const [top, bottom] = range
  check('上滚后滑块存在（非 whale）', snap.thumbs.length >= 2, `thumbs=${JSON.stringify(snap.thumbs)}`)
  if (snap.thumbs.length > 0) {
    const first = snap.thumbs[0]!, last = snap.thumbs[snap.thumbs.length - 1]!
    check('上滚后滑块仍在轨道内', first >= top && last < bottom, `first=${first} last=${last} range=[${top},${bottom})`)
    check('上滚后滑块离开底端', last < bottom - 1, `last=${last} bottom=${bottom}`)
  }
}

// ── 4. 点击轨道顶部：滚到顶（whale 回到视口，跳过滑块位置断言）──
{
  const [top] = gutterRange()
  clickAt(COLS, top + 1)
  let lines: string[] = []
  await settle(() => { lines = screenLines(); return lines.slice(0, 24).some(l => l.includes('问题 1')) })
  check('点击轨道顶后滚到顶（问题 1 可见）', lines.slice(0, 24).some(l => l.includes('问题 1')),
    `top4=${JSON.stringify(lines.slice(0, 4).map(l => l.trimEnd().slice(0, 24)))}`)
}

// ── 4b. 拖拽轨道到底部：连续滚动；不落入选字/复制路径 ──
// 全屏 alt-screen 开着鼠标上报，未修饰左键拖拽会命中轨道的 onDragStart
// （拖拽协议），不再走 startSelection；带位移的 release 也不会 copy-on-select。
{
  const [top, bottom] = gutterRange()
  const end = bottom - 1
  const oscBefore = osc52Count()
  dragAt(COLS, top + 1)
  dragMotion(COLS, top + Math.floor((bottom - top) / 2))
  dragMotion(COLS, end)
  dragRelease(COLS, end)
  let lines: string[] = []
  const scrolled = await settled(() => {
    lines = screenLines()
    return lines.slice(0, 30).some(l => l.includes('回复 8'))
  })
  check('拖拽轨道：转录连续滚动到末期内容（回复 8 可见）', scrolled,
    `head=${JSON.stringify(lines.slice(0, 2).map(l => l.trimEnd().slice(0, 16)))}`)
  const ink = instances.get(stdout) as unknown as { hasTextSelection?: () => boolean } | undefined
  check('拖拽滚动条不建立文本选区', ink?.hasTextSelection?.() === false, `sel=${ink?.hasTextSelection?.()}`)
  check('拖拽滚动条不触发 copy-on-select（无 OSC 52）', osc52Count() === oscBefore,
    `osc52=${osc52Count()} before=${oscBefore}`)
}

// ── 4c. 拖到底落定后：腾出的槽位必须把滑块钉回底 ──
// 回底卸载「钉住的提示头 + 回到底部 pill」（两者都是 !isSticky），槽位长回
// 几行；渲染器在 React commit 之后的 pass 里把 scrollTop 重钉到新的
// maxScroll，但它不翻转 sticky（订阅面收不到通知）。组件若只在订阅面
// 重渲染，滑块就停在按旧视口算出的位置、浮在底上方，直到 hover 等无关
// 渲染救场（用户实测：触底后滑块上漂，hover 才落回）。这里断言落定后
// 贴底——等待与断言共用快照，去掉组件里的落定再渲染该断言即失败。
{
  let snap = gutterSnapshot()
  let bottom = gutterRange()[1]
  const pinned = await settled(() => {
    if (bottomPillVisible()) return false
    snap = gutterSnapshot()
    bottom = gutterRange()[1]
    return snap.thumbs.length >= 2 && snap.thumbs[snap.thumbs.length - 1] === bottom - 1
  })
  check('拖到底落定后：滑块贴底（重钉 pass 后有再渲染）', pinned,
    `last=${snap.thumbs[snap.thumbs.length - 1]} bottom=${bottom}`)
}

// ── 4d. End/回到底部落定后同样贴底（pill 点击走同一条 scrollToBottom）──
{
  await wheel(true, 16)
  // 前置交给断言：settle 超时静默返回，滚轮若没把滑块推离底部，End 会从
  // 贴底态触发，下面的落定断言照样绿——但覆盖的就不是 scrollToBottom 的重钉路径。
  let off = gutterSnapshot()
  const offBottom = await settled(() => {
    off = gutterSnapshot()
    return off.thumbs.length >= 2 && off.thumbs[off.thumbs.length - 1]! < gutterRange()[1] - 1
  })
  check('End 前置：滚轮后滑块已离开底部', offBottom,
    `last=${off.thumbs[off.thumbs.length - 1]} bottom=${gutterRange()[1]}`)
  stdin.write('\x1b[F') // End = handle.scrollToBottom()（Chat 的 key.end 分支）
  let snap = gutterSnapshot()
  let bottom = gutterRange()[1]
  const pinned = await settled(() => {
    if (bottomPillVisible()) return false
    snap = gutterSnapshot()
    bottom = gutterRange()[1]
    return snap.thumbs.length >= 2 && snap.thumbs[snap.thumbs.length - 1] === bottom - 1
  })
  check('End 回底落定后：滑块贴底（scrollToBottom 的渲染 pass 后有再渲染）', pinned,
    `last=${snap.thumbs[snap.thumbs.length - 1]} bottom=${bottom}`)
}

// ── 5. 切 hidden：无 gutter（whale 的 █ 不算——只查 timeline/scrollbar glyph）──
const hasGutterGlyph = (): boolean => {
  const [top, bottom] = gutterRange()
  let anyGlyph = false
  for (let y = top; y < bottom; y++) {
    const two = cellAt(y, COLS - 2) + cellAt(y, COLS - 1)
    if (two.includes('▴') || two.includes('▾') || two === '━━' || two === '──' || two === ' ─') anyGlyph = true
    if (two.includes('██')) {
      let whale = false
      for (let x = COLS - 24; x < COLS - 4; x++) {
        const c = cellAt(y, x)
        if (c === '█' || c === '▀' || c === '▄') { whale = true; break }
      }
      if (!whale) anyGlyph = true
    }
  }
  return anyGlyph
}
setGutter('hidden')
check('hidden：右缘无任何 gutter glyph', await settled(() => !hasGutterGlyph()))

// ── 6. 切回 timeline：rail 恢复 ──
await wheel(false, 30)
setGutter('timeline')
{
  let snap = gutterSnapshot()
  await settle(() => {
    snap = gutterSnapshot()
    return snap.ticks.length === 8 && snap.chevrons.length === 2
  })
  check('切回 timeline：rail 恢复', snap.ticks.length === 8 && snap.chevrons.length === 2,
    `ticks=${snap.ticks.length} chevrons=${snap.chevrons.length}`)
}

await inst.unmount()

// ─ 7. 拖拽协议语义：记录型 handle 直接挂载 ScrollbarGutter ──
// 真实 Chat 的 handle 不可注入，这里用确定性几何（viewport=20、content=120
// ⇒ thumbH=3、trackH=17、maxScroll=100）逐步断言绝对映射的 trackScrollTop
// 取值，并覆盖未移动点击回放与 Shift 选区路径。组件与真实 Chat 同走
// AlternateScreen + App 的鼠标/拖拽分派，选字路径行为一致。
{
  const PROBE_VIEWPORT = 20, PROBE_CONTENT = 120
  const probeThumbH = Math.max(2, Math.round((PROBE_VIEWPORT * PROBE_VIEWPORT) / PROBE_CONTENT))
  const probeTrackH = Math.max(1, PROBE_VIEWPORT - probeThumbH)
  const probeMaxScroll = PROBE_CONTENT - PROBE_VIEWPORT
  const expectTop = (y: number): number =>
    y <= 0 ? 0 : y >= probeTrackH ? probeMaxScroll : Math.round((y / probeTrackH) * probeMaxScroll)
  const calls: number[] = []
  let fakeScrollTop = 0
  const fakeHandle = {
    scrollTo(y: number) { calls.push(y); fakeScrollTop = Math.max(0, Math.floor(y)) },
    scrollBy() {}, scrollToElement() {}, scrollToBottom() {},
    getScrollTop: () => fakeScrollTop, getPendingDelta: () => 0,
    getScrollHeight: () => PROBE_CONTENT, getFreshScrollHeight: () => PROBE_CONTENT,
    getViewportHeight: () => PROBE_VIEWPORT, getViewportTop: () => 0,
    isSticky: () => false, subscribe: () => () => {}, setClampBounds() {},
  }
  class ProbeStdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  class ProbeStdout extends Writable {
    columns = COLS; rows = 30; isTTY = true
    _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() }
  }
  class ProbeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
  const probeIn = new ProbeStdin(), probeOut = new ProbeStdout(), probeErr = new ProbeStderr()
  const pPress = (row: number) => probeIn.write(`\x1b[<0;1;${row + 1}M`)
  const pMotion = (row: number) => probeIn.write(`\x1b[<32;1;${row + 1}M`)
  const pRelease = (row: number) => probeIn.write(`\x1b[<0;1;${row + 1}m`)
  // 带 Shift 位（0x04）的 press/motion/release：不打开拖拽会话，走选区路径。
  const pShiftPress = (row: number) => probeIn.write(`\x1b[<4;1;${row + 1}M`)
  const pShiftMotion = (row: number) => probeIn.write(`\x1b[<36;1;${row + 1}M`)
  const pShiftRelease = (row: number) => probeIn.write(`\x1b[<4;1;${row + 1}m`)
  function ProbeScene() {
    useInput(() => {})
    return (
      <AlternateScreen>
        <Box flexDirection="column">
          <ScrollbarGutter handle={fakeHandle as any} terminalWidth={COLS} />
        </Box>
      </AlternateScreen>
    )
  }
  const probeInst = await render(<ProbeScene />, {
    stdout: probeOut as any, stdin: probeIn as any, stderr: probeErr as any,
    exitOnCtrlC: false, patchConsole: false,
  })
  const probeInk = instances.get(probeOut as any) as unknown as { hasTextSelection?: () => boolean } | undefined

  // a. press → motion(4) → motion(10) → release(15)：首个 motion 同帧并发
  //    dragstart + dragmove（App 语义），因此每一步都按 localRow 映射。
  calls.length = 0
  pPress(0)
  pMotion(4)
  pMotion(10)
  pRelease(15)
  await settle(() => calls.length >= 4)
  const expectDrag = [expectTop(4), expectTop(4), expectTop(10), expectTop(15)]
  check('拖拽映射：按轨道行依次收到预期 scrollTo（绝对映射）',
    JSON.stringify(calls) === JSON.stringify(expectDrag),
    `calls=${JSON.stringify(calls)} expect=${JSON.stringify(expectDrag)}`)
  check('拖拽映射：未建立文本选区', probeInk?.hasTextSelection?.() === false,
    `sel=${probeInk?.hasTextSelection?.()}`)
  // copy-on-select 不在此断言：本场景不挂 useCopyOnSelect，OSC 52 恒不会
  // 出现（真实覆盖在 4b 的 Chat 场景）。

  // b. 未移动 press+release：拖拽会话休眠，release 回放点击 → 点击跳转仍生效。
  calls.length = 0
  pPress(6)
  pRelease(6)
  await settle(() => calls.length >= 1)
  check('未移动 press+release：点击跳转照常触发',
    JSON.stringify(calls) === JSON.stringify([expectTop(6)]), `calls=${JSON.stringify(calls)}`)

  // c. Shift+拖动：不打开拖拽会话，仍走选区路径，且不触发拖拽滚动。
  calls.length = 0
  pShiftPress(0)
  pShiftMotion(8)
  const shiftSelected = await settled(() => probeInk?.hasTextSelection?.() === true)
  pShiftRelease(8)
  probeIn.write('\x1b')
  check('Shift+拖动：仍走选区路径且不触发拖拽滚动',
    shiftSelected && calls.length === 0, `sel=${shiftSelected} calls=${JSON.stringify(calls)}`)

  probeInst.unmount()
}

// ─ 8. 悬停展开总结行（recapOnOpen）：沟槽必须跟随压缩/恢复后的视口 ──
// 真实 Chat + 真实 AutoRecapRow（channel.autoRecapOnOpen=true，设置默认开）。
// 总结行在 ScrollBox **下方**的底部 chrome 里（Chat.tsx 的 recap 渲染在关闭
// </ScrollBox> 之后、flexShrink=0 的底簇里）：悬停多出「点击展开查看/应用」
// 一行，底部 chrome 变高、转录行（ScrollBox + gutter 所在的行）被压矮，
// 分隔线上抬。这条布局变化不经过 scrollTo/scrollBy（订阅面无通知），也不
// 翻转 sticky（render-node-to-output 只在 stickyScroll===false 翻真时调用
// onStickyRestore），所以 ScrollbarGutter 全程不重渲染：它按上一帧几何画的
// 子树被父行裁掉底部，取消悬停时又从上一帧 blit 回那几行——而上一帧那几行
// 已经被上抬的 chrome（空行/分隔线）占用。用户实测即：滑块底部几行没回来、
// 停在压缩位置。这里断言两个方向的几何都跟随视口；防真空门槛要求展开确实把
// 转录视口压小 ≥2 行（提示行出现 + 分隔线上抬），否则「跟随」是空断言。
{
  const HOVER_HINT = '点击展开查看/应用'
  // 转录行底 = 总结行分隔线 - 2（AutoRecapRow 的 marginTop 空行 + 分隔线）。
  // 直接读屏，不依赖 gutterRange 的 promptRow 近似（总结行插在二者之间后，
  // promptRow-2 不再等于轨道底）。
  const term2 = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  class RecapStdout extends Writable {
    columns = COLS; rows = ROWS; isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term2.write(String(chunk), cb) }
  }
  class RecapStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
  class RecapStdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const recapIn = new RecapStdin(), recapOut = new RecapStdout(), recapErr = new RecapStderr()
  const recapChannel: any = {
    ...channel,
    scrollGutter: 'scrollbar',
    autoRecapOnOpen: true,
    recapRecent: () => Promise.resolve({ summary: '自动总结内容', title: '建议标题' }),
    // 本场景只悬停不派发 channel 变更：订阅面保持空实现即可。
    subscribe: () => () => {},
  }
  const recapInst = await render(
    <AlternateScreen>
      <Chat channel={recapChannel} questionStore={new QuestionStore()} fullscreen />
    </AlternateScreen>,
    { stdout: recapOut as any, stdin: recapIn as any, stderr: recapErr as any, exitOnCtrlC: false, patchConsole: false },
  )
  const recapLines = (): string[] => {
    const buf = term2.buffer.active
    return Array.from({ length: ROWS }, (_, y) => buf.getLine(buf.baseY + y)?.translateToString(true) ?? '')
  }
  const recapCell = (y: number, col: number): string => {
    const buf = term2.buffer.active
    return buf.getLine(buf.baseY + y)?.getCell(col)?.getChars() ?? ''
  }
  /** 总结行分隔线所在行（视口里最后一条整行 ─ 线）。 */
  const recapDividerRow = (): number => {
    const lines = recapLines()
    for (let y = ROWS - 1; y >= 0; y--) {
      const t = lines[y]!.trimEnd()
      if (t.length > 50 && /^─+$/.test(t)) return y
    }
    return -1
  }
  const recapThumbs = (): number[] => {
    const out: number[] = []
    for (let y = 0; y < ROWS; y++) {
      if ((recapCell(y, COLS - 2) + recapCell(y, COLS - 1)).includes('██')) out.push(y)
    }
    return out
  }
  const recapHintVisible = (): boolean => recapLines().some(l => l.includes(HOVER_HINT))
  /** 复习卡实例里转录 ScrollBox 的 DOM 节点（渲染期写 scrollViewportHeight 的
   *  那个），用来读「当前真实视口」。 */
  const recapScrollNode = (): any => {
    const rk = instances.get(recapOut as any) as any
    const walk = (node: any): any => {
      if (node?.scrollViewportHeight !== undefined) return node
      for (const c of node?.childNodes ?? []) {
        const hit = walk(c)
        if (hit) return hit
      }
      return null
    }
    return walk(rk?.rootNode)
  }
  /** 沟槽轨道 DOM 行数 = 组件上一次渲染读到并画出的视口行数。轨道是唯一的
   *  width=2 列箱，每行是 height=1 的 Box（悬停发生在总结行、不在 gutter 上，
   *  所以 hover chip 不会混入）。这是「组件确实按新视口重渲染过」的独立判据：
   *  压缩方向若只靠屏幕比例会假绿——被父行裁掉的陈旧滑块可见行恰好落在压缩
   *  后视口的正确位置上，只有 DOM 行数能区分陈旧画面与新帧。 */
  const recapGutterRows = (): number => {
    const rk = instances.get(recapOut as any) as any
    const walk = (node: any): any => {
      if (!node) return null
      const st = node.style ?? {}
      if (st.width === 2 && st.flexDirection === 'column') return node
      for (const c of node.childNodes ?? []) {
        const hit = walk(c)
        if (hit) return hit
      }
      return null
    }
    const track = walk(rk?.rootNode)
    return (track?.childNodes ?? []).filter((c: any) => c?.style?.height === 1).length
  }
  const recapSnap = () => {
    const th = recapThumbs()
    const divider = recapDividerRow()
    return {
      last: th[th.length - 1] ?? -1, h: th.length,
      divider, trackLast: divider - 2,
      hint: recapHintVisible(),
      pill: recapLines().some(l => l.includes('回到底部') || l.includes('条新消息')),
    }
  }
  // 就绪前提：总结行已渲染、贴底（无 pill）、滑块存在。
  let pre = recapSnap()
  const preOk = await settled(() => {
    pre = recapSnap()
    return recapLines().some(l => l.includes('回顾')) && !pre.pill && pre.h >= 2 && pre.last === pre.trackLast
  })
  check('总结行悬停：悬停前贴底且滑块贴真底（前提）', preOk,
    `last=${pre.last} trackLast=${pre.trackLast} h=${pre.h} divider=${pre.divider}`)
  const recapRow = recapLines().findIndex(l => l.includes('回顾'))
  recapIn.write(`\x1b[<35;10;${recapRow + 1}M`)
  // 防真空：悬停必须真的撑高总结行（提示行出现）并把分隔线上抬 ≥2 行。
  let hov = recapSnap()
  const expanded = await settled(() => {
    hov = recapSnap()
    return hov.hint && hov.divider <= pre.divider - 2
  })
  check('总结行悬停：展开确实压缩转录视口（提示行 + 分隔线上抬 ≥2 行）', expanded,
    `hint=${hov.hint} divider=${hov.divider} preDivider=${pre.divider}`)
  // 压缩方向：经过落定窗口后，滑块底部与压缩后轨道底一致、不越界，且沟槽
  // DOM 轨道行数已变成压缩后的真实视口行数（陈旧帧会停在上一次的 30）。
  let hoverRailRows = recapGutterRows()
  const hoverFit = await settled(() => {
    hov = recapSnap()
    hoverRailRows = recapGutterRows()
    return hov.hint && !hov.pill && hov.h >= 2 && hov.last === hov.trackLast &&
      hoverRailRows === (recapScrollNode()?.scrollViewportHeight ?? 0)
  })
  check('总结行悬停：滑块与压缩后视口一致且无越界', hoverFit,
    `last=${hov.last} trackLast=${hov.trackLast} h=${hov.h} (viewport=${hov.trackLast + 1})` +
    ` gutterRows=${hoverRailRows}/${recapScrollNode()?.scrollViewportHeight ?? 0}`)
  // 恢复方向：取消悬停、分隔线回落后，滑块必须贴回真底，且被裁掉的底部
  // 行回来（高度回到悬停前）。与压缩方向对称，还要 DOM 轨道行数恢复到
  // 真实视口——旧像素 blit 回来可骗过屏幕断言，只有 DOM 行数能证明组件
  // 确实按恢复后的视口重渲染过。
  recapIn.write('\x1b[<35;10;3M')
  let post = recapSnap()
  let postRailRows = recapGutterRows()
  const restored = await settled(() => {
    if (recapHintVisible()) return false
    post = recapSnap()
    postRailRows = recapGutterRows()
    return !post.pill && post.h >= 2 && post.last === post.trackLast && post.h === pre.h &&
      postRailRows === (recapScrollNode()?.scrollViewportHeight ?? 0)
  })
  check('总结行取消悬停：滑块贴回真底且被裁的行回来（DOM 轨道同步恢复）', restored,
    `last=${post.last} trackLast=${post.trackLast} h=${post.h} preH=${pre.h} divider=${post.divider} preDivider=${pre.divider}` +
    ` gutterRows=${postRailRows}/${recapScrollNode()?.scrollViewportHeight ?? 0}`)
  await recapInst.unmount()
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
