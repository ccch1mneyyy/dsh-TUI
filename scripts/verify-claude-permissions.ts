/**
 * The Claude permission bridge against a fake SDK `query()` (no CLI, no
 * network). The matrix:
 *
 *  - allow once / reject (with the user's reason) / allow always (the CLI's
 *    own suggestions go back as `updatedPermissions`, classified permanent);
 *    option generation from the suggestion shapes, and its suppression;
 *  - the six deadlock rules (numbered in permissions.ts): abort signal
 *    while pending (→ cancelled, panel closes), a user cancel only
 *    interrupts (the bridge never answers on its own; the CLI's abort
 *    settles it), dispose while pending (deny before close), two parallel
 *    prompts, a redelivered request id (its own signal counts too: abort
 *    second / first-then-second / already-aborted / a normal answer, one
 *    settlement per group), a callback that fails while building its prompt
 *    (→ deny, never a throw), and the forced turn close withdrawing what the
 *    CLI never withdrew;
 *  - `AskUserQuestion`: answers by question text (`label`, `a, b`, custom
 *    text), cancel → deny + interrupt;
 *  - `ExitPlanMode`: approve with auto-accepted or manual edits → allow +
 *    `setMode` for the session; keep planning (with feedback) and dismissal
 *    → deny + interrupt;
 *  - session status `requires-action` while prompts are parked;
 *  - translator: `system/permission_denied` → warning notice + the card's
 *    error reason; plan-mode tools render no card; `EnterPlanMode` →
 *    `mode.changed{plan}`; an answered `AskUserQuestion` projects its record.
 *
 * Run: node --import tsx/esm scripts/verify-claude-permissions.ts
 */
import assert from 'node:assert/strict'
import type { AgentEvent, AgentEventOf } from '../src/agent/events.js'
import type { AgentSession } from '../src/agent/session.js'
import type { buildQueryOptions } from '../src/backends/claude/options.js'
import { CLOSED_MESSAGE, PLAN_DISMISSED_MESSAGE, PLAN_KEEP_PLANNING_MESSAGE, QUESTION_CANCEL_MESSAGE, REJECT_MESSAGE, WITHDRAWN_MESSAGE } from '../src/backends/claude/permissions.js'
import { openClaudeSession, type ClaudeClock, type ClaudeSessionDeps } from '../src/backends/claude/session.js'
import { createClaudeTranslator } from '../src/backends/claude/translate.js'
import { getLang, setLang, t } from '../src/i18n.js'
import { claudeText } from '../src/backends/claude/text.js'
import { createProjectorHarness } from './lib/projector-harness.js'

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

type QueryParams = { prompt: AsyncIterable<Record<string, unknown>>; options: ReturnType<typeof buildQueryOptions> }

/** A manual clock (the force-settle timer). */
function manualClock() {
  let now = 0
  let nextId = 1
  const timers = new Map<number, { at: number; callback: () => void }>()
  const clock: ClaudeClock = {
    setTimeout(callback, ms) { const id = nextId++; timers.set(id, { at: now + ms, callback }); return id },
    clearTimeout(handle) { timers.delete(handle as number) },
  }
  return {
    clock,
    advance(ms: number) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.callback()
      }
    },
  }
}

/** A fake `Query`: messages pushed by the test, interrupts and close recorded. */
function fakeSdk() {
  const queries: { params: QueryParams; interrupts: number; closed: boolean; closedAt: number; emit(message: unknown): void }[] = []
  let order = 0
  const sdk = {
    query: (params: QueryParams) => {
      const outbox: unknown[] = []
      const waiters: ((result: IteratorResult<unknown>) => void)[] = []
      let ended = false
      void (async () => { for await (const _ of params.prompt) { /* drain stdin */ } })()
      const flush = (): void => {
        while (waiters.length > 0 && (outbox.length > 0 || ended)) {
          const waiter = waiters.shift()!
          if (outbox.length > 0) waiter({ value: outbox.shift(), done: false })
          else waiter({ value: undefined, done: true })
        }
      }
      const query = {
        params,
        interrupts: 0,
        closed: false,
        closedAt: 0,
        emit(message: unknown) { outbox.push(message); flush() },
        initializationResult: () => Promise.resolve({ capabilities: ['msg_lifecycle_v1', 'interrupt_receipt_v1'] }),
        interrupt() { query.interrupts += 1; return Promise.resolve({ still_queued: [] }) },
        close() { query.closed = true; query.closedAt = ++order; ended = true; flush() },
        [Symbol.asyncIterator]() {
          return {
            next: (): Promise<IteratorResult<unknown>> => {
              if (outbox.length > 0) return Promise.resolve({ value: outbox.shift(), done: false })
              if (ended) return Promise.resolve({ value: undefined, done: true })
              return new Promise(resolve => { waiters.push(resolve) })
            },
          }
        },
      }
      queries.push(query)
      return query
    },
  } as unknown as ClaudeSessionDeps['sdk']
  return { sdk, queries, nextOrder: () => ++order }
}

