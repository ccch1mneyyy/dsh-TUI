/**
 * Goal budget and the backend-neutral `/goal` (N6):
 *
 *  1. grammar (`src/channel/goal-command.ts`): status, set (with
 *     `--budget 50k` / `--tokens=1.5m`, `edit`), the whole-input control
 *     words, invalid budgets and a missing objective; the budget readout
 *     `已用 12.3k / 50k tokens · 4m` (zh) / `Used 12.3k / 50k tokens · 4m`
 *     (en), uncapped and compact forms; the status lines;
 *  2. the capability snapshot: a goals-capable non-DSH session serves
 *     `/goal`; one without it refuses `/goal` as unavailable; a DSH session
 *     keeps its registry row (no ride-along command, never unavailable);
 *  3. the shared projector keeps a goal's budget and DSH goals stay
 *     budget-free;
 *  4. the real Chat over a real core channel: `/goal --budget 50k …`,
 *     `/goal pause|resume|clear` reach the capability (success toast,
 *     draft consumed), `/goal` prints the status, an invalid line stays in
 *     the composer and reaches nobody, a failing capability is reported;
 *     the goal panel shows the budget instead of rounds; a session without
 *     the capability answers `/goal` with the unavailable notice (nothing
 *     submitted); a DSH-style registry row still owns `/goal`;
 *  5. the footer chip shows `12.3k/50k` for a budgeted goal and the rounds
 *     otherwise.
 *
 * Run: node --import tsx/esm scripts/verify-goal-budget.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [
  { Writable, PassThrough },
  React,
  { Terminal: XTerm },
  ui,
  { Chat },
  { QuestionStore },
  { ApprovalStore },
  { createChannel },
  { parseGoalCommand, parseTokenBudget, formatGoalBudget, formatGoalBudgetCompact, goalStatusLines },
  { channelCapabilities },
  { isUnavailableLocalCommand, BACKEND_GOAL_COMMAND },
  { createChannelProjection },
  { createInitialChannelView },
  { GoalStatusChip },
  { setLang, t },
  { default: instances },
  { settled, sleep, viewportLines },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/approvals.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/channel/goal-command.js'),
  import('../src/channel/capabilities.js'),
  import('../src/commands.js'),
  import('../src/channel/projection.js'),
  import('../src/dsh-adapter/channel/state.js'),
  import('../src/components/GoalTodoPanel.js'),
  import('../src/i18n.js'),
  import('../src/ink/instances.js'),
  import('./lib/term-test.mjs'),
])
import type { AgentEvent, AgentEventMeta } from '../src/agent/events.js'
import type { AgentInput, AgentSession, SubmitPlacement } from '../src/agent/session.js'
import type { SessionCapabilities } from '../src/agent/capabilities.js'

setLang('en')
let passed = 0
let failures = 0
const results: string[] = []
const check = (label: string, ok: boolean, detail = ''): void => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail !== '' ? `\n      ${detail.replaceAll('\n', '\n      ')}` : ''}`)
  if (ok) passed += 1
  else failures += 1
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const budget = { tokensUsed: 12_300, tokenBudget: 50_000, timeUsedSeconds: 250 }

// ── 1. grammar and readouts ─────────────────────────────────────────────
check('1 bare /goal asks for the status', eq(parseGoalCommand(''), { kind: 'status' }) && eq(parseGoalCommand('   '), { kind: 'status' }))
check('1 an objective sets the goal', eq(parseGoalCommand(' ship the parser '), { kind: 'set', objective: 'ship the parser' }))
check('1 --budget 50k sets it under a token budget', eq(parseGoalCommand('--budget 50k ship it'), { kind: 'set', objective: 'ship it', tokenBudget: 50_000 }))
check('1 --tokens=1.5m is the same flag', eq(parseGoalCommand('--tokens=1.5m ship it'), { kind: 'set', objective: 'ship it', tokenBudget: 1_500_000 }))
check('1 edit replaces the objective', eq(parseGoalCommand('edit tighten the scope'), { kind: 'set', objective: 'tighten the scope' }) && eq(parseGoalCommand('editing docs'), { kind: 'set', objective: 'editing docs' }))
check('1 control words only as the whole input', eq(parseGoalCommand('pause'), { kind: 'pause' }) && eq(parseGoalCommand('resume'), { kind: 'resume' }) && eq(parseGoalCommand('clear'), { kind: 'clear' }) && eq(parseGoalCommand('pause after the tests'), { kind: 'set', objective: 'pause after the tests' }))
check('1 a bad budget is refused, saying why', eq(parseGoalCommand('--budget lots ship'), { kind: 'invalid', reason: t('goal-backend-bad-budget', { value: 'lots' }) }) && parseGoalCommand('--budget').kind === 'invalid')
check('1 a budget without an objective is refused', eq(parseGoalCommand('--budget 10k'), { kind: 'invalid', reason: t('goal-backend-missing-objective') }))
check('1 budgets parse 50000 / 50k / 1.5m / 50_000 and refuse 0', parseTokenBudget('50000') === 50_000 && parseTokenBudget('50K') === 50_000 && parseTokenBudget('1.5m') === 1_500_000 && parseTokenBudget('50_000') === 50_000 && parseTokenBudget('0') === undefined)
check('1 en readout', formatGoalBudget(budget) === 'Used 12.3k / 50k tokens · 4m', formatGoalBudget(budget))
check('1 uncapped readout', formatGoalBudget({ ...budget, tokenBudget: null, timeUsedSeconds: 45 }) === 'Used 12.3k tokens · 45s')
check('1 compact chip form', formatGoalBudgetCompact(budget) === '12.3k/50k' && formatGoalBudgetCompact({ ...budget, tokenBudget: null }) === '12.3k')
setLang('zh')
check('1 zh readout', formatGoalBudget(budget) === '已用 12.3k / 50k tokens · 4m', formatGoalBudget(budget))
setLang('en')
const goal = { id: 'g1', revision: 1, objective: 'Ship the parser', phase: 'active' as const, maxGoalRounds: 0, roundsStarted: 0, budget }
check('1 status lines: goal, phase, budget, usage', eq(goalStatusLines(goal), [t('goal-backend-objective', { objective: 'Ship the parser' }), t('goal-backend-phase', { phase: t('goal-phase-active') }), 'Used 12.3k / 50k tokens · 4m', t('goal-backend-usage')]), JSON.stringify(goalStatusLines(goal)))
check('1 status lines without a budget show rounds; a blocked goal says why', goalStatusLines({ ...goal, budget: undefined, phase: 'blocked', roundsStarted: 2, maxGoalRounds: 5, blockedReason: { code: 'usageLimited', message: 'Usage limit reached' } }).join('|') === [t('goal-backend-objective', { objective: 'Ship the parser' }), t('goal-backend-phase', { phase: t('goal-phase-blocked') }), t('goal-backend-rounds', { started: 2, max: 5 }), t('goal-backend-blocked', { message: 'Usage limit reached' }), t('goal-backend-usage')].join('|'))
check('1 no goal: none + usage', eq(goalStatusLines(undefined), [t('goal-backend-none'), t('goal-backend-usage')]))

// ── 2. the capability snapshot ──────────────────────────────────────────
const goalsCap: NonNullable<SessionCapabilities['goals']> = { set: () => Promise.resolve(), pause: () => Promise.resolve(), resume: () => Promise.resolve(), clear: () => Promise.resolve() }
{
  const served = channelCapabilities({ backendId: 'codex', backendLabel: 'Codex', capabilities: { native: {}, goals: goalsCap }, dsh: false })
  const absent = channelCapabilities({ backendId: 'claude', backendLabel: 'Claude', capabilities: { native: {} }, dsh: false })
  const dsh = channelCapabilities({ backendId: 'dsh', backendLabel: 'DSH', capabilities: { native: {} }, dsh: true })
  check('2 a goals-capable backend serves /goal', served.goals && served.commands.includes('goal') && !isUnavailableLocalCommand('goal', served))
  check('2 a backend without it refuses /goal as unavailable', !absent.goals && !absent.commands.includes('goal') && isUnavailableLocalCommand('goal', absent))
  check('2 DSH keeps its registry row: no ride-along, never unavailable', dsh.goals && !dsh.commands.includes('goal') && !isUnavailableLocalCommand('goal', dsh))
  check('2 a snapshot predating the flag serves everything', !isUnavailableLocalCommand('goal', { commands: [] }) && !isUnavailableLocalCommand('goal', undefined))
}

// ── 3. the shared projector keeps the budget ────────────────────────────
{
  const view = createInitialChannelView({ model: 'm', provider: 'p', cwd: '/fixture' }, { agentId: 'a', sessionId: 's', mode: { id: 'normal', name: 'Normal' } as never, cwdDescription: '/fixture' })
  const state = { ...view, emit: () => undefined } as Parameters<typeof createChannelProjection>[0]
  const projector = createChannelProjection(state, {
    rowIds: { value: 0 }, resetContextWarning: () => undefined, checkContextWarning: () => undefined, notify: () => () => undefined,
    jobs: { onOutputSeen: () => undefined, onStarted: () => undefined }, inputConvergence: { cancelInFlight: false }, selectionAttached: () => undefined,
  })
  const { roundsStarted: _rounds, ...snapshot } = goal
  projector.apply([{ type: 'goal.change', operation: 'set', goal: snapshot }], { replay: false })
  check('3 a budgeted goal keeps its budget', eq(state.goal?.budget, budget) && state.goal?.objective === 'Ship the parser')
  projector.apply([{ type: 'goal.change', operation: 'update', goal: { ...snapshot, budget: { ...budget, tokensUsed: 20_000 } } }], { replay: false })
  check('3 a later snapshot replaces the budget', state.goal?.budget?.tokensUsed === 20_000)
  projector.apply([{ type: 'goal.change', operation: 'clear' }], { replay: false })
  check('3 clear drops it', state.goal === undefined)
  const { budget: _budget, ...dshGoal } = snapshot
  projector.apply([{ type: 'goal.change', operation: 'create', goal: { ...dshGoal, maxGoalRounds: 4 }, roundsStarted: 1 }], { replay: false })
  check('3 a DSH goal stays budget-free', state.goal !== undefined && !('budget' in state.goal) && state.goal.roundsStarted === 1)
}

// ── 4. Chat over a real core channel ────────────────────────────────────
interface Harness {
  readonly channel: ReturnType<typeof createChannel>
  readonly submits: { input: AgentInput; placement: SubmitPlacement }[]
  emit(events: readonly AgentEvent[]): void
  screen(): string
  typeLine(text: string): Promise<void>
  enter(): Promise<void>
  unmount(): Promise<void>
}
async function mountChat(capabilities: Omit<SessionCapabilities, 'native'>, wrap?: (channel: ReturnType<typeof createChannel>) => unknown): Promise<Harness> {
  const submits: { input: AgentInput; placement: SubmitPlacement }[] = []
  const listeners = new Set<(batch: readonly AgentEvent[], meta: AgentEventMeta) => void>()
  const session: AgentSession = {
    ref: { backendId: 'fake', sessionId: '55555555-5555-4555-8555-555555555555' },
    cwd: process.cwd(),
    status: 'idle',
    capabilities: { native: {}, ...capabilities },
    history: () => Promise.resolve([]),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    submit(input, placement) { submits.push({ input, placement }); return Promise.resolve({ accepted: true }) },
    cancel: () => Promise.resolve({ stillQueued: [] }),
    dispose: () => Promise.resolve(),
  }
  const ctx = { on: () => () => undefined, get: () => undefined, logger: { warn: () => undefined, info: () => undefined, debug: () => undefined } } as never
  const channel = createChannel(ctx, session, { model: 'fake-model', provider: '', cwd: process.cwd(), activity: false, backendLabel: 'Fake Agent' })
  const COLS = 100
  const ROWS = 34
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 200, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void { term.write(String(chunk), callback) }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const stdin = new FakeStdin()
  const stdout = new FakeStdout()
  const instance = await ui.render(
    React.createElement(Chat, { channel: (wrap?.(channel) ?? channel) as never, questionStore: new QuestionStore(), approvalStore: new ApprovalStore(), onExit: () => undefined, fullscreen: false, trajectorySeen: true }),
    { stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  for (const value of instances.values()) instances.set(process.stdout, value)
  const screen = (): string => viewportLines(term, ROWS).join('\n')
  // 固定窗:pacing the key handlers attach after the first frame.
  await sleep(300)
  return {
    channel,
    submits,
    emit: events => { for (const listener of [...listeners]) listener(events, { replay: false, wake: 'sync' }) },
    screen,
    typeLine: async text => {
      for (const char of text) stdin.write(char)
      // 固定窗:pacing the prompt applies typed characters on its own render tick.
      await sleep(80)
    },
    enter: async () => {
      stdin.write('\r')
      // 固定窗:pacing Enter dispatches on the next render tick.
      await sleep(120)
    },
    unmount: async () => { instance.unmount(); await sleep(50) }, // 固定窗:pacing unmount settles before the next harness mounts
  }
}
const toastsOf = (channel: { notifications: readonly { text: string }[] }): string => channel.notifications.map(item => item.text).join(' | ')

{
  const calls: string[] = []
  let failNext = false
  const h = await mountChat({
    goals: {
      set: (objective, options) => { calls.push(`set:${objective}:${options?.tokenBudget ?? '-'}`); return Promise.resolve() },
      pause: () => { calls.push('pause'); return Promise.resolve() },
      resume: () => { calls.push('resume'); return Promise.resolve() },
      clear: () => {
        calls.push('clear')
        if (failNext) { failNext = false; return Promise.reject(new Error('thread busy')) }
        return Promise.resolve()
      },
    },
  })
  check('4 the goals-capable session offers /goal (once)', h.channel.commandList.filter(command => command.name === 'goal').length === 1 && h.channel.commandList.includes(BACKEND_GOAL_COMMAND) && h.channel.backendCapabilities.goals)
  await h.typeLine('/goal --budget 50k ship the parser')
  await h.enter()
  check('4 /goal --budget 50k reaches the capability', await settled(() => calls.includes('set:ship the parser:50000')), calls.join(','))
  check('4 … with a success toast, nothing submitted, draft consumed', await settled(() => toastsOf(h.channel).includes(t('goal-backend-set')) && !h.screen().includes('ship the parser')) && h.submits.length === 0, `${toastsOf(h.channel)}\n${h.screen()}`)
  for (const word of ['pause', 'resume'] as const) {
    await h.typeLine(`/goal ${word}`)
    await h.enter()
    check(`4 /goal ${word} reaches the capability`, await settled(() => calls.includes(word)), calls.join(','))
  }
  await h.typeLine('/goal --budget lots x')
  await h.enter()
  check('4 an invalid line is refused and stays in the composer', await settled(() => toastsOf(h.channel).includes(t('goal-backend-bad-budget', { value: 'lots' }))) && h.screen().includes('/goal --budget lots x') && h.submits.length === 0 && !calls.some(call => call.startsWith('set:x')), `${toastsOf(h.channel)}\n${h.screen()}`)
  for (let i = 0; i < 30; i += 1) await h.typeLine('\x7f')
  failNext = true
  await h.typeLine('/goal clear')
  await h.enter()
  check('4 a failing capability is reported (and the line kept)', await settled(() => toastsOf(h.channel).includes(t('capability-failed', { name: 'goal', err: 'thread busy' }))) && h.screen().includes('/goal clear'), toastsOf(h.channel))
  for (let i = 0; i < 30; i += 1) await h.typeLine('\x7f')

  const { roundsStarted: _rounds, ...snapshot } = goal
  h.emit([{ type: 'goal.change', operation: 'set', goal: snapshot }])
  check('4 the goal panel shows the budget instead of rounds', await settled(() => h.screen().includes('Ship the parser') && h.screen().includes('Used 12.3k / 50k tokens · 4m')) && !h.screen().includes('0/0'), h.screen())
  await h.typeLine('/goal')
  await h.enter()
  check('4 bare /goal prints the status into the transcript', await settled(() => h.screen().includes(t('goal-backend-objective', { objective: 'Ship the parser' })) && h.screen().includes(t('goal-backend-phase', { phase: t('goal-phase-active') }))), h.screen())
  check('4 nothing ever reached the model', h.submits.length === 0)
  await h.unmount()
}
{
  const h = await mountChat({})
  await h.typeLine('/goal ship it')
  await h.enter()
  check('4 without the capability /goal is unavailable, nothing submitted', await settled(() => toastsOf(h.channel).includes(t('cmd-unavailable-backend', { cmd: 'goal', backend: 'fake' }))) && h.submits.length === 0 && !h.channel.commandList.some(command => command.name === 'goal'), `${toastsOf(h.channel)} / submits=${h.submits.length}`)
  await h.unmount()
}
{
  // A DSH-style composition: the registry row owns /goal even when the
  // session also had a goals host (it never does on DSH; the row wins).
  const external: string[] = []
  let hostCalls = 0
  const h = await mountChat({ goals: { ...goalsCap, set: () => { hostCalls += 1; return Promise.resolve() } } }, channel => new Proxy(channel, {
    get(target, key, receiver) {
      if (key === 'commandList') return [...target.commandList.filter(command => command.name !== 'goal'), { name: 'goal', description: 'Set or show the session goal', external: true }]
      if (key === 'runExternalCommandOutcome') return (name: string, rawInput: string) => { external.push(`${name}|${rawInput}`); return Promise.resolve({ kind: 'success', text: '', consumeDraft: true }) }
      return Reflect.get(target, key, receiver)
    },
  }))
  await h.typeLine('/goal registry route')
  await h.enter()
  check('4 a registry row owns /goal (DSH route unchanged)', await settled(() => external.includes('goal| registry route')) && hostCalls === 0 && h.submits.length === 0, external.join(','))
  await h.unmount()
}

// ── 5. the footer chip ──────────────────────────────────────────────────
{
  const COLS = 60
  const term = new XTerm({ cols: COLS, rows: 4, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = COLS
    rows = 4
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void { term.write(String(chunk), callback) }
  }
  const stdout = new FakeStdout()
  const chip = (value: typeof goal | (Omit<typeof goal, 'budget'> & { budget?: undefined }), minimal = false) => React.createElement(GoalStatusChip, { goal: value as never, minimal })
  const app = await ui.render(chip(goal), { stdout: stdout as never, stdin: new PassThrough() as never, stderr: stdout as never, debug: true, exitOnCtrlC: false, patchConsole: false })
  const line = (): string => viewportLines(term, 4).join('\n')
  check('5 a budgeted chip shows tokens used / budget', await settled(() => line().includes('● 12.3k/50k')), line())
  app.rerender(chip({ ...goal, budget: undefined, roundsStarted: 2, maxGoalRounds: 5 }))
  check('5 a DSH chip keeps its rounds', await settled(() => line().includes('● 2/5')), line())
  app.rerender(chip(goal, true))
  check('5 minimal mode keeps the text form', await settled(() => line().includes('goal 12.3k/50k')), line())
  app.unmount()
}

for (const line of results) console.log(line)
console.log(`\nverify-goal-budget ${failures === 0 ? 'OK' : 'FAILED'} (${passed} passed, ${failures} failed)`)
process.exit(failures === 0 ? 0 : 1)
