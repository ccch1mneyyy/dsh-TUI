/**
 * Claude session lifecycle (docs/agent-backend-design.md §4.4, §4.7, §4.13)
 * against a FAKE SDK `query()` — no CLI, no network:
 *
 *  - open → dispose ×50 leaves no listener, no timer, no live query (close +
 *    abort + closed input stream every time; dispose is idempotent);
 *  - submit maps placements to priorities and stamps `uuid = clientMessageId`;
 *    images are refused loudly;
 *  - cancel mid-stream interrupts (cancel_queued only for an `interrupt`
 *    cancel on a CLI advertising it) and the confirmation clears the
 *    force-settle timer; with no confirmation the injected 30 s clock
 *    force-closes the turn with a notice and `requires-action`;
 *  - a permission prompt is always settled: Phase 2 denies with a notice
 *    row; a decider that never answers is settled by the SDK's abort signal
 *    and by dispose;
 *  - a consumer error (process death) marks the session disposed, closes the
 *    open turn and says so; unknown message types are ignored;
 *  - a failed handshake throws after tearing the query down;
 *  - env scrubbing, the Fidelity Profile options and the start-mode
 *    resolution are pinned as units.
 *
 * Run: node --import tsx/esm scripts/verify-claude-session-lifecycle.ts
 */
