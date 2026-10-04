/**
 * Channel over a non-DSH session: a fake `AgentSession` with no `native.dsh`
 * goes through the real `createChannel`, and the channel must
 *
 *  - publish a capability snapshot (`backendCapabilities`, `sessionRef`,
 *    `costReport`) and offer only the commands the backend serves;
 *  - run the generic actions on any session (submit → `session.submit`,
 *    cancel, clear, pushLocal, loadOlder → 0, local-fs file completion,
 *    `/new` through the backend's own `open`, `/doctor`);
 *  - never start an async retraction (Alt+Up on a backend without
 *    `retractPending` answers false without calling the backend);
 *  - fail every DSH-only action explicitly (notify `capability-unavailable-backend`
 *    + the contract's failure value) while passive reads stay silent;
 *  - delegate to a typed capability when the session declares it;
 *  - fence events of a replaced session by binding generation.
 *
 * A DSH channel built from the same entry point keeps its full command list
 * (capability snapshot = every built-in, `commandList` untouched).
 *
 * A non-DSH session is served by the same channel core as DSH, so the
 * backend-neutral features reach it too: the IDE selection channel (consumed
 * into the submitted message, indicator on the user row), the git branch
 * breadcrumb, `/export` from the projected rows, `!cmd` with its workspace
 * target. `/new` never tears down a turn that started (or a prompt that
 * arrived) while the new session was opening.
 *
 * Run: node --import tsx/esm scripts/verify-backend-channel.ts
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, AgentEventMeta } from '../src/agent/events.js'
import type { AgentInput, AgentSession, SubmitPlacement } from '../src/agent/session.js'
import type { SessionCapabilities } from '../src/agent/capabilities.js'
import { LOCAL_COMMANDS } from '../src/commands.js'
import { createChannel } from '../src/dsh-adapter/channel.js'
import { annotateCommandCapabilities } from '../src/dsh-adapter/channel/capabilities.js'
import { Config, normalizeBackendChoice } from '../src/dsh-adapter/index.js'
import { MAX_ROWS } from '../src/channel/transcript.js'
import { PermissionStore } from '../src/channel/permissions.js'
import { QuestionStore } from '../src/channel/questions.js'
import type { PermissionDecision } from '../src/agent/capabilities.js'
import { setLang, t } from '../src/i18n.js'
import { settled } from './lib/term-test.mjs'
import { startWsFixture } from './lib/ide-ws-fixture.js'

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}

interface FakeSession extends AgentSession {
  readonly submits: { input: AgentInput; placement: SubmitPlacement }[]
  readonly cancels: string[]
  disposed: boolean
  emit(events: readonly AgentEvent[], meta?: Partial<AgentEventMeta>): void
  listenerCount(): number
}

const fakeSession = (sessionId: string, capabilities: Omit<SessionCapabilities, 'native'> = {}): FakeSession => {
  const listeners = new Set<(batch: readonly AgentEvent[], meta: AgentEventMeta) => void>()
  const session: FakeSession = {
    ref: { backendId: 'fake', sessionId },
    cwd: '/fixture',
    status: 'idle',
    capabilities: { ...capabilities, native: {} },
    submits: [],
    cancels: [],
    disposed: false,
    history: () => Promise.resolve([]),
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    submit(input, placement) {
      session.submits.push({ input, placement })
      return Promise.resolve({ accepted: true })
    },
    cancel(cause) {
      session.cancels.push(cause)
      return Promise.resolve({ stillQueued: [] })
    },
    dispose() {
      session.disposed = true
      return Promise.resolve()
    },
    emit(events, meta = {}) {
      for (const listener of [...listeners]) listener(events, { replay: false, wake: 'sync', ...meta })
    },
    listenerCount: () => listeners.size,
  }
  return session
}

// A bare context: no host services mounted (degraded composition).
const ctx = {
  on: () => () => undefined,
  get: () => undefined,
  logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
} as never

const workdir = mkdtempSync(join(tmpdir(), 'dsh-tui-backend-channel-'))
mkdirSync(join(workdir, 'src'))
writeFileSync(join(workdir, 'src', 'alpha-module.ts'), 'export const alpha = 1\n')
writeFileSync(join(workdir, 'README.md'), '# fixture\n')

const opened: FakeSession[] = []
const first = fakeSession('11111111-1111-4111-8111-111111111111')
const channel = createChannel(ctx, first, {
  model: 'fake-model',
  provider: '',
  cwd: workdir,
  activity: false,
  backendLabel: 'Fake Agent',
  openSession: target => {
    const next = fakeSession(`22222222-2222-4222-8222-22222222222${opened.length}`)
    assert.equal(target.kind, 'create')
    opened.push(next)
    return Promise.resolve(next)
  },
})
const toasts = (): string[] => channel.notifications.map(item => item.text)
const unavailableText = (name: string): string => t('capability-unavailable-backend', { name })

try {
  // ── capability snapshot and command surface ─────────────────────────
  check('snapshot names the backend', channel.backendCapabilities.backendId === 'fake' && channel.backendCapabilities.backendLabel === 'Fake Agent')
  check('sessionRef follows the bound session', channel.sessionRef.backendId === 'fake' && channel.sessionRef.sessionId === first.ref.sessionId)
  check('no backend cost reported yet', channel.costReport === undefined)
  check('no retraction without the capability', channel.backendCapabilities.retractPending === false)
  const offered = channel.commandList.map(command => command.name)
  for (const name of ['new', 'clear', 'status', 'cost', 'doctor', 'help', 'exit', 'theme', 'lang']) {
    check(`generic /${name} is offered`, offered.includes(name))
  }
  for (const name of ['preset', 'tree', 'rewind', 'fork', 'resume', 'model', 'effort', 'compact', 'balance', 'workspace', 'agents', 'jobs', 'mcp']) {
    check(`/${name} is hidden without its capability`, !offered.includes(name))
  }
  check('snapshot commands == offered list', JSON.stringify(channel.backendCapabilities.commands) === JSON.stringify(offered))
  // /trace 是三态契约：每个后端都提供这个入口，四个入口的判定一致。核心挂了
  // 中立的 AgentEvent 折叠源，所以事件到来前报 empty，到来后报 supported。
  // 能力判定读组合的结构声明，不看命令清单，也不看 backendId；只有没挂数据源
  // 的组合才报 unsupported。
  check('/trace is offered on every backend (three-state entry contract)', offered.includes('trace'))
  check('the core trajectory source reports empty before events (fold mounted)', channel.trajectorySource() === 'empty')
  // The composition facts (`ChannelUi.capabilities()`) for a session no
  // extension describes: no compact capability → `/compact` has no route.
  check('composition facts without compact: /compact and /plan have no route', channel.capabilities().compact.route === 'none' && channel.capabilities().plan.route === 'none' && !channel.capabilities().skills)
  check('Tab completion offers only served commands', channel.commandCompletions('/pre').length === 0 && channel.commandCompletions('/ne').some(item => item.name === 'new'))

  // ── generic actions ─────────────────────────────────────────────────
  check('the session is subscribed once', first.listenerCount() === 1)
  channel.submit('hello backend')
  check('submit reaches session.submit as a followup', await settled(() => first.submits.length === 1) && first.submits[0]!.placement === 'followup' && first.submits[0]!.input.text === 'hello backend')
  const clientId = first.submits[0]!.input.clientMessageId
  check('submit tracks a pending preview under the client id', channel.pending.some(item => item.id === clientId))
  check('Alt+Up never starts an async retraction', channel.removePending(clientId) === false && channel.pending.some(item => item.id === clientId))
  first.emit([{ type: 'pending.changed', items: [], claimed: [clientId] }], { wake: 'none' })
  check('a claim retires the preview', !channel.pending.some(item => item.id === clientId))
  first.emit([
    { type: 'session.ready', sessionId: first.ref.sessionId, cwd: workdir, model: 'fake-model-x' },
    { type: 'turn.start', turn: 1, origin: 'user', userMessageId: clientId, time: 1 },
    { type: 'user.message', id: clientId, anchor: clientId, seq: 1, turn: 1, time: 1, source: 'user', text: 'hello backend', blocks: [{ type: 'text', text: 'hello backend' }] },
    { type: 'step.start', turn: 1, step: 1 },
    { type: 'assistant.attempt.start', attemptId: 'msg_1', turn: 1, step: 1 },
    { type: 'assistant.delta', attemptId: 'msg_1', index: 0, time: 2, delta: { kind: 'reasoning-tokens', estimated: 120 } },
  ])
  check('session.ready sets the model', channel.model === 'fake-model-x')
  check('turn.start opens the working state', channel.working)
  check('the fold reports supported once events flow', channel.trajectorySource() === 'supported' && channel.traceEvents().length > 0)
  check('the confirmed user message is a bubble', channel.rows.some(row => row.kind === 'user' && row.text === 'hello backend'))
  const thinking = channel.rows.find(row => row.kind === 'reasoning')
  check('reasoning-tokens opens a count-only thinking row', thinking !== undefined && thinking.text === '' && thinking.reasoningTokens === 120 && thinking.streaming === true)
  first.emit([
    { type: 'assistant.delta', attemptId: 'msg_1', index: 0, time: 3, delta: { kind: 'reasoning-tokens', estimated: 480 } },
    { type: 'assistant.delta', attemptId: 'msg_1', index: 1, time: 4, delta: { kind: 'text', text: 'Hi there' } },
    { type: 'assistant.message', seq: 2, anchor: 'msg_1', turn: 1, step: 1, attemptId: 'msg_1', time: 5, canonical: true, blocks: [{ type: 'reasoning', text: '' }, { type: 'text', text: 'Hi there' }], usage: { input: 10, output: 5 } },
    { type: 'step.end', turn: 1, step: 1 },
    { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 6, cost: { currency: 'USD', amount: 0.0042, source: 'backend' } },
  ])
  const settledThinking = channel.rows.find(row => row.kind === 'reasoning')
  check('a canonical empty thinking block keeps the count-only row', settledThinking !== undefined && settledThinking.reasoningTokens === 480 && settledThinking.streaming !== true)
  check('the assistant text settles', channel.rows.some(row => row.kind === 'assistant' && row.text === 'Hi there' && row.streaming !== true))
  check('turn.end closes the turn', !channel.working)
  check('turn.end cost becomes the backend cost report', channel.costReport?.amount === 0.0042 && channel.costReport.source === 'backend')
  first.emit([{ type: 'notice', level: 'warning', text: 'heads up from the backend' }])
  check('a warning notice is a row and a toast', channel.rows.some(row => row.kind === 'notice' && row.text === 'heads up from the backend') && toasts().includes('heads up from the backend'))
  first.emit([{ type: 'session.status', status: 'running' }], { wake: 'none' })
  check('session.status drives the channel status', channel.status === 'running')
  first.emit([{ type: 'session.status', status: 'idle' }], { wake: 'none' })

  channel.cancel()
  check('cancel reaches session.cancel(user)', await settled(() => first.cancels.includes('user')) && channel.cancelPending)
  first.emit([{ type: 'turn.start', turn: 2, origin: 'user', time: 7 }, { type: 'turn.end', turn: 2, reason: { kind: 'aborted' }, time: 8 }])
  check('the aborted turn releases the cancel gate', !channel.cancelPending)

  check('loadOlder has no history slicing here', channel.loadOlder() === 0)
  channel.pushLocal('/probe', ['line one'])
  check('pushLocal renders local rows', channel.rows.some(row => row.kind === 'local' && row.text === '/probe'))
  const candidates = await channel.listFileCandidates('alpha')
  check('file completion falls back to the local disk', candidates.some(candidate => candidate.path.includes('alpha-module.ts')), candidates)
  const doctor = channel.doctorInfo()
  check('/doctor names the backend', doctor.some(line => line.includes('Fake Agent')))
  channel.clear()
  check('clear resets the transcript', channel.rows.length === 1 && channel.rows[0]!.kind === 'notice')

  // ── explicit unavailability ─────────────────────────────────────────
  const before = toasts().length
  check('agent-view rows read silently', channel.agentViewRows().length === 0 && toasts().length === before)
  check('rewindTo → null + notice', await channel.rewindTo({ id: 0, kind: 'user', text: 'x' }) === null && toasts().includes(unavailableText('rewind')))
  check('forkSession → false', await channel.forkSession() === false && toasts().includes(unavailableText('fork')))
  check('switchModel → false', await channel.switchModel('p', 'm') === false && toasts().includes(unavailableText('model')))
  const resumed = await channel.resumeTo('other')
  check('resumeTo → {ok:false, unavailable}', resumed.ok === false && 'reason' in resumed && resumed.reason === 'unavailable')
  const efforts = await channel.listEfforts()
  check('listEfforts → empty', efforts.efforts.length === 0 && toasts().includes(unavailableText('effort')))
  channel.compact()
  check('compact notifies', toasts().includes(unavailableText('compact')))
  check('promptRewind cancels', await channel.promptRewind({ id: 0, kind: 'user', text: 'x' }) === 'cancel')
  check('buildSessionTree → null', await channel.buildSessionTree() === null)
  check('subagent interrupt → false', channel.subagentControl.interrupt('a') === false)
  check('job kill → false', channel.jobControl.kill('j') === false)
  check('runExternalCommand → undefined (the line goes to the model)', await channel.runExternalCommand('anything', '') === undefined)
  check('mcpStatus answers with the unavailable line', channel.mcpStatus().join('\n').includes(unavailableText('mcp')))
  // 核心轨迹源：非 DSH 会话的 traceEvents 是从 AgentEvent 折叠出的 raw 事件
  // （上面发出的回合已成行），不是 DSH 的 rawHistory。
  check('traceEvents carries the folded stream off DSH', channel.traceEvents().some(event => event.type === 'turn/start'))
  check('permission presets are unavailable', channel.permissionPresets().availability === 'unavailable')

  // ── /new through the backend's own open ─────────────────────────────
  check('/new opens a fresh backend session', await channel.newSession() === true && opened.length === 1)
  const second = opened[0]!
  check('the replaced session is disposed', await settled(() => first.disposed))
  check('the replaced session is unsubscribed', first.listenerCount() === 0 && second.listenerCount() === 1)
  check('sessionRef follows /new', channel.sessionRef.sessionId === second.ref.sessionId && channel.agentId === second.ref.sessionId)
  check('cost report resets with the session', channel.costReport === undefined)
  check('the trajectory fold resets with the session', channel.traceEvents().length === 0 && channel.trajectorySource() === 'empty')
  const rowsBefore = channel.rows.length
  first.emit([{ type: 'notice', level: 'info', text: 'stale event from the old session' }])
  check('a replaced session cannot write the transcript', channel.rows.length === rowsBefore)
  channel.submit('second session')
  check('input follows the new session', await settled(() => second.submits.length === 1) && first.submits.length === 1)
} finally {
  channel.releaseContributions()
}

// ── capability-backed delegates ───────────────────────────────────────
{
  const calls: string[] = []
  let mode = 'default'
  const capable = fakeSession('33333333-3333-4333-8333-333333333333', {
    pendingRetraction: { remove: () => true },
    compact: { run: () => { calls.push('compact'); return Promise.resolve() } },
    modes: { list: () => [{ id: 'default', label: 'Default' }, { id: 'plan', label: 'Plan' }], current: () => mode, set: id => { mode = id; calls.push(`mode:${id}`); return Promise.resolve() } },
    models: { list: () => Promise.resolve([{ id: 'haiku', label: 'Haiku' }]), current: () => ({ model: 'haiku' }), set: ref => { calls.push(`model:${ref.model}`); return Promise.resolve({ kind: 'switched' as const }) } },
    effort: { levels: () => [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], current: () => 'low', set: id => { calls.push(`effort:${id}`); return Promise.resolve() } },
    fork: { fork: () => { calls.push('fork'); return Promise.resolve({ backendId: 'fake', sessionId: 'forked' }) } },
  })
  const backed = createChannel(ctx, capable, { model: 'm', provider: '', cwd: workdir, activity: false })
  try {
    const offered = backed.commandList.map(command => command.name)
    check('declared capabilities offer their commands', ['compact', 'model', 'effort', 'fork'].every(name => offered.includes(name)))
    check('retractPending flows into the snapshot', backed.backendCapabilities.retractPending)
    check('composition facts follow the session: /compact routes to the channel action', backed.capabilities().compact.route === 'local' && backed.capabilities().plan.route === 'none')
    backed.compact()
    await backed.cycleMode()
    const switched = await backed.switchModel('', 'haiku')
    const effortSet = await backed.setEffort('high')
    const forked = await backed.forkSession()
    check('actions delegate to the typed capabilities', switched && effortSet && forked && JSON.stringify(calls) === JSON.stringify(['compact', 'mode:plan', 'model:haiku', 'effort:high', 'fork']), calls)
    check('a capability-backed action does not report unavailability', !backed.notifications.some(item => item.text.startsWith(t('capability-unavailable-backend', { name: '' }).trim().split(':')[0]!)))
  } finally {
    backed.releaseContributions()
  }
}

// ── rejecting capabilities, silent boot effort, no fold, `!!` after the
//    session closed, backend config normalization ────────────────────────
{
  const failing = fakeSession('44444444-4444-4444-8444-444444444444', {
    modes: { list: () => [{ id: 'default', label: 'Default' }, { id: 'plan', label: 'Plan' }], current: () => 'default', set: () => Promise.reject(new Error('mode refused by cli')) },
    models: { list: () => Promise.reject(new Error('catalog down')), current: () => ({ model: 'm' }), set: () => Promise.reject(new Error('switch refused')) },
  })
  failing.submit = () => Promise.reject(new Error('session closed'))
  const shell = { resolve: (request: unknown) => request, run: () => Promise.resolve({ stdout: { text: 'shell-out' }, stderr: { text: '' }, timedOut: false }) }
  const shellCtx = { on: () => () => undefined, get: (name: string) => name === 'shell' ? shell : undefined, logger: { warn: () => undefined, info: () => undefined, debug: () => undefined } } as never
  const guarded = createChannel(shellCtx, failing, { model: 'm', provider: '', cwd: workdir, activity: false })
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    await guarded.cycleMode()
    check('a rejecting mode capability resolves and reports', guarded.notifications.some(item => item.text === t('capability-failed', { name: 'mode', err: 'mode refused by cli' })))
    check('a rejecting model list answers empty', (await guarded.listModels()).length === 0)
    check('a rejecting model switch answers false', await guarded.switchModel('', 'x') === false)
    const toastCount = guarded.notifications.length
    guarded.setDefaultEffort(undefined)
    check('the boot-time default effort apply is silent', guarded.notifications.length === toastCount)
    for (let index = 0; index < MAX_ROWS + 20; index += 1) guarded.pushLocal(`/row-${index}`, [])
    failing.emit([
      { type: 'turn.start', turn: 1, origin: 'user', time: 1 },
      { type: 'user.message', id: 'u1', anchor: 'u1', seq: 1, turn: 1, time: 1, source: 'user', text: 'x'.repeat(400), blocks: [{ type: 'text', text: 'x'.repeat(400) }] },
      { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 2 },
    ])
    for (let index = 0; index < MAX_ROWS; index += 1) guarded.pushLocal(`/tail-${index}`, [])
    check('rows past the window are never folded without history slicing', !guarded.rows.some(row => row.folded === true) && guarded.rows.some(row => row.kind === 'user' && row.text.length === 400))
    guarded.submit('!!echo hi')
    check('`!!` after the session closed reports instead of rejecting', await settled(() => guarded.notifications.some(item => item.text === t('send-failed', { err: 'session closed' }))))
    await new Promise(resolve => setImmediate(resolve))
    check('no unhandled rejection escaped', unhandled.length === 0, unhandled.map(String))
  } finally {
    process.off('unhandledRejection', onUnhandled)
    guarded.releaseContributions()
  }
  check('backend choice: case and blanks normalize', normalizeBackendChoice(' Claude ') === 'claude' && normalizeBackendChoice('DSH') === 'dsh')
  check('backend choice: empty or unknown → default', normalizeBackendChoice('') === undefined && normalizeBackendChoice('gpt') === undefined && normalizeBackendChoice(undefined) === undefined)
  const parse = (backend: unknown): unknown => (Config as unknown as (value: unknown) => { backend?: unknown })({ backend }).backend
  check('Config accepts a stray DSH_TUI_BACKEND value without failing the boot', parse('Claude') === 'claude' && parse('') === undefined && parse('nonsense') === undefined && parse(undefined) === undefined)
}

// ── prompts park in the stores Chat renders, per binding ──────────────
{
  const permissions = new PermissionStore()
  const questions = new QuestionStore()
  const responses: { requestId: string; decision: PermissionDecision }[] = []
  const asking = (sessionId: string): FakeSession => fakeSession(sessionId, {
    permissions: { respond: (requestId, decision) => { responses.push({ requestId, decision }) }, pending: () => [] },
    questions: { respond: () => undefined, cancel: () => undefined },
  })
  const firstAsker = asking('55555555-5555-4555-8555-555555555555')
  const nextAsker = asking('66666666-6666-4666-8666-666666666666')
  const prompted = createChannel(ctx, firstAsker, {
    model: 'm', provider: '', cwd: workdir, activity: false,
    interaction: { permissions, questions },
    openSession: () => Promise.resolve(nextAsker),
  })
  try {
    const request = { requestId: 'req-1', toolName: 'Bash', command: 'ls', options: [{ id: 'allow-once', kind: 'allow-once' as const }, { id: 'reject', kind: 'reject' as const }] }
    firstAsker.emit([{ type: 'permission.request', request }])
    check('a session prompt parks in the shared store', permissions.getSnapshot()?.command === 'ls' && permissions.getSnapshot()?.agentId === firstAsker.ref.sessionId)
    check('the capability snapshot declares permissions', prompted.backendCapabilities.permissions)
    permissions.decide('allowed-once')
    check('the panel decision reaches the session', responses.length === 1 && responses[0]!.requestId === 'req-1' && responses[0]!.decision.kind === 'allow-once')
    firstAsker.emit([{ type: 'permission.request', request: { ...request, requestId: 'req-2' } }])
    firstAsker.emit([{ type: 'question.request', request: { requestId: 'q-1', questions: [{ question: 'Pick?', options: [{ label: 'a' }] }] } }])
    check('a session question opens the questionnaire', questions.getSnapshot()?.question.question === 'Pick?')
    check('/new replaces the session', await prompted.newSession() === true)
    check('the replaced session\'s prompts are withdrawn with it', await settled(() => permissions.getSnapshot() === null && questions.getSnapshot() === null) && responses.length === 1)
    nextAsker.emit([{ type: 'permission.request', request: { ...request, requestId: 'req-3' } }])
    check('the new session\'s prompts park', permissions.getSnapshot()?.agentId === nextAsker.ref.sessionId)
  } finally {
    prompted.releaseContributions()
  }
  check('releasing the channel withdraws the open prompt', permissions.getSnapshot() === null && responses.length === 1)
}

// ── /new never races a turn or a prompt during the open ──────────────
{
  const current = fakeSession('77777777-7777-4777-8777-777777777777')
  let release: ((session: FakeSession) => void) | undefined
  const racing = createChannel(ctx, current, {
    model: 'm', provider: '', cwd: workdir, activity: false,
    openSession: () => new Promise<FakeSession>(resolve => { release = resolve }),
  })
  const opening = async (): Promise<() => void> => {
    release = undefined
    await settled(() => release !== undefined)
    return () => undefined
  }
  try {
    // A turn starts on the current session while the new one is opening.
    const first = racing.newSession()
    await opening()
    current.emit([{ type: 'turn.start', turn: 1, origin: 'user', time: 1 }])
    const candidate = fakeSession('88888888-8888-4888-8888-888888888888')
    release!(candidate)
    check('/new is abandoned when a turn started during the open', await first === false)
    check('… the candidate is disposed', await settled(() => candidate.disposed))
    check('… the current session stays bound and alive', !current.disposed && current.listenerCount() === 1 && racing.sessionRef.sessionId === current.ref.sessionId)
    check('… and the user is told why', racing.notifications.some(item => item.text === t('new-session-raced')))
    current.emit([{ type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 2 }])
    // A prompt sent while the new session is opening (not started yet).
    const second = racing.newSession()
    await opening()
    racing.submit('typed while the new session opened')
    await settled(() => current.submits.length === 1)
    const candidate2 = fakeSession('99999999-9999-4999-8999-999999999999')
    release!(candidate2)
    check('/new is abandoned when a prompt arrived during the open', await second === false && await settled(() => candidate2.disposed))
    check('… the prompt went to the session it was typed in', current.submits[0]!.input.text === 'typed while the new session opened' && !current.disposed)
    // Nothing raced: the switch proceeds.
    current.emit([{ type: 'pending.changed', items: [], claimed: [current.submits[0]!.input.clientMessageId] }], { wake: 'none' })
    const third = racing.newSession()
    await opening()
    const candidate3 = fakeSession('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    release!(candidate3)
    check('an uncontested /new still switches', await third === true && racing.sessionRef.sessionId === candidate3.ref.sessionId && await settled(() => current.disposed))
    // A whole turn that started and ended during the open (`working` is
    // false again, nothing pending) still races the switch.
    const fourth = racing.newSession()
    await opening()
    candidate3.emit([{ type: 'turn.start', turn: 1, origin: 'user', time: 1 }])
    candidate3.emit([{ type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 2 }])
    const candidate4 = fakeSession('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4')
    release!(candidate4)
    check('/new is abandoned when a whole turn came and went during the open', await fourth === false && await settled(() => candidate4.disposed) && racing.sessionRef.sessionId === candidate3.ref.sessionId && !racing.working)
  } finally {
    racing.releaseContributions()
  }
}

// ── /new never drops an input still in the channel's FIFO ──────────
{
  let releaseRead: (() => void) | undefined
  const slowFs = {
    resolve: (path: string) => Promise.resolve({ displayPath: path }),
    stat: () => Promise.resolve({ type: 'file' as const }),
    readText: () => new Promise<string>(resolve => { releaseRead = () => resolve('slow file body') }),
    listDir: () => Promise.resolve([]),
  }
  let releaseShell: (() => void) | undefined
  const slowShell = {
    resolve: (request: unknown) => request,
    run: () => new Promise<{ stdout: { text: string }; stderr: { text: string }; timedOut: boolean }>(resolve => {
      releaseShell = () => resolve({ stdout: { text: 'shell output' }, stderr: { text: '' }, timedOut: false })
    }),
  }
  const fsCtx = { on: () => () => undefined, get: (name: string) => name === 'fs' ? slowFs : name === 'shell' ? slowShell : undefined, logger: { warn: () => undefined, info: () => undefined, debug: () => undefined } } as never
  const current = fakeSession('c5c5c5c5-c5c5-4c5c-8c5c-c5c5c5c5c5c5')
  let release: ((session: FakeSession) => void) | undefined
  let opens = 0
  const parked = createChannel(fsCtx, current, {
    model: 'm', provider: '', cwd: workdir, activity: false,
    openSession: () => { opens += 1; return new Promise<FakeSession>(resolve => { release = resolve }) },
    sessionCatalog: { list: () => Promise.resolve([]) },
  })
  const toasts = (): string[] => parked.notifications.map(item => item.text)
  try {
    // The `@` read parks the input in the FIFO: not pending, not working.
    parked.submit('read @notes.txt please')
    check('an @-mention read parks the input in the FIFO', await settled(() => releaseRead !== undefined) && parked.pending.length === 0 && current.submits.length === 0)
    // Refused at once (no handshake first), and the toast names the input.
    check('/new is refused at once while an input is still on its way, naming it', await parked.newSession() === false && opens === 0
      && toasts().includes(t('session-switch-input-parked', { input: 'read @notes.txt please' })) && parked.sessionRef.sessionId === current.ref.sessionId, toasts())
    const before = toasts().filter(text => text === t('session-switch-input-parked', { input: 'read @notes.txt please' })).length
    check('/resume likewise (refused at once, nothing opened)', (await parked.resumeTo('d0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0')).ok === false && opens === 0
      && toasts().filter(text => text === t('session-switch-input-parked', { input: 'read @notes.txt please' })).length === before + 1, toasts())
    releaseRead!()
    check('… and the parked input reaches the session it was typed in', await settled(() => current.submits.length === 1) && current.submits[0]!.input.text === 'read @notes.txt please')
    // `!!` is an input from its first keystroke: its output goes to the session.
    parked.submit('!!make test')
    await settled(() => releaseShell !== undefined)
    check('/new is refused at once while a `!!` command is on its way', await parked.newSession() === false && opens === 0 && toasts().includes(t('session-switch-input-parked', { input: '!!' })), toasts())
    releaseShell!()
    check('… and its output reaches the session it ran for', await settled(() => current.submits.length === 2) && (current.submits[1]!.input.text).includes('shell output'))
    // An input parked during the open still abandons the candidate (the race).
    releaseRead = undefined
    const opening = parked.newSession()
    await settled(() => release !== undefined)
    parked.submit('read @notes.txt again')
    await settled(() => releaseRead !== undefined)
    const candidate = fakeSession('c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c6c6')
    release!(candidate)
    check('/new is abandoned when an input parks while it opens', await opening === false && await settled(() => candidate.disposed) && parked.sessionRef.sessionId === current.ref.sessionId)
    releaseRead!()
    check('… and that input reaches the session it was typed in', await settled(() => current.submits.length === 3) && current.submits[2]!.input.text === 'read @notes.txt again')
  } finally {
    parked.releaseContributions()
  }
}

// ── a raced /new never attaches its candidate first ─────────────────
{
  const { createCoreChannel } = await import('../src/dsh-adapter/channel/core/compose.js')
  const { createChannelOwner } = await import('../src/dsh-adapter/channel/owner.js')
  const owner = createChannelOwner()
  const current = fakeSession('d7d7d7d7-d7d7-4d7d-8d7d-d7d7d7d7d7d7')
  const core = createCoreChannel(ctx, current, { model: 'm', provider: '', cwd: workdir, activity: false }, owner)
  let release: ((session: FakeSession) => void) | undefined
  const attached: string[] = []
  core.extend({
    newSession: {
      available: () => true,
      plan: () => Promise.resolve({
        open: () => new Promise<FakeSession>(resolve => { release = resolve }),
        attach: candidate => { attached.push(candidate.ref.sessionId); return Promise.resolve() },
        adopt: candidate => candidate.ref.sessionId,
      }),
    },
  })
  const state = core.start()
  try {
    const opening = state.newSession()
    await settled(() => release !== undefined)
    current.emit([{ type: 'turn.start', turn: 1, origin: 'user', time: 1 }])
    const candidate = fakeSession('d8d8d8d8-d8d8-4d8d-8d8d-d8d8d8d8d8d8')
    release!(candidate)
    check('a raced candidate is abandoned BEFORE its workspace attach', await opening === false && attached.length === 0 && await settled(() => candidate.disposed))
  } finally {
    state.releaseContributions()
  }
}

// ── backend-neutral features on a non-DSH session ────────────────────
{
  // IDE selection: a real loopback IDE fixture pushes a selection; the
  // submit attaches it and the confirmed user row shows the indicator.
  const fixture = await startWsFixture('tok-backend-channel', [workdir], { clearSelectionAfterMs: null })
  process.env.DSH_TUI_IDE_PORT = String(fixture.port)
  process.env.DSH_TUI_IDE_TOKEN = 'tok-backend-channel'
  const commands: string[] = []
  const shell = {
    resolve: (request: unknown) => request,
    run: (spec: { command: string }) => {
      commands.push(spec.command)
      return Promise.resolve({ stdout: { text: spec.command.startsWith('git branch') ? 'feature-x\n' : 'ran' }, stderr: { text: '' }, timedOut: false })
    },
  }
  const shellCtx = { on: () => () => undefined, get: (name: string) => name === 'shell' ? shell : undefined, logger: { warn: () => undefined, info: () => undefined, debug: () => undefined } } as never
  const neutral = fakeSession('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
  const channel = createChannel(shellCtx, neutral, { model: 'm', provider: '', cwd: workdir, activity: false, backendLabel: 'Fake Agent' })
  try {
    check('IDE selection reaches a non-DSH channel', await settled(() => channel.selection !== undefined, { timeoutMs: 5000 }))
    channel.submit('explain the selection')
    check('… and is attached to the submitted message', await settled(() => neutral.submits.length === 1) && (neutral.submits[0]!.input.blocks ?? []).some(block => block.type === 'text' && typeof block.text === 'string' && block.text.includes('fa.ts')), neutral.submits[0]?.input.blocks)
    const id = neutral.submits[0]!.input.clientMessageId
    neutral.emit([
      { type: 'turn.start', turn: 1, origin: 'user', userMessageId: id, time: 1 },
      { type: 'user.message', id, anchor: id, seq: 1, turn: 1, time: 1, source: 'user', text: 'explain the selection', blocks: [{ type: 'text', text: 'explain the selection' }] },
      { type: 'step.start', turn: 1, step: 1 },
      { type: 'assistant.attempt.start', attemptId: 'm1', turn: 1, step: 1 },
      { type: 'assistant.message', seq: 2, anchor: 'm1', turn: 1, step: 1, attemptId: 'm1', time: 2, canonical: true, blocks: [{ type: 'text', text: 'It lists three files.' }] },
      { type: 'step.end', turn: 1, step: 1 },
      { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 3 },
    ])
    check('… the user row shows the selection indicator', channel.rows.some(row => row.kind === 'user' && row.selectionAttached !== undefined))
    check('the git branch breadcrumb works on a non-DSH session', await settled(() => channel.gitBranch === 'feature-x') && commands[0] === 'git branch --show-current')
    check('/export is offered', channel.commandList.some(command => command.name === 'export') && channel.backendCapabilities.commands.includes('export'))
    const exported = channel.exportSession()
    const text = exported === null ? '' : readFileSync(exported, 'utf8')
    check('/export writes the projected transcript', exported !== null && text.includes('explain the selection') && text.includes('It lists three files.'), exported)
    channel.submit('!echo hi')
    check('`!cmd` runs in the workspace shell, its target badge on the row', await settled(() => channel.rows.some(row => row.kind === 'local-output' && row.text === 'ran')) && channel.rows.some(row => row.kind === 'local' && row.text === 'echo hi' && row.executionTarget !== undefined))
  } finally {
    channel.releaseContributions()
    delete process.env.DSH_TUI_IDE_PORT
    delete process.env.DSH_TUI_IDE_TOKEN
    fixture.close()
  }
  check('releasing the channel disposes the session it owns', await settled(() => neutral.disposed))
}

// ── DSH keeps its full command list ───────────────────────────────────
{
  const stubAgentCtx = { on: () => () => undefined }
  const agent = {
    id: 'dsh-1', status: 'idle', session: { id: 'dsh-1', seq: 0, events: [] }, ctx: stubAgentCtx,
    followup: () => undefined, steer: () => undefined, inbox: { remove: () => true },
  }
  const dsh = createChannel(ctx, agent as never, { model: 'deepseek-chat', provider: 'deepseek', cwd: workdir, activity: false })
  try {
    check('a DSH session supports every built-in command', JSON.stringify(dsh.backendCapabilities.commands) === JSON.stringify(LOCAL_COMMANDS.map(command => command.name)))
    // The expected list: the built-ins, with the entries whose composition
    // route is missing re-described by `annotateCommandCapabilities` (this
    // bare fixture mounts neither a compaction service nor a `/plan`
    // registry command).
    const today = annotateCommandCapabilities(LOCAL_COMMANDS, dsh.capabilities())
    check('the DSH command list is today\'s list', JSON.stringify(dsh.commandList) === JSON.stringify(today) && today.some(command => command.descriptionKey === 'cmd-desc-compact-unavailable'))
    check('DSH snapshot is all-capable', dsh.backendCapabilities.backendId === 'dsh' && dsh.backendCapabilities.retractPending && dsh.backendCapabilities.rewind && dsh.backendCapabilities.models && dsh.backendCapabilities.resume)
    check('DSH sessionRef', dsh.sessionRef.backendId === 'dsh' && dsh.sessionRef.sessionId === 'dsh-1')
    check('DSH reports no backend cost', dsh.costReport === undefined)
  } finally {
    dsh.releaseContributions()
  }
}

// ── /mcp reports and controls are fenced by the bound session ────────
{
  // An MCP answer belongs to one session: a slow /mcp on A must not
  // overwrite the report (or the `/mcp reconnect|toggle` completion) of the
  // session that replaced it, also when the user comes back to A (a promise
  // of the old binding generation is still old). A reconnect or toggle
  // completing after a switch must neither refresh nor toast for the new
  // session.
  interface Row { name: string; status: string; toolCount?: number }
  const rows = (names: string[]): Row[] => names.map(name => ({ name, status: 'connected', toolCount: 1 }))
  const probe = () => {
    const calls: ((list: readonly Row[]) => void)[] = []
    const controlPending: (() => void)[] = []
    const state = {
      servers: [] as Row[],
      auto: false,
      autoControls: false,
      controls: [] as string[],
      answer(index: number, names: string[]): void { calls[index]?.(rows(names)) },
      releaseControls(): void { for (const done of controlPending.splice(0)) done() },
    }
    const mcp = {
      status: () => new Promise<readonly Row[]>(resolve => { if (state.auto) resolve([...state.servers]); else calls.push(resolve) }),
      reconnect: (name: string) => { state.controls.push(`reconnect:${name}`); return state.autoControls ? Promise.resolve() : new Promise<void>(done => { controlPending.push(done) }) },
      toggle: (name: string, enabled: boolean) => { state.controls.push(`toggle:${name}:${enabled}`); return state.autoControls ? Promise.resolve() : new Promise<void>(done => { controlPending.push(done) }) },
    }
    return { state, mcp }
  }
  const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
  const A = probe()
  const B = probe()
  const C = probe()
  B.state.auto = true; B.state.servers = rows(['beta-server'])
  C.state.auto = true; C.state.servers = rows(['gamma-server'])
  const sessionA = fakeSession('e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1', { mcp: A.mcp })
  const byId = new Map([[sessionA.ref.sessionId, sessionA]])
  let created = 0
  const mcpChannel = createChannel(ctx, sessionA, {
    model: 'm', provider: '', cwd: workdir, activity: false, backendLabel: 'Fake Agent',
    openSession: target => {
      if (target.kind === 'resume') return Promise.resolve(byId.get(target.sessionId)!)
      created += 1
      const next = created === 1
        ? fakeSession(`b2b2b2b2-b2b2-42b2-82b2-${String(created).padStart(12, '0')}`, { mcp: B.mcp })
        : fakeSession(`c3c3c3c3-c3c3-43c3-83c3-${String(created).padStart(12, '0')}`, { mcp: C.mcp })
      byId.set(next.ref.sessionId, next)
      return Promise.resolve(next)
    },
    sessionCatalog: { list: async () => [] },
  })
  const serversOf = (): string[] => mcpChannel.commandCompletions('/mcp reconnect ').map(item => item.name.replace(/^mcp reconnect /u, ''))
  const toastsOf = (): string[] => mcpChannel.notifications.map(item => item.text)
  try {
    check('a fresh /mcp answers the loading line', mcpChannel.mcpStatus().join('\n') === t('backend-mcp-loading'))
    mcpChannel.mcpStatus() // a second ask of the same binding, kept pending for the generation case
    check('/new switches to the second session', await mcpChannel.newSession() === true)
    await settled(() => serversOf().includes('beta-server'))
    // The answer A owed its own /mcp lands now, one session too late.
    A.state.answer(1, ['alpha-stale-server'])
    await tick()
    check('a delayed status of the replaced session does not pollute the completion', JSON.stringify(serversOf()) === JSON.stringify(['beta-server']), serversOf().join(','))
    check('… nor the report the next /mcp reads', mcpChannel.mcpStatus().some(line => line.includes('beta-server')) && !mcpChannel.mcpStatus().join('\n').includes('alpha-stale-server'), mcpChannel.mcpStatus().join('\n'))

    // Back on A (a new binding generation): the promise parked by the first
    // A binding is old even though the same session object is bound again;
    // only the binding generation tells the two A bindings apart.
    A.state.auto = true; A.state.servers = rows(['alpha-fresh'])
    check('resume lands back on A', (await mcpChannel.resumeTo(sessionA.ref.sessionId)).ok === true)
    await settled(() => serversOf().includes('alpha-fresh'))
    A.state.answer(2, ['alpha-older'])
    await tick()
    check('a promise of the FIRST A binding is not accepted on the re-bound A', JSON.stringify(serversOf()) === JSON.stringify(['alpha-fresh']), serversOf().join(','))
    check('… and the report the next /mcp reads is the fresh one', mcpChannel.mcpStatus().some(line => line.includes('alpha-fresh')) && !mcpChannel.mcpStatus().join('\n').includes('alpha-older'), mcpChannel.mcpStatus().join('\n'))

    // A control (toggle) held across a switch: completing it later must not
    // refresh or toast for the session that replaced the one it asked about.
    check('/new switches to the third session', await mcpChannel.newSession() === true)
    await settled(() => serversOf().includes('gamma-server'))

    const toggling = mcpChannel.mcpControl({ action: 'toggle', name: 'gamma-server', enabled: false })
    check('resume lands back on A again', (await mcpChannel.resumeTo(sessionA.ref.sessionId)).ok === true)
    await settled(() => serversOf().includes('alpha-fresh'))
    C.state.releaseControls()
    check('the delayed toggle itself still succeeds', await toggling === true)
    await tick()
    check('a control completing after a switch does not toast for the new session', !toastsOf().includes(t('mcp-disabled', { name: 'gamma-server' })), toastsOf().join(' | '))
    A.state.autoControls = true
    check('a control of the CURRENT session still reports', await mcpChannel.mcpControl({ action: 'reconnect', name: 'alpha-fresh' }) === true && toastsOf().includes(t('mcp-reconnected', { name: 'alpha-fresh' })), toastsOf().join(' | '))
  } finally {
    mcpChannel.releaseContributions()
  }
}

// ── bare /effort explains itself on 0/1-tier routes ─────────────────
{
  // The Chat slider assumes listEfforts already said why it cannot open
  // (Chat.tsx returns silently for <= 1 tiers). The DSH specialist does
  // that, and every other backend has to as well.
  const empty = fakeSession('d1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1', {
    effort: { levels: () => [], current: () => undefined, set: () => Promise.resolve() },
  })
  const emptyChannel = createChannel(ctx, empty, { model: 'm', provider: '', cwd: workdir, activity: false })
  try {
    const list = await emptyChannel.listEfforts()
    check('a 0-tier effort route reports the unsupported model', list.efforts.length === 0 && emptyChannel.notifications.some(item => item.text === t('effort-unsupported')), emptyChannel.notifications.map(item => item.text).join(' | '))
  } finally { emptyChannel.releaseContributions() }
  const single = fakeSession('d2d2d2d2-d2d2-42d2-82d2-d2d2d2d2d2d2', {
    effort: { levels: () => [{ id: 'medium', label: 'Medium' }], current: () => 'medium', set: () => Promise.resolve() },
  })
  const singleChannel = createChannel(ctx, single, { model: 'm', provider: '', cwd: workdir, activity: false })
  try {
    const list = await singleChannel.listEfforts()
    check('a single-tier effort route says so', list.efforts.length === 1 && singleChannel.notifications.some(item => item.text === t('effort-single-tier', { name: 'Medium' })), singleChannel.notifications.map(item => item.text).join(' | '))
  } finally { singleChannel.releaseContributions() }
}
// ── backend-native permission modes (capabilities.modes) ────────────
// /permission over the typed `modes` capability: the channel exposes the
// roster (listModes) and the switch (setMode), the command surface offers
// /permission exactly when the session declares modes, and Tab completion
// lists the mode ids with the current one tagged. A backend without modes
// gets no command and no completion, and the passive roster read stays
// silent (an empty list is the answer).
{
  const sets: string[] = []
  let current = 'acceptEdits'
  const modeful = fakeSession('f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1', {
    modes: {
      list: () => [{ id: 'default', label: 'Default' }, { id: 'acceptEdits', label: 'Accept edits' }, { id: 'plan', label: 'Plan' }],
      current: () => current,
      set: id => { sets.push(id); current = id; return Promise.resolve() },
    },
  })
  const modeChannel = createChannel(ctx, modeful, { model: 'm', provider: '', cwd: workdir, activity: false, backendLabel: 'Fake Agent' })
  try {
    const roster = modeChannel.listModes()
    check('listModes maps the capability list with the current index', JSON.stringify(roster) === JSON.stringify({ modes: [{ id: 'default', name: 'Default' }, { id: 'acceptEdits', name: 'Accept edits' }, { id: 'plan', name: 'Plan' }], currentIndex: 1 }), JSON.stringify(roster))
    const offered = modeChannel.commandList.map(command => command.name)
    check('a modes-capable backend offers /permission', offered.includes('permission') && modeChannel.commandList.find(command => command.name === 'permission')?.descriptionKey === 'cmd-desc-permission', offered.join(','))
    check('snapshot commands == offered list (the modes injection keeps the invariant)', JSON.stringify(modeChannel.backendCapabilities.commands) === JSON.stringify(offered))
    check('setMode delegates to the typed capability', await modeChannel.setMode('plan') === true && JSON.stringify(sets) === JSON.stringify(['plan']))
    check('setMode refuses an id the backend does not offer', await modeChannel.setMode('bogus') === false && modeChannel.notifications.some(item => item.text === unavailableText('mode')) && JSON.stringify(sets) === JSON.stringify(['plan']))
    const children = modeChannel.commandCompletions('/permission ')
    check('Tab completes /permission with the mode ids', JSON.stringify(children.map(item => item.name)) === JSON.stringify(['permission default', 'permission acceptEdits', 'permission plan']) && children.find(item => item.name === 'permission plan')?.tag === 'current', JSON.stringify(children))
    check('the completion follows a switch (current trails the live mode)', await modeChannel.setMode('default') === true && modeChannel.commandCompletions('/permission ').find(item => item.name === 'permission default')?.tag === 'current')
  } finally {
    modeChannel.releaseContributions()
  }

  const modeless = fakeSession('f2f2f2f2-f2f2-42f2-82f2-f2f2f2f2f2f2')
  const bareChannel = createChannel(ctx, modeless, { model: 'm', provider: '', cwd: workdir, activity: false, backendLabel: 'Fake Agent' })
  try {
    const before = bareChannel.notifications.length
    const roster = bareChannel.listModes()
    check('a backend without modes answers an empty roster, silently', roster.modes.length === 0 && roster.currentIndex === -1 && bareChannel.notifications.length === before, JSON.stringify(roster))
    check('a backend without modes keeps /permission out of the list', !bareChannel.commandList.some(command => command.name === 'permission') && !bareChannel.backendCapabilities.commands.includes('permission'))
    check('… and out of the completion', bareChannel.commandCompletions('/per').length === 0 && bareChannel.commandCompletions('/permission ').length === 0)
  } finally {
    bareChannel.releaseContributions()
  }
}

// ── a late interrupt receipt speaks only for its own request and session ──
{
  type Receipt = Awaited<ReturnType<AgentSession['cancel']>>
  const receipts: ((receipt: Receipt) => void)[] = []
  const withReceipts = (sessionId: string): FakeSession => {
    const session = fakeSession(sessionId)
    session.cancel = cause => {
      session.cancels.push(cause)
      return new Promise<Receipt>(resolve => { receipts.push(resolve) })
    }
    return session
  }
  const current = withReceipts('d0d0d0d0-d0d0-40d0-80d0-d0d0d0d0d0d0')
  const next = withReceipts('d1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1')
  const dock = createChannel(ctx, current, {
    model: 'm', provider: '', cwd: workdir, activity: false,
    openSession: () => Promise.resolve(next),
  })
  const queue = async (text: string): Promise<string> => {
    const before = current.submits.length
    dock.submit(text)
    await settled(() => current.submits.length === before + 1)
    return current.submits.at(-1)!.input.clientMessageId
  }
  const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
  try {
    // Request A: Esc docks a queued message, and the aborted turn ends
    // before A's receipt comes back.
    current.emit([{ type: 'turn.start', turn: 1, origin: 'user', time: 1 }])
    const a = await queue('queued in turn 1')
    check('Esc with a queued message docks it and asks for a receipt', dock.interruptAndDock() === 1 && receipts.length === 1)
    current.emit([{ type: 'turn.end', turn: 1, reason: { kind: 'aborted' }, time: 2 }])
    // Request B on the next turn, A still unanswered.
    current.emit([{ type: 'turn.start', turn: 2, origin: 'user', time: 3 }])
    const b = await queue('queued in turn 2')
    check('a dock on the next turn sends its own request', dock.interruptAndDock() === 1 && receipts.length === 2)
    check('the newer request keeps holding the rows the older one has not vouched for', dock.removePending(a) === false && dock.pending.some(item => item.id === a && item.docked === true))
    receipts[0]!({ stillQueued: [], outcome: 'confirmed' })
    await tick()
    await queue('queued while B is unanswered')
    dock.interruptAndDock()
    check('an older receipt does not release the newer request (later docks still join it)', receipts.length === 2)
    check('the older confirmed receipt frees its own rows', dock.removePending(a) === true && dock.removePending(b) === false)
    receipts[1]!({ stillQueued: [], outcome: 'confirmed' })
    await tick()
    current.emit([{ type: 'turn.end', turn: 2, reason: { kind: 'aborted' }, time: 4 }])
    // Request C answers only after the channel moved to another session.
    current.emit([{ type: 'turn.start', turn: 3, origin: 'user', time: 5 }])
    await queue('queued in turn 3')
    check('a third dock asks for its own receipt', dock.interruptAndDock() > 0 && receipts.length === 3)
    current.emit([{ type: 'turn.end', turn: 3, reason: { kind: 'aborted' }, time: 6 }])
    check('/new adopts while that receipt is out', await dock.newSession() === true && dock.sessionRef.sessionId === next.ref.sessionId)
    const toastsBefore = dock.notifications.length
    receipts[2]!({ stillQueued: [], outcome: 'failed' })
    await tick()
    check('a receipt of the session left behind raises nothing on the new one', dock.notifications.length === toastsBefore && !dock.notifications.some(item => item.text === t('interrupt-failed')))
    next.emit([{ type: 'turn.start', turn: 1, origin: 'user', time: 7 }])
    const before = next.submits.length
    dock.submit('queued on the new session')
    await settled(() => next.submits.length === before + 1)
    check('the new session docks with a request of its own', dock.interruptAndDock() === 1 && receipts.length === 4 && next.cancels.includes('interrupt'))
  } finally {
    dock.releaseContributions()
  }
}
// ── a rewind that outlives its session never replaces the next one ──
{
  type Outcome = Awaited<ReturnType<NonNullable<SessionCapabilities['rewind']>['rewind']>>
  let finishRewind: ((outcome: Outcome) => void) | undefined
  const rewound = fakeSession('e0e0e0e0-e0e0-40e0-80e0-e0e0e0e0e0e0', {
    rewind: { rewind: () => new Promise<Outcome>(resolve => { finishRewind = resolve }) },
  })
  const fresh = fakeSession('e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1')
  const opens: string[] = []
  const rewinder = createChannel(ctx, rewound, {
    model: 'm', provider: '', cwd: workdir, activity: false,
    openSession: target => {
      opens.push(target.kind)
      return Promise.resolve(target.kind === 'create' ? fresh : fakeSession('e2e2e2e2-e2e2-42e2-82e2-e2e2e2e2e2e2'))
    },
  })
  try {
    const pending = rewinder.rewindTo({ id: 1, kind: 'user', text: 'edit me', anchor: 'msg-1' })
    await settled(() => finishRewind !== undefined)
    check('/new lands while the backend is still forking', await rewinder.newSession() === true && rewinder.sessionRef.sessionId === fresh.ref.sessionId)
    finishRewind!({ kind: 'rewound', session: { backendId: 'fake', sessionId: 'fork-1' } })
    check('the late fork does not replace the session the user moved to', await pending === null && rewinder.sessionRef.sessionId === fresh.ref.sessionId && !opens.includes('resume'), opens)
    check('… and the user is told where the fork is', rewinder.notifications.some(item => item.text === t('rewind-fork-kept', { command: '/resume fork-1' })))
  } finally {
    rewinder.releaseContributions()
  }
}
rmSync(workdir, { recursive: true, force: true })
console.log(`\nverify-backend-channel OK (${passed} checks)`)
process.exit(0)
