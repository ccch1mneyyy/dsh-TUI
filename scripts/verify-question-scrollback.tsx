/**
 * Regression: opening, advancing, and closing an inline questionnaire must
 * not copy the startup splash into terminal scrollback (issues #19/#38/#69).
 */
import type { Channel } from '../src/dsh-adapter/channel.js'

process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'WezTerm'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { ApprovalStore }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/approvals.js'),
])

const COLS = 100
const ROWS = 24
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 2000, allowProposedApi: true })
const rawChunks: string[] = []

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    const text = String(chunk)
    rawChunks.push(text)
    term.write(text, callback)
  }
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(
  stage: string,
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(intervalMs)
  }
  if (predicate()) return
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for: ${stage}\n` +
    `--- visible terminal ---\n${visibleText()}`,
  )
}
const longOptions = Array.from({ length: 18 }, (_, index) => ({
  label: `运行环境 ${index + 1}`,
  description: `第 ${index + 1} 个运行环境的独立说明。`,
}))
const listeners = new Set<() => void>()
const channelFixture = {
  version: 0,
  rows: [
    { id: 0, kind: 'user', text: '帮我检查配置' },
    { id: 1, kind: 'assistant', text: '我先确认几个选项。', streaming: false },
  ],
  status: 'idle',
  sessionTitle: 'question-scrollback',
  agentId: 'probe',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'max',
  tokens: { input: 120, output: 45 },
  lastUsage: { input: 120, cacheRead: 20, cacheWrite: 0, output: 45 },
  contextWindow: 1000,
  contextSegments: { system: 30, prompt: 40, assistant: 30, thinking: 20, tools: 20 },
  statusBar: {
    compact: true,
    model: true,
    thinking: true,
    cwd: true,
    contextUsage: true,
    cache: true,
    tokens: false,
    tps: false,
    gitBranch: false,
    sessionTitle: false,
    mode: false,
    contextBar: true,
    activity: true,
    trajectory: false,
    shortcutHint: true,
  },
  cwd: 'C:/code/demo-project',
  displayCwd: 'C:/code/demo-project',
  gitBranch: 'main',
  working: true,
  spinnerMode: 'requesting',
  responseChars: 20,
  activeToolCount: 0,
  mode: { id: 'default', plan: false },
  modeIndex: 0,
  cycleMode() {},
  turnStart: Date.now(),
  lastUserText: '帮我检查配置',
  pending: [],
  commandList: [{ name: 'provider', description: 'provider wizard' }],
  commandCompletions: () => [],
  notifications: [],
  activityEnabled: true,
  contextBarEnabled: true,
  activityFrames: [],
  workingActivity: {
    phase: 'asking',
    line: '等待回答',
    toolCount: 0,
    turnElapsedMs: 1000,
    phaseStartedAt: Date.now() - 1000,
  },
  subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
  submit() {},
  cancel() {},
  clear() {},
  notify() {},
  pushLocal() {},
  listModels: () => Promise.resolve([]),
  listSessions: () => [],
  providerSetup: () => ({
    listCatalogProviders: () => Array.from({ length: 31 }, (_, index) => ({
      provider: `provider-${String(index).padStart(2, '0')}`,
      displayName: `Provider ${index}`,
    })),
    routeExists: () => false,
    discoverModels: async () => [],
    envShadows: () => false,
    readCredential: async () => undefined,
    writeCredential() {},
    removeCredential() {},
    writeProfile: async () => {},
  }),
  setResumeTarget() {},
  loadOlder() {},
  mcpStatus: () => [],
}
const channel = channelFixture as unknown as Channel

const store = new QuestionStore()
const approvalStore = new ApprovalStore()
const stdout = new FakeStdout() as FakeStdout & NodeJS.WriteStream
const stdin = new FakeStdin() as FakeStdin & NodeJS.ReadStream
const app = await render(
  <Chat channel={channel} questionStore={store} approvalStore={approvalStore} onExit={() => {}} />,
  { stdout, stdin, stderr: stdout, exitOnCtrlC: false, patchConsole: false },
)

function splashCount(): number {
  const buffer = term.buffer.active
  let count = 0
  for (let y = 0; y < buffer.length; y++) {
    if ((buffer.getLine(y)?.translateToString(true) ?? '').includes('探索未至')) count += 1
  }
  return count
}

function visibleText(): string {
  const buffer = term.buffer.active
  return Array.from({ length: term.rows }, (_, offset) =>
    buffer.getLine(buffer.baseY + offset)?.translateToString(true) ?? '').join('\n')
}

async function resizeAndWait(columns: number, rows: number, stage: string): Promise<void> {
  const chunksBeforeResize = rawChunks.length
  stdout.columns = columns
  stdout.rows = rows
  term.resize(columns, rows)
  stdout.emit('resize')
  await waitFor(`${stage} redraw`, () =>
    term.cols === columns && term.rows === rows && rawChunks.length > chunksBeforeResize)
}

let failures = 0
let initialBufferLength = 0
function check(stage: string, exact = false) {
  const count = splashCount()
  const ok = exact ? count === 1 : count <= 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${stage}: splash copies=${count}, buffer lines=${term.buffer.active.length}`)
  if (!ok) failures += 1
}

