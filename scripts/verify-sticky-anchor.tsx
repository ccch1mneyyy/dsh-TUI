/**
 * verify-sticky-anchor — 置顶 prompt 头跟随视口（“翻到哪条置顶哪条”）。
 *
 * 用户报告：滚动到倒数第二条消息时，置顶头仍显示最后一条消息。修复后
 * StickyPromptHeader 不再读 `channel.lastUserText`，而是钉住时间线 active
 * 轮：占据视口顶行的轮次（顶部锚定，Grok timeline 语义 —— prompt 顶在
 * 视口顶之上/恰在顶行的最后一轮；logo 等前置内容占顶时取第一轮）。
 * 与时间线 rail 的 ━━ 高亮同源（同一个 MessageList 上报），两者永不分歧。
 *
 * 断言（全屏 headless xterm，100×40）：
 *   1. 初始钉底：无置顶头（第 0 行不以 ❯ 开头）；
 *   2. 上滚后：置顶头 = 顶部锚定轮 —— 视口首内容为 回复 k 时恰为 问题 k；
 *      首内容为 问题 M 时为 M-1 或 M（prompt 自身顶到视口顶行 = M，
 *      其上仅剩 1 行 margin 空行 = M-1）；
 *   3. 继续上滚：跟随变化，且永不为屏幕上看不到的“最后一条”；
 *   4. 逐格下滚：每步都与顶部锚定轮一致；
 *   5. 点击置顶头：被钉消息跳到视口顶部（转译区首行附近出现该消息）；
 *   6. 滚回底部：重新钉底，置顶头消失。
 *
 * 运行：node --import tsx/esm scripts/verify-sticky-anchor.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { LOCAL_COMMANDS, completeCommands }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
])

const COLS = 100, ROWS = 40
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
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

// 8 轮对话：user 消息各 1 行（问题 1..8），assistant 回复各 8 行。
// 内容总高 ≈ 14（LogoHeader）+ 8×9 = 86 行 ≫ 视口，可滚动。
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
  // 故意的“错误真源”：修复前置顶头读它 → 永远显示问题 8；修复后必须
  // 不再使用它（断言 3 专门抓这一点）。
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
await sleep(700)

function screenLines(): string[] {
  const buf = term.buffer.active
  return Array.from({ length: ROWS }, (_, y) => buf.getLine(buf.baseY + y)?.translateToString(true) ?? '')
}
/** 置顶头文本（第 0 行），无头时返回 null。 */
function headerText(): string | null {
  const line0 = screenLines()[0]!.trimEnd()
  return /^❯/.test(line0) ? line0 : null
}
/** 转译区首个可见内容行（跳过置顶头）：[所属轮次, 是 prompt 行吗]。 */
function firstContentTurn(): { turn: number; isPrompt: boolean } | null {
  const lines = screenLines()
  for (let y = headerText() ? 1 : 0; y < ROWS; y++) {
    const m = lines[y]!.match(/(问题|回复) (\d+)/)
    if (m) return { turn: Number(m[2]), isPrompt: m[1] === '问题' }
  }
  return null
}
const wheel = async (up: boolean, times: number) => {
  for (let i = 0; i < times; i++) {
    stdin.write(`\x1b[<${up ? 64 : 65};50;30M`)
    await sleep(180)
  }
}
const clickHeader = async () => {
  stdin.write('\x1b[<0;5;1M')
  stdin.write('\x1b[<0;5;1m')
  await sleep(400)
}
/** 内容末行（最后一轮最后 1 行回复）是否已出现在 prompt 框正上方 —— 真·钉底。 */
function atBottomEnd(): boolean {
  const lines = screenLines()
  let promptRow = -1
  for (let y = ROWS - 1; y >= 0; y--) {
    if (lines[y]!.trimStart().startsWith('❯')) { promptRow = y; break }
  }
  const from = promptRow >= 0 ? Math.max(0, promptRow - 4) : ROWS - 6
  for (let y = from; y < ROWS; y++) {
    if (lines[y]!.includes('回复 8 第 8 行')) return true
  }
  return false
}
/**
 * 断言置顶头 = 顶部锚定轮（占据视口顶行的轮次）。屏幕侧推断：
 *  - 首内容为 回复 k → 该答案属于第 k 轮，prompt k 必在顶上方 → 头 = k；
 *  - 首内容为 问题 M → prompt 恰在视口顶行（头 = M）或其上只剩 1 行
 *    margin 空行（prompt 文字顶还在顶行下方 1 行 → 头 = M-1）；
 *  - M = 1 时恒为 1（前置内容占顶 → 第一轮兜底）；
 *  - 真·钉底（末行已可见）时头合法隐藏。
 */