import assert from 'node:assert/strict'
import type { AgentEvent, AgentEventMeta } from '../src/agent/events.js'
import type { AgentSession } from '../src/agent/session.js'
import { buildQueryOptions, OPTION_POLICY, resolveStartPermissionMode } from '../src/backends/claude/options.js'
import { buildClaudeEnv } from '../src/backends/claude/process.js'
import { openClaudeSession, PHASE2_DENY_MESSAGE, type ClaudeClock, type ClaudeSessionDeps } from '../src/backends/claude/session.js'
import { setLang, t } from '../src/i18n.js'

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/** A manual clock that counts outstanding timers. */
function manualClock() {
  let now = 0
  let nextId = 1
  const timers = new Map<number, { at: number; callback: () => void }>()
  const clock: ClaudeClock = {
    setTimeout(callback, ms) {
      const id = nextId++
      timers.set(id, { at: now + ms, callback })
      return id
    },
    clearTimeout(handle) { timers.delete(handle as number) },
  }
  return {
    clock,
    outstanding: () => timers.size,
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

type Options = Parameters<typeof buildQueryOptions>[0]
type QueryParams = { prompt: AsyncIterable<Record<string, unknown>>; options: ReturnType<typeof buildQueryOptions> }

/** A fake `Query`: the test pushes SDK messages; the session pushes inputs. */
function fakeSdk(behaviour: { initFails?: boolean; capabilities?: string[] } = {}) {
  const queries: ReturnType<typeof makeQuery>[] = []
  function makeQuery(params: QueryParams) {
    const outbox: unknown[] = []
    const waiters: ((result: IteratorResult<unknown>) => void)[] = []
    let ended = false
    let failure: Error | undefined
    const inputs: Record<string, unknown>[] = []
    const interrupts: unknown[] = []
    let closed = false
    // Drain the session's input stream like the CLI's stdin reader.
    const reader = (async () => { for await (const message of params.prompt) inputs.push(message) })()
    const settle = (): void => {
      while (waiters.length > 0 && (outbox.length > 0 || ended || failure !== undefined)) {
        const waiter = waiters.shift()!
        if (outbox.length > 0) waiter({ value: outbox.shift(), done: false })
        else waiter({ value: undefined, done: true })
      }
    }
    const query = {
      params,
      inputs,
      interrupts,
      reader,
      get closed() { return closed },
      emit(message: unknown) { outbox.push(message); settle() },
      fail(error: Error) { failure = error; const waiter = waiters.shift(); waiter?.({ value: undefined, done: true }); failureWaiters.forEach(fn => fn(error)) },
      initializationResult: () => behaviour.initFails === true
        ? Promise.reject(new Error('cli did not start'))
        : Promise.resolve({ capabilities: behaviour.capabilities ?? ['msg_lifecycle_v1', 'interrupt_receipt_v1', 'interrupt_cancel_queued_v1'] }),
      interrupt(options?: unknown) { interrupts.push(options ?? null); return Promise.resolve({ still_queued: [] }) },
      close() { closed = true; ended = true; settle() },
      [Symbol.asyncIterator]() {
        return {
          next: (): Promise<IteratorResult<unknown>> => {
            if (failure !== undefined) return Promise.reject(failure)
            if (outbox.length > 0) return Promise.resolve({ value: outbox.shift(), done: false })
            if (ended) return Promise.resolve({ value: undefined, done: true })
            return new Promise((resolve, reject) => { waiters.push(resolve); failureWaiters.push(reject) })
          },
        }
      },
    }
    const failureWaiters: ((error: Error) => void)[] = []
    return query
  }
  return {
    queries,
    sdk: { query: (params: QueryParams) => { const query = makeQuery(params); queries.push(query); return query } } as unknown as ClaudeSessionDeps['sdk'],
  }
}

const baseDeps = (sdk: ClaudeSessionDeps['sdk'], clock: ClaudeClock, extra: Partial<ClaudeSessionDeps> = {}): ClaudeSessionDeps => ({
  sdk,
  cwd: '/fixture/project',
  sessionId: '00000000-0000-4000-8000-000000000001',
  start: { mode: 'default', source: 'default' },
  executable: { path: '/fixture/bin/claude', source: 'env' },
  env: { PATH: '/usr/bin' },
  host: { debug: () => undefined },
  clock,
  ...extra,
})

const collect = (session: AgentSession) => {
  const batches: { events: readonly AgentEvent[]; meta: AgentEventMeta }[] = []
  const unsubscribe = session.subscribe((events, meta) => { batches.push({ events, meta }) })
  return { batches, unsubscribe, events: () => batches.flatMap(batch => batch.events) }
}

// ── open → dispose ×50 ─────────────────────────────────────────────────
{
  const { clock, outstanding } = manualClock()
  const fake = fakeSdk()
  for (let i = 0; i < 50; i += 1) {
    const session = await openClaudeSession(baseDeps(fake.sdk, clock, { sessionId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }))
    const sink = collect(session)
    await session.dispose()
    await session.dispose()
    sink.unsubscribe()
  }
  const all = fake.queries
  check('×50: every query closed', all.length === 50 && all.every(query => query.closed))
  check('×50: every abort controller aborted', all.every(query => query.params.options.abortController?.signal.aborted === true))
  await Promise.all(all.map(query => query.reader))
  check('×50: every input stream ended (stdin EOF)', true)
  check('×50: no timer left behind', outstanding() === 0, outstanding())
}

// ── submit placements ─────────────────────────────────────────────────
{
  const { clock } = manualClock()
  const fake = fakeSdk()
  const session = await openClaudeSession(baseDeps(fake.sdk, clock))
  const query = fake.queries[0]!
  const sink = collect(session)
  await session.submit({ text: 'first', clientMessageId: '00000000-0000-4000-8000-0000000000a1' }, 'followup')
  query.emit({ type: 'command_lifecycle', command_uuid: '00000000-0000-4000-8000-0000000000a1', state: 'started' })
  await tick()
  await session.submit({ text: 'steered', clientMessageId: '00000000-0000-4000-8000-0000000000a2' }, 'steer')
  await session.submit({ text: 'later', clientMessageId: '00000000-0000-4000-8000-0000000000a3' }, 'followup')
  await session.submit({ text: 'now', clientMessageId: '00000000-0000-4000-8000-0000000000a4' }, 'now')
  await tick()
  const priorities = query.inputs.map(input => input.priority ?? 'plain')
  check('submit: idle followup is a plain push, then next/later/now', JSON.stringify(priorities) === JSON.stringify(['plain', 'next', 'later', 'now']), priorities)
  check('submit: uuid = clientMessageId', query.inputs[1]!.uuid === '00000000-0000-4000-8000-0000000000a2')
  check('submit: the confirmed input becomes the user row', sink.events().some(event => event.type === 'user.message' && event.text === 'first'))
  await assert.rejects(session.submit({ text: 'img', clientMessageId: 'x', images: [{} as never] }, 'followup'), /Images cannot be sent/)
  await assert.rejects(session.submit({ text: 'pasted', clientMessageId: 'z', blocks: [{ type: 'text', text: 'pasted' }, { type: 'image' }] }, 'followup'), /Images cannot be sent/)
  check('submit: images (field or image blocks) are refused loudly', true)
  query.emit({ type: 'mystery_frame', payload: 1 })
  query.emit({ type: 'system', subtype: 'brand_new' })
  await tick()
  check('unknown message types are ignored without events', sink.batches.every(batch => batch.events.length > 0))
  await session.dispose()
  await assert.rejects(session.submit({ text: 'late', clientMessageId: 'y' }, 'followup'), /closed/)
  check('submit after dispose is refused', true)
}

// ── cancel: confirmed / forced ────────────────────────────────────────
{
  const { clock, outstanding, advance } = manualClock()
  const fake = fakeSdk()
  const session = await openClaudeSession(baseDeps(fake.sdk, clock))
  const query = fake.queries[0]!
  const sink = collect(session)
  await session.submit({ text: 'count', clientMessageId: '00000000-0000-4000-8000-0000000000b1' }, 'followup')
  query.emit({ type: 'command_lifecycle', command_uuid: '00000000-0000-4000-8000-0000000000b1', state: 'started' })
  query.emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1', model: 'fake' } }, parent_tool_use_id: null })
  query.emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '1\n2' } }, parent_tool_use_id: null })
  await tick()
  check('stream deltas wake frame-coalesced', sink.batches.some(batch => batch.meta.wake === 'frame'))
  check('a running turn reports running', session.status === 'running')
  await session.cancel('user')
  check('cancel(user) interrupts without dropping the queue', JSON.stringify(query.interrupts) === JSON.stringify([null]))
  check('cancel arms the force-settle timer', outstanding() === 1)
  query.emit({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'aborted_streaming', total_cost_usd: 0.01, modelUsage: {} })
  await tick()
  check('the result clears the timer', outstanding() === 0)
  check('the aborted turn closes as aborted', sink.events().some(event => event.type === 'turn.end' && event.reason.kind === 'aborted'))
  await session.cancel('interrupt')
  check('cancel(interrupt) drops the queue on a cancel_queued CLI', JSON.stringify(query.interrupts[1]) === JSON.stringify({ cancelQueued: true }))

  // A turn that never confirms the interrupt.
  await session.submit({ text: 'stuck', clientMessageId: '00000000-0000-4000-8000-0000000000b2' }, 'followup')
  query.emit({ type: 'command_lifecycle', command_uuid: '00000000-0000-4000-8000-0000000000b2', state: 'started' })
  await tick()
  await session.cancel('user')
  advance(29_999)
  check('no forced close before 30 s', !sink.events().slice(-3).some(event => event.type === 'turn.end'))
  advance(1)
  const tail = sink.events().slice(-3)
  check('30 s without confirmation force-closes the turn', tail.some(event => event.type === 'turn.end' && event.reason.kind === 'aborted'), tail)
  check('the forced close says so', tail.some(event => event.type === 'notice' && event.text === t('claude-cancel-forced')))
  check('the session asks for attention', tail.some(event => event.type === 'session.status' && event.status === 'requires-action'))
  await session.dispose()
  check('no timer after dispose', outstanding() === 0)
}

