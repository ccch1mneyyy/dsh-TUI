/**
 * Focused regression for the session-overview projection and its Chat wiring:
 *
 *  1. Pure derivation helpers over synthetic session events — the fold
 *     (summary/title/turn-failure/updatedAt), live preview extraction, the
 *     state mapping, and the title fallback.
 *  2. Chat wiring: the "← N agents" footer hint and a bare ← on the empty
 *     prompt requesting the background-and-open flow.
 *
 * The screen that used to render this projection in its own full-page view is
 * gone (the three-in-one session manager replaced it); its assertions went with
 * it. What remains covers code that is still shipped.
 *
 * Run with:
 *   node --import tsx/esm scripts/verify-agent-view.mjs
 *
 * FORCE_COLOR must be set BEFORE any chalk import evaluates — ESM imports
 * are hoisted, so chalk-dependent modules load via dynamic import() below.
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { render }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('../src/ui.js'),
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

// ── 2. Chat wiring: prompt footer hint + ← on an empty prompt ──────────────
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

const text = stripAnsi(chatStdout.frames)
check('chat: footer counts needs-input background sessions', text.includes('← 1 个会话等待输入'), JSON.stringify(text.slice(-200)))
check('chat: footer hint renders before any ← press', backgroundRequests === 0)

// A bare left arrow on the empty prompt = the background-and-open flow.
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