function checkBufferStable(stage: string) {
  const length = term.buffer.active.length
  const ok = length === initialBufferLength
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${stage}: buffer lines=${length}`)
  if (!ok) failures += 1
}

function checkVisible(stage: string, marker: string) {
  const screen = visibleText()
  const ok = screen.includes(marker)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${stage}`)
  if (!ok) console.log(screen)
  if (!ok) failures += 1
}

await waitFor('initial splash', () => splashCount() === 1)
initialBufferLength = term.buffer.active.length
check('initial render', true)

// A pasted multiline draft grows PromptInput to its five-row cap. Opening a
// question must freeze this measured seat rather than collapse to the old
// hard-coded three rows; the opaque overlay must hide every draft row while
// preserving all three measured StatusLine rows, then closing must restore the
// complete draft and frame height.
channelFixture.working = false
channelFixture.workingActivity.phase = 'idle'
channelFixture.workingActivity.line = ''
channelFixture.version += 1
for (const listener of listeners) listener()
await waitFor('three-row status chrome before multiline question', () =>
  visibleText().includes('ctx 14%') && visibleText().includes('? 查看快捷键'))
const multilineDraftLines = ['第一行 prompt', '第二行 prompt', '第三行 prompt', '第四行 prompt']
stdin.write(`\x1b[200~${multilineDraftLines.join('\n')}\x1b[201~`)
await waitFor('multiline prompt to become visible', () =>
  multilineDraftLines.every(line => visibleText().includes(line)))
checkVisible('multiline prompt is visible before question', '第四行 prompt')
initialBufferLength = term.buffer.active.length

const answer = store.ask({
  questions: [
    {
      id: 'runtime',
      header: '运行环境',
      question: '使用哪个运行环境？',
      options: longOptions,
    },
    {
      id: 'confirm',
      header: '确认',
      question: '继续执行吗？',
      options: [
        { label: '继续', description: '应用当前配置。' },
        { label: '取消', description: '保持现状。' },
      ],
    },
  ],
} as never)
await waitFor('first questionnaire page', () => {
  const screen = visibleText()
  return screen.includes('使用哪个运行环境？')
    && screen.includes('ctx 14%')
    && screen.includes('? 查看快捷键')
    && multilineDraftLines.every(line => !screen.includes(line))
})
await sleep(250)
check('question opened')
checkBufferStable('question open does not grow scrollback')
checkVisible('first question remains visible', '使用哪个运行环境？')
checkVisible('first question preserves status fields', 'ctx 14%')
checkVisible('first question preserves supplemental status row', '? 查看快捷键')
const firstQuestionHidesDraft = multilineDraftLines.every(line => !visibleText().includes(line))
console.log(`${firstQuestionHidesDraft ? 'PASS' : 'FAIL'}  first question hides every multiline draft row`)
if (!firstQuestionHidesDraft) failures += 1

