/**
 * verify-timeline-rail — 全屏转录区 Grok 式时间线导航栏：每轮一个 tick、
 * 当前轮 ━━ 高亮（顶部锚定）、▲/▼ 严格几何步进、点击 tick 跳转、悬停
 * 预览卡、窄终端隐藏。
 *
 * 断言（headless xterm 100×40，全屏 Chat，8 轮对话）：
 *   1. 底部：右侧 2 列出现 ▲/▼ + 恰 8 个 tick + 恰一个 ━━（active）；
 *      active = 占据视口顶行的轮次（顶部锚定，不是最新轮）；
 *   2. 上滚：active 随轮次边界越过视口顶而移动，始终恰一个 ━━，
 *      且 active 与视口顶行内容所属轮次一致；
 *   3. 点击第 3 个 tick：问题 3 跳到转译区顶，━━ 移到该 tick；
 *   4. ▼：问题 4 到顶（严格 below-top 目标）；▲：问题 3 回到顶；
 *   5. 滚到顶：active = 首 tick（pre-turn 内容 → 第一轮），▲ 点击无操作；
 *   6. 悬停第 2 个 tick：左侧弹出圆角预览卡（含 问题 2）；移开消失；
 *   7. resize 到 59 列：rail 隐藏；恢复 100 列：rail 回来。
 *
 * 运行：node --import tsx/esm scripts/verify-timeline-rail.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { LOCAL_COMMANDS, completeCommands }, { settle, settled, sleep }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
  import('./lib/term-test.mjs'),
])

const COLS = 100, ROWS = 40
let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const writes: string[] = []
class FakeStdout extends Writable {
  columns = COLS; rows = ROWS; isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    writes.push(String(chunk))
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
  rows.push({
    id: turn * 2,
    kind: 'assistant',
    text: Array.from({ length: 8 }, (_, i) => `回复 ${turn} 第 ${i + 1} 行`).join('\n'),
  })
}

const listeners = new Set<() => void>()
const channel: any = {
  // 探针确定性：鲸鱼欢迎期闲置动画（默认开）不进本探针的测量窗口。
  whaleIdle: false,
  version: 0,
  rows,
  status: 'idle',
  sessionTitle: 'probe',
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
  activityFrames: 'claude',
  agentPreset: undefined,
  subagents: [],
  lastUserText: '问题 8',
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
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

const inst = await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} fullscreen />
  </AlternateScreen>,
  { stdout: stdout as any, stdin: stdin as any, stderr: stderr as any, exitOnCtrlC: false, patchConsole: false },
)
let bootSnap = railSnapshot()
let bootOwner: number | null = null
await settled(() => {
  bootSnap = railSnapshot()
  if (bootSnap.ticks.length !== 8 || bootSnap.activeRow === null || bootSnap.upRow === null || bootSnap.downRow === null) return false
  // 断言同条件（#561 修复，保持）：初始 sticky 滚动到底与 rail active 重算
  // 之间存在竞争，只等「tick 出现」在快 runner 上会断到 active 尚未对齐的
  // 帧（块 1 的顶部锚定断言随机红）。settle 必须包含块 1 断言的同一不变量
  // ——active 与视口顶行的轮次归属一致；真回归时此条件永不成立，超时后
  // 断言照常红。块 1 的断言直接在本次捕获的快照上求值，无重读分叉。
  bootOwner = topOwningTurn()
  return bootOwner !== null && bootSnap.ticks.indexOf(bootSnap.activeRow) === bootOwner - 1
})

function screenLines(): string[] {
  const buf = term.buffer.active
  return Array.from({ length: ROWS }, (_, y) => buf.getLine(buf.baseY + y)?.translateToString(true) ?? '')
}
function cellAt(y: number, col: number): string {
  const buf = term.buffer.active
  return buf.getLine(buf.baseY + y)?.getCell(col)?.getChars() ?? ''
}
function headerVisible(): boolean {
  return /^❯/.test(screenLines()[0]!.trimEnd())
}
/** rail 区域：置顶头之下、prompt 输入框 margin 之上。返回 [top, bottom)。 */
function railRange(): [number, number] {
  const lines = screenLines()
  const top = headerVisible() ? 1 : 0
  let promptRow = -1
  for (let y = ROWS - 1; y >= 0; y--) {
    if (lines[y]!.trimStart().startsWith('❯')) { promptRow = y; break }
  }
  return [top, promptRow >= 0 ? promptRow - 2 : ROWS - 4]
}
/** rail 快照：{ ticks: 各 tick 屏幕 0 基行序, activeRow: ━━ 行, upRow, downRow } */
function railSnapshot(): { ticks: number[]; activeRow: number | null; upRow: number | null; downRow: number | null } {
  const [top, bottom] = railRange()
  const ticks: number[] = []
  let activeRow: number | null = null
  let upRow: number | null = null
  let downRow: number | null = null
  for (let y = top; y < bottom; y++) {
    const two = cellAt(y, COLS - 2) + cellAt(y, COLS - 1)
    if (two.includes('▴')) upRow = y
    else if (two.includes('▾')) downRow = y
    else if (two === '━━') { ticks.push(y); activeRow = y }
    else if (two === '──' || two === ' ─') ticks.push(y)
  }
  return { ticks, activeRow, upRow, downRow }
}
/** 视口顶行（及其后数行）首个可见内容所属的轮次编号。 */
function topOwningTurn(): number | null {
  const lines = screenLines()
  const [top] = railRange()
  for (let y = top; y < Math.min(top + 4, ROWS); y++) {
    const m = lines[y]!.match(/(?:问题|回复) (\d+)/)
    if (m) return Number(m[1])
  }
  return null
}
// 逐事件 pacing sleep 保留：滚轮事件需要逐个进入 hover/scroll 路径，无可
// 轮询的逐步条件；clickAt/hoverAt 的固定窗口同时是场景 5/6b「无操作/无卡」
// 稳定性探针的现身时间，必须保留。
const wheel = async (up: boolean, times: number) => {
  for (let i = 0; i < times; i++) {
    stdin.write(`\x1b[<${up ? 64 : 65};90;30M`)
    await sleep(180)
  }
}
const clickAt = async (col: number, row: number) => {
  stdin.write(`\x1b[<0;${col};${row}M`)
  stdin.write(`\x1b[<0;${col};${row}m`)
  await sleep(400)
}
const hoverAt = async (col: number, row: number) => {
  stdin.write(`\x1b[<35;${col};${row}M`)
  await sleep(300)
}

