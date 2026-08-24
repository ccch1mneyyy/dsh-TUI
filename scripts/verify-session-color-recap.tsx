/**
 * Session identity regression (issue #372): the `/color` session accent,
 * the session-name label on the prompt border, and the `/recap` panel.
 *
 * Drives the real Chat command path in xterm (same harness as
 * verify-thinking-display): `/color <name>` must call channel.setSessionColor
 * and repaint the prompt border in that color (cell-level fg assertion),
 * the session title must render as a chip on the top border, `/color reset`
 * must clear it, and `/recap` must surface the model summary + proposed
 * title with a one-key apply through renameSession.
 *
 * Every command step settles on the SCREEN showing the command's visible
 * effect (notification / local row / panel) — not on the synchronous mock
 * call — because React's commit lags the state change: typing the next
 * command before the previous render settles can drop keystrokes into a
 * stale input callback.
 *
 * Run: node --import tsx/esm scripts/verify-session-color-recap.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render },
  { Chat },
  { setLang },
  { settle, viewportLines },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/i18n.js'),
  import('./lib/term-test.mjs'),
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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function screenText(): string {
  return viewportLines(term, ROWS).join('\n')
}

let failures = 0
function check(name: string, condition: boolean, detail = ''): void {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${name}${detail === '' ? '' : `  (${detail})`}`)
  if (!condition) failures += 1
}

/** The prompt top-border row: the line containing the `╭` corner. */
function borderRow(): { y: number; text: string } | undefined {
  const lines = viewportLines(term, ROWS)
  const y = lines.findIndex(line => line.includes('╭'))
  return y === -1 ? undefined : { y, text: lines[y]! }
}

/** Foreground color (0xRRGGBB) of the first `─` run on the prompt border. */
function borderFgColor(): number | undefined {
  const row = borderRow()
  if (row === undefined) return undefined
  const line = term.buffer.active.getLine(row.y)
  if (line === undefined) return undefined
  for (let col = 0; col < COLS; col++) {
    const cell = line.getCell(col)
    if (cell === undefined) continue
    const ch = cell.getChars()
    if (ch === '─' || ch === '╭' || ch === '╮') {
      const fg = cell.getFgColor()
      if (fg !== 0xffffff) return fg
    }
  }
  return undefined
}

