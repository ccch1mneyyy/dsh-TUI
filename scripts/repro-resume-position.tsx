/**
 * repro-resume-position — 用户报告：进入 resume 的历史会话时视图不在最底
 * 下（落在中部历史），既卡又看不到最新消息。
 *
 * 三条真实进入路径逐一验证落点：
 *  S1 启动器 boot --resume：Chat 冷挂载时 rows 已完整回放（工厂 setup
 *     hook 先于首帧）——预置长历史直接 render。
 *  S2 /resume 浏览器恢复（之前钉在底部）：短会话 A → /resume → Enter →
 *     resumeTo 原地清空重填 rows（真实语义：同数组、id 从 0 重放）→ 浏览
 *     器关闭 → 转录重挂载。
 *  S3 /resume 浏览器恢复（之前上滚阅读）：同 S2 但恢复前先滚轮上滚打破
 *     sticky——检验挂载时的滚动状态是否干净。
 *
 * 行形状对齐真实长会话：user + thinking(600B) + 工具卡(24 行结果) +
 * assistant(9-12 行 markdown)，90 轮 ≈ 300 行（超过 120 行折叠窗口）。
 *
 * 断言（每场景）：
 *  - 视口包含最后一条消息的结尾标记（最新消息可见）；
 *  - 无 "N 条新消息"/回到底部 pill（!isSticky 的唯一可见信号）；
 *  - 视口不包含中部历史的独有标记（没停在半路）。
 * 另测打开→静息时长（卡顿体感代理）。
 *
 * 运行：node --import tsx/esm scripts/repro-resume-position.tsx
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

function screenLines(): string[] {
  const buf = term.buffer.active
  return Array.from({ length: ROWS }, (_, y) => buf.getLine(buf.baseY + y)?.translateToString(true) ?? '')
}

// ── 会话行工厂：真实形状（thinking / 工具卡 / assistant 长文）──
const T0 = Date.now() - 600_000
function buildHistory(turns: number, tailMark: string, midMark: string): any[] {
  const rows: any[] = []
  let id = 0
  for (let i = 1; i <= turns; i++) {
    rows.push({ id: id++, kind: 'user', text: `问题 ${i}：帮我看看这个模块的解析逻辑`, time: T0 + i * 8000 })
    const mid = i === Math.floor(turns / 2) ? `【${midMark}】` : ''
    if (i % 3 === 0) {
      rows.push({
        id: id++, kind: 'reasoning',
        text: `思考 ${i}：`.padEnd(600, '先分析结构再遍历节点，检查类型约束与边界。'),
      })
      rows.push({
        id: id++, kind: 'tool', text: '',
        tool: {
          callId: `t${i}`, name: 'Bash', argsText: '{"command": "node --check mod.js"}',
          argsFull: '{}', status: 'ok', startedAt: 0, durationMs: 30,
          resultText: Array.from({ length: 24 }, (_, k) => `  line ${k}: ok depth=${k}`).join('\n'),
        },
      })
    }
    rows.push({
      id: id++, kind: 'assistant',
      text: `回复 ${i}：${mid}${'这一段是正文内容，分析输入结构、遍历节点、检查类型约束与边界情况，覆盖空输入、深层嵌套和循环引用。'.repeat(3)}${i === turns ? ` ${tailMark}` : ''}`,
      time: T0 + i * 8000 + 3000,
    })
  }
  return rows
}

/**
 * The workspace the probe's sessions live in. `/resume` now lands on the
 * unified session screen, and that screen lists the sessions OF THE SELECTED
 * WORKSPACE — a stub that only exposes `listSessions` shows a session list for
 * a workspace the ledger does not contain, i.e. an empty pane with nothing to
 * enter. Both halves of the listing are therefore stubbed, and they agree on
 * this path.
 */
const WORKSPACE_PATH = '/tmp/demo'

const sessions: any[] = Array.from({ length: 4 }, (_, i) => ({
  id: `s${i}`,
  kind: { kind: 'root' },
  title: { text: `历史会话 ${i}`, source: 'auto' },
  cwd: WORKSPACE_PATH,
  createdAt: T0 - i * 60_000,
  updatedAt: T0 + i * 60_000,
  bytes: 12_000 + i * 1000,
  branch: 'main',
  model: 'deepseek-v4-flash',
  childCount: 0,
  hasPrompt: true,
  label: undefined,
  agentPreset: undefined,
}))

const workspaceRegistry = [
  { id: 'w-demo', path: WORKSPACE_PATH, title: 'demo', present: true, sessionCount: sessions.length },
]

