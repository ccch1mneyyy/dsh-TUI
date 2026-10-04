/**
 * A conversation reset on a Claude session, over a fake SDK (no CLI, no
 * network):
 *
 *  - `conversation_reset` (a plan-mode exit that clears the context) →
 *    `session.reset`: the channel core clears the transcript rows, the
 *    subagent and job rosters, the usage / cost / title of the discarded
 *    conversation, keeps queued inputs, and adds a notice row naming why;
 *    "load earlier" never brings the old conversation back;
 *  - a batch carrying the reset projects what came before it first and
 *    what follows it onto the cleared view;
 *  - the CLI then runs under a new session id, named by the frames after
 *    the reset (probe claude-sdk-probe-5b `reset`): the session's ref, the
 *    channel's `sessionRef`, `/fork`, a reconnect and the launcher's resume
 *    marker all follow it;
 *  - the TUI's own `/clear` stays view-only for every backend: rows cleared
 *    and a notice, nothing sent to the session.
 *
 * Run: node --import tsx/esm scripts/verify-claude-reset.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-claude-reset-'))
process.env.HOME = home
process.env.USERPROFILE = home

const [
  { openClaudeSession },
  { memoryClaudePrefs },
  { createChannel },
  { setLang, t },
  { settled },
  fakes,
] = await Promise.all([
  import('../src/backends/claude/session.js'),
  import('../src/backends/claude/prefs.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/i18n.js'),
  import('./lib/term-test.mjs'),
  import('./lib/claude-fake-sdk.js'),
])

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
const { fakeClaudeSdk, claudeDeps, tick } = fakes
const ctx = { on: () => () => undefined, get: () => undefined, logger: { warn: () => undefined, info: () => undefined, debug: () => undefined } } as never
const OLD = '00000000-0000-4000-8000-0000000000ab'
const NEW = '00000000-0000-4000-8000-00000000beef'

{
  const forked: string[] = []
  const fake = fakeClaudeSdk(() => ({ capabilities: ['msg_lifecycle_v1', 'interrupt_receipt_v1'] }), { stopTask: () => undefined })
  const prefs = memoryClaudePrefs({ lastSession: OLD })
  const store = {
    getSessionMessages: () => Promise.resolve([]),
    forkSession: (id: string) => { forked.push(id); return Promise.resolve({ sessionId: 'forked-1' }) },
  }
  const session = await openClaudeSession(claudeDeps(fake.sdk, { sessionId: OLD, prefs, store: store as never }))
  const channel = createChannel(ctx, session, { model: 'Claude Agent', provider: 'claude', cwd: '/fixture/project', activity: false, backendLabel: 'Claude Agent' })
  const query = fake.queries[0]!
  try {
    // A turn with a reply, a subagent card and a cost.
    await session.submit({ text: 'make a plan', clientMessageId: 'u1' }, 'turn')
    query.emit({ type: 'command_lifecycle', command_uuid: 'u1', state: 'started', session_id: OLD })
    query.emit({ type: 'stream_event', session_id: OLD, event: { type: 'message_start', message: { id: 'm1', model: 'claude-haiku', usage: { input_tokens: 10 } } } })
    query.emit({ type: 'assistant', session_id: OLD, message: { id: 'm1', content: [{ type: 'text', text: 'Here is the plan.' }, { type: 'tool_use', id: 'call-1', name: 'Agent', input: { description: 'explore', prompt: 'x' } }] } })
    query.emit({ type: 'system', subtype: 'session_title_changed', title: 'Planning', session_id: OLD })
    query.emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.25, modelUsage: {}, session_id: OLD })
    check('before: rows, a subagent, a cost and a title', await settled(() => channel.rows.some(row => row.kind === 'assistant') && channel.subagents.length === 1 && channel.costReport?.amount === 0.25 && channel.sessionTitle === 'Planning'))
    // The old conversation tracked a plan task (TaskCreate + in_progress).
    query.emit({ type: 'assistant', session_id: OLD, message: { id: 'm2', content: [{ type: 'tool_use', id: 'call-2', name: 'TaskCreate', input: { subject: 'Old chore', description: 'x', activeForm: 'Old form' } }] } })
    query.emit({ type: 'user', session_id: OLD, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-2', content: 'ok' }] }, tool_use_result: { task: { id: 'task-1', subject: 'Old chore' } } })
    query.emit({ type: 'assistant', session_id: OLD, message: { id: 'm3', content: [{ type: 'tool_use', id: 'call-3', name: 'TaskUpdate', input: { taskId: 'task-1', status: 'in_progress' } }] } })
    query.emit({ type: 'user', session_id: OLD, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-3', content: 'ok' }] }, tool_use_result: { success: true, taskId: 'task-1', updatedFields: ['status'] } })
    check('before: the plan-tracking task shows on the panel, in_progress', await settled(() => channel.todos.length === 1 && channel.todos[0]?.content === 'Old chore' && channel.todos[0]?.status === 'in_progress'), channel.todos)
    // An input the CLI has not started when the reset lands.
    await session.submit({ text: 'queued after', clientMessageId: 'u2' }, 'followup')
    query.emit({ type: 'conversation_reset', new_conversation_id: 'not-the-session-id', uuid: 'r1', session_id: OLD, trigger: 'plan_mode_exit' })
    check('the reset clears the transcript and says why', await settled(() => channel.rows.length === 1 && channel.rows[0]!.kind === 'notice' && channel.rows[0]!.text === t('conversation-reset-plan')), channel.rows.map(row => `${row.kind}:${row.text}`))
    check('… the rosters, usage, cost and title of the old conversation go with it', channel.subagents.length === 0 && channel.backgroundJobs.length === 0 && channel.costReport === undefined && channel.sessionTitle === '' && channel.tokens.input === 0)
    check('… "load earlier" does not bring the old conversation back', !channel.olderHistory && channel.loadOlder() === 0)
    // The CLI continues under a new session id, named by the next frame.
    query.emit({ type: 'system', subtype: 'init', session_id: NEW, model: 'claude-haiku', permissionMode: 'default', slash_commands: [], tools: [] })
    check('the next frame\'s session id becomes the session\'s', await settled(() => session.ref.sessionId === NEW) && channel.sessionRef.sessionId === NEW)
    check('… the launcher\'s resume marker follows it', prefs.read().lastSession === NEW)
    // The queued input runs on in the new conversation.
    query.emit({ type: 'command_lifecycle', command_uuid: 'u2', state: 'started', session_id: NEW })
    query.emit({ type: 'result', subtype: 'success', is_error: false, result: 'continued', total_cost_usd: 0.01, modelUsage: {}, session_id: NEW })
    check('… the input queued before the reset still runs after it', await settled(() => channel.rows.some(row => row.kind === 'user' && row.text === 'queued after')))
    // The new conversation's task table starts clean — even when the CLI
    // reuses the old short task id ('task-1').
    query.emit({ type: 'assistant', session_id: NEW, message: { id: 'm4', content: [{ type: 'tool_use', id: 'call-4', name: 'TaskCreate', input: { subject: 'New chore', description: 'y' } }] } })
    query.emit({ type: 'user', session_id: NEW, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-4', content: 'ok' }] }, tool_use_result: { task: { id: 'task-1', subject: 'New chore' } } })
    check('… the new conversation\'s task table starts clean (a reused short id mismatches nothing)', await settled(() => channel.todos.length === 1 && channel.todos[0]?.content === 'New chore' && channel.todos[0]?.status === 'pending'), channel.todos)
    query.emit({ type: 'result', subtype: 'success', is_error: false, result: 'planned', total_cost_usd: 0.01, modelUsage: {}, session_id: NEW })
    await tick()
    await session.capabilities.fork!.fork()
    check('/fork copies the new session', forked.at(-1) === NEW, forked)
    await session.capabilities.auth?.reconnect()
    await settled(() => fake.queries.length === 2)
    check('a reconnect resumes the new session', fake.queries[1]?.options.resume === NEW, fake.queries[1]?.options.resume)
    // The TUI's own /clear: view-only, nothing reaches the session.
    const inputs = fake.queries[1]!.inputs.length
    channel.clear()
    await tick()
    check('/clear is view-only: rows cleared with its notice, no input sent', channel.rows.length === 1 && channel.rows[0]!.text === t('session-cleared') && fake.queries[1]!.inputs.length === inputs)
  } finally {
    channel.releaseContributions()
    await session.dispose()
  }
}

// ── a batch carrying the reset: before it, then the cleared view ───────
{
  const listeners = new Set<(batch: readonly import('../src/agent/events.js').AgentEvent[], meta: import('../src/agent/events.js').AgentEventMeta) => void>()
  const session = {
    ref: { backendId: 'claude', sessionId: 'batch-1' },
    cwd: '/fixture/project',
    status: 'idle' as const,
    capabilities: { native: {} },
    history: () => Promise.resolve([]),
    subscribe(listener: (batch: readonly import('../src/agent/events.js').AgentEvent[], meta: import('../src/agent/events.js').AgentEventMeta) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    submit: () => Promise.resolve({ accepted: true }),
    removePending: () => false,
    cancel: () => Promise.resolve({ stillQueued: [] }),
    dispose: () => Promise.resolve(),
  }
  const channel = createChannel(ctx, session as never, { model: 'm', provider: '', cwd: '/fixture/project', activity: false })
  try {
    for (const listener of listeners) listener([
      { type: 'notice', level: 'info', text: 'before the reset' },
      { type: 'session.reset', trigger: 'clear' },
      { type: 'notice', level: 'info', text: 'after the reset' },
    ], { replay: false })
    const texts = channel.rows.map(row => row.text)
    check('a reset mid-batch: what preceded it is cleared, what follows lands on the cleared view', JSON.stringify(texts) === JSON.stringify([t('conversation-reset-clear'), 'after the reset']), texts)
  } finally {
    channel.releaseContributions()
  }
}


// ── the translator drops the old conversation's own state ────────────────
{
  const { createClaudeTranslator } = await import('../src/backends/claude/translate.js')
  type Ev = import('../src/agent/events.js').AgentEvent
  const translator = createClaudeTranslator({ cwd: '/fixture/project', userRows: 'lifecycle' })
  const events: Ev[] = []
  const feed = (...frames: Rec[]): void => { for (const frame of frames) events.push(...translator.translate(frame)) }
  const call = (n: number, name: string, input: Record<string, unknown>): Rec => ({ type: 'assistant', message: { id: 'm' + n, content: [{ type: 'tool_use', id: 'call-' + n, name, input }] } })
  const resultOf = (n: number, structured?: Record<string, unknown>, isError = false): Rec => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-' + n, content: 'ok', ...(isError ? { is_error: true } : {}) }] }, ...(structured === undefined ? {} : { tool_use_result: structured }) })
  feed(
    call(1, 'TaskCreate', { subject: 'Old chore', description: 'x', activeForm: 'Old form' }),
    resultOf(1, { task: { id: '1', subject: 'Old chore' } }),
    call(2, 'TaskUpdate', { taskId: '1', status: 'in_progress' }),
    resultOf(2, { success: true, taskId: '1', updatedFields: ['status'] }),
  )
  const before = translator.activityState()
  check('translator: the old in_progress task drives the working line', before.turnOpen && before.activeForm === 'Old form', before)
  // An optimistic patch whose result never comes, plus a queued input.
  feed(call(3, 'TaskUpdate', { taskId: '1', status: 'deleted' }))
  translator.registerInput('queued-1', 'still runs', 'followup')
  const seqBefore = translator.seqNumber
  const turnBefore = translator.turnNumber
  feed({ type: 'conversation_reset', trigger: 'plan_mode_exit' })
  const after = translator.activityState()
  check('translator: the reset clears the task table — no old activeForm on the working line', after.activeForm === undefined && !after.turnOpen, after)
  check('translator: the reset emits session.reset (and closes the open turn first)', events.some(event => event.type === 'turn.end' && event.reason.kind === 'aborted') && events.some(event => event.type === 'session.reset'), events.filter(event => event.type === 'turn.end' || event.type === 'session.reset').map(event => event.type))
  check('translator: queued inputs survive the reset (the CLI still runs them)', JSON.stringify(translator.unstartedInputs()) === JSON.stringify(['queued-1']), translator.unstartedInputs())
  check('translator: turn / seq numbering stays monotonic across the reset', translator.seqNumber >= seqBefore && translator.turnNumber >= turnBefore, [seqBefore, translator.seqNumber, turnBefore, translator.turnNumber])
  const writesBefore = events.filter(event => event.type === 'todo.write').length
  feed(resultOf(3, undefined, true))
  check('translator: a late failure of the old conversation\'s patch resurrects nothing', events.filter(event => event.type === 'todo.write').length === writesBefore, [writesBefore, events.filter(event => event.type === 'todo.write').length])
  feed(call(4, 'TaskCreate', { subject: 'New chore' }), resultOf(4, { task: { id: '1', subject: 'New chore' } }))
  const last = events.filter(event => event.type === 'todo.write').at(-1)
  check('translator: the new conversation\'s task table starts clean (a reused short id mismatches nothing)',
    last !== undefined && last.type === 'todo.write' && last.items.length === 1 && last.items[0]?.content === 'New chore' && last.items[0]?.status === 'pending', last?.items)
}

console.log(`\nverify-claude-reset OK (${passed} checks)`)
process.exit(0)