// ── permissions ───────────────────────────────────────────────────────
{
  const { clock } = manualClock()
  const fake = fakeSdk()
  const session = await openClaudeSession(baseDeps(fake.sdk, clock))
  const query = fake.queries[0]!
  const sink = collect(session)
  const canUseTool = query.params.options.canUseTool!
  const controller = new AbortController()
  const result = await canUseTool('Write', { file_path: '/fixture/project/a.txt', content: 'x' }, { signal: controller.signal, toolUseID: 'toolu_1', requestId: 'req_1' })
  check('Phase 2: every prompt is denied with the phase message', result.behavior === 'deny' && result.message === PHASE2_DENY_MESSAGE)
  await tick()
  check('Phase 2: the denial explains itself in a notice row', sink.events().some(event => event.type === 'notice' && event.level === 'warning' && event.callId === 'toolu_1'))
  const question = await canUseTool('AskUserQuestion', { questions: [] }, { signal: controller.signal, toolUseID: 'toolu_2', requestId: 'req_2' })
  check('Phase 2: AskUserQuestion is declined too', question.behavior === 'deny')
  await session.dispose()
}
{
  const { clock } = manualClock()
  const fake = fakeSdk()
  const never = (): Promise<never> => new Promise(() => undefined)
  const session = await openClaudeSession(baseDeps(fake.sdk, clock, { decidePermission: never }))
  const canUseTool = fake.queries[0]!.params.options.canUseTool!
  const aborted = new AbortController()
  const viaSignal = canUseTool('Bash', { command: 'ls' }, { signal: aborted.signal, toolUseID: 'toolu_3', requestId: 'req_3' })
  aborted.abort()
  check('a withdrawn prompt (abort signal) settles as deny', (await viaSignal).behavior === 'deny')
  const pending = canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'toolu_4', requestId: 'req_4' })
  await tick()
  await session.dispose()
  check('dispose settles a pending prompt as deny', (await pending).behavior === 'deny')
  const afterDispose = await canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'toolu_5', requestId: 'req_5' })
  check('a prompt after dispose is denied at once', afterDispose.behavior === 'deny')
}