stdin.write('\r')
await waitFor('second questionnaire page', () => {
  const screen = visibleText()
  return screen.includes('继续执行吗？')
    && screen.includes('ctx 14%')
    && screen.includes('? 查看快捷键')
    && multilineDraftLines.every(line => !screen.includes(line))
})
await sleep(250)
check('advanced to second question')
checkBufferStable('question advance does not grow scrollback')
checkVisible('second question remains visible', '继续执行吗？')
checkVisible('second question preserves status fields', 'ctx 14%')
checkVisible('second question preserves supplemental status row', '? 查看快捷键')
const secondQuestionHidesDraft = multilineDraftLines.every(line => !visibleText().includes(line))
console.log(`${secondQuestionHidesDraft ? 'PASS' : 'FAIL'}  second question hides every multiline draft row`)
if (!secondQuestionHidesDraft) failures += 1

stdin.write('\r')
await answer
await waitFor('questionnaire close and prompt restoration', () =>
  multilineDraftLines.every(line => visibleText().includes(line)) && splashCount() === 1)
check('questionnaire closed', true)
checkBufferStable('question close does not grow scrollback')
const restoredDraft = multilineDraftLines.every(line => visibleText().includes(line))
console.log(`${restoredDraft ? 'PASS' : 'FAIL'}  complete multiline prompt is restored after question`)
if (!restoredDraft) failures += 1

// Exercise the real PromptInput → Chat command dispatcher → provider wizard
// path rather than only injecting QuestionStore snapshots. A three-row status
// configuration also proves the overlay anchor follows measured chrome height.
stdin.write('\x1b')
await waitFor('multiline prompt clear', () => !visibleText().includes('第四行 prompt'))
await waitFor('three-row status chrome', () => visibleText().includes('ctx 14%')
  && visibleText().includes('? 查看快捷键'))
initialBufferLength = term.buffer.active.length
stdin.write('/provider')
stdin.write('\r')
await waitFor('/provider mode snapshot', () => store.getSnapshot()?.question.id === 'mode')
await waitFor('/provider mode page', () => visibleText().includes('要添加哪种模型提供方？'))
await sleep(250)
checkBufferStable('real /provider command open does not grow scrollback')
checkVisible('real /provider command opens its first wizard question', '要添加哪种模型提供方？')
checkVisible('question preserves status fields below the overlay', 'ctx 14%')
checkVisible('question preserves supplemental status row below the overlay', '? 查看快捷键')
stdin.write('\r')
await waitFor('/provider catalog snapshot', () => store.getSnapshot()?.question.id === 'catalog')
await waitFor('/provider catalog page', () => visibleText().includes('provider-00'))
checkBufferStable('real /provider second wizard step does not grow scrollback')
checkVisible('real /provider opens the catalog step', 'provider-00')
stdin.write('\x1b')
await waitFor('/provider cancellation to restore prompt', () =>
  store.getSnapshot() === null && !visibleText().includes('选择 provider'))
checkBufferStable('real /provider cancel does not grow scrollback')
channelFixture.working = true
channelFixture.workingActivity.phase = 'asking'
channelFixture.workingActivity.line = '等待回答'
channelFixture.version += 1
const chunksBeforeWorkingRestore = rawChunks.length
for (const listener of listeners) listener()
await waitFor('working status restoration', () => rawChunks.length > chunksBeforeWorkingRestore)

// Clear the draft, then exercise the reviewer's small-terminal boundary at
// every height from 6 through 12. Resize itself may reflow the terminal; each
// scenario takes a fresh baseline and only judges open/close transitions.
for (let rows = 6; rows <= 12; rows += 1) {
  await resizeAndWait(COLS, rows, `${rows}-row terminal`)
  initialBufferLength = term.buffer.active.length

  const smallAnswer = store.ask({
    questions: [{
      id: `small-${rows}`,
      header: `小终端 ${rows}`,
      question: `终端高度 ${rows} 行仍可回答吗？`,
      options: longOptions,
    }],
  } as never)
  await waitFor(`${rows}-row question page`, () => visibleText().includes(`终端高度 ${rows} 行仍可回答吗？`)
    || visibleText().includes('Enter 提交'))
  checkBufferStable(`${rows}-row question open does not grow scrollback`)
  checkVisible(`${rows}-row question keeps actionable content visible`, 'Enter 提交')
  checkVisible(`${rows}-row question keeps focused option visible`, '● 运行环境 1')
  stdin.write('\r')
  const smallResult = await smallAnswer
  await waitFor(`${rows}-row question close`, () => !visibleText().includes(`小终端 ${rows}`))
  checkBufferStable(`${rows}-row question close does not grow scrollback`)
  const smallSelected = smallResult.answers.find(item => item.id === `small-${rows}`)?.selected ?? []
  const smallSubmitted = smallSelected.length === 1 && smallSelected[0] === '运行环境 1'
  console.log(`${smallSubmitted ? 'PASS' : 'FAIL'}  ${rows}-row question submits focused option`)
  if (!smallSubmitted) failures += 1
}