function assertHeaderFollowsViewport(label: string): number | null {
  const first = firstContentTurn()
  const header = headerText()
  if (first === null) {
    check(`${label}: 无内容可推断（跳过）`, true)
    return null
  }
  if (atBottomEnd()) {
    check(`${label}: 钉底态置顶头隐藏`, header === null, `header=${JSON.stringify(header)}`)
    return null
  }
  const expected = first.isPrompt
    ? (first.turn === 1 ? [1] : [first.turn - 1, first.turn])
    : [first.turn]
  const headerTurn = header?.match(/问题 (\d+)/)
  const got = headerTurn ? Number(headerTurn[1]) : null
  check(`${label}: 置顶头 = 顶部锚定轮（期望 ∈ {${expected.join('/')}}）`,
    header !== null && got !== null && expected.includes(got),
    `首内容=${first.isPrompt ? '问题' : '回复'} ${first.turn} header=${JSON.stringify(header)}`)
  if (!expected.includes(8)) {
    check(`${label}: 置顶头 ≠ 最后一条消息`, got === null || got !== 8, `header=${JSON.stringify(header)}`)
  }
  return got
}

// ── 1. 初始钉底：无置顶头，末尾消息可见 ──
check('初始钉底无置顶头', headerText() === null, `line0=${JSON.stringify(screenLines()[0]!.trimEnd().slice(0, 20))}`)
check('初始末尾消息可见', screenLines().some(l => l.includes('问题 8')))

// ── 2/3. 上滚：置顶头出现并跟随视口 ──
await wheel(true, 4)   // -12 行
assertHeaderFollowsViewport('上滚 4 格后')
await wheel(true, 8)   // 再 -24 行（累计 -36）
assertHeaderFollowsViewport('上滚 12 格后')

// ── 4. 逐格下滚回读：每步都跟随 ──
let seenAny = false
for (let step = 1; step <= 14; step++) {
  await wheel(false, 1)
  const got = assertHeaderFollowsViewport(`下滚第 ${step} 格`)
  if (got !== null) seenAny = true
}
check('下滚过程中至少观察到一次置顶头跟随', seenAny)

// ── 5. 点击置顶头：被钉消息跳到视口顶 ──
{
  // 先上滚 3 格：点击的 seek 会把被钉消息对齐到视口顶，若该位置恰好是
  // 内容底部，渲染器会按既定规则重新钉底（sticky → 置顶头合法消失，
  // 见 render-node-to-output 的 sticky-restore）——那不是本测试要覆盖的
  // 场景，避开它。
  await wheel(true, 3)
  const header = headerText()
  const pinned = header?.match(/问题 (\d+)/)
  if (header !== null && pinned) {
    const top = Number(pinned[1])
    const before = screenLines().slice(1, 6).map(l => l.trimEnd())
    await clickHeader()
    const after = screenLines().slice(1, 6).map(l => l.trimEnd())
    check('点击后: 置顶头仍显示原消息', headerText()?.includes(`问题 ${top}`) === true,
      `header=${JSON.stringify(headerText())}`)
    check('点击后: 原消息跳到转译区顶部', after[0]?.includes(`问题 ${top}`) || after[1]?.includes(`问题 ${top}`) || after[2]?.includes(`问题 ${top}`),
      `before=${JSON.stringify(before[0])} after=${JSON.stringify(after[0])}`)
  } else {
    check('点击测试跳过（需要置顶头可见）', false, `header=${JSON.stringify(header)}`)
  }
}

// ── 6. 滚回底部：重新钉底，置顶头消失 ──
await wheel(false, 30)
const headerAfterBottom = headerText()
check('滚回底部后置顶头消失', headerAfterBottom === null, `line0=${JSON.stringify(screenLines()[0]!.trimEnd().slice(0, 20))}`)
check('滚回底部后末尾消息可见', screenLines().some(l => l.includes('问题 8')))

await inst.unmount()
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