function makeChannel(initialRows: any[]) {
  const listeners = new Set<() => void>()
  const rows = initialRows
  const channel: any = {
  // 探针确定性：鲸鱼欢迎期闲置动画（默认开）不进本探针的测量窗口。
  whaleIdle: false,
    version: 0, rows, status: 'idle', sessionTitle: 'probe', agentId: 'probe',
    model: 'deepseek-v4-flash', provider: 'deepseek', reasoningEffort: 'max', effortLevels: [],
    tokens: { input: 0, output: 0 }, cwd: WORKSPACE_PATH, displayCwd: WORKSPACE_PATH, gitBranch: 'main',
    working: false, spinnerMode: 'requesting', responseChars: 0, activeToolCount: 0, turnStart: 0,
    pending: [], commandList: LOCAL_COMMANDS, notifications: [], mode: { plan: false, sandbox: undefined },
    activityFrames: 'moon8', agentPreset: undefined, subagents: [], lastUserText: '',
    scrollGutter: 'timeline', whale: true,
    subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
    emit() { channel.version++; for (const cb of listeners) cb() },
    submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
    listModels: () => Promise.resolve([]),
    listSessions: () => Promise.resolve(sessions),
    // 三合一会话界面（/resume · /agentview · /home）的两半读取面：左栏工作区
    // 账本 + 右栏会话列表。缺了前者的宿主会退化成一个空左栏、并且右栏因为
    // 选不中工作区而永远为空——正是本探针要复现的"没有会话可进"。
    listWorkspaceRegistry: () => Promise.resolve(workspaceRegistry),
    resolveWorkspace: (reference: string) =>
      Promise.resolve({ cwd: reference, uri: reference, label: reference, kind: 'local', badge: 'LOCAL' }),
    switchWorkspace: () => Promise.resolve(true),
    stopBackgroundAgent: () => Promise.resolve(false),
    deleteSession: () => Promise.resolve(true),
    renameSessionTo: () => Promise.resolve(true),
    setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [], pushLocal: () => {},
    commandCompletions: (input: string) => completeCommands(input),
    // 真实 resumeTo 语义（channel.ts ~2955）：同数组原地清空重填、id 从 0
    // 重放、同步完成、末尾一次 emit。
    async resumeTo(sessionId: string) {
      rows.length = 0
      for (const row of buildHistory(90, 'TAILMARK_Q7X', 'MIDMARK_Z9')) rows.push(row)
      channel.lastUserText = '问题 90'
      channel.agentId = sessionId
      channel.emit()
      return { ok: true }
    },
  }
  return channel
}

function assertLanded(tag: string, ms: number, snapshot?: string[]): void {
  const lines = snapshot ?? screenLines()
  const screen = lines.join('\n')
  const tailVisible = screen.includes('TAILMARK_Q7X')
  const midVisible = screen.includes('MIDMARK_Z9')
  const pill = screen.includes('条新消息') || screen.includes('回到底部')
  check(`${tag}: 最新消息结尾标记可见（在最底下）`, tailVisible,
    tailVisible ? '' : `视口末行="${lines[ROWS - 3]!.trimEnd().slice(0, 40)}"`)
  check(`${tag}: 无新消息 pill（sticky 已钉底）`, !pill)
  check(`${tag}: 视口不在中部历史`, !midVisible)
  console.log(`  [${tag}] 打开→检查点 ${ms.toFixed(0)}ms`)
  if (!tailVisible || process.env.DUMP) {
    console.log('  ──── 视口全量 ────')
    lines.forEach((l, y) => console.log(`  ${String(y).padStart(2)}|${l.replace(/\s+$/, '')}`))
  }
}

// ── S1：boot --resume（冷挂载 + 预置完整长历史）──
{
  const channel = makeChannel(buildHistory(90, 'TAILMARK_Q7X', 'MIDMARK_Z9'))
  const inst = await render(
    <AlternateScreen><Chat channel={channel} questionStore={new QuestionStore()} fullscreen /></AlternateScreen>,
    { stdout: stdout as any, stdin: stdin as any, stderr: stderr as any, exitOnCtrlC: false, patchConsole: false },
  )
  const t0 = performance.now()
  // 等待与断言共用同一快照：assertLanded 在 settle 捕获的 lines 上求值。
  let lines: string[] = []
  await settle(() => { lines = screenLines(); return lines.join('\n').includes('TAILMARK_Q7X') })
  assertLanded('S1 boot--resume', performance.now() - t0, lines)
  await inst.unmount()
}