// ── 1. 底部：rail 出现，8 tick，恰一个 ━━，active 顶部锚定 ──
// 断言在 boot settle 捕获的同一快照上求值（#561 语义保持）。
{
  const snap = bootSnap
  check('rail 出现（▲/▼/tick 齐）', snap.upRow !== null && snap.downRow !== null && snap.ticks.length > 0,
    `up=${snap.upRow} down=${snap.downRow} ticks=${snap.ticks.length}`)
  check('恰 8 个 tick', snap.ticks.length === 8, `ticks=${snap.ticks.length}`)
  check('恰一个 ━━（active）', snap.activeRow !== null && snap.ticks.filter(y => y === snap.activeRow).length === 1,
    `active=${snap.activeRow}`)
  const activeIndex = snap.activeRow !== null ? snap.ticks.indexOf(snap.activeRow) : -1
  check('active = 视口顶行所属轮次（顶部锚定，非最新轮）', bootOwner !== null && activeIndex === bootOwner - 1,
    `active#${activeIndex + 1} vs 顶行属于问题 ${bootOwner}`)
}

// ── 2. 上滚 4 格：active 随边界移动且与顶行轮次一致 ──
await wheel(true, 4)
{
  // 等待与断言共用同一快照：谓词即两条 check 条件的合取（#561 同款不变量）。
  let snap = railSnapshot()
  let owner: number | null = null
  await settle(() => {
    snap = railSnapshot()
    owner = topOwningTurn()
    return snap.ticks.length === 8 && snap.activeRow !== null
      && owner !== null && snap.ticks.indexOf(snap.activeRow) === owner - 1
  })
  check('上滚后仍恰 8 tick / 恰一个 ━━', snap.ticks.length === 8 && snap.activeRow !== null,
    `ticks=${snap.ticks.length} active=${snap.activeRow}`)
  const activeIndex = snap.activeRow !== null ? snap.ticks.indexOf(snap.activeRow) : -1
  check('上滚后 active 与顶行轮次一致', owner !== null && activeIndex === owner - 1,
    `active#${activeIndex + 1} vs 顶行属于问题 ${owner}`)
}

// ── 3. 点击第 3 个 tick：问题 3 到顶，━━ 移到该 tick ──
{
  const snap = railSnapshot()
  const tickRow = snap.ticks[2]
  check('第 3 个 tick 存在', tickRow !== undefined, `ticks=${JSON.stringify(snap.ticks)}`)
  if (tickRow !== undefined) {
    await clickAt(COLS, tickRow + 1)
    check('点击后 问题 3 跳到转译区顶', await settled(() => screenLines().slice(0, 3).some(l => l.includes('问题 3'))),
      `top3=${JSON.stringify(screenLines().slice(0, 3).map(l => l.trimEnd()))}`)
    check('点击后 ━━ 移到该 tick', await settled(() => railSnapshot().activeRow === tickRow),
      `active=${railSnapshot().activeRow} expected=${tickRow}`)
  }
}