const providerOptions = Array.from({ length: 31 }, (_, index) => ({
  label: `provider-${String(index).padStart(2, '0')}`,
}))

// A constrained inline frame should instead advertise continuation, keep the
// focused tail reachable, and submit that exact tail without scrollback growth.
await resizeAndWait(100, 24, '100x24 constrained inline terminal')
initialBufferLength = term.buffer.active.length
const providerAnswer = store.ask({
  questions: [{
    id: 'provider-catalog-windowed',
    header: '/provider',
    question: '选择 provider',
    options: providerOptions,
    hideCustomInput: true,
  }],
} as never)
await waitFor('100x24 windowed provider catalog', () => visibleText().includes('● provider-00'))
checkBufferStable('100x24 provider catalog open does not grow scrollback')
checkVisible('100x24 provider catalog keeps action hint visible', 'Enter 提交')
const initialProviderScreen = visibleText()
const visibleProviderCount = providerOptions.filter(option =>
  initialProviderScreen.includes(option.label)).length
const providerCatalogCommunicatesRange = visibleProviderCount < providerOptions.length
  && initialProviderScreen.includes('↓○')
console.log(`${providerCatalogCommunicatesRange ? 'PASS' : 'FAIL'}  100x24 provider catalog exposes continuation  (${visibleProviderCount}/${providerOptions.length})`)
if (!providerCatalogCommunicatesRange) failures += 1
for (let index = 0; index < providerOptions.length - 1; index += 1) stdin.write('\x1b[B')
await waitFor('100x24 provider tail focus', () => visibleText().includes('● provider-30'))
checkBufferStable('100x24 provider navigation does not grow scrollback')
checkVisible('100x24 provider focus can reach visible final option', '● provider-30')
stdin.write('\r')
const providerResult = await providerAnswer
await waitFor('100x24 provider catalog close', () => store.getSnapshot() === null)
checkBufferStable('100x24 provider submit does not grow scrollback')
const providerSelected = providerResult.answers.find(answer => answer.id === 'provider-catalog-windowed')?.selected ?? []
const providerSubmitted = providerSelected.length === 1 && providerSelected[0] === 'provider-30'
console.log(`${providerSubmitted ? 'PASS' : 'FAIL'}  100x24 provider submits visible final option`)
if (!providerSubmitted) failures += 1

