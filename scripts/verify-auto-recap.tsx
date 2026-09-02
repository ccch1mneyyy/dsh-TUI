/**
 * Auto-recap regression (`dsh-tui.recapOnOpen`): the dim one-line recap
 * row at the bottom of the transcript when a session opens/resumes.
 *
 * Drives the real Chat in xterm (same harness as verify-session-color-recap):
 *  - mount with `autoRecapOnOpen: true` triggers exactly one `recapRecent`
 *    call and renders the dim row (summary text);
 *  - hovering the row reveals the affordances (expand hint + dismiss chip);
 *  - clicking expands into the full RecapPanel (suggested title, `a` to
 *    apply through renameSession), Esc collapses back to the dim row;
 *  - clicking the dismiss chip hides the row until the next session switch;
 *  - switching sessions re-triggers; a failed recap stays silent; the
 *    setting off stops the trigger.
 *
 * Run: node --import tsx/esm scripts/verify-auto-recap.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, AlternateScreen },
  { Chat },
  { setLang },
  { settle, settled, screenHas, findText, viewportLines },
  { stringWidth },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/i18n.js'),
  import('./lib/term-test.mjs'),
  import('../src/ink/stringWidth.js'),
])

const COLS = 100
const ROWS = 30
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    term.write(String(chunk), callback)
  }
}

class FakeStderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void) { callback() }
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

let failures = 0
function check(name: string, condition: boolean, detail = ''): void {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${name}${detail === '' ? '' : `  (${detail})`}`)
  if (!condition) failures += 1
}

function makeChannel() {
  const listeners = new Set<() => void>()
  const renameCalls: string[] = []
  let recapCallCount = 0
  let nextRowId = 3
  let recapResult: { summary: string | null; title?: string; error?: string } = {
    summary: 'AUTO_RECAP_SUMMARY',
    title: 'AUTO_RECAP_TITLE',
  }
  const channel: any = {
    version: 0,
    rows: [
      { id: 1, kind: 'user', text: '检查这个问题' },
      { id: 2, kind: 'assistant', text: '已经检查。', streaming: false },
    ],
    status: 'idle',
    sessionTitle: '我的会话',
    sessionColor: '',
    autoRecapOnOpen: true,
    agentId: 'probe',
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    tokens: { input: 20, output: 10 },
    cwd: '/tmp',
    displayCwd: '/tmp',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting',
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    lastUserText: '',
    pending: [],
    notifications: [],
    contextWindow: undefined,
    reasoningEffort: 'max',
    workingActivity: undefined,
    activityEnabled: false,
    contextBarEnabled: true,
    agentPreset: 'standard',
    goal: undefined,
    todos: [],
    commandList: [],
    commandCompletions() { return [] },
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    mode: { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
    modeIndex: 0,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    notify() {},
    pushLocal() {},
    renameSession(title: string) {
      renameCalls.push(title)
      channel.sessionTitle = title
      channel.emit()
    },
    recapRecent: async () => {
      recapCallCount += 1
      return recapResult
    },
    emit() {
      channel.version += 1
      for (const listener of listeners) listener()
    },
    submit(text: string) {
      // 发送新消息 = 追加一条 user 行（自动摘要退场的信号）。
      channel.rows.push({ id: nextRowId++, kind: 'user', text })
      channel.emit()
    },
    steer() {},
    removePending: () => true,
    cancel() {},
    interruptAndDeliver: () => 0,
    clear() {},
    loadOlder: () => 0,
    listModels: async () => [],
    listFiles: async () => [],
    listSessions: async () => [],
    setResumeTarget() {},
    setActivityFrames: () => true,
    activityFrames: 'claude',
    runExternalCommand: async () => '',
    mcpStatus: () => [],
    exportSession: () => null,
    initWorkspace: () => null,
    doctorInfo: () => [],
    pluginsInfo: () => [],
    listSubagents: async () => [],
    listPresets: async () => [],
    switchPreset: async () => false,
    switchModel: async () => false,
    rewindTo: async () => null,
    resumeTo: async () => ({ ok: false, reason: 'unavailable' }),
    newSession: async () => false,
    compact() {},
    traceEvents: () => [],
    settingsSections: () => [],
    subscribeSettingsSections: () => () => {},
    renameCalls,
    get recapCallCount() { return recapCallCount },
    set recapResult(value: { summary: string | null; title?: string; error?: string }) { recapResult = value },
  }
  return channel
}

setLang('zh')
const stdin = new FakeStdin()
const channel = makeChannel()
const questionStore = { subscribe: () => () => {}, getSnapshot: () => null, answerCurrent: () => {} }
const approvalStore = { subscribe: () => () => {}, getSnapshot: () => null }
const instance = await render(
  <AlternateScreen>
    <Chat
      fullscreen
      channel={channel}
      questionStore={questionStore as any}
      approvalStore={approvalStore as any}
    />
  </AlternateScreen>,
  {
    stdout: new FakeStdout(),
    stderr: new FakeStderr(),
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  },
)

/** SGR hover 注入（1-indexed）。 */
const hover = (col: number, row: number) => stdin.write(`\x1b[<35;${col};${row}M`)
/** SGR 点击注入：press+release 同一单元格（1-indexed）。 */
const clickCell = (col: number, row: number) => {
  stdin.write(`\x1b[<0;${col};${row}M`)
  stdin.write(`\x1b[<0;${col};${row}m`)
}