// ── S2/S3：/resume 浏览器（S3 恢复前先上滚打破 sticky）──
for (const [tag, scrollFirst] of [['S2 resume(at-bottom)', false], ['S3 resume(scrolled-up)', true]] as const) {
  const channel = makeChannel(buildHistory(15, '', ''))
  const inst = await render(
    <AlternateScreen><Chat channel={channel} questionStore={new QuestionStore()} fullscreen /></AlternateScreen>,
    { stdout: stdout as any, stdin: stdin as any, stderr: stderr as any, exitOnCtrlC: false, patchConsole: false },
  )
  await settle(() => screenLines().join('\n').includes('问题 15'))
  if (scrollFirst) {
    // 逐事件 pacing：滚轮事件逐个进入 scroll 路径。
    for (let i = 0; i < 12; i++) { stdin.write('\x1b[<64;50;20M'); await sleep(16) } // 固定窗:pacing 滚轮事件步间
    check(`${tag}: 前置——上滚后视口离开底部`, await settled(() => !screenLines().join('\n').includes('问题 15')))
  }
  // /resume → 三合一会话界面 → 进右栏选会话 → Enter 恢复
  //
  // `/resume`, `/agentview` and `/home` are ONE screen now (a workspace rail
  // plus the sessions of the selected workspace), and it opens with the
  // keyboard on the RAIL: Enter there opens a workspace action menu, not a
  // session. Entering a session is therefore two deliberate steps — `→` moves
  // the cursor into the session pane (landing on the session this terminal is
  // attached to), then Enter mounts it.
  //
  // The two fixed windows wait for key readiness that is not observable on
  // screen: the completion overlay has to take the Enter that runs the command,
  // and the screen has to have finished its own listing before it accepts the
  // pane switch. Settling on "历史会话 visible" would fire `→` into a screen
  // that has not mounted its key handler yet.
  stdin.write('/resume')
  await sleep(300) // 固定窗:pacing 等补全浮层收键就绪，无可观测锚点
  stdin.write('\r')
  await sleep(500) // 固定窗:pacing 等会话界面收键就绪，无可观测锚点
  check(`${tag}: 会话界面打开`, await settled(() => screenLines().some(l => l.includes('历史会话'))), '')
  stdin.write('\x1b[C') // → 把光标移进右栏（落在"新建会话"卡片上）
  await sleep(200) // 固定窗:pacing 切栏后等焦点重绘，无可观测锚点
  stdin.write('\x1b[B') // ↓ 越过第 0 行的「＋ 新建会话」卡片，站到第一条会话
  await sleep(120) // 固定窗:pacing 焦点行步间
  stdin.write('\r') // Enter → resumeTo → onClose
  // 等两个条件同时成立，而不是等一个固定窗口：恢复后的转录要先把 90 轮
  // 行高量完（未量完时末尾标记可能在视口下方），并且落点要真的在底部。
  // 固定窗口在慢 runner 上会撞上"内容已回放但量测未静息"的中间帧（实测
  // 700ms 就在这个帧上断言，末行还是输入框下边框）。
  //
  // `settle` 而不是 `settled`：等待后要断言的是 assertLanded 的多条不变量，
  // 这里只是先把状态推到可判定的位置。
  const t0 = performance.now()
  await settle(
    () => screenLines().join('\n').includes('TAILMARK_Q7X'),
    { timeoutMs: 5000 },
  )
  await sleep(200) // 固定窗:pacing 行高量测静息步间，settled 会提前返回
  assertLanded(tag, performance.now() - t0)
  // 回到底部探针：滚 1 上再 2 下（pill 出现会使视口矮 2 行，等量滚回
  // 必然差 2 行——这是既有 pill 语义；多滚一下代表用户“回到底部”）。
  stdin.write('\x1b[<64;50;20M')
  await sleep(200) // 固定窗:pacing 滚轮事件步间
  stdin.write('\x1b[<65;50;20M')
  await sleep(120) // 固定窗:pacing 滚轮事件步间
  stdin.write('\x1b[<65;50;20M')
  const healed = await settled(() => screenLines().join('\n').includes('TAILMARK_Q7X'))
  check(`${tag}: 滚离后滚回底部，最新消息可见`, healed)
  if (!healed) {
    console.log('  ──── 自愈探针后视口 ────')
    screenLines().forEach((l, y) => console.log(`  ${String(y).padStart(2)}|${l.replace(/\s+$/, '')}`))
  }
  await inst.unmount()
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