// Narrow terminals amplify wrapped question/header/detail rows. The option
// window must budget those physical rows, keep the focused tail visible, and
// submit that exact tail instead of clipping it below the action hint.
for (const rows of [18, 24]) {
  await resizeAndWait(40, rows, `40x${rows} wrapped terminal`)
  initialBufferLength = term.buffer.active.length
  const narrowOptions = Array.from({ length: 12 }, (_, index) => ({
    label: `窄屏选项-${String(index).padStart(2, '0')}`,
    description: `这是第 ${index + 1} 个需要在窄终端中截断显示的较长说明。`,
  }))
  const narrowAnswer = store.ask({
    questions: [{
      id: `narrow-${rows}`,
      header: '这是一个会在四十列终端中自动换行的长标题',
      question: '这是一个会占用多行的很长中文问题，用于验证选项窗口是否正确预留了自动换行所需的空间？',
      detail: '详细说明也会在窄屏幕上自动换行，不应该把当前焦点或底部操作提示挤出可见区域。',
      options: narrowOptions,
      hideCustomInput: true,
    }],
  } as never)
  await waitFor(`40x${rows} wrapped question page`, () => visibleText().includes('● 窄屏选项-00')
    && visibleText().includes('Enter 提交'))
  checkBufferStable(`40x${rows} wrapped question open does not grow scrollback`)
  checkVisible(`40x${rows} wrapped question keeps action hint visible`, 'Enter 提交')
  const firstNavigationCount = rows === 24 ? 6 : narrowOptions.length - 1
  for (let index = 0; index < firstNavigationCount; index += 1) stdin.write('\x1b[B')
  if (rows === 24) {
    await waitFor('40x24 focus on option 06', () => visibleText().includes('● 窄屏选项-06'))
    await resizeAndWait(40, 18, '40x24 to 40x18 question resize')
    await waitFor('40x24 to 40x18 focused question page', () => visibleText().includes('● 窄屏选项-06')
      && visibleText().includes('Enter 提交'))
    initialBufferLength = term.buffer.active.length
    checkVisible('40x24→40x18 resize keeps current focus visible', '● 窄屏选项-06')
    checkVisible('40x24→40x18 resize keeps action hint visible', 'Enter 提交')
    for (let index = firstNavigationCount; index < narrowOptions.length - 1; index += 1) {
      stdin.write('\x1b[B')
    }
  }
  await waitFor(`40x${rows} final option focus`, () => visibleText().includes('● 窄屏选项-11'))
  checkVisible(`40x${rows} wrapped question keeps final focus visible`, '● 窄屏选项-11')
  stdin.write('\r')
  const narrowResult = await narrowAnswer
  await waitFor(`40x${rows} wrapped question close`, () => store.getSnapshot() === null)
  checkBufferStable(`40x${rows} wrapped question submit does not grow scrollback`)
  const narrowSelected = narrowResult.answers.find(answer => answer.id === `narrow-${rows}`)?.selected ?? []
  const narrowSubmitted = narrowSelected.length === 1 && narrowSelected[0] === '窄屏选项-11'
  console.log(`${narrowSubmitted ? 'PASS' : 'FAIL'}  40x${rows} wrapped question submits final option`)
  if (!narrowSubmitted) failures += 1
}

// Cancellation is a separate outcome from submission and must restore the
// stable prompt/status frame without leaving the queued ask unresolved.
await resizeAndWait(40, 18, '40x18 cancellation terminal')
initialBufferLength = term.buffer.active.length
const cancelOutcome = store.ask({
  questions: [{
    id: 'cancel-narrow',
    header: '取消测试',
    question: '按 Esc 应取消整个问卷并恢复输入区。',
    options: longOptions,
  }],
} as never).then(
  () => 'resolved',
  (error: unknown) => typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : 'unknown',
)
await waitFor('40x18 cancellation question page', () => {
  const screen = visibleText()
  return screen.includes('Enter') && screen.includes('提交') && screen.includes('Esc 中断')
})
stdin.write('\x1b')
const cancelCode = await cancelOutcome
await waitFor('40x18 cancellation question close', () => !visibleText().includes('取消测试'))
checkBufferStable('40x18 Esc cancel does not grow scrollback')
const cancelledCorrectly = cancelCode === 'ASK_CANCELLED'
console.log(`${cancelledCorrectly ? 'PASS' : 'FAIL'}  40x18 Esc rejects with ASK_CANCELLED  (${cancelCode})`)
if (!cancelledCorrectly) failures += 1

// Approval and managed dialogs outrank a parked question. The question must
// remain mounted only logically—not visually or as an input listener—until
// the approval settles; one Enter must never answer both stores.
const parkedQuestion = store.ask({
  questions: [{
    id: 'approval-priority',
    question: '审批结束后才应显示这个问题。',
    options: [{ label: '问卷仍在等待' }],
    hideCustomInput: true,
  }],
} as never)
const approvalOutcome = approvalStore.park({
  agent: {
    id: 'probe',
    session: {
      events: [{
        type: 'tool/call',
        seq: 1,
        time: 0,
        data: {
          turn: 0,
          step: 0,
          callId: 'approval-priority-call',
          name: 'Bash',
          arguments: JSON.stringify({ command: 'printf approval-priority' }),
        },
      }],
    },
  },
  toolName: 'Bash',
  callId: 'approval-priority-call',
  reason: '严格验证模态优先级',
} as never)
await waitFor('approval priority panel', () => visibleText().includes('printf approval-priority'))
const approvalOwnsFrame = visibleText().includes('printf approval-priority')
  && !visibleText().includes('审批结束后才应显示这个问题。')
