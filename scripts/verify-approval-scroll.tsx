/**
 * Approval viewport regression: long commands and reasons must remain readable
 * without pushing the decision rows off a Linux terminal's visible screen.
 * Checks the real renderer through xterm, including mouse and keyboard input.
 *
 * Run: pnpm verify:approval-scroll
 */
import './lib/fake-home.mjs'
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, AlternateScreen, useTerminalSize },
  { ApprovalPanel },
  { Chat },
  { ApprovalStore },
  { QuestionStore },
  { t, setLang },
  { settled, viewportLines, findText },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/approvals/ApprovalPanel.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/approvals.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/i18n.js'),
  import('./lib/term-test.mjs'),
])

const HEAD = 'ZZZCMDHEAD'
const TAIL = 'ZZZREASONTAIL'
const approval = {
  key: 'long-approval',
  agentId: 'probe',
  toolName: 'Bash',
  command: Array.from({ length: 40 }, (_, index) =>
    `${index === 0 ? HEAD : `command-${index}`} echo 审批前需要完整查看的命令内容`,
  ).join('\n'),
  reason: Array.from({ length: 20 }, (_, index) =>
    `${index === 19 ? TAIL : `reason-${index}`} 这是请求批准的具体说明。`,
  ).join('\n'),
}

class FakeStdout extends Writable {
  isTTY = true
  parsedWrites = 0
  constructor(
    readonly term: InstanceType<typeof XTerm>,
    public columns: number,
    public rows: number,
  ) { super() }
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    this.term.write(String(chunk), () => {
      this.parsedWrites += 1
      callback()
    })
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
function check(name: string, ok: boolean, screen?: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`)
  if (!ok) {
    failures += 1
    if (screen !== undefined) console.error(screen)
  }
}

function makeChannel(working: boolean, todos: boolean) {
  return {
    version: 0,
    rows: Array.from({ length: 40 }, (_, id) => ({
      id, kind: id % 2 === 0 ? 'user' : 'assistant', text: `Transcript line ${id}`, time: 0,
    })),
    status: working ? 'running' : 'idle',
    sessionTitle: 'probe', agentId: 'probe', model: 'deepseek-v4-flash',
    tokens: { input: 120, output: 45 },
    cwd: '/tmp/demo', displayCwd: '/tmp/demo', gitBranch: 'main',
    working, spinnerMode: 'requesting', responseChars: 0, activeToolCount: 0,
    mode: { id: 'default', plan: false }, modeIndex: 0, cycleMode() {},
    turnStart: Date.now(), lastUserText: 'hello', pending: [],
    commandList: ['settings', 'jobs', 'tree'].map(name => ({ name, description: `open ${name}` })), notifications: [],
    activityEnabled: false, contextBarEnabled: false, activityFrames: [],
    todos: todos ? Array.from({ length: 8 }, (_, index) => ({ content: `Pending task ${index}`, status: 'pending' })) : [],
    subscribe: () => () => {}, submit() {}, cancel() {}, clear() {}, notify() {},
    listModels: () => Promise.resolve([]), commandCompletions: () => [], pushLocal() {},
    settingsHost: () => undefined, settingsSections: () => [],
    subscribeSettingsSections: () => () => {}, runExternalCommand: () => Promise.resolve(undefined),
    listSessions: () => [], setResumeTarget() {},
    buildSessionTree: async () => ({ roots: [], activeLeafId: null, sessionCount: 0 }),
  } as never
}

function request(callId: string, command: string, reason: string) {
  return {
    agent: { id: 'probe', session: { events: [{
      type: 'tool/call', seq: 1, time: 0,
      data: { turn: 0, step: 0, callId, name: 'Bash', arguments: JSON.stringify({ command }) },
    }] } },
    toolName: 'Bash', callId, reason,
  } as never
}

async function scenario(
  surface: 'direct' | 'chat' | 'settings' | 'jobs' | 'tree',
  fullscreen: boolean,
  cols: number,
  rows: number,
  working = false,
  singleLine = false,
  todos = false,
  english = false,
) {
  setLang(english ? 'en' : 'zh')
  const name = `${surface} ${fullscreen ? 'fullscreen' : 'inline'} ${cols}x${rows}${working ? ' working' : ''}${singleLine ? ' wrapped' : ''}${todos ? ' todos' : ''}${english ? ' English' : ''}`
  const term = new XTerm({ cols, rows, scrollback: 1000, allowProposedApi: true })
  const stdout = new FakeStdout(term, cols, rows) as FakeStdout & NodeJS.WriteStream
  const stdin = new FakeStdin() as FakeStdin & NodeJS.ReadStream
  let observedSize = { columns: 0, rows: 0, parsedWrites: 0 }
  function SizeObserver({ children }: { children: import('react').ReactNode }) {
    const size = useTerminalSize()
    React.useLayoutEffect(() => {
      observedSize = { ...size, parsedWrites: stdout.parsedWrites }
    }, [size.columns, size.rows])
    return children
  }
  const store = new ApprovalStore()
  const questions = new QuestionStore()
  const payload = singleLine
    ? { ...approval, command: `${HEAD} ${'中文👩‍💻é命令 '.repeat(100)}` }
    : approval
  let decision: string | undefined
  const node = surface === 'direct'
    ? React.createElement(ApprovalPanel, {
      approval: payload, onDecide(outcome) { decision = outcome },
    })
    : React.createElement(Chat, {
      channel: makeChannel(working, todos), questionStore: questions, approvalStore: store,
      fullscreen, onExit() {},
    })
  const app = await render(
    React.createElement(SizeObserver, {
      children: fullscreen ? React.createElement(AlternateScreen, { children: node }) : node,
    }),
    { stdout, stdin, stderr: new FakeStderr() as FakeStderr & NodeJS.WriteStream,
      exitOnCtrlC: false, patchConsole: false },
  )
  const screen = () => viewportLines(term).join('\n')
  const decisionsVisible = () => screen().includes(`1. ${t('approval-yes')}`) && screen().includes(`2. ${t('approval-no')}`)
  const hintVisible = () => screen().replace(/\s+/g, ' ').includes(english ? 'Esc reject' : 'Esc 拒绝')
  const isScreen = surface === 'settings' || surface === 'jobs' || surface === 'tree'
  const surfaceVisible = () => surface === 'settings'
    ? /插件设置|没有可配置的插件设置/.test(screen())
    : screen().includes(t(surface === 'jobs' ? 'jobs-panel-title' : 'tree-title').trim())
  if (isScreen) {
    stdin.write(`/${surface}`)
    await settled(() => screen().includes(`/${surface}`))
    stdin.write('\r')
    check(`${name}: underlying screen opens`, await settled(surfaceVisible), screen())
  }
  let outcome: Promise<unknown> | undefined
  if (surface !== 'direct') {
    outcome = store.park(request('first', payload.command, payload.reason))
    void outcome.then(value => { decision = String(value) })
  }
  check(`${name}: both options and keyboard hint remain visible`,
    await settled(() => decisionsVisible() && hintVisible()), screen())
  check(`${name}: command head is readable`, screen().includes(HEAD), screen())
  check(`${name}: long detail is windowed`, !screen().includes(TAIL))
  const hit = findText(term, HEAD) ?? { col: 10, row: 3 }
  const wheel = (direction: 'up' | 'down', ticks: number, position = hit) => {
    for (let tick = 0; tick < ticks; tick += 1) {
      stdin.write(`\x1b[<${direction === 'up' ? 64 : 65};${position.col + 1};${position.row + 1}M`)
    }
  }
  // Inline terminals normally own the wheel; PageDown must still make the
  // complete pending approval reachable without native scrollback.
  if (fullscreen || isScreen) wheel('down', 200)
  else for (let page = 0; page < 200; page += 1) stdin.write('\x1b[6~')
  check(`${name}: final approval reason is reachable`,
    await settled(() => screen().includes(TAIL)), screen())
  check(`${name}: options remain visible at detail end`, decisionsVisible(), screen())
  stdin.write('\x1b[5~')
  stdin.write('\x1b[5~')
  check(`${name}: PageUp scrolls approval details`,
    await settled(() => !screen().includes(TAIL)), screen())
  stdin.write('\x1b[6~')
  stdin.write('\x1b[6~')
  check(`${name}: PageDown returns to final reason`,
    await settled(() => screen().includes(TAIL)), screen())
  if (fullscreen && surface === 'chat') {
    const option = findText(term, `2. ${t('approval-no')}`) ?? hit
    wheel('up', 200, option)
    check(`${name}: wheel over options scrolls approval details`,
      await settled(() => screen().includes(HEAD)), screen())
  }
  if (surface === 'chat' && cols === 80 && rows === 24) {
    stdin.write('\x1b[B')
    const rejectFocused = () => viewportLines(term).some(line => line.includes(`❯2. ${t('approval-no')}`))
    check(`${name}: arrow selects Reject`, await settled(rejectFocused), screen())
    term.resize(40, 14)
    stdout.columns = 40
    stdout.rows = 14
    stdout.emit('resize')
    check(`${name}: narrow resize reaches the terminal`, await settled(() =>
      observedSize.columns === 40 && observedSize.rows === 14 && stdout.parsedWrites > observedSize.parsedWrites))
    check(`${name}: options survive narrowing to 40x14`,
      await settled(() => decisionsVisible() && hintVisible()), screen())
    check(`${name}: selected Reject survives narrowing`, rejectFocused(), screen())
    const expandedRows = todos ? 50 : 30
    term.resize(100, expandedRows)
    stdout.columns = 100
    stdout.rows = expandedRows
    stdout.emit('resize')
    check(`${name}: expanded resize reaches the terminal`, await settled(() =>
      observedSize.columns === 100 && observedSize.rows === expandedRows && stdout.parsedWrites > observedSize.parsedWrites))
    check(`${name}: options survive expansion to 100x${expandedRows}`,
      await settled(() => decisionsVisible() && hintVisible()), screen())
    check(`${name}: selected Reject survives expansion`, rejectFocused(), screen())
  }
  const confirmSelection = surface === 'chat' && cols === 80 && rows === 24
  stdin.write(confirmSelection ? '\r' : '2')
  check(`${name}: ${confirmSelection ? 'Enter confirms selected Reject' : 'digit 2 rejects'}`,
    await settled(() => decision === 'rejected'))
  if (outcome !== undefined && decision !== undefined) await outcome
  if (surface === 'chat') {
    decision = undefined
    const next = store.park(request('second', 'ZZZNEXTCOMMAND', 'short reason'))
    void next.then(value => { decision = String(value) })
    check(`${name}: next approval starts with visible details`,
      await settled(() => screen().includes('ZZZNEXTCOMMAND') && decisionsVisible()), screen())
    stdin.write('\r')
    check(`${name}: Enter approves the next request once`, await settled(() => decision === 'allowed-once'))
    if (decision !== undefined) await next
  }
  if (isScreen) {
    check(`${name}: underlying screen returns after decision`,
      await settled(surfaceVisible), screen())
    let answered = false
    const pending = questions.ask({ questions: [{
      question: 'FOREGROUNDQUESTION',
      options: [{ label: 'ANSWER-YES' }, { label: 'ANSWER-NO' }],
    }] })
    void pending.then(value => { answered = value.answers[0]?.selected[0] === 'ANSWER-YES' })
    check(`${name}: questionnaire and custom input interrupt the screen`,
      await settled(() => screen().includes('FOREGROUNDQUESTION') && screen().includes('自定义回答')), screen())
    stdin.write('\r')
    check(`${name}: questionnaire owns Enter`, await settled(() => answered))
    if (answered) await pending
    check(`${name}: underlying screen returns after answering`, await settled(surfaceVisible), screen())
  }
  await app.unmount()
  term.dispose()
}

for (const fullscreen of [true, false]) {
  await scenario('direct', fullscreen, 80, 24)
  await scenario('chat', fullscreen, 100, 10, true)
  await scenario('direct', fullscreen, 40, 14, false, true)
  await scenario('chat', fullscreen, 80, 24, true)
  await scenario('chat', fullscreen, 40, 14, true, true)
  await scenario('settings', fullscreen, 40, 14)
  await scenario('jobs', fullscreen, 40, 14)
  await scenario('tree', fullscreen, 40, 14)
  await scenario('chat', fullscreen, 80, 24, true, false, true)
  await scenario('chat', fullscreen, 40, 14, true, true, false, true)
}
if (failures > 0) {
  console.error(`\n${failures} approval scroll check(s) FAILED`)
  process.exit(1)
}
console.log('\nApproval scrolling verified')
process.exit(0)
