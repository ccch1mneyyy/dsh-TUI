/**
 * Read-only /agents session-view regression (issue #223).
 *
 * Drives the real Chat screen through headless xterm and checks the complete
 * list -> transcript -> list -> conversation round trip. The projection
 * checks pin the durable event shapes that the scene renders.
 *
 * Run: node --import tsx/esm scripts/verify-subagent-session-view.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal }, { render }, { Chat }, { SubagentScene }, { QuestionStore }, { setLang }, transcript, instancesModule] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/screens/Chat.js'),
    import('../src/screens/SubagentScene.js'),
    import('../src/dsh-adapter/questions.js'),
    import('../src/i18n.js'),
    import('../src/dsh-adapter/transcript.js'),
    import('../src/ink/instances.js'),
  ])
const instances = instancesModule.default

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const events = [
  { type: 'user/message', seq: 1, time: 100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Review the test suite' }] } },
  { type: 'assistant/message', seq: 2, time: 200, data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: 'Inspect the failing paths' }, { type: 'text', text: 'I found a missing regression.' }] } } },
  { type: 'tool/call', seq: 3, time: 300, data: { turn: 1, step: 1, callId: 'call-1', name: 'read_file', arguments: '{"path":"src/login.ts"}' } },
  { type: 'tool/result', seq: 4, time: 450, data: { turn: 1, step: 1, message: { source: { callId: 'call-1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'login source' }] }] } } },
  { type: 'assistant/chunk', seq: 5, time: 500, data: { turn: 2, step: 1, chunk: { type: 'text-delta', text: 'Still checking' } } },
] as never

const projected = transcript.projectReadOnlyTranscript(events)
check('projection keeps the user message', projected.some(row => row.kind === 'user' && row.text === 'Review the test suite'))
check('projection keeps settled reasoning', projected.some(row => row.kind === 'reasoning' && row.text === 'Inspect the failing paths'))
check('projection keeps the assistant reply', projected.some(row => row.kind === 'assistant' && row.text === 'I found a missing regression.'))
check('projection settles tool results', projected.some(row => row.kind === 'tool' && row.tool?.status === 'ok' && row.tool.resultFull === 'login source'))
check('projection keeps an in-flight assistant chunk', projected.some(row => row.kind === 'assistant' && row.streaming && row.text === 'Still checking'))

const columns = 100
const rows = 28
const term = new Terminal({ cols: columns, rows, scrollback: 200, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = columns
  rows = rows
  isTTY = true
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    term.write(String(chunk), callback)
  }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

const listeners = new Set<() => void>()
const calls: string[] = []
let runningReads = 0
let catalogMode: 'populated' | 'empty' | 'unavailable' = 'populated'
const channel: Record<string, unknown> = {
  version: 0,
  rows: [
    { id: 0, kind: 'user', text: 'parent conversation' },
    { id: 1, kind: 'assistant', text: 'delegating now' },
  ],
  status: 'idle', sessionTitle: 'parent', agentId: 'parent-session', model: 'deepseek-chat', provider: 'deepseek',
  tokens: { input: 1200, output: 260 }, cwd: 'D:/Code/dsh-TUI', displayCwd: 'D:/Code/dsh-TUI', gitBranch: 'main',
  working: false, spinnerMode: 'idle', responseChars: 0, activeToolCount: 0, turnStart: 0,
  lastUserText: 'parent conversation', pending: [], notifications: [], contextWindow: 128000,
  contextSegments: { system: 300, prompt: 500, assistant: 200, thinking: 100, tools: 100 },
  lastUsage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 }, reasoningEffort: 'high',
  workingActivity: undefined, activityEnabled: false, contextBarEnabled: true, agentPreset: 'standard',
  goal: undefined, todos: [], commandList: [{ name: 'agents', description: '查看本会话的子代理' }],
  commandCompletions: () => [], mode: { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' }, modeIndex: 0,
  subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
  async listSubagents() {
    if (catalogMode === 'unavailable') return undefined
    if (catalogMode === 'empty') return []
    return [
      { kind: 'child', id: 'child-running', mode: 'continuable', label: 'auth-race-audit', activity: 'running', hasChildren: true },
      { kind: 'child', id: 'child-done', mode: 'one-shot', label: 'test-review', activity: 'inactive', hasChildren: false },
      { kind: 'diagnostic', id: 'child-corrupt', reason: 'corrupt' },
    ]
  },
  async readSubagentSession(id: string) {
    calls.push(id)
    if (id === 'child-running') {
      runningReads += 1
      return { id, rows: runningReads === 1 ? [] : transcript.projectReadOnlyTranscript(events) }
    }
    if (id === 'child-done') return { id, rows: transcript.projectReadOnlyTranscript(events) }
    return undefined
  },
  pushLocal() {}, submit() {}, steer() {}, removePending: () => true, cancel() {}, interruptAndDeliver: () => 0,
  clear() {}, loadOlder: () => 0, notify() {}, listModels: async () => [], listFiles: async () => [],
  listSessions: async () => [], previewSession: async () => [], setResumeTarget() {},
  setActivityFrames: () => true, activityFrames: 'claude', runExternalCommand: async () => '',
  mcpStatus: () => [], exportSession: () => null, initWorkspace: () => null, doctorInfo: () => [],
  listPresets: async () => [], switchPreset: async () => false, switchModel: async () => false,
  rewindTo: async () => null, resumeTo: async () => false, newSession: async () => false,
  compact() {}, traceEvents: () => [],
}

const stdout = new FakeStdout()
const stdin = new FakeStdin()
const screen = (): string => {
  const buffer = term.buffer.active
  return Array.from({ length: rows }, (_, y) =>
    (buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '').replace(/\s+$/u, ''),
  ).join('\n')
}

const instance = await render(
  React.createElement(Chat, {
    channel: channel as never,
    questionStore: new QuestionStore(),
    onExit() {},
    fullscreen: false,
  }),
  { stdout: stdout as never, stderr: stdout as never, stdin: stdin as never, exitOnCtrlC: false, patchConsole: false },
)
for (const value of instances.values()) instances.set(process.stdout, value)
await sleep(250)
stdin.write('/agents')
await sleep(100)
stdin.write('\r')
await sleep(500)

let current = screen()
check('/agents opens a full-screen list', current.includes('子代理') && !current.includes('parent conversation'))
check('list renders continuable/running/nested metadata', current.includes('auth-race-audit') && current.includes('运行中') && current.includes('子代理'))
check('list renders one-shot/inactive metadata', current.includes('test-review') && current.includes('一次性') && current.includes('已归档'))
check('list contains a non-selectable diagnostic row', current.includes('child-corrup') && current.includes('损坏'))
check('focus starts on the first child', /❯\s+auth-race-audit/u.test(current), current.split('\n').find(line => line.includes('auth-race-audit')))

stdin.write('\x1b[B')
await sleep(200)
stdin.write('\r')
await sleep(500)
current = screen()
check('Enter opens the selected child transcript', calls.at(-1) === 'child-done')
check('detail renders the child messages', current.includes('Review the test suite') && current.includes('I found a missing regression.'))
check('detail is explicitly read-only', current.includes('只读'))
check('parent transcript stays off-screen', !current.includes('parent conversation'))

if (process.env.CAPTURE_ISSUE_223 === '1') {
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync('artifacts/issue-223', { recursive: true })
  writeFileSync('artifacts/issue-223/after.txt', current, 'utf8')
  const escaped = current.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
  writeFileSync('artifacts/issue-223/after.html', `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#111318;color:#e5e7eb}body{padding:28px}pre{font:16px/1.35 "Cascadia Mono","Consolas",monospace;white-space:pre;margin:0}</style><pre>${escaped}</pre>`, 'utf8')
}

stdin.write('\x1b')
await sleep(350)
current = screen()
check('first Esc returns to the child list', current.includes('auth-race-audit') && current.includes('test-review'))
stdin.write('\x1b[A')
await sleep(150)
stdin.write('\r')
await sleep(400)
current = screen()
check('an empty running child opens an explicit empty transcript', calls.at(-1) === 'child-running' && current.includes('还没有可显示'))
await sleep(900)
current = screen()
check('a running child transcript refreshes while open', runningReads >= 2 && current.includes('I found a missing regression.'))
stdin.write('\x1b')
await sleep(250)
stdin.write('\x1b[A')
await sleep(180)
current = screen()
check('navigation skips diagnostic rows', /❯\s+test-review/u.test(current))
stdin.write('\x1b')
await sleep(450)
current = screen()
check('second Esc restores the parent conversation', current.includes('parent conversation') && !current.includes('auth-race-audit'))

catalogMode = 'empty'
stdin.write('/agents')
await sleep(100)
stdin.write('\r')
await sleep(400)
current = screen()
check('an empty catalog has a stable empty state', current.includes('当前会话暂无子代理'))
stdin.write('\x1b')
await sleep(300)

catalogMode = 'unavailable'
stdin.write('/agents')
await sleep(100)
stdin.write('\r')
await sleep(400)
current = screen()
check('a missing subagent service is distinguished from an empty catalog', current.includes('子代理服务未挂载'))
stdin.write('\x1b')
await sleep(300)

instance.unmount()
instances.delete(process.stdout)
term.dispose()

async function verifyLayout(cols: number, height: number, lang: 'zh' | 'en'): Promise<void> {
  setLang(lang)
  const layoutTerm = new Terminal({ cols, rows: height, scrollback: 20, allowProposedApi: true })
  class LayoutStdout extends Writable {
    columns = cols
    rows = height
    isTTY = true
    writes: string[] = []
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      const text = String(chunk)
      this.writes.push(text)
      layoutTerm.write(text, callback)
    }
  }
  class LayoutStdin extends PassThrough {
    isTTY = true
    setRawMode(): this { return this }
    ref(): this { return this }
    unref(): this { return this }
  }
  catalogMode = 'populated'
  const layoutStdout = new LayoutStdout()
  const layoutStdin = new LayoutStdin()
  const layoutInstance = await render(
    React.createElement(SubagentScene, { channel: channel as never, onClose() {} }),
    { stdout: layoutStdout as never, stderr: layoutStdout as never, stdin: layoutStdin as never, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(350)
  const listBuffer = layoutTerm.buffer.active
  const listScreen = Array.from({ length: height }, (_, y) =>
    listBuffer.getLine(y)?.translateToString(true) ?? '',
  ).join('\n')
  // A bare Ink root parks one trailing newline in the normal buffer. One
  // scroll row is therefore expected here; anything beyond it is layout
  // overflow (the product wraps this scene in the alternate screen).
  check(`${lang} ${cols}x${height} list stays inside the viewport`, listBuffer.baseY <= 1)
  check(`${lang} ${cols}x${height} list keeps its title and final hint`, listScreen.includes(lang === 'zh' ? '子代理' : 'Subagents') && listScreen.trimEnd().endsWith(lang === 'zh' ? 'Esc 返回' : 'Esc back'))

  layoutStdout.writes.length = 0
  layoutStdin.write('\r')
  await sleep(400)
  const detailBuffer = layoutTerm.buffer.active
  const detailScreen = Array.from({ length: height }, (_, y) =>
    detailBuffer.getLine(y)?.translateToString(true) ?? '',
  ).join('\n')
  check(`${lang} ${cols}x${height} detail stays inside the viewport`, detailBuffer.baseY <= 1, `baseY=${detailBuffer.baseY}`)
  check(`${lang} ${cols}x${height} detail paints read-only metadata`, layoutStdout.writes.join('').includes(lang === 'zh' ? '只读' : 'read-only'), JSON.stringify(detailScreen))
  layoutInstance.unmount()
  layoutTerm.dispose()
}

await verifyLayout(60, 14, 'zh')
await verifyLayout(40, 8, 'en')

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall subagent-session-view checks passed')