console.log(`${approvalOwnsFrame ? 'PASS' : 'FAIL'}  approval hides parked question`)
if (!approvalOwnsFrame) failures += 1
stdin.write('\r')
const approvalResult = await approvalOutcome
await waitFor('parked question after approval', () => store.getSnapshot()?.question.id === 'approval-priority'
  && visibleText().includes('问卷仍在等待'))
const onlyApprovalSettled = approvalResult === 'allowed-once'
  && store.getSnapshot()?.question.id === 'approval-priority'
console.log(`${onlyApprovalSettled ? 'PASS' : 'FAIL'}  one Enter settles approval only`)
if (!onlyApprovalSettled) failures += 1
stdin.write('\r')
const parkedResult = await parkedQuestion
const parkedSelected = parkedResult.answers.find(answer => answer.id === 'approval-priority')?.selected ?? []
const parkedSubmitted = parkedSelected.length === 1 && parkedSelected[0] === '问卷仍在等待'
console.log(`${parkedSubmitted ? 'PASS' : 'FAIL'}  parked question remains answerable after approval`)
if (!parkedSubmitted) failures += 1

// Plan review uses a bounded, independently-scrollable detail viewport while
// decisions remain pinned and keyboard-reachable. Resize must retain an
// actionable focused row, and PageDown must expose the tail of a long plan.
await resizeAndWait(40, 12, '40x12 plan review terminal')
const planDetail = [
  '# PLAN-START',
  ...Array.from({ length: 24 }, (_, index) => `- 计划步骤 ${String(index + 1).padStart(2, '0')}`),
  '- PLAN-END',
].join('\n')
const planOutcome = store.ask({
  questions: [{
    id: 'bounded-plan-review',
    header: '长计划评审',
    question: '请浏览计划并选择下一步。',
    detail: planDetail,
    options: [
      { label: '批准计划', description: '离开计划模式。' },
      { label: '继续规划', description: '保留计划模式。' },
    ],
    intent: { kind: 'plan-review', approve: '批准计划' },
  }],
} as never)
await waitFor('plan review first page', () =>
  visibleText().includes('PLAN-START') && visibleText().includes('批准计划'))
for (let page = 0; page < 12; page += 1) stdin.write('\x1b[6~')
await waitFor('plan review detail tail', () => visibleText().includes('PLAN-END'))
const planTailReachable = visibleText().includes('PLAN-END')
console.log(`${planTailReachable ? 'PASS' : 'FAIL'}  small-terminal plan detail reaches tail with PageDown`)
if (!planTailReachable) failures += 1
await resizeAndWait(40, 10, '40x10 plan review terminal')
await waitFor('resized plan review actions', () =>
  visibleText().includes('批准计划') && visibleText().includes('Enter 提交'))
const planActionableAfterResize = visibleText().includes('批准计划')
  && visibleText().includes('Enter 提交')
console.log(`${planActionableAfterResize ? 'PASS' : 'FAIL'}  resized plan review keeps decisions and controls visible`)
if (!planActionableAfterResize) failures += 1
stdin.write('\x1b[B')
await waitFor('second plan decision focus', () => visibleText().includes('❯2. 继续规划'))
stdin.write('\r')
const planResult = await planOutcome
const planSelected = planResult.answers.find(answer => answer.id === 'bounded-plan-review')?.selected ?? []
const planSubmitted = planSelected.length === 1 && planSelected[0] === '继续规划'
console.log(`${planSubmitted ? 'PASS' : 'FAIL'}  resized plan review submits focused decision`)
if (!planSubmitted) failures += 1

// Fullscreen hosts already own the alternate screen. Reuse the same root to
// prove a genuinely available 198x58 viewport shows the whole provider list,
// then resize for the focused-tail questionnaire scenario.
await resizeAndWait(198, 58, '198x58 fullscreen setup')
app.rerender(
  <AlternateScreen>
    <Chat channel={channel} questionStore={store} approvalStore={approvalStore} onExit={() => {}} fullscreen />
  </AlternateScreen>,
)
await waitFor('fullscreen alternate buffer', () => term.buffer.active === term.buffer.alternate)
initialBufferLength = term.buffer.active.length
const fullProviderAnswer = store.ask({
  questions: [{
    id: 'provider-catalog-full',
    header: '/provider',
    question: '选择 provider',
    options: providerOptions,
    hideCustomInput: true,
  }],
} as never)
await waitFor('198x58 complete provider catalog', () =>
  providerOptions.every(option => visibleText().includes(option.label)))
