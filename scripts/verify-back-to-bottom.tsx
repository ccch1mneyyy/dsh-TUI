/**
 * verify-back-to-bottom — 一键回底：pill 常驻化 + End/Enter 键。
 *
 * 断言（headless xterm 100×40，全屏 Chat，8 轮对话）：
 *   1. 钉底：无 pill；
 *   2. 上滚：pill 出现「↓ 回到底部」；再流入新消息（追加 1 轮）→
 *      pill 切「↓ N 条新消息」；
 *   3. 按 End：回底（末轮可见、pill 消失）；
 *   4. 再上滚：pill 出现；按 Enter：回底（pill 消失）；
 *   5. 再上滚：点击 pill：回底；
 *   6. 钉底按 End：无操作（末轮仍可见，不崩）。
 *
 * 运行：node --import tsx/esm scripts/verify-back-to-bottom.tsx
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
for (let turn = 1; turn <= 8; turn++) {
  rows.push({ id: turn * 2 - 1, kind: 'user', text: `问题 ${turn}` })
  rows.push({ id: turn * 2, kind: 'assistant', text: Array.from({ length: 8 }, (_, i) => `回复 ${turn} 第 ${i + 1} 行`).join('\n') })
}
const listeners = new Set<() => void>()
const channel: any = {
  version: 0, rows, status: 'idle', sessionTitle: 'probe', agentId: 'probe',
  model: 'deepseek-v4-flash', provider: 'deepseek', reasoningEffort: 'max', effortLevels: [],
  tokens: { input: 0, output: 0 }, cwd: '/tmp/demo', displayCwd: '/tmp/demo', gitBranch: 'main',
  working: false, spinnerMode: 'requesting', responseChars: 0, activeToolCount: 0, turnStart: 0,
  pending: [], commandList: LOCAL_COMMANDS, notifications: [], mode: { plan: false, sandbox: undefined },
  activityFrames: 'claude', agentPreset: undefined, subagents: [], lastUserText: '问题 8',
  scrollGutter: 'timeline',
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => Promise.resolve([]),
  deleteSession: () => Promise.resolve(true), renameSessionTo: () => Promise.resolve(true),
  setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [], pushLocal: () => {},
  commandCompletions: (input: string) => completeCommands(input),
}
const emitChannel = () => { channel.version++; for (const l of listeners) l() }

const inst = await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} fullscreen />
  </AlternateScreen>,
  { stdout: stdout as any, stdin: stdin as any, stderr: stderr as any, exitOnCtrlC: false, patchConsole: false },
)
// 启动等待保留固定窗口：首个断言是「钉底无 pill」的稳定性探针，对已成立
// 条件（空屏也无 pill）轮询立即返回等于没测。
await sleep(700)

function screenLines(): string[] {
  const buf = term.buffer.active
  return Array.from({ length: ROWS }, (_, y) => buf.getLine(buf.baseY + y)?.translateToString(true) ?? '')
}
/** pill 行文本（含 ↓ 的左缘行），无则 null。 */
function pillText(): string | null {
  for (const l of screenLines()) {
    if (/↓/.test(l)) return l.trim()
  }
  return null
}
const lastTurnVisible = () => screenLines().some(l => l.includes('问题 8'))
// 逐事件 pacing sleep 保留：滚轮事件需要逐个进入 hover/scroll 路径，
// 每步之间没有可区分新旧帧的屏幕条件可轮询。
const wheel = async (up: boolean, times: number) => {
  for (let i = 0; i < times; i++) {
    stdin.write(`\x1b[<${up ? 64 : 65};90;30M`)
    await sleep(150)
  }
}
/** 按键：等待由调用点的 settled 断言承担（「无操作」稳定性探针除外，
 *  那里保留固定窗口）。 */
const pressKey = (name: string) => {
  const seqs: Record<string, string> = {
    end: '\x1b[F',
    enter: '\r',
  }
  stdin.write(seqs[name]!)
}

// ── 1. 钉底：无 pill ──
check('钉底无 pill', pillText() === null, `pill=${JSON.stringify(pillText())}`)

// ── 2. 上滚：常驻 pill；流入新消息后切计数 ──
await wheel(true, 6)
check('上滚后 pill 出现（回到底部）', await settled(() => {
  const p = pillText()
  return p !== null && p.includes('回到底部')
}), `pill=${JSON.stringify(pillText())}`)
// 追加一轮新消息（模拟流式落定）
rows.push({ id: 17, kind: 'user', text: '问题 9' })
rows.push({ id: 18, kind: 'assistant', text: '回复 9 第 1 行\n回复 9 第 2 行' })
emitChannel()
check('新消息后 pill 切计数', await settled(() => {
  const p = pillText()
  return p !== null && /2 条新消息/.test(p)
}), `pill=${JSON.stringify(pillText())}`)