async function open(extra: Partial<ClaudeSessionDeps> = {}) {
  const fake = fakeSdk()
  const { clock, advance } = manualClock()
  const session = await openClaudeSession({
    sdk: fake.sdk,
    cwd: '/fixture/project',
    sessionId: '00000000-0000-4000-8000-0000000000aa',
    start: { mode: 'default', source: 'default' },
    executable: { path: '/fixture/bin/claude', source: 'env' },
    env: { PATH: '/usr/bin' },
    host: { locale: getLang, debug: () => undefined },
    clock,
    ...extra,
  })
  const events: AgentEvent[] = []
  session.subscribe(batch => { events.push(...batch) })
  await tick()
  const query = fake.queries[0]!
  const canUseTool = query.params.options.canUseTool!
  return { session, events, query, canUseTool, advance, fake }
}

const of = <T extends AgentEvent['type']>(events: readonly AgentEvent[], type: T): AgentEventOf<T>[] =>
  events.filter((event): event is AgentEventOf<T> => event.type === type)
const lastRequest = (events: readonly AgentEvent[]) => of(events, 'permission.request').at(-1)!.request
const lastQuestion = (events: readonly AgentEvent[]) => of(events, 'question.request').at(-1)!.request
const opts = (requestId: string, extra: Record<string, unknown> = {}, signal = new AbortController().signal) =>
  ({ signal, toolUseID: `toolu_${requestId}`, requestId, ...extra }) as Parameters<NonNullable<QueryParams['options']['canUseTool']>>[2]
const acceptEdits = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
const writeInput = { file_path: '/fixture/project/notes.txt', content: 'x' }