// ── process death / handshake failure / backlog ───────────────────────
{
  const { clock, outstanding } = manualClock()
  const fake = fakeSdk()
  const session = await openClaudeSession(baseDeps(fake.sdk, clock))
  const query = fake.queries[0]!
  const sink = collect(session)
  await session.submit({ text: 'go', clientMessageId: '00000000-0000-4000-8000-0000000000c1' }, 'followup')
  query.emit({ type: 'command_lifecycle', command_uuid: '00000000-0000-4000-8000-0000000000c1', state: 'started' })
  await tick()
  query.fail(new Error('ProcessTransport: process exited with code 1'))
  await tick()
  await tick()
  check('process death marks the session disposed', session.status === 'disposed')
  check('process death closes the open turn as an error', sink.events().some(event => event.type === 'turn.end' && event.reason.kind === 'error'))
  check('process death says so', sink.events().some(event => event.type === 'notice' && event.level === 'error' && event.text.includes('process exited')))
  check('process death tears the query down', query.closed && outstanding() === 0)
  await session.dispose()
}
{
  const { clock, outstanding } = manualClock()
  const fake = fakeSdk({ initFails: true })
  await assert.rejects(openClaudeSession(baseDeps(fake.sdk, clock)), /cli did not start/)
  check('a failed handshake throws after closing the query', fake.queries[0]!.closed && outstanding() === 0)
}
{
  const { clock } = manualClock()
  const fake = fakeSdk({ capabilities: [] })
  const session = await openClaudeSession(baseDeps(fake.sdk, clock, { startNotices: ['start notice'] }))
  const sink = collect(session)
  check('backlog waits for the subscriber setup to return', sink.events().length === 0)
  await tick()
  check('start notices reach the first subscriber', sink.events().some(event => event.type === 'notice' && event.text === 'start notice'))
  await session.cancel('interrupt')
  check('no cancel_queued without the capability', JSON.stringify(fake.queries[0]!.interrupts) === JSON.stringify([null]))
  await session.dispose()
}