// ── 4. ▼ → 问题 4 到顶；▲ → 问题 3 回到顶 ──
{
  const snap = railSnapshot()
  if (snap.downRow !== null) {
    await clickAt(COLS, snap.downRow + 1)
    check('▼ 后 问题 4 到顶', await settled(() => screenLines().slice(0, 3).some(l => l.includes('问题 4'))),
      `top3=${JSON.stringify(screenLines().slice(0, 3).map(l => l.trimEnd()))}`)
    const snap2 = railSnapshot()
    if (snap2.upRow !== null) {
      await clickAt(COLS, snap2.upRow + 1)
      check('▲ 后 问题 3 回到顶', await settled(() => screenLines().slice(0, 3).some(l => l.includes('问题 3'))),
        `top3=${JSON.stringify(screenLines().slice(0, 3).map(l => l.trimEnd()))}`)
    } else {
      check('▲ 行存在', false, 'upRow missing')
    }
  } else {
    check('▼ 行存在', false, 'downRow missing')
  }
}

// ── 5. 滚到顶：active = 首 tick，▲ 无操作 ──
await wheel(true, 40)
{
  const snap = railSnapshot()
  check('顶部 active = 第一个 tick', snap.activeRow === snap.ticks[0],
    `active=${snap.activeRow} first=${snap.ticks[0]}`)
  const before = screenLines()[0]
  if (snap.upRow !== null) {
    // 稳定性探针：断言点击后「无操作」——clickAt 内置的固定窗口就是给
    // 错误滚动留的现身时间，settle 对已成立条件会立即返回，等于没测。
    await clickAt(COLS, snap.upRow + 1)
    const after = screenLines()[0]
    check('顶部 ▲ 无操作（dim = no-op）', before === after, `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`)
  }
}

// ── 6. 悬停第 2 个 tick：预览卡出现又消失 ──
await wheel(false, 20)
{
  // 回到底部，稳定窗口
  const snap = railSnapshot()
  const tickRow = snap.ticks[1]
  check('第 2 个 tick 存在（悬停目标）', tickRow !== undefined, `ticks=${JSON.stringify(snap.ticks)}`)
  if (tickRow !== undefined) {
    await hoverAt(COLS, tickRow + 1)
    check('悬停弹出预览卡（含 问题 2）', await settled(() => screenLines().some(l => l.slice(55, 96).includes('问题 2'))),
      `right-half=${JSON.stringify(screenLines().filter(l => l.includes('问题 2')).slice(0, 2))}`)
    check('预览卡圆角边框', await settled(() => screenLines().some(l => l.slice(55, 97).includes('╭') || l.slice(55, 97).includes('╮')
      || l.slice(55, 97).includes('╰') || l.slice(55, 97).includes('╯'))))
    // 移开：回到转译区中部（无 handler 的文本上）
    await hoverAt(30, 20)
    check('移开后预览卡消失', await settled(() => !screenLines().some(l => l.slice(55, 97).includes('╭') || l.slice(55, 97).includes('╮'))),
      'border still present')
  }
}

// ── 6b. 快速划过 tick：dwell 门下全程无卡（残影修复的回归）──
{
  const snap = railSnapshot()
  let anyCard = false
  // 8ms 间隔连续扫过全部 tick 行（模拟快速划过）
  for (const row of snap.ticks) {
    stdin.write(`\x1b[<35;${COLS};${row + 1}M`)
    await sleep(8)
    if (screenLines().some(l => l.slice(55, 97).includes('╭') || l.slice(55, 97).includes('╮'))) anyCard = true
  }
  // 稳定性探针保留固定窗口：断言「卡不得出现」——settle 对已成立的
  // 否定条件会立即返回，等于没给错误弹卡留出现身时间。
  await sleep(60)
  if (screenLines().some(l => l.slice(55, 97).includes('╭') || l.slice(55, 97).includes('╮'))) anyCard = true
  check('快速划过 tick 全程无预览卡（dwell 门）', !anyCard)
  // 停留后卡照常出现
  const row = snap.ticks[2]
  if (row !== undefined) {
    stdin.write(`\x1b[<35;${COLS};${row + 1}M`)
    check('停留 350ms 后预览卡出现', await settled(() => screenLines().some(l => l.slice(55, 97).includes('╭') || l.slice(55, 97).includes('╮'))))
    await hoverAt(30, 20)
  }
}