// ── allow once / reject / allow always ────────────────────────────────
{
  const { session, events, canUseTool } = await open()
  const once = canUseTool('Write', writeInput, opts('r1', { suggestions: acceptEdits, displayName: 'Write', description: 'Write a file' }))
  await tick()
  const request = lastRequest(events)
  check('a prompt surfaces as permission.request', request.requestId === 'r1' && request.callId === 'toolu_r1' && request.toolName === 'Write' && request.displayName === 'Write')
  check('the gated file is shown relative to the cwd', request.command === 'notes.txt', request.command)
  check('options: allow once, allow always (auto-accept edits), reject', JSON.stringify(request.options.map(option => option.kind)) === JSON.stringify(['allow-once', 'allow-always', 'reject'])
    && request.options[1]!.label === claudeText('claude-always-accept-edits'), request.options)
  check('a rejection may carry a reason', request.feedback === true)
  check('a parked prompt is requires-action', session.status === 'requires-action' && of(events, 'session.status').some(event => event.status === 'requires-action'))
  check('capabilities.permissions.pending lists it', session.capabilities.permissions?.pending().some(view => view.requestId === 'r1') === true)
  session.capabilities.permissions!.respond('r1', { kind: 'allow-once' })
  check('allow once → allow with the original input, no persistence', JSON.stringify(await once) === JSON.stringify({ behavior: 'allow', updatedInput: writeInput, toolUseID: 'toolu_r1' }))
  check('allow once settles the request', of(events, 'permission.settled').some(event => event.requestId === 'r1' && event.outcome === 'allow-once'))
  check('nothing parked → no longer requires-action', session.status !== 'requires-action')

  const rejected = canUseTool('Bash', { command: 'rm -rf build' }, opts('r2'))
  await tick()
  check('Bash shows its command', lastRequest(events).command === 'rm -rf build')
  check('no suggestions → no allow-always', !lastRequest(events).options.some(option => option.kind === 'allow-always'))
  session.capabilities.permissions!.respond('r2', { kind: 'reject', message: 'use git clean instead' })
  const deny = await rejected
  check('reject → deny with the user reason, classified user_reject', deny.behavior === 'deny' && deny.message.startsWith(REJECT_MESSAGE) && deny.message.includes('use git clean instead')
    && deny.decisionClassification === 'user_reject' && deny.toolUseID === 'toolu_r2', deny)
  const plain = canUseTool('Bash', { command: 'ls' }, opts('r2b'))
  await tick()
  session.capabilities.permissions!.respond('r2b', { kind: 'reject' })
  check('a plain reject → the design message', (await plain).behavior === 'deny' && (await plain as { message: string }).message === REJECT_MESSAGE)

  const rules = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }]
  const always = canUseTool('Bash', { command: 'npm test' }, opts('r3', { suggestions: rules }))
  await tick()
  check('addRules → "don\'t ask again in this project" label', lastRequest(events).options.find(option => option.kind === 'allow-always')?.label === claudeText('claude-always-rules-project', { rules: 'Bash(npm test:*)' }))
  session.capabilities.permissions!.respond('r3', { kind: 'allow-always' })
  const allowed = await always
  check('allow always → the CLI\'s own suggestions, classified permanent', allowed.behavior === 'allow' && JSON.stringify(allowed.updatedPermissions) === JSON.stringify(rules) && allowed.decisionClassification === 'user_permanent', allowed)

  const dirs = [{ type: 'addDirectories', directories: ['/fixture/other'], destination: 'session' }]
  const dirPrompt = canUseTool('Read', { file_path: '/fixture/other/a' }, opts('r4', { suggestions: dirs, blockedPath: '/fixture/other/a', defaultToNo: true, agentID: 'agent-123' }))
  await tick()
  const dirRequest = lastRequest(events)
  check('addDirectories → "allow access" label', dirRequest.options.find(option => option.kind === 'allow-always')?.label === claudeText('claude-always-directories', { dirs: '/fixture/other' }))
  check('blockedPath, defaultToNo and the subagent pass through', dirRequest.blockedPath === '/fixture/other/a' && dirRequest.defaultToNo === true && dirRequest.agentId === 'agent-123', dirRequest)
  session.capabilities.permissions!.respond('r4', { kind: 'allow-once' })
  await dirPrompt

  const suppressed = canUseTool('Bash', { command: 'curl x' }, opts('r5', { suggestions: rules, suppressAlwaysAllowRule: true }))
  const forced = canUseTool('Bash', { command: 'curl y' }, opts('r6', { suggestions: rules, matchedAskRule: { source: 'userSettings', toolName: 'Bash' } }))
  await tick()
  const [suppressedView, forcedView] = of(events, 'permission.request').slice(-2).map(event => event.request)
  check('suppressAlwaysAllowRule hides allow-always', !suppressedView!.options.some(option => option.kind === 'allow-always') && suppressedView!.suppressAlwaysAllow === true)
  check('a forcing ask rule hides allow-always', !forcedView!.options.some(option => option.kind === 'allow-always') && forcedView!.matchedAskRule?.toolName === 'Bash')
  session.capabilities.permissions!.respond('r5', { kind: 'allow-always' })
  check('an allow-always the prompt never offered is refused (fail closed)', (await suppressed).behavior === 'deny')
  session.capabilities.permissions!.respond('r6', { kind: 'allow-once' })
  await forced
  session.capabilities.permissions!.respond('r6', { kind: 'allow-once' })
  check('a second answer to a settled prompt is ignored', of(events, 'permission.settled').filter(event => event.requestId === 'r6').length === 1)
  await session.dispose()
}

