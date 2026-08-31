/**
 * Long exit_plan_mode review regression (issue #413).
 *
 * A 40-paragraph plan must not push Approve / Keep planning / feedback off a
 * 24-row terminal. The plan body occupies a bounded ScrollBox; wheel events
 * over that body reveal later paragraphs while the decision rows stay pinned
 * and Enter still submits a clean Approve payload.
 *
 * Covers the panel both directly and inside Chat (the issue's suggested
 * matrix). Chat.tsx is not part of the fix — position-first wheel routing
 * hits the new ScrollBox on its own.
 *
 * Run: node --import tsx/esm scripts/verify-plan-review-scroll.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, AlternateScreen },
  { AskUserQuestionPanel },
  { Chat },
  { QuestionStore },
  { settle, settled, sleep, viewportLines, findText },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/questions/AskUserQuestionPanel.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('./lib/term-test.mjs'),
])

const COLS = 90
const ROWS = 24
const SHORT_ROWS = 14
const HEAD = 'ZZZHEAD'
const LATE = 'ZZZLATE'
const TAIL = 'ZZZTAIL'
const PARAGRAPHS = 40

const planDetail = Array.from({ length: PARAGRAPHS }, (_, index) => {
  if (index === 0) return `## Step 1\n\n${HEAD} first paragraph of the plan.`
  if (index === 24) return `## Step 25\n\n${LATE} later paragraph of the plan.`
  if (index === PARAGRAPHS - 1) return `## Step ${PARAGRAPHS}\n\n${TAIL} last paragraph of the plan.`
  return `## Step ${index + 1}\n\nBody of step ${index + 1}: more plan detail here.`
}).join('\n\n')

const question = {
  header: 'Plan review',
  question: 'Approve this plan and leave plan mode?',
  detail: planDetail,
  options: [
    { label: 'Approve', description: 'Leave plan mode; the plan is carried out from the next step.' },
    { label: 'Keep planning', description: 'Stay in plan mode and keep refining the plan.' },
  ],
  intent: { kind: 'plan-review' as const, approve: 'Approve' },
}

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  constructor(private readonly term: InstanceType<typeof XTerm>) {
    super()
  }
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    this.term.write(String(chunk), callback)
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

function makeTerm(rows = ROWS) {
  const term = new XTerm({ cols: COLS, rows, scrollback: 1000, allowProposedApi: true })
  const stdout = new FakeStdout(term) as FakeStdout & NodeJS.WriteStream
  stdout.rows = rows
  const stdin = new FakeStdin() as FakeStdin & NodeJS.ReadStream
  const stderr = new FakeStderr() as FakeStderr & NodeJS.WriteStream
  const screen = () => viewportLines(term, rows).join('\n')
  return { term, stdout, stdin, stderr, screen }
}

/** SGR wheel: 64=up 65=down. findText is 0-based; SGR is 1-based. */
function wheelAt(
  stdin: FakeStdin,
  term: InstanceType<typeof XTerm>,
  dir: 'up' | 'down',
  ticks: number,
  fallback = { col: 20, row: 8 },
) {
  const hit = findText(term, HEAD) ?? fallback
  const col = hit.col + 1
  const row = hit.row + 1
  const btn = dir === 'up' ? 64 : 65
  for (let i = 0; i < ticks; i++) stdin.write(`\x1b[<${btn};${col};${row}M`)
}

function makeChannel(rows: unknown[]) {
  return {
    version: 0,
    rows,
    status: 'idle',
    sessionTitle: 'probe',
    agentId: 'probe',
    model: 'deepseek-v4-flash',
    tokens: { input: 120, output: 45 },
    cwd: '/tmp/demo',
    displayCwd: '/tmp/demo',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting',
    responseChars: 0,
    activeToolCount: 0,
    mode: { id: 'default', plan: true },
    modeIndex: 0,
    cycleMode() {},
    turnStart: Date.now(),
    lastUserText: 'make a plan',
    pending: [],
    commandList: [],
    notifications: [],
    activityEnabled: false,
    contextBarEnabled: false,
    activityFrames: [],
    subscribe: () => () => {},
    submit: () => {},
    cancel: () => {},
    clear: () => {},
    notify: () => {},
    listModels: () => Promise.resolve([]),
    listSessions: () => [],
    setResumeTarget: () => {},
  } as never
}

let failures = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures += 1
}

function dump(label: string, shot: string) {
  console.error(`\n=== ${label} ===\n${shot}\n`)
}