// ── 3. End 键回底 ──
pressKey('end')
check('End 后回到底部（末轮可见）', await settled(() => lastTurnVisible()))
check('End 后 pill 消失', await settled(() => pillText() === null), `pill=${JSON.stringify(pillText())}`)

// ── 4. 上滚后 Enter 回底 ──
await wheel(true, 8)
check('再次上滚 pill 重现', await settled(() => pillText() !== null), `pill=${JSON.stringify(pillText())}`)
pressKey('enter')
check('Enter 后回到底部', await settled(() => lastTurnVisible() && pillText() === null),
  `last=${lastTurnVisible()} pill=${JSON.stringify(pillText())}`)

// ── 5. 点击 pill 回底 ──
await wheel(true, 8)
{
  let pillRow = -1, pillCol = -1
  await settle(() => {
    const lines = screenLines()
    pillRow = -1
    pillCol = -1
    for (let y = 0; y < ROWS && pillRow === -1; y++) {
      const l = lines[y]!
      const x = l.indexOf('↓')
      if (x >= 0) { pillRow = y; pillCol = x }
    }
    return pillRow !== -1
  })
  check('点击前 pill 可见', pillRow !== -1, `row=${pillRow}`)
  if (pillRow !== -1) {
    stdin.write(`\x1b[<0;${pillCol + 2};${pillRow + 1}M`)
    stdin.write(`\x1b[<0;${pillCol + 2};${pillRow + 1}m`)
    check('点击 pill 后回到底部', await settled(() => lastTurnVisible() && pillText() === null),
      `last=${lastTurnVisible()} pill=${JSON.stringify(pillText())}`)
  }
}

// ── 6. 钉底按 End：无操作不崩 ──
// 稳定性探针：期望状态不变（已在底部），保留固定窗口——轮询已成立条件
// 会立即返回等于没测。
pressKey('end')
await sleep(400)
check('钉底按 End 无操作', lastTurnVisible() && pillText() === null)

await inst.unmount()

// ── 7. 远距跳底：20 轮重会话从中部 End 回底，不空白、末轮可见 ──
// 修复前：viewport 落在从未挂载的行上（spacer 高度全是估算），topPad
// 吞掉视口 = 永久空白，直到下一次 wheel 才救活。
{
  const heavy: any[] = []
  for (let turn = 1; turn <= 20; turn++) {
    heavy.push({ id: turn * 2 - 1, kind: 'user', text: `问题 ${turn}` })
    heavy.push({ id: turn * 2, kind: 'assistant', text: Array.from({ length: 8 }, (_, i) => `回复 ${turn} 第 ${i + 1} 行`).join('\n') })
  }
  const heavyChannel: any = { ...channel, rows: heavy, lastUserText: '问题 20' }
  const inst2 = await render(
    <AlternateScreen>
      <Chat channel={heavyChannel} questionStore={new QuestionStore()} fullscreen />
    </AlternateScreen>,
    { stdout: stdout as any, stdin: stdin as any, stderr: stderr as any, exitOnCtrlC: false, patchConsole: false },
  )
  await settle(() => screenLines().some(l => l.includes('问题 20')))
  // 上滚 30 格 → 中部（跳底距离 ≈ 150 行 ≫ 视口）；逐事件 pacing 保留。
  for (let i = 0; i < 30; i++) {
    stdin.write('\x1b[<64;90;30M')
    await sleep(60)
  }
  // 中部位置稳定窗：随后的回底延迟采样以此为起点，无可轮询条件。
  await sleep(300)
  // End 回底 + 采样
  stdin.write('\x1b[F')
  let settledAt = -1
  for (let s = 0; s < 12; s++) {
    await sleep(50)
    if (screenLines().some(l => l.includes('问题 20'))) { settledAt = (s + 1) * 50; break }
  }
  check('远距 End 回底：末轮可见（≤600ms）', settledAt > 0, `settledAt=${settledAt}ms`)
  // 回底后的空白带/pill 断言是稳定性探针，取样前保留固定稳定窗。
  await sleep(300)
  const lines = screenLines()
  // 空白行统计：转译区（跳过置顶头）连续全空行数 ≤ 6（轮间分隔正常 2-3 行）
  let promptRow = -1
  for (let y = ROWS - 1; y >= 0; y--) { if (lines[y]!.trimStart().startsWith('❯')) { promptRow = y; break } }
  const endRow = promptRow >= 0 ? promptRow - 2 : ROWS - 4
  let maxRun = 0, run = 0
  for (let y = 1; y < endRow; y++) {
    if (lines[y]!.trim() === '') run++
    else run = 0
    maxRun = Math.max(maxRun, run)
  }
  check('远距回底后无空白带（连续空行 ≤6）', maxRun <= 6, `maxRun=${maxRun}`)
  check('远距回底后 pill 消失', pillText() === null, `pill=${JSON.stringify(pillText())}`)
  await inst2.unmount()
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
