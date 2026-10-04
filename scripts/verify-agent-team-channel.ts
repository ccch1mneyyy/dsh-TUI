/**
 * Agent-team channel layer regression: the unified agent-message domain and
 * both backends' message capabilities, over pure helpers, the DSH subagent
 * projection, the Claude translator and the channel core. No UI components,
 * no live backend.
 *
 *  A. the neutral fold and vocabulary helpers (agent/messages.ts): state
 *     monotonicity, the DSH relay source shape (a plain user text is never
 *     guessed into a relay), the stable prompt-failure mapping;
 *  B. the DSH subagent projection: durable AgentMessageSource relays fold
 *     into views (parent-directed and child-directed), the direct
 *     continuable prompt submit (receipt → queued; RemoteError codes →
 *     stable reasons; one-shot fail-closed; service absent = no capability),
 *     listChildren roster filtering (continuable only), reset clears;
 *  C. the Claude SendMessage observation: input parsing (no recipient or no
 *     body = no message), a call is only ever issued, result states
 *     (explicit error → refused, structured field → its state, bare success
 *     / unknown shape → unknown), main lane and subagent lane through the
 *     real translator;
 *  D. the channel core over bare sessions: the parent-mediated control is
 *     composed only when the session declares the capability (absence = no
 *     member, no UI), the submit envelope rides the ordinary FIFO as a
 *     fixed followup and reports issued, listTargets mirrors the roster;
 *  E. the Claude session end to end over the fake SDK: SendMessage tool
 *     traffic folds into the session's own message capability.
 *
 * Run: node --import tsx/esm scripts/verify-agent-team-channel.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-agent-team-channel-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.FORCE_COLOR = '3'

const [
  { setLang },
  { foldAgentMessage, agentRelaySourceOf, agentMessageTextOf, agentMessageFailureOf, MAX_AGENT_MESSAGES },
  { createSubagentProjection },
  { parseSendMessageInput, sendMessageCallView, sendMessageResultState },
  { createClaudeTranslator },
  { openClaudeSession },
  { createChannel },
  fakes,
] = await Promise.all([
  import('../src/i18n.js'),
  import('../src/agent/messages.js'),
  import('../src/dsh-adapter/channel/subagent-projection.js'),
  import('../src/backends/claude/send-message.js'),
  import('../src/backends/claude/translate.js'),
  import('../src/backends/claude/session.js'),
  import('../src/dsh-adapter/channel.js'),
  import('./lib/claude-fake-sdk.js'),
])

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
const settled = async (probe: () => boolean, attempts = 50): Promise<boolean> => {
  for (let i = 0; i < attempts; i++) {
    if (probe()) return true
    await new Promise(resolve => setImmediate(resolve))
  }
  return probe()
}
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

// ── Section A: the neutral fold and vocabulary helpers ────────────────────
{
  const views: import('../src/adapter/ports/channel-view.js').AgentMessageView[] = []
  foldAgentMessage(views, { messageId: 'call-1', via: 'parent-mediated', text: 'ship it', state: 'issued', observedAt: 1 })
  check('A1 a new observation appends one view', views.length === 1 && views[0]!.messageId === 'call-1' && views[0]!.state === 'issued')
  foldAgentMessage(views, { messageId: 'call-1', via: 'parent-mediated', text: '', state: 'unknown', observedAt: 2 })
  check('A2 the settlement updates the SAME row (no text, no regression)', views.length === 1 && views[0]!.state === 'unknown' && views[0]!.text === 'ship it' && views[0]!.observedAt === 2)
  foldAgentMessage(views, { messageId: 'call-1', via: 'parent-mediated', text: '', state: 'delivered', observedAt: 3 })
  check('A3 unknown stays terminal (a later delivered is dropped)', views[0]!.state === 'unknown')
  foldAgentMessage(views, { messageId: 'm2', via: 'direct-continuable', text: 'later', state: 'queued', observedAt: 4 })
  foldAgentMessage(views, { messageId: 'm2', via: 'direct-continuable', text: '', state: 'issued', observedAt: 5 })
  check('A4 queued never regresses to issued', views[1]!.state === 'queued')
  foldAgentMessage(views, { messageId: 'm2', via: 'direct-continuable', text: '', state: 'delivered', observedAt: 6 })
  check('A5 queued advances to an explicit delivered', views[1]!.state === 'delivered')
  const bounded: import('../src/adapter/ports/channel-view.js').AgentMessageView[] = []
  for (let i = 0; i < MAX_AGENT_MESSAGES + 25; i++) bounded.push({ messageId: `m${i}`, via: 'agent-relay', text: '', state: 'queued', observedAt: i })
  const copy = [...bounded]
  foldAgentMessage(copy, { messageId: 'fresh', via: 'agent-relay', text: '', state: 'queued', observedAt: 0 })
  check('A6 the store stays bounded, newest kept', copy.length === MAX_AGENT_MESSAGES && copy[copy.length - 1]!.messageId === 'fresh')

  check('A7 a relay source is recognized exactly', agentRelaySourceOf({ kind: 'agent-message', form: 'relay', senderSessionId: 'child-9' })?.senderSessionId === 'child-9')
  check('A8 a plain user source is not a relay', agentRelaySourceOf({ kind: 'user' }) === undefined)
  check('A9 agent-message without relay form is not a relay', agentRelaySourceOf({ kind: 'agent-message', form: 'recall', senderSessionId: 'x' }) === undefined)
  check('A10 the settlement notice is not a relay', agentRelaySourceOf({ kind: 'subagent-settled', form: 'notice', summary: 'done', senderSessionId: 'x' }) === undefined)
  check('A11 non-object and senderless shapes are not relays', agentRelaySourceOf(undefined) === undefined && agentRelaySourceOf({ kind: 'agent-message', form: 'relay' }) === undefined)
  check('A12 text blocks join and trim', agentMessageTextOf([{ type: 'text', text: ' a ' }, { type: 'image', mediaType: 'image/png', data: '' }, { type: 'text', text: 'b' }]) === 'a b')
  check('A13 non-array content reads empty', agentMessageTextOf(undefined) === '' && agentMessageTextOf('nope') === '')

  const coded = (code: string) => Object.assign(new Error('remote said no'), { code })
  check('A14 the continuation error codes map stably',
    agentMessageFailureOf(coded('subagent/not-resumable')).reason === 'not-resumable'
    && agentMessageFailureOf(coded('subagent/unauthorized')).reason === 'unauthorized'
    && agentMessageFailureOf(coded('subagent/delivery-unavailable')).reason === 'delivery-unavailable'
    && agentMessageFailureOf(coded('subagent/parent-unavailable')).reason === 'parent-unavailable'
    && agentMessageFailureOf(coded('gateway/cancelled')).reason === 'cancelled')
  const aborted = new Error('The operation was aborted')
  aborted.name = 'AbortError'
  check('A15 caller cancellation maps to cancelled', agentMessageFailureOf(aborted).reason === 'cancelled')
  check('A16 anything else is a plain failure with safe text', agentMessageFailureOf(new Error('boom')).reason === 'failed' && agentMessageFailureOf(new Error('boom')).message === 'boom')
}

// ── Section B: the DSH subagent projection ────────────────────────────────
{
  const stateStub = { rows: [], subagents: [] as unknown[], subagentCost: [], emitCount: 0, emit() { this.emitCount += 1 }, emitStream() {} }
  const parentSession = { id: 'sess-parent-1' }
  const agent = { id: 'ag-1', status: 'idle', session: parentSession }
  const childSession = { id: 'sess-child-1' }
  const recordedRequests: unknown[] = []
  let failCode: string | undefined
  const service = {
    prompt: async (request: unknown) => {
      recordedRequests.push(request)
      if (failCode !== undefined) {
        const error = new Error('remote')
        ;(error as { code?: string }).code = failCode
        throw error
      }
      return { messageId: 'msg-77' }
    },
    listChildren: async () => [
      { id: 'child-cont', createdAt: 1, mode: 'continuable', label: 'Scanner' },
      { id: 'child-shot', createdAt: 2, mode: 'one-shot', label: 'Burner' },
      { id: 'child-unk', createdAt: 3, mode: 'unknown' },
    ],
  }
  const projection = createSubagentProjection(() => stateStub as never, {
    rowIds: { value: 0 },
    agent: () => agent as never,
    subagents: () => service,
    lookupChild: () => undefined,
  })
  const control = projection.control
  check('B0 the control exposes the direct continuable capability', control.message !== undefined && control.message.via === 'direct-continuable' && control.message.steer === true)

  // A relay into the parent: durable user/message with AgentMessageSource.
  projection.onSessionEvent(parentSession, { type: 'user/message', seq: 11, time: 111, data: { id: 'relay-1', source: { kind: 'agent-message', form: 'relay', senderSessionId: 'sess-child-1' }, content: [{ type: 'text', text: 'scan finished' }] } })
  let messages = control.message!.messages()
  check('B1 a durable relay folds into a queued child→parent view',
    messages.length === 1 && messages[0]!.messageId === 'relay-1' && messages[0]!.from === 'sess-child-1' && messages[0]!.to === 'sess-parent-1'
    && messages[0]!.via === 'agent-relay' && messages[0]!.state === 'queued' && messages[0]!.text === 'scan finished' && messages[0]!.sourceRef === 'seq:11' && messages[0]!.parentSessionId === 'sess-parent-1',
    messages)

  // Plain user text, injected context and settlement notices are not relays.
  projection.onSessionEvent(parentSession, { type: 'user/message', seq: 12, time: 112, data: { id: 'plain-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'just typing' }] } })
  projection.onSessionEvent(parentSession, { type: 'user/message', seq: 13, time: 113, data: { id: 'inj-1', source: { kind: 'some-plugin' }, content: [{ type: 'text', text: 'injected' }] } })
  projection.onSessionEvent(parentSession, { type: 'user/message', seq: 14, time: 114, data: { id: 'settle-1', source: { kind: 'subagent-settled', form: 'notice', summary: 'done', senderSessionId: 'sess-child-1' }, content: [] } })
  check('B2 ordinary user text is never guessed into a relay', control.message!.messages().length === 1)

  // A relay into a tracked child.
  projection.store.onSpawned('child-1', 'subagent')
  projection.store.linkSession('child-1', childSession)
  projection.onSessionEvent(childSession, { type: 'user/message', seq: 21, time: 121, data: { id: 'relay-2', source: { kind: 'agent-message', form: 'relay', senderSessionId: 'sess-parent-1' }, content: [{ type: 'text', text: 'please continue' }] } })
  messages = control.message!.messages()
  check('B3 a relay into a tracked child folds parent→child', messages.length === 2 && messages[1]!.to === 'child-1' && messages[1]!.from === 'sess-parent-1', messages)

  // The direct prompt submit.
  let result = await control.message!.submit({ targetId: 'child-cont', text: '  focus on tests  ', delivery: 'queue' })
  check('B4 a prompt receipt resolves queued with the durable message id',
    result.ok === true && result.state === 'queued' && result.messageId === 'msg-77' && typeof result.intentId === 'string' && result.intentId.startsWith('tui-'),
    result)
  const request = recordedRequests[recordedRequests.length - 1] as { requestId: string; parentSessionId: string; childSessionId: string; mode: string; delivery: string; content: { type: string; text: string }[] }
  check('B5 the request goes through the control plane verbatim (trimmed, exact parent)',
    request.parentSessionId === 'sess-parent-1' && request.childSessionId === 'child-cont' && request.mode === 'continuable' && request.delivery === 'queue' && request.content.length === 1 && request.content[0]!.text === 'focus on tests',
    request)
  messages = control.message!.messages()
  check('B6 the receipt folds as a user→child queued view', messages.length === 3 && messages[2]!.from === 'user' && messages[2]!.to === 'child-cont' && messages[2]!.via === 'direct-continuable' && messages[2]!.intentId === request.requestId, messages)

  for (const [code, reason] of [['subagent/not-resumable', 'not-resumable'], ['subagent/unauthorized', 'unauthorized'], ['subagent/delivery-unavailable', 'delivery-unavailable'], ['subagent/parent-unavailable', 'parent-unavailable'], ['gateway/cancelled', 'cancelled']] as const) {
    failCode = code
    result = await control.message!.submit({ targetId: 'child-cont', text: 'x', delivery: 'steer' })
    check(`B7 ${code} maps to ${reason}`, result.ok === false && result.reason === reason, result)
  }
  failCode = undefined

  result = await control.message!.submit({ targetId: 'unknown-child', text: 'y', delivery: 'queue' })
  check('B8 an unknown child still reaches the service (its authority decides)', result.ok === true, result)
  projection.store.onDiscovered('child-shot', { mode: 'one-shot' })
  result = await control.message!.submit({ targetId: 'child-shot', text: 'z', delivery: 'queue' })
  check('B9 a known one-shot child fails closed client-side', result.ok === false && result.reason === 'not-resumable', result)
  result = await control.message!.submit({ targetId: 'child-cont', text: '   ', delivery: 'queue' })
  check('B10 empty text refuses locally', result.ok === false && result.reason === 'failed', result)

  const targets = await control.message!.listTargets()
  check('B11 the roster lists continuable children only', targets.length === 1 && targets[0]!.agentId === 'child-cont' && targets[0]!.sessionId === 'child-cont' && targets[0]!.label === 'Scanner' && targets[0]!.mode === 'continuable', targets)

  const bare = createSubagentProjection(() => stateStub as never, { rowIds: { value: 0 }, agent: () => agent as never, subagents: () => undefined, lookupChild: () => undefined })
  const bareResult = await bare.control.message!.submit({ targetId: 'child-cont', text: 'x', delivery: 'queue' })
  check('B12 no continuation service = no capability (unavailable)', bareResult.ok === false && bareResult.reason === 'unavailable', bareResult)
  let rosterFailed = false
  await bare.control.message!.listTargets().catch(() => { rosterFailed = true })
  check('B13 a missing roster read rejects instead of answering empty', rosterFailed)

  projection.reset()
  check('B14 reset clears the observed messages', control.message!.messages().length === 0)
}

// ── Section C: the Claude SendMessage observation ─────────────────────────
{
  check('C1 the tool input parses with either body field', parseSendMessageInput({ to: 'helper', message: 'hi' })?.text === 'hi' && parseSendMessageInput({ to: 'helper', text: 'ho' })?.text === 'ho')
  check('C2 an unaddressable or empty input is not a fact', parseSendMessageInput({ message: 'hi' }) === undefined && parseSendMessageInput({ to: 'helper', message: '' }) === undefined && parseSendMessageInput('nope') === undefined)

  const callMain = sendMessageCallView({ callId: 'call-9', observedAt: 5, input: { to: 'helper', text: 'hi' } })
  check('C3 a parent-lane call observes as issued with no sender id', callMain.messageId === 'call-9' && callMain.from === undefined && callMain.to === 'helper' && callMain.state === 'issued' && callMain.sourceRef === 'call-9' && callMain.via === 'parent-mediated')
  const callLane = sendMessageCallView({ callId: 'call-10', lane: 'toolu_parent', observedAt: 6, input: { to: 'peer', text: 'yo' } })
  check('C4 a subagent-lane call names the lane as sender', callLane.from === 'toolu_parent' && callLane.to === 'peer')

  check('C5 an explicit error result is a refusal', sendMessageResultState({ isError: true, structured: undefined }) === 'refused')
  check('C6 a structured delivery field marks exactly its state', sendMessageResultState({ isError: false, structured: { delivery: 'delivered' } }) === 'delivered' && sendMessageResultState({ isError: false, structured: { status: 'held' } }) === 'held')
  check('C7 a bare success or unknown shape is unknown — never a guessed delivery',
    sendMessageResultState({ isError: false, structured: undefined }) === 'unknown'
    && sendMessageResultState({ isError: false, structured: { ok: true } }) === 'unknown'
    && sendMessageResultState({ isError: false, structured: { delivery: 'queued' } }) === 'unknown')

  const translator = createClaudeTranslator({ cwd: '/fixture', userRows: 'lifecycle', debug: () => undefined })
  const callEvents = translator.translate({ type: 'assistant', message: { id: 'msg_a', model: 'claude', content: [{ type: 'tool_use', id: 'call-77', name: 'SendMessage', input: { to: 'helper', message: 'relay me' } }] } })
  const observed = callEvents.filter(event => event.type === 'agent.message')
  check('C8 the real translator observes the parent SendMessage call as issued', observed.length === 1 && observed[0]!.message.state === 'issued' && observed[0]!.message.messageId === 'call-77', callEvents.map(e => e.type))
  const resultEvents = translator.translate({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-77', content: 'sent' }] } })
  const settledView = resultEvents.filter(event => event.type === 'agent.message')
  check('C9 the bare-success result settles unknown', settledView.length === 1 && settledView[0]!.message.state === 'unknown', resultEvents.map(e => e.type))

  const laneTranslator = createClaudeTranslator({ cwd: '/fixture', userRows: 'lifecycle', debug: () => undefined })
  const laneCall = laneTranslator.translate({ type: 'assistant', parent_tool_use_id: 'toolu_parent', message: { id: 'msg_l', content: [{ type: 'tool_use', id: 'call-88', name: 'SendMessage', input: { to: 'peer', message: 'child to child' } }] } })
  check('C10 a subagent lane observes with the lane as sender', laneCall.some(event => event.type === 'agent.message' && event.message.messageId === 'call-88' && event.message.from === 'toolu_parent' && event.message.to === 'peer'), laneCall.map(e => e.type))
}

// ── Section D: the channel core over bare sessions ────────────────────────
{
  const ctx = { on: () => () => undefined, get: () => undefined, logger: { warn: () => undefined } } as never
  const launchOptions = { model: 'deepseek-chat', cwd: '/tmp', provider: 'deepseek', activity: false }
  const makeSession = (withCapability: boolean) => {
    const state = { submits: [] as { text: string; placement: string }[], listeners: new Set<(batch: readonly unknown[], meta: unknown) => void>() }
    const session = {
      ref: { backendId: 'claude', sessionId: 'cs1' },
      cwd: '/tmp',
      status: 'running' as const,
      capabilities: {
        native: {},
        ...(withCapability ? { subagents: { interrupt: async () => true, messaging: 'parent-mediated' as const } } : {}),
      },
      history: async () => [],
      subscribe(listener: (batch: readonly unknown[], meta: unknown) => void) {
        state.listeners.add(listener)
        return () => { state.listeners.delete(listener) }
      },
      submit(input: { text: string }, placement: string) {
        state.submits.push({ text: input.text, placement })
        return Promise.resolve({ accepted: true })
      },

      cancel: async () => ({ stillQueued: [], outcome: 'confirmed' as const }),
      dispose: async () => {},
    }
    const push = (event: unknown): void => {
      for (const listener of [...state.listeners]) listener([event], { replay: false, wake: 'sync' })
    }
    return { session, state, push }
  }

  // Without the capability: no message member at all (the composer hides).
  const bare = makeSession(false)
  const bareChannel = createChannel(ctx, bare.session as never, launchOptions)
  check('D0 no session capability = no message control', bareChannel.subagentControl.message === undefined)

  // With it: the parent-mediated control over the ordinary submit pipeline.
  const med = makeSession(true)
  const channel = createChannel(ctx, med.session as never, launchOptions)
  const message = channel.subagentControl.message
  check('D1 the parent-mediated control is composed', message !== undefined && message.via === 'parent-mediated' && message.steer === false)
  med.push({ type: 'agent.message', message: { messageId: 'obs-1', via: 'parent-mediated', text: 'seen', state: 'issued', observedAt: 9 } })
  check('D2 agent.message folds into channel activity', message!.messages().length === 1 && message!.messages()[0]!.messageId === 'obs-1')

  med.push({ type: 'subagent.start', agentId: 'toolu_1', description: 'Scan the repo', background: false, time: 1 })
  const targets = await message!.listTargets()
  check('D3 listTargets mirrors the live roster', targets.length === 1 && targets[0]!.agentId === 'toolu_1' && targets[0]!.label === 'Scan the repo' && targets[0]!.status === 'running', targets)

  const submitted = await message!.submit({ targetId: 'toolu_1', targetName: 'Scan the repo', text: 'focus on tests', delivery: 'steer' })
  check('D4 the submit reports issued with a local intent id', submitted.ok === true && submitted.state === 'issued' && typeof submitted.intentId === 'string', submitted)
  check('D5 the envelope rode the ordinary FIFO as a FIXED followup', await settled(() => med.state.submits.length === 1) && med.state.submits[0]!.placement === 'followup', med.state.submits)
  check('D6 the envelope addresses the target and carries the text verbatim',
    med.state.submits[0]!.text.includes('Scan the repo') && med.state.submits[0]!.text.includes('toolu_1') && med.state.submits[0]!.text.includes('focus on tests'),
    med.state.submits[0]?.text)
  const noName = await message!.submit({ targetId: 'toolu_2', text: 'ping', delivery: 'queue' })
  check('D7 a missing name falls back to the stable id', noName.ok === true && (await settled(() => med.state.submits.length === 2)) && med.state.submits[1]!.text.includes('toolu_2'))
  const empty = await message!.submit({ targetId: 'toolu_1', text: '  ', delivery: 'queue' })
  check('D8 empty text refuses without dispatching', empty.ok === false && empty.reason === 'failed' && med.state.submits.length === 2)
  void bareChannel
}

// ── Section E: the Claude session end to end over the fake SDK ────────────
{
  const { fakeClaudeSdk, claudeDeps, tick } = fakes
  const fake = fakeClaudeSdk(() => ({ capabilities: ['msg_lifecycle_v1'] }), { stopTask: () => undefined })
  const session = await openClaudeSession(claudeDeps(fake.sdk) as never)
  const ctx = { on: () => () => undefined, get: () => undefined, logger: { warn: () => undefined } } as never
  const channel = createChannel(ctx, session, { model: 'Claude Agent', provider: 'claude', cwd: '/fixture/project', activity: false, backendLabel: 'Claude Agent' })
  const query = fake.queries[0]!
  const message = channel.subagentControl.message
  check('E0 the claude channel serves the parent-mediated capability', message !== undefined && message!.via === 'parent-mediated' && message!.steer === false)
  check('E1 the channel activity fold starts empty', message!.messages().length === 0)

  query.emit({ type: 'assistant', message: { id: 'msg_e1', model: 'claude', content: [{ type: 'tool_use', id: 'call-e1', name: 'SendMessage', input: { to: 'helper', message: 'please scan' } }] } })
  await tick()
  await tick()
  let views = message!.messages()
  check('E2 the live SendMessage call folds into channel activity', views.length === 1 && views[0]!.messageId === 'call-e1' && views[0]!.state === 'issued' && views[0]!.to === 'helper' && views[0]!.via === 'parent-mediated', views)

  query.emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-e1', is_error: true, content: 'agent not found' }] } })
  await tick()
  await tick()
  views = message!.messages()
  check('E3 the errored result settles refused, same row', views.length === 1 && views[0]!.state === 'refused', views)

  query.emit({ type: 'assistant', message: { id: 'msg_e2', model: 'claude', content: [{ type: 'tool_use', id: 'call-e2', name: 'SendMessage', input: { to: 'other', message: 'second' } }] } })
  await tick()
  query.emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-e2', content: 'ok' }] }, tool_use_result: { delivery: 'delivered' } })
  await tick()
  await tick()
  views = message!.messages()
  check('E4 a structured delivery fact marks delivered (only then)', views.length === 2 && views[1]!.state === 'delivered', views)
  await session.dispose()
  void channel
}

await flush()
console.log(`ALL PASS (${passed} checks)`)
