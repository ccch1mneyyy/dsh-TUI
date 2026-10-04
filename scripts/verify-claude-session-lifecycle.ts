/**
 * Claude session lifecycle against a fake SDK `query()` (no CLI, no
 * network):
 *
 *  - open → dispose ×50 leaves no listener, no timer, no live query (close +
 *    abort + closed input stream every time; dispose is idempotent);
 *  - submit maps placements to priorities and stamps `uuid = clientMessageId`;
 *    an image it cannot send is refused loudly (never dropped);
 *  - cancel mid-stream interrupts (cancel_queued only for an `interrupt`
 *    cancel on a CLI advertising it) and the confirmation clears the
 *    force-settle timer; with no confirmation the injected 30 s clock
 *    force-closes the turn with a notice and `requires-action`;
 *  - the cancel receipt carries its certainty: rejection → failed,
 *    an older CLI's undefined answer → unknown, still_queued → confirmed;
 *    the unconfirmed legs return the covered uuids (snapshot before the
 *    request — inputs pushed during it never ride the old batch);
 *  - a permission prompt is always settled: it parks as `permission.request`
 *    (the full matrix lives in verify-claude-permissions); an unanswered
 *    prompt is settled by the SDK's abort signal and by dispose;
 *  - a consumer error (process death) marks the session disposed, closes the
 *    open turn and says so; unknown message types are ignored;
 *  - a failed handshake throws after tearing the query down;
 *  - every handshake resets the CLI capabilities and picks the user-row
 *    source explicitly: a missing/empty capabilities list (an older CLI
 *    without msg_lifecycle_v1) confirms inputs by their replay echo —
 *    one user row with origin user, and a reconnect never re-delivers an
 *    input the old CLI already confirmed;
 *  - a fresh session seeds its model from the open handshake (the same
 *    priority it spawned with): /effort levels resolve and the effort
 *    control reaches the CLI before the first turn; a reconnect never
 *    overwrites the model once set (a resumed session keeps the replay's);
 *  - env scrubbing, the Fidelity Profile options and the start-mode
 *    resolution are pinned as units (bypassPermissions only ever starts
 *    from the env override, but the SDK's bypass gate
 *    `allowDangerouslySkipPermissions` rides along on every query, see
 *    options.ts, so the session may enter bypass at runtime; settings-level
 *    bypass still downgrades).
 *
 * Run: node --import tsx/esm scripts/verify-claude-session-lifecycle.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, AgentEventMeta } from '../src/agent/events.js'
import type { AgentSession } from '../src/agent/session.js'
import { buildQueryOptions, OPTION_POLICY, resolveStartPermissionMode } from '../src/backends/claude/options.js'
import { memoryClaudePrefs } from '../src/backends/claude/prefs.js'
import type { ClaudeReplay } from '../src/backends/claude/replay.js'
import { buildClaudeEnv } from '../src/backends/claude/process.js'
import { openClaudeSession, type ClaudeClock, type ClaudeSessionDeps } from '../src/backends/claude/session.js'
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
function fakeSdk(behaviour: { initFails?: boolean; capabilities?: string[]; init?: (index: number) => Record<string, unknown>; interrupt?: (options?: unknown) => Promise<unknown> } = {}) {
  const queries: ReturnType<typeof makeQuery>[] = []
  function makeQuery(params: QueryParams) {
    const outbox: unknown[] = []
    const waiters: ((result: IteratorResult<unknown>) => void)[] = []
    let ended = false
    let failure: Error | undefined
    const inputs: Record<string, unknown>[] = []
    const interrupts: unknown[] = []
    const flagSettings: unknown[] = []
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
      flagSettings,
      reader,
      get closed() { return closed },
      emit(message: unknown) { outbox.push(message); settle() },
      fail(error: Error) { failure = error; const waiter = waiters.shift(); waiter?.({ value: undefined, done: true }); failureWaiters.forEach(fn => fn(error)) },
      initializationResult: () => behaviour.initFails === true
        ? Promise.reject(new Error('cli did not start'))
        : Promise.resolve(behaviour.init === undefined
          ? { capabilities: behaviour.capabilities ?? ['msg_lifecycle_v1', 'interrupt_receipt_v1', 'interrupt_cancel_queued_v1'] }
          : behaviour.init(queries.length)),
      interrupt(options?: unknown) { interrupts.push(options ?? null); return behaviour.interrupt === undefined ? Promise.resolve({ still_queued: [] }) : behaviour.interrupt(options) },
      applyFlagSettings(options?: unknown) { flagSettings.push(options ?? null); return Promise.resolve({}) },
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
  // Images are sent (see verify-claude-images); an image the session
  // cannot send (an unreadable facade, an image block without one) is
  // still refused loudly, never dropped from the message.
  await assert.rejects(session.submit({ text: 'img', clientMessageId: 'x', images: [{} as never] }, 'followup'), new RegExp(t('claude-image-type-refused', { name: 'undefined', type: '?' }).replace(/[()?]/gu, '\\$&')))
  await assert.rejects(session.submit({ text: 'pasted', clientMessageId: 'z', blocks: [{ type: 'text', text: 'pasted' }, { type: 'image' }] }, 'followup'), new RegExp(t('claude-image-gone')))
  check('submit: an image it cannot send (bad facade, block without one) is refused loudly', !query.inputs.some(input => input.uuid === 'x' || input.uuid === 'z'))
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

// ── cancel receipts: failure never reads as an empty queue ────────────
// A rejected or answerless interrupt must not answer stillQueued []: that
// is a success-shaped receipt over a queue whose state was never confirmed,
// and the channel's dock would offer a re-send over still-live backend
// copies. The receipt carries its certainty instead: only a CLI that
// answered with still_queued is 'confirmed'; the other legs return the
// covered snapshot (what the cancel saw, never what arrived during the
// request).
{
  const uuid = (tag: string): string => `00000000-0000-4000-8000-0000000000${tag}`
  const queueOne = async (session: AgentSession, id: string): Promise<void> => {
    await session.submit({ text: 'queued', clientMessageId: id }, 'followup')
    await tick()
  }
  // (1) interrupt rejection → failed + the covered uuids.
  {
    const { clock } = manualClock()
    const fake = fakeSdk({ interrupt: () => Promise.reject(new Error('interrupt refused')) })
    const session = await openClaudeSession(baseDeps(fake.sdk, clock))
    await queueOne(session, uuid('d1'))
    const receipt = await session.cancel('interrupt')
    check('receipt: a rejected interrupt is failed, never queue-empty', receipt.outcome === 'failed' && JSON.stringify(receipt.stillQueued) === JSON.stringify([uuid('d1')]), receipt)
    await session.dispose()
  }
  // (2) an older CLI resolves interrupt() to undefined (sdk.d.ts) →
  // unknown + the covered uuids; no cancel_queued was ever sent.
  {
    const { clock } = manualClock()
    const fake = fakeSdk({ capabilities: ['msg_lifecycle_v1'], interrupt: () => Promise.resolve(undefined) })
    const session = await openClaudeSession(baseDeps(fake.sdk, clock))
    await queueOne(session, uuid('d2'))
    const receipt = await session.cancel('interrupt')
    check('receipt: no receipt (older CLI) is unknown and covers the queue', receipt.outcome === 'unknown' && JSON.stringify(receipt.stillQueued) === JSON.stringify([uuid('d2')]), receipt)
    check('receipt: no cancel_queued without the capability', JSON.stringify(fake.queries[0]!.interrupts) === JSON.stringify([null]), fake.queries[0]!.interrupts)
    await session.dispose()
  }
  // (3) an explicit cancelled receipt (still_queued []) → confirmed empty.
  {
    const { clock } = manualClock()
    const fake = fakeSdk({ interrupt: () => Promise.resolve({ still_queued: [] }) })
    const session = await openClaudeSession(baseDeps(fake.sdk, clock))
    await queueOne(session, uuid('d3'))
    const receipt = await session.cancel('interrupt')
    check('receipt: explicit cancelled is confirmed empty', receipt.outcome === 'confirmed' && receipt.stillQueued.length === 0, receipt)
    check('receipt: cancel_queued rode the request', JSON.stringify(fake.queries[0]!.interrupts) === JSON.stringify([{ cancelQueued: true }]), fake.queries[0]!.interrupts)
    await session.dispose()
  }
  // (4) an explicit still_queued receipt → confirmed with the kept ids.
  {
    const { clock } = manualClock()
    const fake = fakeSdk({ interrupt: () => Promise.resolve({ still_queued: [uuid('d4')] }) })
    const session = await openClaudeSession(baseDeps(fake.sdk, clock))
    await queueOne(session, uuid('d4'))
    const receipt = await session.cancel('interrupt')
    check('receipt: explicit still_queued is confirmed with the kept ids', receipt.outcome === 'confirmed' && JSON.stringify(receipt.stillQueued) === JSON.stringify([uuid('d4')]), receipt)
    await session.dispose()
  }
  // (5) the snapshot boundary: an input pushed while the request is in
  // flight belongs to a newer batch — the fallback neither covers nor
  // claims to have cancelled it.
  {
    const { clock } = manualClock()
    let releaseInterrupt!: (value: unknown) => void
    const fake = fakeSdk({ interrupt: () => new Promise(resolve => { releaseInterrupt = resolve }) })
    const session = await openClaudeSession(baseDeps(fake.sdk, clock))
    await session.submit({ text: 'before', clientMessageId: uuid('d5') }, 'followup')
    await tick()
    const pending = session.cancel('interrupt')
    await session.submit({ text: 'during', clientMessageId: uuid('d6') }, 'followup')
    releaseInterrupt(undefined)
    const receipt = await pending
    check('receipt: the covered snapshot predates the request window', receipt.outcome === 'unknown' && JSON.stringify(receipt.stillQueued) === JSON.stringify([uuid('d5')]), receipt)
    await session.dispose()
  }
}

// ── permissions ───────────────────────────────────────────────────────
{
  const { clock } = manualClock()
  const fake = fakeSdk()
  const session = await openClaudeSession(baseDeps(fake.sdk, clock))
  const sink = collect(session)
  const canUseTool = fake.queries[0]!.params.options.canUseTool!
  const aborted = new AbortController()
  const viaSignal = canUseTool('Bash', { command: 'ls' }, { signal: aborted.signal, toolUseID: 'toolu_3', requestId: 'req_3' })
  await tick()
  check('a prompt parks as permission.request', sink.events().some(event => event.type === 'permission.request' && event.request.requestId === 'req_3'))
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
  // The conditional ones: the persisted model/effort, the route pin of an
  // injected subscription token, and `resume` in place of `sessionId` for a
  // credential reconnect. `allowDangerouslySkipPermissions` is not among
  // them: the gate is sent on every query (options.ts).
  const withChoices = buildQueryOptions({
    cwd: '/fixture/project', sessionId: 's', permissionMode: 'default', executable: undefined, env: {}, canUseTool: (() => undefined) as unknown as Options['canUseTool'],
    stderr: () => undefined, abortController: new AbortController(), replayUserMessages: true, model: 'haiku', effort: 'low',
    settingsFile: '/fixture/flag-settings.json',
    onElicitation: (() => undefined) as unknown as Options['onElicitation'], onUserDialog: (() => undefined) as unknown as Options['onUserDialog'], supportedDialogKinds: ['refusal_fallback_prompt'],
  })
  const resumed = buildQueryOptions({
    cwd: '/fixture/project', resume: 's', permissionMode: 'default', executable: undefined, env: {}, canUseTool: (() => undefined) as unknown as Options['canUseTool'],
    stderr: () => undefined, abortController: new AbortController(), replayUserMessages: true,
  })
  const builtWith = (permissionMode: Options['permissionMode']) => buildQueryOptions({
    cwd: '/fixture/project', sessionId: 's', permissionMode, executable: undefined, env: {}, canUseTool: (() => undefined) as unknown as Options['canUseTool'],
    stderr: () => undefined, abortController: new AbortController(), replayUserMessages: true,
  })
  const bypassed = builtWith('bypassPermissions')
  check('profile: bypass carries the SDK-required allowDangerouslySkipPermissions', bypassed.permissionMode === 'bypassPermissions' && bypassed.allowDangerouslySkipPermissions === true, bypassed.allowDangerouslySkipPermissions)
  for (const mode of ['default', 'acceptEdits', 'plan', 'dontAsk'] as const) {
    // The gate is not a bypass switch: it only pre-warms the process (a
    // session started without it could never enter bypassPermissions,
    // sdk.d.ts:331), while the start mode stays exactly what was resolved.
    const spawned = builtWith(mode)
    check(`profile: ${mode} starts in its own mode AND carries the gate`, spawned.permissionMode === mode && spawned.allowDangerouslySkipPermissions === true, { mode: spawned.permissionMode, gate: spawned.allowDangerouslySkipPermissions })
  }
  const built = [...new Set([...Object.keys(withChoices), ...Object.keys(resumed), ...Object.keys(bypassed)])].sort()
  check('profile: exactly the `set` options are built', JSON.stringify(set) === JSON.stringify(built), { set, built })
  check('profile: a reconnect resumes instead of naming a new session', resumed.resume === 's' && resumed.sessionId === undefined && options.sessionId === 's' && options.resume === undefined)
  check('profile: no model/effort unless chosen', options.model === undefined && options.effort === undefined && withChoices.model === 'haiku' && withChoices.effort === 'low')
  check('profile: flag settings only with a route pin, and by file path', options.settings === undefined && resumed.settings === undefined && withChoices.settings === '/fixture/flag-settings.json')
  const fakeSettings = (defaultMode: unknown) => ({
    resolveSettings: () => Promise.resolve({ effective: { permissions: { defaultMode } } }),
    filterEscalatingDefaultMode: (resolved: unknown) => (resolved as { effective: unknown }).effective,
  }) as unknown as Parameters<typeof resolveStartPermissionMode>[0]
  check('start mode: default when nothing is configured', (await resolveStartPermissionMode(fakeSettings(undefined), '/p', {})).mode === 'default')
  check('start mode: a configured acceptEdits is honoured', (await resolveStartPermissionMode(fakeSettings('acceptEdits'), '/p', {})).mode === 'acceptEdits')
  const bypass = await resolveStartPermissionMode(fakeSettings('bypassPermissions'), '/p', {})
  check('start mode: bypassPermissions from settings is downgraded (repo files cannot opt in)', bypass.mode === 'default' && bypass.downgradedFrom === 'bypassPermissions', bypass)
  check('start mode: the developer override wins', (await resolveStartPermissionMode(fakeSettings('plan'), '/p', { DSH_TUI_CLAUDE_PERMISSION_MODE: 'acceptEdits' })).mode === 'acceptEdits')
  const envBypass = await resolveStartPermissionMode(fakeSettings('plan'), '/p', { DSH_TUI_CLAUDE_PERMISSION_MODE: 'bypassPermissions' })
  check('start mode: the env override alone can start bypassPermissions', envBypass.mode === 'bypassPermissions' && envBypass.source === 'env', envBypass)
  for (const refused of ['auto', 'nonsense']) {
    const start = await resolveStartPermissionMode(fakeSettings('plan'), '/p', { DSH_TUI_CLAUDE_PERMISSION_MODE: refused })
    check(`start mode: the override refuses ${refused} (settings win, the refusal is reported)`, start.mode === 'plan' && start.source === 'settings' && start.ignoredOverride === refused, start)
  }
}

// ── the explicit `model` parameter yields to the env slot routing ──────
// CLI 2.1.284's SDK path resolves an explicit model against the bundled
// official catalog and fail-fasts a non-official name (a relay model) as
// [claude-code:unrecognized_model]; the env slot routing (ANTHROPIC_MODEL /
// ANTHROPIC_DEFAULT_<TIER>_MODEL) serves those names fine. When the env the
// child actually applies already routes to the persisted model, the
// parameter is omitted; anything else keeps the pin (an official switch
// must still reach the CLI). The config dir is a fixture, so the machine's
// own ~/.claude/settings.json cannot leak routing into the assertions.
{
  const configDir = mkdtempSync(join(tmpdir(), 'dsh-tui-claude-modelenv-'))
  try {
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ env: {} }))
    const openWith = async (env: Record<string, string>, model: string | undefined) => {
      const { clock } = manualClock()
      const fake = fakeSdk()
      const session = await openClaudeSession(baseDeps(fake.sdk, clock, {
        env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: configDir, ...env },
        prefs: memoryClaudePrefs(model === undefined ? {} : { model }),
      }))
      return { session, options: fake.queries[0]!.params.options }
    }
    // ① the env the child applies already routes to the persisted model →
    //    the parameter is omitted (the fail-fast catalog check never runs).
    const omitted = await openWith({ ANTHROPIC_MODEL: 'glm-5.3[1M]' }, 'glm-5.3[1M]')
    check('model param: an env slot serving the persisted model omits the parameter', omitted.options.model === undefined, omitted.options.model)
    await omitted.session.dispose()
    // ①b base-normalized: a tier slot naming the base id (no [1M] suffix)
    //     serves the same model.
    const baseSlot = await openWith({ ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3' }, 'glm-5.3[1M]')
    check('model param: a tier slot naming the base id omits the parameter too', baseSlot.options.model === undefined, baseSlot.options.model)
    await baseSlot.session.dispose()
    // ①c the settings file's own env routing counts as well (the CLI applies
    //     it over the inherited spawn env — mergedModelEnv's order).
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_MODEL: 'glm-5.3[1M]' } }))
    const settingsRouted = await openWith({}, 'glm-5.3[1M]')
    check('model param: the settings env routing omits the parameter as well', settingsRouted.options.model === undefined, settingsRouted.options.model)
    await settingsRouted.session.dispose()
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ env: {} }))
    // ② an official model with no env routing: the parameter rides along.
    const official = await openWith({}, 'claude-opus-5-5')
    check('model param: an official model with no env routing is passed', official.options.model === 'claude-opus-5-5', official.options.model)
    await official.session.dispose()
    // ③ the env routes elsewhere: the explicit pin survives.
    const mismatch = await openWith({ ANTHROPIC_MODEL: 'glm-4.7' }, 'glm-5.3[1M]')
    check('model param: an env slot routing elsewhere keeps the parameter', mismatch.options.model === 'glm-5.3[1M]', mismatch.options.model)
    await mismatch.session.dispose()
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
}

// ── the handshake resets capabilities and picks the user-row source ─────
// A missing or empty capabilities list is an older CLI: without
// msg_lifecycle_v1 the replay echo must confirm the input (one user row,
// origin user), and a reconnect must not re-deliver what the CLI confirmed.
{
  const cases: readonly [string, () => Record<string, unknown>][] = [
    ['no capabilities key', () => ({})],
    ['an empty capabilities list', () => ({ capabilities: [] })],
  ]
  for (const [label, init] of cases) {
    const { clock } = manualClock()
    const fake = fakeSdk({ init: () => init() })
    const session = await openClaudeSession(baseDeps(fake.sdk, clock))
    const sink = collect(session)
    await session.submit({ text: 'hello', clientMessageId: 'u-1' }, 'followup')
    fake.queries[0]!.emit({ type: 'user', isReplay: true, uuid: 'u-1' })
    await tick()
    const rows = sink.events().filter((event): event is Extract<AgentEvent, { type: 'user.message' }> => event.type === 'user.message' && event.id === 'u-1')
    check(`capabilities (${label}): the replay echo becomes ONE user row with origin user`, rows.length === 1 && rows[0]!.source === 'user' && rows[0]!.text === 'hello', rows)
    fake.queries[0]!.emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })
    await tick()
    // The confirmed input must not ride along the next reconnect.
    fake.queries[0]!.emit({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' })
    for (let i = 0; i < 6; i += 1) await tick()
    check(`capabilities (${label}): a reconnect re-delivers nothing the CLI confirmed`, fake.queries.length === 2 && fake.queries[1]!.inputs.length === 0, fake.queries[1]?.inputs)
    await session.dispose()
  }
  // A non-empty list without msg_lifecycle_v1: the echo path.
  {
    const { clock } = manualClock()
    const fake = fakeSdk({ capabilities: ['interrupt_receipt_v1'] })
    const session = await openClaudeSession(baseDeps(fake.sdk, clock))
    const sink = collect(session)
    await session.submit({ text: 'hi', clientMessageId: 'u-1' }, 'followup')
    fake.queries[0]!.emit({ type: 'user', isReplay: true, uuid: 'u-1' })
    await tick()
    const rows = sink.events().filter((event): event is Extract<AgentEvent, { type: 'user.message' }> => event.type === 'user.message' && event.id === 'u-1')
    check('capabilities (no msg_lifecycle_v1): the echo still becomes one user row', rows.length === 1 && rows[0]!.source === 'user')
    await session.dispose()
  }
}

// ── capabilities across reconnects: each handshake decides again ────────
{
  const { clock } = manualClock()
  const withLifecycle = ['msg_lifecycle_v1', 'interrupt_receipt_v1']
  // Query 0 has lifecycle frames, query 1 (the reconnect) reports none,
  // query 2 (reconnected again) has them back. (The fake hands the init
  // callback the query's 1-based ordinal at handshake time.)
  const inits = [() => ({ capabilities: withLifecycle }), () => ({}), () => ({ capabilities: withLifecycle })]
  const fake = fakeSdk({ init: index => inits[index - 1]!() })
  const session = await openClaudeSession(baseDeps(fake.sdk, clock))
  const sink = collect(session)
  const rowsFor = (id: string): readonly AgentEvent[] => sink.events().filter((event): event is Extract<AgentEvent, { type: 'user.message' }> => event.type === 'user.message' && event.id === id)
  await session.submit({ text: 'one', clientMessageId: 'u-1' }, 'followup')
  fake.queries[0]!.emit({ type: 'command_lifecycle', command_uuid: 'u-1', state: 'started' })
  await tick()
  check('reconnect transitions: a lifecycle CLI confirms via its lifecycle frame', rowsFor('u-1').length === 1)
  fake.queries[0]!.emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })
  await tick()
  fake.queries[0]!.emit({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' })
  for (let i = 0; i < 6; i += 1) await tick()
  check('… the replacement CLI opened', fake.queries.length === 2)
  await session.submit({ text: 'two', clientMessageId: 'u-2' }, 'followup')
  fake.queries[1]!.emit({ type: 'user', isReplay: true, uuid: 'u-2' })
  await tick()
  check('… a reconnect to a CLI without capabilities switches to the echo (not inherited)', rowsFor('u-2').length === 1 && rowsFor('u-2')[0]!.source === 'user', rowsFor('u-2'))
  fake.queries[1]!.emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })
  await tick()
  fake.queries[1]!.emit({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' })
  for (let i = 0; i < 6; i += 1) await tick()
  check('… a second replacement CLI opened', fake.queries.length === 3)
  await session.submit({ text: 'three', clientMessageId: 'u-3' }, 'followup')
  fake.queries[2]!.emit({ type: 'command_lifecycle', command_uuid: 'u-3', state: 'started' })
  // The echo of the same input must not add a second row in lifecycle mode.
  fake.queries[2]!.emit({ type: 'user', isReplay: true, uuid: 'u-3' })
  await tick()
  check('… back on lifecycle frames the echo adds no second row', rowsFor('u-3').length === 1, rowsFor('u-3'))
  await session.dispose()
}

// ── the session's model is seeded from the open handshake (/effort) ─────
// No submit, no stream init: the state right after open is what /effort
// sees. The init shape is the real SDK contract: no scalar model, the
// catalog's `default` alias row carrying the resolved default.
{
  const { clock } = manualClock()
  const catalog = [{ value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }]
  const fake = fakeSdk({ init: () => ({ models: catalog, capabilities: ['msg_lifecycle_v1'] }) })
  const session = await openClaudeSession(baseDeps(fake.sdk, clock))
  const sink = collect(session)
  await tick()
  check('fresh open: the session names the handshake default model before any turn', session.capabilities.models.current().model === 'claude-opus-5-5', session.capabilities.models.current())
  check('fresh open: effort levels resolve', session.capabilities.effort.levels().length === 5, session.capabilities.effort.levels())
  check('fresh open: the channel learns the model from the backlog', sink.events().some(event => event.type === 'model.changed' && event.model === 'claude-opus-5-5'), sink.events().filter(event => event.type === 'model.changed'))
  await session.capabilities.effort.set('high')
  check('fresh open: /effort reaches the CLI once (flag settings)', JSON.stringify(fake.queries[0]!.flagSettings) === JSON.stringify([{ effortLevel: 'high' }]), fake.queries[0]!.flagSettings)
  check('fresh open: the effort readout follows', session.capabilities.effort.current() === 'high')
  await session.dispose()
}
{
  // The real SDK's initialize response carries no scalar model, only the
  // catalog, whose `default` alias row names the resolved default. A cold
  // start (no prefs, no explicit model) must still seed from that row.
  const { clock } = manualClock()
  const catalog = [
    { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'claude-haiku-4-5', displayName: 'Haiku', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
  ]
  const fake = fakeSdk({ init: () => ({ models: catalog, capabilities: ['msg_lifecycle_v1'] }) })
  const session = await openClaudeSession(baseDeps(fake.sdk, clock))
  const sink = collect(session)
  await tick()
  check('cold start (no scalar model): the catalog default row seeds the resolved model', session.capabilities.models.current().model === 'claude-opus-5-5', session.capabilities.models.current())
  check('cold start: effort levels resolve off that row', session.capabilities.effort.levels().length === 5, session.capabilities.effort.levels())
  check('cold start: the channel learns it from the backlog', sink.events().some(event => event.type === 'model.changed' && event.model === 'claude-opus-5-5'))
  await session.dispose()
  // A default row without resolvedModel seeds its own value; no default row
  // at all stays unknown (nothing is hardcoded or guessed).
  const aliasOnly = await openClaudeSession(baseDeps(fakeSdk({ init: () => ({ models: [{ value: 'default', displayName: 'Default' }], capabilities: ['msg_lifecycle_v1'] }) }).sdk, clock))
  check('cold start: a default row without resolvedModel seeds its value', aliasOnly.capabilities.models.current().model === 'default')
  await aliasOnly.dispose()
  const noDefault = await openClaudeSession(baseDeps(fakeSdk({ init: () => ({ models: catalog.filter(row => row.value !== 'default'), capabilities: ['msg_lifecycle_v1'] }) }).sdk, clock))
  check('cold start: no default row, no scalar, no prefs stays unknown', noDefault.capabilities.models.current().model === '' && noDefault.capabilities.effort.levels().length === 0)
  await noDefault.dispose()
  // A scalar model, when the CLI does provide one, wins over the row.
  const both = await openClaudeSession(baseDeps(fakeSdk({ init: () => ({ model: 'claude-sonnet-4-5', models: catalog, capabilities: ['msg_lifecycle_v1'] }) }).sdk, clock))
  check('cold start: a scalar handshake model wins over the default row', both.capabilities.models.current().model === 'claude-sonnet-4-5')
  await both.dispose()
}
{
  // Priority: the persisted choice, then the explicit start model, then the
  // handshake default; nothing at all keeps the model unknown (no crash).
  const { clock } = manualClock()
  const prefs = memoryClaudePrefs()
  prefs.write({ model: 'claude-haiku-4-5' })
  const withDefault = fakeSdk({ init: () => ({ model: 'claude-opus-5-5', capabilities: ['msg_lifecycle_v1'] }) })
  const persisted = await openClaudeSession(baseDeps(withDefault.sdk, clock, { prefs }))
  check('seed priority: the persisted model wins over the handshake default', persisted.capabilities.models.current().model === 'claude-haiku-4-5')
  await persisted.dispose()
  const explicit = await openClaudeSession(baseDeps(fakeSdk({ init: () => ({ model: 'claude-opus-5-5', capabilities: ['msg_lifecycle_v1'] }) }).sdk, clock, { model: 'claude-sonnet-4-5' }))
  check('seed priority: the explicit start model wins over the handshake default', explicit.capabilities.models.current().model === 'claude-sonnet-4-5')
  await explicit.dispose()
  const unknown = await openClaudeSession(baseDeps(fakeSdk({ init: () => ({ capabilities: ['msg_lifecycle_v1'] }) }).sdk, clock))
  check('seed priority: no model anywhere stays unknown (levels empty, no crash)', unknown.capabilities.models.current().model === '' && unknown.capabilities.effort.levels().length === 0)
  await unknown.dispose()
}
{
  // A reconnect never overwrites a model set since (and a resumed session
  // keeps the replay's model: the seed only fills an empty one).
  const { clock } = manualClock()
  const fake = fakeSdk({ init: () => ({ model: 'claude-opus-5-5', capabilities: ['msg_lifecycle_v1'] }) })
  const session = await openClaudeSession(baseDeps(fake.sdk, clock))
  await tick()
  check('reconnect seed: the open seeded the default', session.capabilities.models.current().model === 'claude-opus-5-5')
  // The CLI's own frames still update the model (first system/init).
  fake.queries[0]!.emit({ type: 'system', subtype: 'init', session_id: 's', cwd: '/fixture/project', model: 'claude-haiku-4-5', slash_commands: [], claude_code_version: '9.9.9' })
  await tick()
  check('reconnect seed: the CLI own init frame still updates the model', session.capabilities.models.current().model === 'claude-haiku-4-5')
  fake.queries[0]!.emit({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' })
  for (let i = 0; i < 6; i += 1) await tick()
  check('reconnect seed: the replacement handshake does not overwrite it', fake.queries.length === 2 && session.capabilities.models.current().model === 'claude-haiku-4-5')
  await session.dispose()
  const resumedSdk = fakeSdk({ init: () => ({ model: 'claude-opus-5-5', capabilities: ['msg_lifecycle_v1'] }) })
  const replay: ClaudeReplay = { events: [], start: { turn: 3, seq: 7, model: 'claude-sonnet-4-5' } }
  const resumedSession = await openClaudeSession(baseDeps(resumedSdk.sdk, clock, { resume: replay }))
  await tick()
  check('resume: the replay model is kept (the seed only fills an empty one)', resumedSession.capabilities.models.current().model === 'claude-sonnet-4-5')
  await resumedSession.dispose()
}

console.log(`\nverify-claude-session-lifecycle OK (${passed} checks)`)
process.exit(0)