// ── units: env, options, start mode ───────────────────────────────────
{
  const parent = {
    CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ID: 'parent', CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/s',
    CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ATTENDED: '1', CLAUDE_PID: '42', AI_AGENT: 'claude-code',
    TRACEPARENT: '00-abc-def-01', CLAUDE_CODE_EXECPATH: '/parent/claude', CLAUDE_EFFORT: 'high', CLAUDE_CODE_INVOKED_SKILLS: 'x',
  }
  const env = buildClaudeEnv({ PATH: '/usr/bin', ...parent, ANTHROPIC_API_KEY: 'kept' })
  check('env: parent Claude Code session variables are scrubbed', Object.keys(parent).every(key => env[key] === undefined), Object.keys(parent).filter(key => env[key] !== undefined))
  check('env: client app + session state events, credentials untouched', env.CLAUDE_AGENT_SDK_CLIENT_APP?.startsWith('dsh-tui/') === true && env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS === '1' && env.ANTHROPIC_API_KEY === 'kept' && env.PATH === '/usr/bin')
  const options = buildQueryOptions({
    cwd: '/fixture/project', sessionId: 's', permissionMode: 'default', executable: undefined, env: {}, canUseTool: (() => undefined) as unknown as Options['canUseTool'],
    stderr: () => undefined, abortController: new AbortController(), replayUserMessages: true,
  })
  check('profile: claude_code system prompt and tools presets', JSON.stringify(options.systemPrompt) === JSON.stringify({ type: 'preset', preset: 'claude_code' }) && JSON.stringify(options.tools) === JSON.stringify({ type: 'preset', preset: 'claude_code' }))
  check('profile: every settings source', JSON.stringify(options.settingSources) === JSON.stringify(['user', 'project', 'local']))
  check('profile: explicit mode, partials, subagent text, per-task stop, checkpoints', options.permissionMode === 'default' && options.includePartialMessages === true && options.forwardSubagentText === true && options.perTaskStopAffordance === true && options.enableFileCheckpointing === true)
  check('profile: no executable path → SDK bundled binary', options.pathToClaudeCodeExecutable === undefined)
  // (`pathToClaudeCodeExecutable` is set only when an executable was found.)
  const set = Object.entries(OPTION_POLICY).filter(([key, policy]) => policy === 'set' && key !== 'pathToClaudeCodeExecutable').map(([key]) => key).sort()
  const built = Object.keys(options).sort()
  check('profile: exactly the `set` options are built', JSON.stringify(set) === JSON.stringify(built), { set, built })
  const fakeSettings = (defaultMode: unknown) => ({
    resolveSettings: () => Promise.resolve({ effective: { permissions: { defaultMode } } }),
    filterEscalatingDefaultMode: (resolved: unknown) => (resolved as { effective: unknown }).effective,
  }) as unknown as Parameters<typeof resolveStartPermissionMode>[0]
  check('start mode: default when nothing is configured', (await resolveStartPermissionMode(fakeSettings(undefined), '/p', {})).mode === 'default')
  check('start mode: a configured acceptEdits is honoured', (await resolveStartPermissionMode(fakeSettings('acceptEdits'), '/p', {})).mode === 'acceptEdits')
  const bypass = await resolveStartPermissionMode(fakeSettings('bypassPermissions'), '/p', {})
  check('start mode: bypassPermissions from settings is downgraded', bypass.mode === 'default' && bypass.downgradedFrom === 'bypassPermissions')
  check('start mode: the developer override wins', (await resolveStartPermissionMode(fakeSettings('plan'), '/p', { DSH_TUI_CLAUDE_PERMISSION_MODE: 'acceptEdits' })).mode === 'acceptEdits')
  for (const refused of ['bypassPermissions', 'auto', 'nonsense']) {
    const start = await resolveStartPermissionMode(fakeSettings('plan'), '/p', { DSH_TUI_CLAUDE_PERMISSION_MODE: refused })
    check(`start mode: the override refuses ${refused} (settings win, the refusal is reported)`, start.mode === 'plan' && start.source === 'settings' && start.ignoredOverride === refused, start)
  }
}

console.log(`\nverify-claude-session-lifecycle OK (${passed} checks)`)
process.exit(0)
