/**
 * `/thinking` display-semantics regression (issue #317).
 *
 * Drives the real Chat command path in xterm so the test observes the same
 * dialog, confirmation flow and transcript visibility as a user.
 *
 * Run: node --import tsx/esm scripts/verify-thinking-display.tsx
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
  { settle, settled, sleep, viewportLines },
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

function screenText(): string {
  return viewportLines(term, ROWS).join('\n')
}

let failures = 0
function check(name: string, condition: boolean, detail = ''): void {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${name}${detail === '' ? '' : `  (${detail})`}`)
  if (!condition) failures += 1
}

function makeChannel() {
  const listeners = new Set<() => void>()
  const setEffortCalls: string[] = []
  const notifications: string[] = []
  const rows = [
    { id: 1, kind: 'user', text: '检查这个问题' },
    { id: 2, kind: 'reasoning', text: 'SECRET_REASONING_TRACE', streaming: true, durationMs: 1200 },
    { id: 3, kind: 'assistant', text: '已经检查。', streaming: false },
  ]
  const channel: any = {
    version: 0,
    rows,
    status: 'idle',
    sessionTitle: 'thinking-display-repro',
    agentId: 'thinking-display-repro',
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
    commandList: [{ name: 'thinking', description: 'Toggle thinking display' }],
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
    async setEffort(id: string) {
      setEffortCalls.push(id)
      channel.reasoningEffort = id
      return true
    },
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
    setEffortCalls,
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
check('切换前流式思考行可见', await settled(() => screenText().includes('SECRET_REASONING_TRACE')))

stdin.write('/thinking')
await settle(() => screenText().includes('/thinking'))
stdin.write('\r')

check('对话框明确这是思考过程显示设置', await settled(() => screenText().includes('思考过程显示')))
check('对话框明确不改变模型思考行为', await settled(() => screenText().includes('不改变模型的思考行为')))
check('隐藏项说明模型仍会照常思考', await settled(() => screenText().includes('模型仍会照常思考')))

stdin.write('\x1b[B')
// 排序 sleep 保留：选中项移动只改高亮色，不改可见文本，屏上无可 settle 的内容。
await sleep(120)
stdin.write('\r')
// 对话框盖住转录区时「思考行不可见」早已成立，settle 屏幕条件会提前返回；
// 通知只在确认处理后才写入，才是确认已生效的信号——先断言它作为门，
// 其余断言在门后读已落定状态。
check('通知准确说明思考过程已隐藏', await settled(() => channel.notifications.includes('思考过程：隐藏')), JSON.stringify(channel.notifications))
check('隐藏立即生效，不出现质量警告', !screenText().includes('可能降低质量'))
check('隐藏后思考行不可见', await settled(() => !screenText().includes('SECRET_REASONING_TRACE')))
check('隐藏后模型 effort 保持不变', channel.reasoningEffort === 'max', channel.reasoningEffort)
check('隐藏不调用 setEffort', channel.setEffortCalls.length === 0, JSON.stringify(channel.setEffortCalls))

setLang('en')
stdin.write('/thinking')
await settle(() => screenText().includes('/thinking'))
stdin.write('\r')

check('English dialog describes thinking display', await settled(() => screenText().includes('Thinking display')))
check('English dialog says model behavior is unchanged', await settled(() => screenText().includes('does not change model behavior')))
check('English shown option describes conversation visibility', await settled(() => screenText().includes("Show DeepSeek's reasoning")))

stdin.write('\x1b[A')
// 排序 sleep 保留：选中项移动只改高亮色，不改可见文本，屏上无可 settle 的内容。
await sleep(120)
stdin.write('\r')

check('showing reasoning again takes effect immediately', await settled(() => screenText().includes('SECRET_REASONING_TRACE')))
check('showing reasoning keeps model effort unchanged', channel.reasoningEffort === 'max', channel.reasoningEffort)
check('showing reasoning does not call setEffort', channel.setEffortCalls.length === 0, JSON.stringify(channel.setEffortCalls))
check('English notification says reasoning is shown', await settled(() => channel.notifications.includes('Thinking display: shown')), JSON.stringify(channel.notifications))

await instance.unmount()
setLang('zh')
process.exit(failures === 0 ? 0 : 1)