function makeChannel() {
  const listeners = new Set<() => void>()
  const setColorCalls: string[] = []
  const renameCalls: string[] = []
  const localReports: Array<{ title: string; lines: string[] }> = []
  const notifications: string[] = []
  const rows = [
    { id: 1, kind: 'user', text: '检查这个问题' },
    { id: 2, kind: 'assistant', text: '已经检查。', streaming: false },
  ]
  const channel: any = {
    version: 0,
    rows,
    status: 'idle',
    sessionTitle: '我的会话',
    sessionColor: '',
    agentId: 'session-identity-repro',
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
    commandList: [
      { name: 'color', description: 'Set the current session accent color' },
      { name: 'recap', description: 'Generate a recap of recent session activity' },
    ],
    commandCompletions(input: string) {
      const prefix = input.replace(/^\//u, '').trim().toLowerCase()
      return this.commandList
        .filter((command: { name: string }) => command.name.startsWith(prefix))
        .map((command: { name: string; description: string }) => ({
          ...command,
          commandLine: `/${command.name}`,
          replacement: `/${command.name} `,
        }))
    },
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    mode: { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
    modeIndex: 0,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    notify(text: string) { notifications.push(text) },
    pushLocal(title: string, lines: string[]) { localReports.push({ title, lines }) },
    setSessionColor(color: string) {
      setColorCalls.push(color)
      channel.sessionColor = color
      channel.emit()
    },
    renameSession(title: string) {
      renameCalls.push(title)
      channel.sessionTitle = title
      channel.emit()
    },
    recapRecent: async () => ({ summary: '最近在修会话颜色与 recap', title: '会话标识 PR' }),
    emit() {
      channel.version += 1
      for (const listener of listeners) listener()
    },
    submit() {},
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
    setColorCalls,
    renameCalls,
    localReports,
    notifications,
  }
  return channel
}

setLang('zh')
const stdin = new FakeStdin()
const channel = makeChannel()
const questionStore = { subscribe: () => () => {}, getSnapshot: () => null, answerCurrent: () => {} }
const approvalStore = { subscribe: () => () => {}, getSnapshot: () => null }
const instance = await render(
  <Chat
    fullscreen
    channel={channel}
    questionStore={questionStore as any}
    approvalStore={approvalStore as any}
  />,
  {
    stdout: new FakeStdout(),
    stderr: new FakeStderr(),
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  },
)
await settle(() => screenText().includes('我的会话'))

// ── 1. session 名标签显示在输入框顶边框上 ──────────────────────────────
let row = borderRow()
check('输入框顶边框存在', row !== undefined)
check('顶边框左侧渲染会话名标签', row !== undefined && row.text.includes('╭ 我的会话 '), row?.text ?? '')
const defaultFg = borderFgColor()
check('未设置颜色时边框为主题 promptBorder 灰蓝', defaultFg === 0x55606f, `0x${defaultFg?.toString(16) ?? '?'}`)

// ── 2. /color <name> 设置会话强调色并重绘边框 ──────────────────────────
stdin.write('/color red')
await settle(() => screenText().includes('/color red'))
stdin.write('\r')
// 渲染完成信号 = 通知上屏（React commit 后才可见）。
await settle(() => screenText().includes('会话颜色已设为 red'))
check('/color red 调用 setSessionColor', channel.setColorCalls.length === 1, JSON.stringify(channel.setColorCalls))
check('setSessionColor 收到 red', channel.setColorCalls[0] === 'red', String(channel.setColorCalls[0]))
check('会话状态记录颜色 red', channel.sessionColor === 'red', channel.sessionColor)
check('通知说明已设置', channel.notifications.includes('会话颜色已设为 red'), JSON.stringify(channel.notifications))
await settle(() => borderFgColor() === 0xe5484d)
const redFg = borderFgColor()
check('边框重绘为会话红 #E5484D', redFg === 0xe5484d, `0x${redFg?.toString(16) ?? '?'}`)

// ── 3. /color status 与未知色名 ────────────────────────────────────────
stdin.write('/color status')
await settle(() => screenText().includes('/color status'))
stdin.write('\r')
await settle(() => screenText().includes('当前会话颜色'))
const statusReport = channel.localReports.find(r => r.title === '/color')
check('/color status 报告当前颜色', statusReport !== undefined && statusReport.lines[0]?.includes('red'), JSON.stringify(channel.localReports))

stdin.write('/color hotpink')
await settle(() => screenText().includes('/color hotpink'))
stdin.write('\r')
await settle(() => screenText().includes('未知颜色'))
check('未知色名报错且不写状态', channel.notifications.some(n => n.includes('未知颜色')) && channel.sessionColor === 'red')

// ── 4. /color reset 清除 ───────────────────────────────────────────────
stdin.write('/color reset')
await settle(() => screenText().includes('/color reset'))
stdin.write('\r')
await settle(() => screenText().includes('已清除会话颜色'))
check('/color reset 调用 setSessionColor(\'\')', channel.setColorCalls.length === 2 && channel.setColorCalls[1] === '', JSON.stringify(channel.setColorCalls))
check('会话颜色清空', channel.sessionColor === '', channel.sessionColor)
await settle(() => borderFgColor() === 0x55606f)
const resetFg = borderFgColor()
check('边框恢复主题色', resetFg === 0x55606f, `0x${resetFg?.toString(16) ?? '?'}`)

// ── 5. /recap 面板：摘要 + 建议标题 + 一键应用 ─────────────────────────
stdin.write('/recap')
await settle(() => screenText().includes('/recap'))
stdin.write('\r')
await settle(() => screenText().includes('最近在修会话颜色与 recap'))
let screen = screenText()
check('recap 摘要渲染', screen.includes('最近在修会话颜色与 recap'))
check('建议标题渲染', screen.includes('建议标题') && screen.includes('会话标识 PR'))
check('应用按钮渲染', screen.includes('应用'))

stdin.write('a')
await settle(() => channel.renameCalls.length === 1)
check('按 a 应用标题走 renameSession', channel.renameCalls[0] === '会话标识 PR', JSON.stringify(channel.renameCalls))
check('会话标题已更新', channel.sessionTitle === '会话标识 PR', channel.sessionTitle)
await settle(() => screenText().includes('已应用'))
check('面板标记已应用', screenText().includes('已应用'))

stdin.write('\x1b')
await settle(() => !screenText().includes('建议标题'))
check('Esc 关闭 recap 面板', !screenText().includes('建议标题'))

await instance.unmount()
setLang('zh')
process.exit(failures === 0 ? 0 : 1)