// ── 1. Direct panel in a 24-row alt-screen ──────────────────────────
{
  const { term, stdout, stdin, stderr, screen } = makeTerm()
  let answer: { selected: string[]; custom?: string } | undefined
  const app = await render(
    React.createElement(AlternateScreen, {
      children: React.createElement(AskUserQuestionPanel, {
        position: 1,
        total: 1,
        answered: 0,
        question,
        onAnswer(selection) { answer = selection },
        onCancel() {},
      }),
    }),
    { stdout, stdin, stderr, exitOnCtrlC: false, patchConsole: false },
  )

  let initial = ''
  await settled(() => {
    initial = screen()
    return initial.includes('Approve') && initial.includes('Keep planning')
  })
  const pinnedOk = initial.includes('Approve')
    && initial.includes('Keep planning')
    && initial.includes('输入反馈')
    && initial.includes('↑/↓ 选择')
  check('direct: decision rows stay visible on a 24-row terminal', pinnedOk)
  check('direct: plan head is visible', initial.includes(HEAD))
  check('direct: plan tail is windowed out', !initial.includes(TAIL) && !initial.includes(LATE))
  if (!pinnedOk || initial.includes(TAIL)) dump('DIRECT INITIAL', initial)

  wheelAt(stdin, term, 'down', 80)
  let scrolled = ''
  await settled(() => {
    scrolled = screen()
    return scrolled.includes(LATE) || scrolled.includes(TAIL)
  })
  check('direct: wheel reveals later plan lines',
    !scrolled.includes(HEAD) && (scrolled.includes(LATE) || scrolled.includes(TAIL)))
  check('direct: decision rows stay visible after wheel',
    scrolled.includes('Approve') && scrolled.includes('Keep planning') && scrolled.includes('↑/↓ 选择'))
  if (scrolled.includes(HEAD) || !(scrolled.includes(LATE) || scrolled.includes(TAIL))) {
    dump('DIRECT AFTER WHEEL', scrolled)
  }

  stdin.write('\r')
  await settled(() => answer !== undefined)
  check('direct: Enter still submits clean Approve',
    JSON.stringify(answer) === JSON.stringify({ selected: ['Approve'] }),
    JSON.stringify(answer))

  await app.unmount()
  term.dispose()
  await sleep(50)
}

// ── 2. Short terminal: omit the body before hiding the decisions ────
{
  const { term, stdout, stdin, stderr, screen } = makeTerm(SHORT_ROWS)
  let answer: { selected: string[]; custom?: string } | undefined
  const app = await render(
    React.createElement(AlternateScreen, {
      children: React.createElement(AskUserQuestionPanel, {
        position: 1,
        total: 1,
        answered: 0,
        question,
        onAnswer(selection) { answer = selection },
        onCancel() {},
      }),
    }),
    { stdout, stdin, stderr, exitOnCtrlC: false, patchConsole: false },
  )

  let initial = ''
  await settled(() => {
    initial = screen()
    return initial.includes('Approve') && initial.includes('Keep planning')
  })
  const controlsVisible = initial.includes('Approve')
    && initial.includes('Keep planning')
    && initial.includes('输入反馈')
    && initial.includes('↑/↓ 选择')
  check('short: decision rows stay visible when the body has no room', controlsVisible)
  check('short: plan body is omitted when no rows remain', !initial.includes(HEAD))
  if (!controlsVisible || initial.includes(HEAD)) dump('SHORT INITIAL', initial)

  stdin.write('\r')
  await settled(() => answer !== undefined)
  check('short: Enter still submits clean Approve',
    JSON.stringify(answer) === JSON.stringify({ selected: ['Approve'] }),
    JSON.stringify(answer))

  await app.unmount()
  term.dispose()
  await sleep(50)
}

// ── 3. Same payload inside Chat (prompt-slot layout) ────────────────
{
  const { term, stdout, stdin, stderr, screen } = makeTerm()
  const store = new QuestionStore()
  const app = await render(
    React.createElement(AlternateScreen, {
      children: React.createElement(Chat, {
        channel: makeChannel([
          { id: 0, kind: 'user', text: 'make a plan' },
          { id: 1, kind: 'assistant', text: 'Here is a plan.', time: Date.now() },
        ]),
        questionStore: store,
        onExit() {},
      }),
    }),
    { stdout, stdin, stderr, exitOnCtrlC: false, patchConsole: false },
  )
  await settle(() => screen().trim().length > 0)
  const review = store.ask({ questions: [{ id: 'plan-review', ...question }] } as never)

  let chatInitial = ''
  await settled(() => {
    chatInitial = screen()
    return chatInitial.includes('Approve') && chatInitial.includes('Keep planning')
  })
  check('chat: decision rows stay visible on a 24-row terminal',
    chatInitial.includes('Approve') && chatInitial.includes('Keep planning') && chatInitial.includes('↑/↓ 选择'))
  check('chat: plan head is visible', chatInitial.includes(HEAD))
  check('chat: plan tail is windowed out', !chatInitial.includes(TAIL) && !chatInitial.includes(LATE))
  if (!chatInitial.includes('Approve')) dump('CHAT INITIAL', chatInitial)

  wheelAt(stdin, term, 'down', 80)
  let chatScrolled = ''
  await settled(() => {
    chatScrolled = screen()
    return chatScrolled.includes(LATE) || chatScrolled.includes(TAIL)
  })
  check('chat: wheel reveals later plan lines',
    !chatScrolled.includes(HEAD) && (chatScrolled.includes(LATE) || chatScrolled.includes(TAIL)))
  check('chat: decision rows stay visible after wheel',
    chatScrolled.includes('Approve') && chatScrolled.includes('Keep planning'))
  if (chatScrolled.includes(HEAD) || !(chatScrolled.includes(LATE) || chatScrolled.includes(TAIL))) {
    dump('CHAT AFTER WHEEL', chatScrolled)
  }

  stdin.write('\r')
  const payload = await review
  check('chat: Enter still submits clean Approve',
    JSON.stringify(payload) === JSON.stringify({ answers: [{ id: 'plan-review', selected: ['Approve'] }] }),
    JSON.stringify(payload))

  await app.unmount()
  term.dispose()
}

if (failures > 0) {
  console.log(`\n${failures} plan-review scroll check(s) FAILED`)
  process.exit(1)
}
console.log('\nPlan-review long-body scroll verified')
process.exit(0)