checkBufferStable('198x58 complete provider catalog keeps alternate buffer stable')
checkVisible('198x58 complete provider catalog keeps action hint visible', 'Enter 提交')
const fullProviderScreen = visibleText()
const fullProviderVisibleCount = providerOptions.filter(option =>
  fullProviderScreen.includes(option.label)).length
const fullProviderCatalogVisible = fullProviderVisibleCount === providerOptions.length
console.log(`${fullProviderCatalogVisible ? 'PASS' : 'FAIL'}  198x58 provider catalog shows every item  (${fullProviderVisibleCount}/${providerOptions.length})`)
if (!fullProviderCatalogVisible) failures += 1
stdin.write('\r')
await fullProviderAnswer
await waitFor('198x58 provider catalog close', () => store.getSnapshot() === null)

await resizeAndWait(80, 20, '80x20 fullscreen question setup')
initialBufferLength = term.buffer.active.length
const fullscreenOptions = Array.from({ length: 16 }, (_, index) => ({
  label: `fullscreen-${String(index).padStart(2, '0')}`,
  description: `fullscreen option ${index + 1}`,
}))
const fullscreenOutcome = store.ask({
  questions: [{
    id: 'fullscreen-resize',
    header: 'fullscreen',
    question: '全屏问卷在 resize 后仍应保持焦点可见。',
    options: fullscreenOptions,
    hideCustomInput: true,
  }],
} as never).then(
  result => ({ result, errorCode: null as string | null }),
  (error: unknown) => ({
    result: null,
    errorCode: typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : 'unknown',
  }),
)
await waitFor('fullscreen question first option', () => visibleText().includes('● fullscreen-00'))
checkBufferStable('80x20 fullscreen question open keeps alternate buffer stable')
for (let index = 0; index < 8; index += 1) stdin.write('\x1b[B')
await waitFor('fullscreen option 08 focus', () => visibleText().includes('● fullscreen-08'))
await resizeAndWait(72, 16, '72x16 fullscreen question resize')
await waitFor('resized fullscreen focused question page', () => visibleText().includes('● fullscreen-08')
  && visibleText().includes('Enter 提交'))
initialBufferLength = term.buffer.active.length
checkVisible('fullscreen resize keeps current focus visible', '● fullscreen-08')
for (let index = 8; index < fullscreenOptions.length - 1; index += 1) stdin.write('\x1b[B')
await waitFor('fullscreen final option focus', () => visibleText().includes('● fullscreen-15'))
stdin.write('\r')
const fullscreenSettled = await fullscreenOutcome
await waitFor('fullscreen question close', () =>
  !visibleText().includes('全屏问卷在 resize 后仍应保持焦点可见。'))
checkBufferStable('72x16 fullscreen submit keeps alternate buffer stable')
const fullscreenSelected = fullscreenSettled.result?.answers
  .find(answer => answer.id === 'fullscreen-resize')?.selected ?? []
const fullscreenSubmitted = fullscreenSelected.length === 1
  && fullscreenSelected[0] === 'fullscreen-15'
  && fullscreenSettled.errorCode === null
console.log(`${fullscreenSubmitted ? 'PASS' : 'FAIL'}  fullscreen resize submits visible final option${fullscreenSettled.errorCode === null ? '' : `  (${fullscreenSettled.errorCode})`}`)
if (!fullscreenSubmitted) failures += 1

const scrollUps = (rawChunks.join('').match(/\x1b\[\d+S/g) ?? []).length
const noScrollUps = scrollUps === 0
console.log(`${noScrollUps ? 'PASS' : 'FAIL'}  no raw CSI scroll-up sequences  (${scrollUps})`)
if (!noScrollUps) failures += 1

await app.unmount()
process.exit(failures === 0 ? 0 : 1)
