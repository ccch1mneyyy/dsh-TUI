/**
 * `/copy` 回归：真实 Chat（xterm headless）+ 桩 channel —
 *  1. `/copy` 把最近一条非空 assistant 回复（Markdown 原文，trim 后）
 *     以 OSC 52 发出，并 notify 已复制的字符数；不向 session 提交；
 *  2. 较早的 assistant 与空白 assistant 行不被选作目标；
 *  3. 没有可复制回复时只 warning，不发 OSC 52；
 *  4. `/copy` 在 LOCAL_COMMANDS 中注册（命令菜单与补全的真源）。
 * Run: node --import tsx/esm scripts/verify-copy-command.tsx
 */
import './lib/fake-home.mjs'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, AlternateScreen },
  { Chat },
  { setLang, t },
  { settle, settled, screenHas, viewportLines },
  { LOCAL_COMMANDS },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/i18n.js'),
  import('./lib/term-test.mjs'),
  import('../src/commands.js'),
])

let failures = 0
function check(name: string, condition: boolean, detail = ''): void {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${name}${detail === '' ? '' : `  (${detail})`}`)
  if (!condition) failures += 1
}

const COLS = 100
const ROWS = 30

function makeChannel(transcriptRows: unknown[]) {
  const listeners = new Set<() => void>()
  const notifications: { id: number; text: string; color?: string; timeoutMs: number }[] = []
  const submits: string[] = []
  let noteId = 0
  const channel: any = {
    version: 0,
    rows: transcriptRows,
    status: 'idle',
    sessionTitle: 'copy probe',
    sessionColor: '',
    autoRecapOnOpen: false,
    agentId: 'probe',
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
    notifications,
    contextWindow: undefined,
    reasoningEffort: 'max',
    activityEnabled: false,
    contextBarEnabled: true,
    agentPreset: 'standard',
    goal: undefined,
    todos: [],
    commandList: [{ name: 'copy', description: 'Copy the latest agent response to the clipboard' }],
    commandCompletions() { return [] },
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    mode: { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
    modeIndex: 0,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    notify(text: string, options?: { color?: string; timeoutMs?: number }) {
      notifications.push({ id: noteId++, text, color: options?.color, timeoutMs: options?.timeoutMs ?? 4000 })
      return () => {}
    },
    pushLocal() {},
    renameSession() {},
    emit() {
      channel.version += 1
      for (const listener of listeners) listener()
    },
    submit(text: string) { submits.push(text) },
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
    activityFrames: 'moon8',
    runExternalCommand: async () => '',
    mcpStatus: () => [],
    exportSession: () => null,
    initWorkspace: () => null,
    doctorInfo: () => [],
    pluginsInfo: () => Promise.resolve([]),
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
  }
  return { channel, notifications, submits }
}

async function makeApp(transcriptRows: unknown[]) {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const rawWrites: string[] = []
  class FakeStdout extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
      rawWrites.push(String(chunk))
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
  const stdin = new FakeStdin()
  const { channel, notifications, submits } = makeChannel(transcriptRows)
  const questionStore = { subscribe: () => () => {}, getSnapshot: () => null, answerCurrent: () => {} }
  const approvalStore = { subscribe: () => () => {}, getSnapshot: () => null }
  const app = await render(
    React.createElement(AlternateScreen, null, React.createElement(Chat, {
      fullscreen: true,
      channel,
      questionStore: questionStore as never,
      approvalStore: approvalStore as never,
      onExit: () => undefined,
    })),
    { stdout: new FakeStdout() as never, stderr: new FakeStderr() as never, stdin: stdin as never, exitOnCtrlC: false, patchConsole: false },
  )
  const typeCommand = async (text: string) => {
    // 同 verify-balance：先等文本上屏再回车，避免 prompt 就绪前丢回车。
    stdin.write(text)
    await settle(() => viewportLines(term, ROWS).join('\n').includes(text))
    stdin.write('\r')
  }
  return { term, app, notifications, submits, rawWrites, typeCommand }
}

setLang('zh')

check('/copy 在 LOCAL_COMMANDS 中注册', LOCAL_COMMANDS.some(command => command.name === 'copy'))

// ── 有回复：复制最近一条非空 assistant ─────────────────────────────
{
  const latest = '**final answer**\n\n```ts\nconst x = 1\n```'
  const { app, notifications, submits, rawWrites, typeCommand } = await makeApp([
    { id: 1, kind: 'assistant', text: 'earlier answer', streaming: false },
    { id: 2, kind: 'user', text: 'next question' },
    { id: 3, kind: 'assistant', text: latest, streaming: false },
    { id: 4, kind: 'assistant', text: '   ', streaming: false },
  ])
  await typeCommand('/copy')
  const payload = `\x1b]52;c;${Buffer.from(latest.trim(), 'utf8').toString('base64')}`
  check('/copy 发出最近一条回复的 OSC 52', await settled(() => rawWrites.join('').includes(payload)), rawWrites.join('').slice(-200))
  check('/copy notify 已复制字符数', notifications.some(item => item.text === t('copied-chars', { n: latest.trim().length })), JSON.stringify(notifications))
  check('/copy 不向 session 提交', submits.length === 0, JSON.stringify(submits))
  app.unmount()
}

// ── 无回复：只 warning，不发 OSC 52 ─────────────────────────────────
{
  const { app, notifications, rawWrites, typeCommand } = await makeApp([
    { id: 1, kind: 'user', text: 'hello' },
  ])
  await typeCommand('/copy')
  check('无回复时 notify 提示', await settled(() => notifications.some(item => item.text === t('copy-no-response') && item.color === 'warning')), JSON.stringify(notifications))
  check('无回复时不发 OSC 52', !rawWrites.join('').includes('\x1b]52;c;'))
  app.unmount()
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nAll copy command checks passed')