// ── 7. resize 59 列：rail 隐藏；恢复 100 列：rail 回来 ──
{
  ;(stdout as any).columns = 59
  stdout.emit('resize')
  term.resize(59, ROWS)
  // 固定窗口保留：断言是「rail 不存在」的否定条件，resize 回流的瞬态
  // 屏幕可能提早满足它——settle 会在重绘完成前就返回。
  await sleep(500)
  const hidden = !screenLines().some((_, y) => {
    const two = cellAt(y, 57) + cellAt(y, 58)
    return two.includes('▴') || two.includes('▾') || two === '━━' || two === ' ─'
  })
  check('59 列 rail 隐藏', hidden)
  ;(stdout as any).columns = COLS
  stdout.emit('resize')
  term.resize(COLS, ROWS)
  // 等待与断言共用同一快照。
  let snap = railSnapshot()
  await settle(() => {
    snap = railSnapshot()
    return snap.ticks.length === 8 && snap.upRow !== null
  })
  check('恢复 100 列 rail 回来', snap.ticks.length === 8 && snap.upRow !== null,
    `ticks=${snap.ticks.length} up=${snap.upRow}`)
}

await inst.unmount()

// ── 8. 工具重会话：折叠窗口吃掉大半轮次，rail 仍覆盖全部轮 ──
// 每轮 = user + 50 工具行 + assistant（52 行/轮）×12 = 624 行 > 300 →
// 折叠窗口只剩 ~5 轮。修复前 rail 只画窗口内轮次（5 tick）；修复后
// 上报全部 12 轮，折叠轮带 folded 标记，点击走 reveal 路径。
{
  const heavy: any[] = []
  let hid = 0
  for (let turn = 1; turn <= 12; turn++) {
    heavy.push({ id: ++hid, kind: 'user', text: `问题 ${turn}` })
    for (let t = 0; t < 50; t++) {
      heavy.push({
        id: ++hid, kind: 'tool', text: '',
        tool: {
          callId: `t${turn}-${t}`, name: 'Read',
          argsText: `{"file_path": "/tmp/f${t}.ts"}`, argsFull: '{}',
          status: 'ok', startedAt: 0, durationMs: 30,
          resultText: `文件 ${t} 内容行 1\n文件 ${t} 内容行 2`,
        },
      })
    }
    heavy.push({ id: ++hid, kind: 'assistant', text: `回复 ${turn} 完毕。` })
  }
  const heavyChannel: any = { ...channel, rows: heavy, lastUserText: '问题 12' }
  const inst2 = await render(
    <AlternateScreen>
      <Chat channel={heavyChannel} questionStore={new QuestionStore()} fullscreen />
    </AlternateScreen>,
    { stdout: stdout as any, stdin: stdin as any, stderr: stderr as any, exitOnCtrlC: false, patchConsole: false },
  )
  // 等待与断言共用同一快照。
  let snap = railSnapshot()
  await settle(() => {
    snap = railSnapshot()
    return snap.ticks.length === 12 && snap.activeRow !== null
  })
  check('工具重会话：rail 覆盖全部 12 轮', snap.ticks.length === 12,
    `ticks=${snap.ticks.length}（折叠窗口内仅 ~5 轮）`)
  check('工具重会话：恰一个 ━━', snap.activeRow !== null, `active=${snap.activeRow}`)
  // 点击第一个 tick（问题 1，被折叠）→ reveal + 跳转
  const firstTick = snap.ticks[0]
  if (firstTick !== undefined) {
    await clickAt(COLS, firstTick + 1)
    // 揭示跳转先画转录区、━━ 后移：两条断言的条件都到位才算落定；断言在
    // settle 捕获的同一快照上求值。
    let lines = screenLines()
    let snap2 = railSnapshot()
    await settle(() => {
      lines = screenLines()
      snap2 = railSnapshot()
      return lines.slice(0, 6).some(l => l.includes('问题 1'))
        && snap2.activeRow !== null && snap2.ticks.indexOf(snap2.activeRow) === 0
    })
    check('点击折叠 tick：问题 1 揭示并到顶', lines.slice(0, 6).some(l => l.includes('问题 1')),
      `top6=${JSON.stringify(lines.slice(0, 4).map(l => l.trimEnd().slice(0, 30)))}`)
    // 揭示后 sticky header 占 1 行 → 视口缩 1 → 整个 tick 块平移；按
    // 轮次索引断言（━�� 在第 0 个 tick 上），不按屏幕行号。
    check('揭示后 ━━ 移到首 tick（问题 1）', snap2.activeRow !== null && snap2.ticks.indexOf(snap2.activeRow) === 0,
      `active=${snap2.activeRow} ticks=${JSON.stringify(snap2.ticks)}`)
  }
  await inst2.unmount()
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