// ── deadlock rules ────────────────────────────────────────────────────
{
  const { session, events, canUseTool, query, advance } = await open()
  // Rule 1: the SDK withdraws the prompt.
  const controller = new AbortController()
  const withdrawn = canUseTool('Write', writeInput, opts('d1', {}, controller.signal))
  await tick()
  controller.abort()
  const result = await withdrawn
  check('rule 1: abort while pending → deny (withdrawn), unclassified', result.behavior === 'deny' && result.message === WITHDRAWN_MESSAGE && result.decisionClassification === undefined)
  check('rule 1: the panel closes (settled cancelled)', of(events, 'permission.settled').some(event => event.requestId === 'd1' && event.outcome === 'cancelled'))
  session.capabilities.permissions!.respond('d1', { kind: 'allow-once' })
  check('rule 1: a late answer changes nothing', of(events, 'permission.settled').filter(event => event.requestId === 'd1').length === 1)
  check('rule 1: an already-aborted signal is refused at once', (await canUseTool('Write', writeInput, opts('d1b', {}, controller.signal))).behavior === 'deny')

  // Rule 2: a user cancel interrupts; the bridge waits for the CLI's abort.
  query.emit({ type: 'system', subtype: 'status', status: 'requesting' })
  await tick()
  const cancelController = new AbortController()
  let settledEarly = false
  const pendingCancel = canUseTool('Bash', { command: 'sleep 9' }, opts('d2', {}, cancelController.signal))
  void pendingCancel.then(() => { settledEarly = true })
  await tick()
  await session.cancel('user')
  await tick()
  check('rule 2: cancel interrupts the CLI', query.interrupts === 1)
  check('rule 2: the bridge never answers on its own', !settledEarly && session.status === 'requires-action')
  cancelController.abort()
  check('rule 2: the CLI\'s abort settles it', (await pendingCancel).behavior === 'deny' && of(events, 'permission.settled').some(event => event.requestId === 'd2' && event.outcome === 'cancelled'))

  // The forced close withdraws a prompt the CLI never withdrew.
  const stuck = canUseTool('Bash', { command: 'stuck' }, opts('d3'))
  await tick()
  await session.cancel('user')
  advance(30_000)
  check('forced turn close: a prompt the CLI never withdrew is settled', (await stuck).behavior === 'deny' && of(events, 'permission.settled').some(event => event.requestId === 'd3' && event.outcome === 'cancelled'))

  // Rule 5: parallel prompts; a redelivered request id shares the answer.
  const first = canUseTool('Write', writeInput, opts('p1'))
  const second = canUseTool('Write', { ...writeInput, file_path: '/fixture/project/b.txt' }, opts('p2'))
  const redelivered = canUseTool('Write', writeInput, opts('p1'))
  await tick()
  check('rule 5: both prompts park with distinct ids', of(events, 'permission.request').filter(event => event.request.requestId === 'p1').length === 1 && of(events, 'permission.request').some(event => event.request.requestId === 'p2'))
  session.capabilities.permissions!.respond('p2', { kind: 'allow-once' })
  session.capabilities.permissions!.respond('p1', { kind: 'reject' })
  check('rule 5: each prompt gets its own answer', (await second).behavior === 'allow' && (await first).behavior === 'deny')
  check('a redelivered request id resolves with the same answer', JSON.stringify(await redelivered) === JSON.stringify(await first))

  // A redelivered request id honours its own signal too, not only the
  // first delivery's; otherwise cancelling the redelivery would leave every
  // resolver hanging until dispose's settleAll. The request is shared:
  // whichever delivered signal aborts settles the whole group once, with
  // exactly one settled event and one answer per resolver. A resolver that
  // never settles must fail a check, not hang the suite, so the 2 s marker
  // is a real timer (the manual clock drives only the force-settle path).
  const settledWithin = async <T,>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise.then((value: T) => ({ ok: true as const, value })),
        new Promise<{ ok: false }>(resolve => { timer = setTimeout(() => resolve({ ok: false }), 2_000) }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  {
    // (a) only the second signal aborts.
    const firstController = new AbortController()
    const secondController = new AbortController()
    const waiting = canUseTool('Write', writeInput, opts('s1', {}, firstController.signal))
    await tick()
    const redeliveredAgain = canUseTool('Write', writeInput, opts('s1', {}, secondController.signal))
    await tick()
    secondController.abort()
    const settledFirst = await settledWithin(waiting)
    const settledSecond = await settledWithin(redeliveredAgain)
    check('R2-5: aborting the redelivered signal settles the shared request', settledFirst.ok && settledSecond.ok && settledFirst.value!.behavior === 'deny' && settledFirst.value!.message === WITHDRAWN_MESSAGE && JSON.stringify(settledSecond.value) === JSON.stringify(settledFirst.value), { settledFirst, settledSecond })
    check('R2-5: exactly one settled event (cancelled) for the group', of(events, 'permission.settled').filter(event => event.requestId === 's1').length === 1 && of(events, 'permission.settled').find(event => event.requestId === 's1')!.outcome === 'cancelled')
    // A late abort of the other signal is a no-op: the prompt is gone.
    firstController.abort()
    check('R2-5: a late abort of the other signal changes nothing', of(events, 'permission.settled').filter(event => event.requestId === 's1').length === 1)
  }
  {
    // (b) the first signal aborts, then the second's: still one settlement.
    const firstController = new AbortController()
    const secondController = new AbortController()
    const waiting = canUseTool('Write', writeInput, opts('s2', {}, firstController.signal))
    await tick()
    const redeliveredAgain = canUseTool('Write', writeInput, opts('s2', {}, secondController.signal))
    await tick()
    firstController.abort()
    const settledFirst = await settledWithin(waiting)
    const settledSecond = await settledWithin(redeliveredAgain)
    secondController.abort()
    check('R2-5: first-then-second aborts settle exactly once', settledFirst.ok && settledSecond.ok && settledFirst.value!.behavior === 'deny' && settledSecond.value!.behavior === 'deny' && of(events, 'permission.settled').filter(event => event.requestId === 's2').length === 1, { settledFirst, settledSecond })
  }
  {
    // (c) the redelivery arrives already aborted: the group settles at once.
    const dead = new AbortController()
    dead.abort()
    const waiting = canUseTool('Write', writeInput, opts('s3'))
    await tick()
    const redeliveredAgain = canUseTool('Write', writeInput, opts('s3', {}, dead.signal))
    await tick()
    const settledFirst = await settledWithin(waiting)
    const settledSecond = await settledWithin(redeliveredAgain)
    check('R2-5: an already-aborted redelivery settles the group at once', settledFirst.ok && settledSecond.ok && settledFirst.value!.behavior === 'deny' && settledFirst.value!.message === WITHDRAWN_MESSAGE && JSON.stringify(settledSecond.value) === JSON.stringify(settledFirst.value) && of(events, 'permission.settled').filter(event => event.requestId === 's3').length === 1, { settledFirst, settledSecond })
  }
  {
    // (d) no abort at all: a normal answer reaches every resolver of the
    // shared request exactly once.
    const waiting = canUseTool('Write', writeInput, opts('s4'))
    await tick()
    const redeliveredAgain = canUseTool('Write', writeInput, opts('s4'))
    await tick()
    session.capabilities.permissions!.respond('s4', { kind: 'reject' })
    const settledFirst = await settledWithin(waiting)
    const settledSecond = await settledWithin(redeliveredAgain)
    check('R2-5: a normal answer still reaches every resolver once', settledFirst.ok && settledSecond.ok && settledFirst.value!.behavior === 'deny' && JSON.stringify(settledSecond.value) === JSON.stringify(settledFirst.value) && of(events, 'permission.settled').filter(event => event.requestId === 's4').length === 1, { settledFirst, settledSecond })
  }

  // Rule 6: a prompt that cannot be built is refused, never a throw.
  const hostile = { toJSON() { throw new Error('unserializable') } }
  const failed = await canUseTool('mcp__x__y', { value: hostile }, opts('e1'))
  check('rule 6: a failing prompt build denies instead of throwing', failed.behavior === 'deny')

  // Rule 4: dispose denies every pending prompt before the query closes.
  const atDispose = canUseTool('Write', writeInput, opts('x1'))
  const question = canUseTool('AskUserQuestion', { questions: [{ question: 'Q?', header: 'H', options: [{ label: 'a' }, { label: 'b' }], multiSelect: false }] }, opts('x2'))
  await tick()
  // The settlement is observed synchronously (its event), not through the
  // promise, whose continuation runs after teardown finished.
  let deniedBeforeClose = false
  session.subscribe(batch => {
    if (batch.some(event => event.type === 'permission.settled' && event.requestId === 'x1')) deniedBeforeClose = !query.closed
  })
  await session.dispose()
  check('rule 4: dispose denies pending prompts', (await atDispose).behavior === 'deny' && (await atDispose as { message: string }).message === CLOSED_MESSAGE && (await question).behavior === 'deny')
  check('rule 4: … before the query closes', deniedBeforeClose && query.closed)
  check('rule 4: a prompt after dispose is refused at once', (await canUseTool('Write', writeInput, opts('x3'))).behavior === 'deny')
}

// ── AskUserQuestion ───────────────────────────────────────────────────
{
  const { session, events, canUseTool } = await open()
  const input = { questions: [
    { question: 'Which color?', header: 'Color', options: [{ label: 'red', description: 'warm' }, { label: 'blue' }], multiSelect: false },
    { question: 'Which sizes?', header: 'Size', options: [{ label: 'S' }, { label: 'M' }], multiSelect: true },
    { question: 'Anything else?', header: 'Notes', options: [{ label: 'no' }], multiSelect: false },
  ] }
  const asked = canUseTool('AskUserQuestion', input, opts('q1', { requiresUserInteraction: true }))
  await tick()
  const request = lastQuestion(events)
  check('AskUserQuestion → question.request, not an approval', request.questions.length === 3 && request.questions[0]!.options[0]!.description === 'warm' && request.questions[1]!.multiSelect === true && of(events, 'permission.request').length === 0)
  session.capabilities.questions!.respond('q1', { answers: [{ selected: ['blue'] }, { selected: ['S', 'M'] }, { selected: [], custom: 'ship it friday' }] })
  const answered = await asked
  check('answers keyed by question text: label, "a, b", custom text', answered.behavior === 'allow' && JSON.stringify(answered.updatedInput) === JSON.stringify({
    ...input,
    answers: { 'Which color?': 'blue', 'Which sizes?': 'S, M', 'Anything else?': 'ship it friday' },
  }), answered)
  check('the ask settles', of(events, 'question.settled').some(event => event.requestId === 'q1'))
  const cancelled = canUseTool('AskUserQuestion', input, opts('q2'))
  await tick()
  session.capabilities.questions!.cancel('q2')
  const denied = await cancelled
  check('cancel → deny + interrupt', denied.behavior === 'deny' && denied.message === QUESTION_CANCEL_MESSAGE && denied.interrupt === true)
  check('an unreadable ask is refused', (await canUseTool('AskUserQuestion', { questions: 'nope' }, opts('q3'))).behavior === 'deny')
  await session.dispose()
}

// ── ExitPlanMode ──────────────────────────────────────────────────────
{
  const { session, events, canUseTool } = await open()
  const planInput = { plan: '# Plan\n1. write plan.txt', planFilePath: '/fixture/home/plan.md' }
  const review = async (requestId: string, selected: string[], custom?: string) => {
    const pending = canUseTool('ExitPlanMode', planInput, opts(requestId, { requiresUserInteraction: true }))
    await tick()
    const request = lastQuestion(events)
    const question = request.questions[0]!
    if (requestId === 'plan1') {
      check('ExitPlanMode → a plan-review question with the plan as detail', question.intent?.kind === 'plan-review' && question.detail === planInput.plan
        && question.intent.approve === claudeText('claude-plan-accept-edits') && question.intent.approveAlso?.[0] === claudeText('claude-plan-manual') && question.intent.decline === claudeText('claude-plan-keep'), question)
    }
    session.capabilities.questions!.respond(requestId, { answers: [{ selected, ...(custom === undefined ? {} : { custom }) }] })
    return pending
  }
  const accepted = await review('plan1', [claudeText('claude-plan-accept-edits')])
  check('approve (auto-accept edits) → allow + setMode acceptEdits for the session', accepted.behavior === 'allow'
    && JSON.stringify(accepted.updatedPermissions) === JSON.stringify([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]), accepted)
  const manual = await review('plan2', [claudeText('claude-plan-manual')])
  check('approve (manual approvals) → allow + setMode default', manual.behavior === 'allow' && JSON.stringify(manual.updatedPermissions) === JSON.stringify([{ type: 'setMode', mode: 'default', destination: 'session' }]))
  const keep = await review('plan3', [claudeText('claude-plan-keep')], 'split step 1')
  check('keep planning with feedback → deny + interrupt with the feedback', keep.behavior === 'deny' && keep.interrupt === true && keep.message.startsWith(PLAN_KEEP_PLANNING_MESSAGE) && keep.message.includes('split step 1'))
  const dismissed = canUseTool('ExitPlanMode', planInput, opts('plan4'))
  await tick()
  session.capabilities.questions!.cancel('plan4')
  const dismissal = await dismissed
  check('a dismissed review → deny + interrupt', dismissal.behavior === 'deny' && dismissal.interrupt === true && dismissal.message === PLAN_DISMISSED_MESSAGE)
  await session.dispose()
}

// ── translator side: permission_denied, plan tools, the question record ──
{
  const translator = createClaudeTranslator({ cwd: '/fixture/project', userRows: 'lifecycle' })
  const harness = createProjectorHarness({ model: '' })
  const feed = (message: unknown): readonly AgentEvent[] => {
    const batch = translator.translate(message)
    harness.apply(batch)
    return batch
  }
  feed({ type: 'system', subtype: 'status', status: 'requesting' })
  feed({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', model: 'haiku', usage: {} } } })
  feed({ type: 'assistant', message: { id: 'm1', content: [
    { type: 'tool_use', id: 'tw', name: 'Write', input: writeInput },
    { type: 'tool_use', id: 'tp', name: 'EnterPlanMode', input: {} },
    { type: 'tool_use', id: 'tx', name: 'ExitPlanMode', input: { plan: '# P' } },
    { type: 'tool_use', id: 'tq', name: 'AskUserQuestion', input: { questions: [{ question: 'Which color?', options: [{ label: 'red' }, { label: 'blue' }] }] } },
  ] } })
  feed({ type: 'stream_event', event: { type: 'message_stop' } })
  const denied = feed({ type: 'system', subtype: 'permission_denied', tool_name: 'Write', tool_use_id: 'tw', decision_reason_type: 'mode', decision_reason: 'dontAsk mode denies unapproved tools', message: 'Permission to use Write has been denied.' })
  check('permission_denied → a warning notice on the call', denied.some(event => event.type === 'notice' && event.level === 'warning' && event.callId === 'tw' && event.text.includes('dontAsk mode denies unapproved tools')), denied)
  feed({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tw', is_error: true, content: 'Permission to use Write has been denied.' }] } })
  const card = harness.state.rows.find(row => row.kind === 'tool' && row.tool?.name === 'Write')
  check('… and the card errors with the decision reason', card?.tool?.status === 'error' && (card.tool.errorText ?? '').includes('dontAsk mode denies unapproved tools'), card?.tool)
  check('plan-mode tools render no card', !harness.state.rows.some(row => row.kind === 'tool' && (row.tool?.name === 'EnterPlanMode' || row.tool?.name === 'ExitPlanMode')))
  const entered = feed({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tp', content: 'Entered plan mode.' }] } })
  check('EnterPlanMode → mode.changed{plan}', entered.some(event => event.type === 'mode.changed' && event.modeId === 'plan'), entered)
  const exited = feed({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tx', content: 'User has approved your plan.' }] } })
  check('an approved plan leaves a notice row', exited.some(event => event.type === 'notice' && event.text === claudeText('claude-plan-approved')))
  feed({ type: 'user', tool_use_result: { answers: { 'Which color?': 'blue' } }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tq', content: 'Your questions have been answered: "Which color?"="blue". You can now continue.' }] } })
  check('an answered AskUserQuestion projects its record', harness.state.rows.some(row => row.kind === 'local-output' && row.text.includes('Which color?') && row.text.includes('blue')), harness.state.rows.map(row => `${row.kind}:${row.text}`))
}

console.log(`\nverify-claude-permissions OK (${passed} checks)`)
process.exit(0)