// ── 1. 挂载自动触发：灰行出现，recapRecent 恰好一次 ─────────────────────
await settle(() => screenHas(term, 'AUTO_RECAP_SUMMARY'))
check('挂载后灰行显示自动总结', screenHas(term, 'AUTO_RECAP_SUMMARY'))
check('自动触发恰好一次 recapRecent', channel.recapCallCount === 1, String(channel.recapCallCount))
check('手动面板未打开（无建议标题）', !screenHas(term, '建议标题'))
check('回顾行带「回顾：」前缀', screenHas(term, '回顾：'))
{
  const line = findText(term, 'AUTO_RECAP_SUMMARY')
  // Divider 与回顾行之间隔了 marginTop 空行——向上找最近的非空行。
  const above = line === null ? undefined
    : viewportLines(term, ROWS).slice(0, line.row).reverse().find(text => text.trim() !== '')
  check('回顾行上方有分隔线', above !== undefined && above.includes('─'))
}

// ── 2. hover 灰行：提示与关闭 chip 出现 ─────────────────────────────────
const rowPos = findText(term, 'AUTO_RECAP_SUMMARY')
check('灰行在视口内', rowPos !== null)
if (rowPos !== null) hover(rowPos.col + 1, rowPos.row + 1)
await settle(() => screenHas(term, '点击展开查看/应用'))
check('hover 显示展开提示', screenHas(term, '点击展开查看/应用'))
check('hover 显示关闭 chip', screenHas(term, '×'))

// ── 3. 点击灰行：展开完整 RecapPanel ───────────────────────────────────
const expandPos = findText(term, 'AUTO_RECAP_SUMMARY')
if (expandPos !== null) clickCell(expandPos.col + 1, expandPos.row + 1)
await settle(() => screenHas(term, '建议标题'))
check('点击展开完整面板', screenHas(term, 'AUTO_RECAP_TITLE') && screenHas(term, '应用'))
check('展开面板带标题栏', screenHas(term, '会话回顾'))

// ── 4. a 键应用建议标题（走 renameSession）────────────────────────────
stdin.write('a')
await settle(() => channel.renameCalls.length === 1)
check('按 a 应用标题走 renameSession', channel.renameCalls[0] === 'AUTO_RECAP_TITLE', JSON.stringify(channel.renameCalls))
check('会话标题已更新', channel.sessionTitle === 'AUTO_RECAP_TITLE', channel.sessionTitle)

// ── 5. Esc 收起：回到灰行 ──────────────────────────────────────────────
stdin.write('\x1b')
await settle(() => !screenHas(term, '建议标题'))
check('Esc 收起回灰行', screenHas(term, 'AUTO_RECAP_SUMMARY'))

// ── 6. 点击 × 关闭：灰行消失直到下次会话切换 ───────────────────────────
// Esc 收起后 AutoRecapRow 重新挂载、hover 态复位；鼠标还停在原地，
// stale-hover 抑制会吞掉新节点的 onMouseEnter——先移开再移回。
const recapPos = findText(term, 'AUTO_RECAP_SUMMARY')
if (recapPos !== null) {
  hover(1, 1)
  await new Promise(resolve => setTimeout(resolve, 100))
  hover(recapPos.col + 1, recapPos.row + 1)
}
await settle(() => findText(term, '×') !== null)
const dismissPos = findText(term, '×')
check('hover 后关闭 chip 出现', dismissPos !== null)
if (dismissPos !== null) {
  // findText 返回 JS 字符串索引；行内含 CJK（hint 文案）时显示列 ≠ JS
  // 列，必须换算成显示宽度再注入点击——否则坐标偏左，落在外层整行
  // Box 上，触发的是展开而非关闭。
  const line = viewportLines(term, ROWS)[dismissPos.row]!
  const displayCol = stringWidth(line.slice(0, dismissPos.col))
  clickCell(displayCol + 1, dismissPos.row + 1)
}
await settle(() => !screenHas(term, 'AUTO_RECAP_SUMMARY'))
check('点击 × 后灰行消失', !screenHas(term, 'AUTO_RECAP_SUMMARY'))

