/**
 * Focused regression for the agent view (CC `claude agents`):
 *
 *  1. Pure derivation helpers over synthetic session events — the fold
 *     (summary/title/turn-failure/updatedAt), live preview extraction, the
 *     state mapping, and the title fallback.
 *  2. Headless screen assembly: renders src/screens/AgentView.tsx into
 *     in-memory terminal streams with a fake channel and asserts the state
 *     groups, rows, dispatch input and hint appear; then drives keys through
 *     FakeStdin and asserts dispatch / help / close behavior.
 *
 * Run with:
 *   node --import tsx/esm scripts/verify-agent-view.mjs
 *
 * FORCE_COLOR must be set BEFORE any chalk import evaluates — ESM imports
 * are hoisted, so chalk-dependent modules load via dynamic import() below.
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { render }, { AgentView }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('../src/ui.js'),
  import('../src/screens/AgentView.js'),
])

const agentViewModule = await import('../src/dsh-adapter/agent-view.js')
const { foldAgentViewEvents, agentViewLivePreview, agentViewStatusOf, sessionTitleFallback, agentViewHasTurns } = agentViewModule

let failures = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    console.log(`ok   ${label}`)
  } else {
    failures += 1
    console.log(`FAIL ${label}${detail.length > 0 ? ` · ${detail}` : ''}`)
  }
}

// ── 1. Pure derivation helpers ─────────────────────────────────────────────
const event = (type, data, time) => ({ type, seq: 0, time, data })
const userMessage = (text, time) => event('user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } }, time)
const assistantMessage = (text, time) => event('assistant/message', { message: { content: [{ type: 'text', text }] } }, time)
const toolCall = (name, time) => event('tool/call', { name }, time)
const turnEnd = (kind, time) => event('turn/end', { reason: { kind } }, time)
const titleEvent = (title, time) => event('session/title', { title }, time)

const EMPTY_FOLD = { hasTurns: false, firstPrompt: '', summary: '', summaryKind: 'none', title: '', updatedAt: 0, lastTurnFailed: false }

{
  const events = [
    userMessage('fix the login page', 1000),
    toolCall('read', 2000),
    assistantMessage('The login page is fixed.', 3000),
    turnEnd('completed', 3100),
    titleEvent('Login fix', 3200),
  ]
  const fold = foldAgentViewEvents(events, 0, EMPTY_FOLD)
  check('fold: summary is the last assistant text', fold.summary === 'The login page is fixed.', fold.summary)
  check('fold: title from session/title', fold.title === 'Login fix', fold.title)
  check('fold: hasTurns true after a human prompt', fold.hasTurns === true)
  check('fold: updatedAt is the last event time', fold.updatedAt === 3200, String(fold.updatedAt))
  check('fold: completed turn is not failed', fold.lastTurnFailed === false)
  check('fold: incremental resume never rescans', foldAgentViewEvents(events, 3, EMPTY_FOLD).hasTurns === false)
}

{
  const events = [
    userMessage('deploy the thing', 1000),
    toolCall('bash', 2000),
    turnEnd('error', 2500),
  ]
  const fold = foldAgentViewEvents(events, 0, EMPTY_FOLD)
  check('fold: a tool call stands in while no assistant text', fold.summary === 'bash', fold.summary)
  check('fold: error turn marks failed', fold.lastTurnFailed === true)
  check('fold: failed beats completed in status', agentViewStatusOf('idle', fold, false) === 'failed')
}

{
  const messy = foldAgentViewEvents(
    [userMessage('第一行提示\n第二行', 1000), assistantMessage('第一段回复\n第二段\n\n第三段', 2000)],
    0,
    EMPTY_FOLD,
  )
  check('fold: prompt flattened to one line', messy.firstPrompt === '第一行提示 第二行', messy.firstPrompt)
  check('fold: multi-paragraph reply flattened to one line', messy.summary === '第一段回复 第二段 第三段', messy.summary)
  const name = sessionTitleFallback(messy, '/work/repo')
  check('name: fallback is a compact label', name === '第一行提示 第二行', name)
}

{
  check('status: parked approval wins over running', agentViewStatusOf('running', EMPTY_FOLD, true) === 'needs-input')
  check('status: running without approval is working', agentViewStatusOf('running', EMPTY_FOLD, false) === 'working')
  check('status: idle with turns is completed', agentViewStatusOf('idle', { ...EMPTY_FOLD, hasTurns: true }, false) === 'completed')
  check('status: idle without turns is idle', agentViewStatusOf('idle', EMPTY_FOLD, false) === 'idle')
}

{
  const events = [
    userMessage('first', 1000),
    assistantMessage('first answer', 2000),
    userMessage('second', 3000),
    assistantMessage('second answer', 4000),
  ]
  const preview = agentViewLivePreview(events, 3)
  check('preview: bounded to the limit', preview.length === 3, String(preview.length))
  check('preview: newest last, roles alternate', preview[0]?.text === 'first answer' && preview[2]?.text === 'second answer', JSON.stringify(preview))
  check('preview: empty for a bare log', agentViewLivePreview([], 3).length === 0)
  check('hasTurns: false without a user message', agentViewHasTurns([assistantMessage('x', 1)]) === false)
}

{
  const titled = sessionTitleFallback({ ...EMPTY_FOLD, firstPrompt: 'a prompt that is quite long and keeps going past forty eight characters for sure' }, '/work/repo')
  check('title fallback: prompt head, clipped to a compact name', titled.length <= 28 && titled.endsWith('…'), titled)
  check('title fallback: cwd basename when empty', sessionTitleFallback(EMPTY_FOLD, '/work/repo') === 'repo')
  check('title fallback: untitled when nothing', sessionTitleFallback(EMPTY_FOLD, undefined) === 'untitled')
}

// ── 2. Headless screen assembly + key driving ──────────────────────────────
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() {
    return this
  }
  ref() {
    return this
  }
  unref() {
    return this
  }
}
class FakeStdout extends Writable {
  frames = []
  _write(chunk, _encoding, callback) {
    this.frames.push(chunk.toString())
    callback()
  }
}
class FakeStderr extends Writable {
  _write(_chunk, _encoding, callback) {
    callback()
  }
}
const stripAnsi = frames => frames.join('').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\u001b[()][A-Z0-9]/g, '')

const rows = Object.freeze([
  { id: 'a1', title: 'Login fix', cwd: '/work/repo', summary: 'patching the auth flow', status: 'working', live: true, current: true, createdAt: 1000, updatedAt: 2000 },
  { id: 'b2', title: 'PR review', cwd: '/work/repo', summary: 'double jump or wall climb?', status: 'needs-input', live: true, current: false, createdAt: 500, updatedAt: 1500 },
  { id: 'c3', title: 'Old deploy', cwd: '/work/repo', summary: 'result: shipped', status: 'stopped', live: false, current: false, createdAt: 10, updatedAt: 900 },
  { id: 'd4', title: 'untitled', cwd: '/work/repo', summary: '', status: 'idle', live: true, current: false, createdAt: 100, updatedAt: 100 },
])

const dispatched = []
let closed = false
let attachedIds = []
const fakeChannel = {
  agentId: 'a1',
  cwd: '/work/repo',
  gitBranch: undefined,
  model: 'deepseek-v4-flash',
  notify: () => () => {},
  agentViewRows: () => rows,
  subscribeAgentView: () => () => {},
  async dispatchBackgroundAgent(prompt) {
    dispatched.push(prompt)
    return { ok: true, sessionId: 'new-1' }
  },
  async attachToAgent(sessionId) {
    attachedIds.push(sessionId)
    return { ok: true }
  },
  async stopBackgroundAgent() {
    return true
  },
  async deleteSession() {
    return true
  },
  async renameSessionTo() {
    return true
  },
  async peekAgentSession() {
    return []
  },
  async replyToAgent() {
    return true
  },
}

const stdin = new FakeStdin()
const stdout = new FakeStdout()
const instance = await render(
  React.createElement(AgentView, {
    channel: fakeChannel,
    home: '/Users/x',
    approval: null,
    onApprove: () => {},
    onClose: () => {
      closed = true
    },
  }),
  {
    stdout,
    stdin,
    stderr: new FakeStderr(),
    exitOnCtrlC: false,
    patchConsole: false,
  },
)
await new Promise(resolve => setTimeout(resolve, 500))

let text = stripAnsi(stdout.frames)
check('screen: state groups rendered', text.includes('等待输入') && text.includes('运行中') && text.includes('已停止'))
check('screen: rows rendered', text.includes('Login fix') && text.includes('PR review') && text.includes('Old deploy'))
check('screen: summaries rendered', text.includes('patching the auth flow'))
check('screen: current marker on the attached row', text.includes('当前'))
check('screen: header shows model · cwd', text.includes('deepseek-v4-flash') && text.includes('/work/repo'))
check('screen: header counts', text.includes('1 个等待输入') && text.includes('1 个运行中') && text.includes('0 个已完成'))
check('screen: empty row shows the CC hint', text.includes('输入提示词开始') && text.includes('未命名'))
check('screen: dispatch input placeholder', text.includes('输入任务并回车'))
check('screen: hint line', text.includes('Space') || text.includes('预览'))

// Working-row animation: the glyph in front of the working row cycles
// through CC's spinner family over time — the accumulated frames must show
// more than one distinct glyph in that exact cell.
await new Promise(resolve => setTimeout(resolve, 500))
const spinnerGlyphs = new Set()
for (const match of stripAnsi(stdout.frames).matchAll(/([·✢*✶✻✽]) Login fix/gu)) spinnerGlyphs.add(match[1])
check('screen: working row glyph animates', spinnerGlyphs.size >= 2, JSON.stringify([...spinnerGlyphs]))

// Per-keystroke rendering: every typed character must appear in the frames
// immediately (the SearchBox width regression clipped the query as it grew).
stdin.write('h')
await new Promise(resolve => setTimeout(resolve, 250))
check('screen: first keystroke renders', stripAnsi(stdout.frames).includes('❯ h'), JSON.stringify(stripAnsi(stdout.frames).slice(-400)))
stdin.write('i')
await new Promise(resolve => setTimeout(resolve, 250))
check('screen: second keystroke accumulates on screen', stripAnsi(stdout.frames).includes('❯ hi'), JSON.stringify(stripAnsi(stdout.frames).slice(-400)))
stdin.write('\u001b')
await new Promise(resolve => setTimeout(resolve, 250))

// Type a prompt and dispatch with Enter.
stdin.write('run the test suite')
await new Promise(resolve => setTimeout(resolve, 300))
stdin.write('\r')
await new Promise(resolve => setTimeout(resolve, 400))
check('screen: Enter with input dispatches', dispatched.length === 1 && dispatched[0] === 'run the test suite', JSON.stringify(dispatched))

// ? opens the help overlay.
stdin.write('?')
await new Promise(resolve => setTimeout(resolve, 300))
text = stripAnsi(stdout.frames)
check('screen: help overlay opens', text.includes('会话总览快捷键') || text.includes('Agent view shortcuts'))
// Esc closes the help, Esc again clears input, Esc again exits.
stdin.write('\u001b')
await new Promise(resolve => setTimeout(resolve, 200))
stdin.write('\u001b')
await new Promise(resolve => setTimeout(resolve, 200))
stdin.write('\u001b')
await new Promise(resolve => setTimeout(resolve, 200))
check('screen: Esc exits after help and input clear', closed === true)

await instance.unmount()

// ── 2b. ←-opened view: notice line + Esc returns to the backgrounded session ─
const returnStdin = new FakeStdin()
const returnStdout = new FakeStdout()
let returnClosed = false
attachedIds = []
const returnInstance = await render(
  React.createElement(AgentView, {
    channel: fakeChannel,
    home: '/Users/x',
    approval: null,
    onApprove: () => {},
    returnSessionId: 'b2',
    onClose: () => {
      returnClosed = true
    },
  }),
  {
    stdout: returnStdout,
    stdin: returnStdin,
    stderr: new FakeStderr(),
    exitOnCtrlC: false,
    patchConsole: false,
  },
)
await new Promise(resolve => setTimeout(resolve, 500))
text = stripAnsi(returnStdout.frames)
check('screen: background notice shown when opened via ←', text.includes('当前会话已转入后台') && text.includes('返回它'))
// Final Esc attaches back to the backgrounded session and closes.
returnStdin.write('\u001b')
await new Promise(resolve => setTimeout(resolve, 400))
check('screen: Esc returns to the backgrounded session', attachedIds.length === 1 && attachedIds[0] === 'b2' && returnClosed === true, JSON.stringify(attachedIds))
await returnInstance.unmount()

// ── 2c. Confirm-stop arm: the delete follows the STOPPED session, never
//       the focused row, only a second Ctrl+X fires, and it expires ─────────
// Regression for the arm bug that deleted a user's main session: the old
// code deleted `focused` on a plain Enter while the stopped row re-sorted
// (focus lands elsewhere) — so Enter nuked the wrong session.
{
  const stopCalls = []
  const deleteCalls = []
  const armChannel = {
    ...fakeChannel,
    async stopBackgroundAgent(id) {
      stopCalls.push(id)
      return true
    },
    async deleteSession(id) {
      deleteCalls.push(id)
      return true
    },
  }
  const armStdin = new FakeStdin()
  const armStdout = new FakeStdout()
  const armInstance = await render(
    React.createElement(AgentView, {
      channel: armChannel,
      home: '/Users/x',
      approval: null,
      onApprove: () => {},
      onClose: () => {},
    }),
    { stdout: armStdout, stdin: armStdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
  )
  await new Promise(resolve => setTimeout(resolve, 400))

  // Initial focus: needs-input row b2 (non-current, stoppable).
  armStdin.write('\x18') // Ctrl+X → stop b2, arm the delete
  await new Promise(resolve => setTimeout(resolve, 300))
  check('arm: Ctrl+X stops the focused background session', stopCalls.length === 1 && stopCalls[0] === 'b2', JSON.stringify(stopCalls))
  check('arm: confirm hint names the armed session', stripAnsi(armStdout.frames).includes('再次按下删除') && stripAnsi(armStdout.frames).includes('PR review'))

  armStdin.write('\r') // Enter — must CANCEL, never delete
  await new Promise(resolve => setTimeout(resolve, 300))
  check('arm: Enter cancels instead of deleting', deleteCalls.length === 0, JSON.stringify(deleteCalls))

  armStdin.write('\x18') // stop b2 again
  await new Promise(resolve => setTimeout(resolve, 300))
  armStdin.write('\x18') // second Ctrl+X within the window → delete the ARMED id
  await new Promise(resolve => setTimeout(resolve, 400))
  check('arm: second Ctrl+X deletes the armed session', deleteCalls.length === 1 && deleteCalls[0] === 'b2', JSON.stringify(deleteCalls))

  armStdin.write('\x18') // stop again for the expiry case
  await new Promise(resolve => setTimeout(resolve, 300))
  await new Promise(resolve => setTimeout(resolve, 2300)) // let the 2s window lapse
  armStdin.write('\x18') // lands in list mode → a fresh stop, never a delete
  await new Promise(resolve => setTimeout(resolve, 300))
  check('arm: expired window never deletes', deleteCalls.length === 1 && stopCalls.length === 4, JSON.stringify({ stopCalls, deleteCalls }))
  await armInstance.unmount()
}

// Focus-shift regression: when stopping removes the row from the roster the
// focus falls on a DIFFERENT row — the confirm must still delete the armed
// id, not the newly focused one.
{
  const mutableRows = rows.map(row => ({ ...row }))
  const deleteCalls = []
  const shiftChannel = {
    ...fakeChannel,
    agentViewRows: () => mutableRows,
    async stopBackgroundAgent(id) {
      const index = mutableRows.findIndex(row => row.id === id)
      if (index >= 0) mutableRows.splice(index, 1) // re-render without the row
      return true
    },
    async deleteSession(id) {
      deleteCalls.push(id)
      return true
    },
  }
  const shiftStdin = new FakeStdin()
  const shiftStdout = new FakeStdout()
  const shiftInstance = await render(
    React.createElement(AgentView, {
      channel: shiftChannel,
      home: '/Users/x',
      approval: null,
      onApprove: () => {},
      onClose: () => {},
    }),
    { stdout: shiftStdout, stdin: shiftStdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
  )
  await new Promise(resolve => setTimeout(resolve, 400))

  shiftStdin.write('\x18') // stop b2 → row disappears, focus falls elsewhere
  await new Promise(resolve => setTimeout(resolve, 300))
  shiftStdin.write('\x18') // confirm: the armed row is gone → cancel, never delete the new focus
  await new Promise(resolve => setTimeout(resolve, 400))
  check('arm: focus shift cannot redirect the delete (vanished arm cancels)', deleteCalls.length === 0, JSON.stringify(deleteCalls))
  await shiftInstance.unmount()
}

// ── 3. Chat wiring: prompt footer hint + ← on an empty prompt ──────────────
// Renders the Chat screen with a smoke-style stub channel; asserts the
// "← N agents" footer (counting the needs-input row) and that a bare ← on
// the empty prompt requests the background+agent-view flow.
const { Chat } = await import('../src/screens/Chat.js')
const { QuestionStore } = await import('../src/dsh-adapter/questions.js')
const { ApprovalStore } = await import('../src/dsh-adapter/approvals.js')

let backgroundRequests = 0
const chatChannel = {
  version: 0,
  rows: [],
  status: 'idle',
  sessionTitle: 'probe',
  agentId: 'a1',
  model: 'deepseek-v4-flash',
  tokens: { input: 0, output: 0 },
  cwd: '/work/repo',
  displayCwd: '/work/repo',
  gitBranch: 'main',
  working: false,
  spinnerMode: 'requesting',
  responseChars: 0,
  activeToolCount: 0,
  mode: { id: 'default', plan: false },
  modeIndex: 0,
  cycleMode() {},
  turnStart: 0,
  lastUserText: '',
  pending: [],
  commandList: [],
  notifications: [],
  subscribe: () => () => {},
  submit: () => {},
  cancel: () => {},
  clear: () => {},
  notify: () => () => {},
  listModels: () => Promise.resolve([]),
  listSessions: () => [],
  setResumeTarget: () => {},
  agentViewRows: () => rows,
  subscribeAgentView: () => () => {},
  backgroundCurrent: () => {
    backgroundRequests += 1
    return Promise.resolve({ ok: false })
  },
}

const chatStdin = new FakeStdin()
const chatStdout = new FakeStdout()
const chatInstance = await render(
  React.createElement(Chat, {
    channel: chatChannel,
    questionStore: new QuestionStore(),
    approvalStore: new ApprovalStore(),
  }),
  {
    stdout: chatStdout,
    stdin: chatStdin,
    stderr: new FakeStderr(),
    exitOnCtrlC: false,
    patchConsole: false,
  },
)
await new Promise(resolve => setTimeout(resolve, 600))

text = stripAnsi(chatStdout.frames)
check('chat: footer counts needs-input background sessions', text.includes('← 1 个会话等待输入'), JSON.stringify(text.slice(-200)))
check('chat: footer hint renders before any ← press', backgroundRequests === 0)

// A bare left arrow on the empty prompt = CC's background-and-open flow.
chatStdin.write('\u001b[D')
await new Promise(resolve => setTimeout(resolve, 400))
check('chat: ← on empty prompt requests background+agent view', backgroundRequests === 1, String(backgroundRequests))

await chatInstance.unmount()

if (failures > 0) {
  console.error(`verify-agent-view: ${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('verify-agent-view: all checks passed')
}