// ── 7. 会话切换重新触发 ────────────────────────────────────────────────
channel.agentId = 'probe-2'
channel.emit()
await settle(() => channel.recapCallCount === 2)
await settle(() => screenHas(term, 'AUTO_RECAP_SUMMARY'))
check('切换会话重新触发', channel.recapCallCount === 2, String(channel.recapCallCount))
check('切换后灰行重新出现', screenHas(term, 'AUTO_RECAP_SUMMARY'))

// ── 7b. 长摘要完整换行显示（不截断）────────────────────────────────────
const LONG_SUMMARY = '这是一段很长的自动总结，用来验证回顾行不会被一行截断，而是完整换行显示全部内容，让用户一打开会话就能看到这次会话到底在忙什么，包括正在进行的和已经完成的部分。' + '  LONG_SUMMARY_TAIL'
channel.recapResult = { summary: LONG_SUMMARY, title: 'AUTO_RECAP_TITLE' }
channel.agentId = 'probe-2b'
channel.emit()
await settle(() => channel.recapCallCount === 3)
await settle(() => screenHas(term, 'LONG_SUMMARY_TAIL'))
check('长摘要完整显示（换行不截断）', screenHas(term, 'LONG_SUMMARY_TAIL'))
check('回顾行仍带前缀', screenHas(term, '回顾：'))

// ── 8. 失败静默：无活动不显示任何行 ────────────────────────────────────
channel.recapResult = { summary: null, error: 'no activity' }
channel.agentId = 'probe-3'
channel.emit()
await settle(() => channel.recapCallCount === 4)
await settle(() => !screenHas(term, 'AUTO_RECAP_SUMMARY'))
check('失败静默（不显示灰行）', !screenHas(term, 'AUTO_RECAP_SUMMARY'))

// ── 9. 设置关闭后不再触发 ──────────────────────────────────────────────
channel.recapResult = { summary: 'AUTO_RECAP_SUMMARY', title: 'AUTO_RECAP_TITLE' }
channel.autoRecapOnOpen = false
channel.agentId = 'probe-4'
channel.emit()
await settle(() => screenHas(term, '我的会话'))
await new Promise(resolve => setTimeout(resolve, 200))
check('设置关闭后不再触发', channel.recapCallCount === 4, String(channel.recapCallCount))
check('设置关闭后无灰行', !screenHas(term, 'AUTO_RECAP_SUMMARY'))

// ── 10. 发送新消息：自动摘要退场，且不重新触发 ─────────────────────────
channel.autoRecapOnOpen = true
channel.agentId = 'probe-5'
channel.emit()
await settle(() => channel.recapCallCount === 5)
// 直接 settle 到摘要落屏，不能 settle 到「回顾：」就立即断言摘要：灰行在
// recap 在途时先画占位行「回顾：正在总结最近活动…」（同样含此前缀），摘要
// 经 promise.then 另行落屏——两帧之间该断言是竞态（channel 订阅唤醒从
// uSES 同步渲染改为 DefaultLane 排期后，占位帧在 CI 上真实出现）。
check('重新开启后切会话恢复灰行', await settled(() => screenHas(term, 'AUTO_RECAP_SUMMARY')))
stdin.write('继续')
await settle(() => screenHas(term, '继续'))
stdin.write('\r')
await settle(() => !screenHas(term, '回顾：'))
check('发送新消息后自动摘要消失', !screenHas(term, 'AUTO_RECAP_SUMMARY'))
await new Promise(resolve => setTimeout(resolve, 200))
check('发送消息不触发新的总结', channel.recapCallCount === 5, String(channel.recapCallCount))

// ── 11. 空会话（/new 无对话行）：不触发、旧摘要被清 ────────────────────
channel.rows = []
channel.agentId = 'probe-6'
channel.emit()
await new Promise(resolve => setTimeout(resolve, 250))
check('空会话不触发总结', channel.recapCallCount === 5, String(channel.recapCallCount))
check('空会话无回顾行', !screenHas(term, '回顾：'))

await instance.unmount()
setLang('zh')
process.exit(failures === 0 ? 0 : 1)
