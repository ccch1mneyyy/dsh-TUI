/**
 * Codex side-query/activity/output regressions against a source-selected production plane.
 * Uses the real Codex hub, side-query, activity and tool-output modules; only the
 * app-server transport is fake. No renderer, network, credentials, or full build.
 * Run: node --import tsx/esm scripts/verify-codex-side-query.ts
 */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createFakeAppServer, FakeRpcError, NO_REPLY } from './lib/codex-fake-app-server.js'
import type { RpcClock } from '../src/backends/codex/rpc/client.js'
import type { AgentEvent } from '../src/agent/events.js'
import type { WorkingActivityView } from '../src/adapter/ports/channel-view.js'

function manualClock(): RpcClock & { advance(ms: number): void; pending(): number; now(): number } {
  let now = 0
  let next = 0
  const timers = new Map<number, { at: number; callback(): void }>()
  return {
    setTimeout(callback, ms) { const id = ++next; timers.set(id, { at: now + ms, callback }); return id },
    clearTimeout(handle) { timers.delete(handle as number) },
    pending: () => timers.size, now: () => now,
    advance(ms) {
      const until = now + ms
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (due === undefined) break
        now = due[1].at; timers.delete(due[0]); due[1].callback()
      }
      now = until
    },
  }
}

type Rec = Record<string, unknown>
type Clock = ReturnType<typeof manualClock>
const runtimeRoot = process.env.CODEX_TEST_SOURCE_ROOT ?? fileURLToPath(new URL('../', import.meta.url))
const moduleUrl = (path: string): string => pathToFileURL(resolve(runtimeRoot, path)).href
const { setLang, t } = await import(moduleUrl('src/i18n.js')) as typeof import('../src/i18n.js')
const { createCodexHub } = await import(moduleUrl('src/backends/codex/rpc/hub.js')) as typeof import('../src/backends/codex/rpc/hub.js')
const { createCodexSideQuery } = await import(moduleUrl('src/backends/codex/session/side-query.js')) as typeof import('../src/backends/codex/session/side-query.js')
const { createCodexActivity } = await import(moduleUrl('src/backends/codex/session/activity.js')) as typeof import('../src/backends/codex/session/activity.js')
const { createToolOutputBuffer } = await import(moduleUrl('src/backends/codex/session/tool-output.js')) as typeof import('../src/backends/codex/session/tool-output.js')
const { openCodexSession } = await import(moduleUrl('src/backends/codex/session/session.js')) as typeof import('../src/backends/codex/session/session.js')
const { memoryCodexPrefs } = await import(moduleUrl('src/backends/codex/prefs.js')) as typeof import('../src/backends/codex/prefs.js')

setLang('en')
let passed = 0
const failures: string[] = []
function check(name: string, actual: unknown, expected: unknown = true): void {
  try { assert.deepEqual(actual, expected); passed += 1; console.log('PASS', name) }
  catch (error) { failures.push(name); console.error('FAIL', name, error instanceof Error ? error.message : String(error)) }
}
// 固定窗:探针 drain fake transport notifications; no timing assertion uses wall clock.
const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })
const THREAD = 'thread-parent'
const CHILD = 'thread-side-query'
const makeHub = async (fake: ReturnType<typeof createFakeAppServer>, clock: Clock) => {
  const hub = createCodexHub({ executable: '/fake/codex', args: ['app-server'], env: {}, cwd: '/TMP/cwd' }, { transportFactory: fake.transportFactory, clock, debug: () => {} })
  await hub.ready
  fake.on('thread/unsubscribe', () => ({}))
  fake.on('turn/interrupt', () => ({}))
  fake.on('thread/read', params => ({ thread: { id: params.threadId, parentThreadId: null } }))
  return hub
}
const sideRuntime = (hub: Awaited<ReturnType<typeof makeHub>>, clock: Clock, closed = false, debug: string[] = []) => createCodexSideQuery({
  hub,
  settings: { model: 'gpt-test', effort: 'low', modeId: 'auto' },
  cwd: '/TMP/cwd', clock, threadId: () => THREAD, closed: () => closed, debug: line => debug.push(line),
})
const sideDeps = (...args: Parameters<typeof sideRuntime>) => sideRuntime(...args).capability
const paramsOf = (fake: ReturnType<typeof createFakeAppServer>, method: string): Rec[] => fake.requests.filter(request => request.method === method).map(request => request.params)

async function scenario(name: string, run: () => Promise<void>): Promise<void> {
  console.log('\n' + name)
  try { await run() } catch (error) { failures.push(name); console.error('FAIL', name, error) }
}

await scenario('side query forks read-only without main events or goals', async () => {
  const fake = createFakeAppServer()
  const clock = manualClock()
  fake.on('thread/fork', () => ({ thread: { id: CHILD } }))
  fake.on('turn/start', () => ({ turn: { id: 'side-turn', status: 'inProgress' } }))
  const hub = await makeHub(fake, clock)
  try {
    const text: string[] = []
    const sideQuery = sideDeps(hub, clock)
    const pending = sideQuery.ask('What changed?', { onText: chunk => text.push(chunk) })
    await fake.waitForRequest('thread/fork')
    const fork = paramsOf(fake, 'thread/fork')[0]!
    check('fork sandbox is read-only', fork.sandbox, 'read-only')
    check('fork is ephemeral and excludes durable turns', { ephemeral: fork.ephemeral, excludeTurns: fork.excludeTurns, deferGoalContinuation: fork.deferGoalContinuation }, { ephemeral: true, excludeTurns: true, deferGoalContinuation: true })
    check('fork uses readonly never approval and current model/cwd', { cwd: fork.cwd, model: fork.model, approvalPolicy: fork.approvalPolicy, developerInstructions: fork.developerInstructions }, { cwd: '/TMP/cwd', model: 'gpt-test', approvalPolicy: 'never', developerInstructions: 'Answer the side question using the existing conversation. Do not call tools, modify files, create goals, or start agents. Give one concise answer.' })
    await fake.waitForRequest('turn/start')
    const start = paramsOf(fake, 'turn/start')[0]!
    check('side turn uses never approval readonly network disabled', { policy: start.approvalPolicy, sandbox: start.sandboxPolicy }, { policy: 'never', sandbox: { type: 'readOnly', networkAccess: false } })
    check('side turn carries current effort and no automatic goal continuation', start.effort === 'low' && paramsOf(fake, 'thread/goal/set').length === 0)
    fake.notify('turn/started', { threadId: CHILD, turn: { id: 'side-turn', status: 'inProgress' } })
    fake.notify('item/agentMessage/delta', { threadId: CHILD, turnId: 'side-turn', delta: 'A ' })
    fake.notify('item/agentMessage/delta', { threadId: CHILD, turnId: 'side-turn', delta: 'B' })
    fake.notify('item/completed', { threadId: CHILD, turnId: 'side-turn', item: { type: 'agentMessage', text: 'A B', phase: 'final_answer' } })
    fake.notify('turn/completed', { threadId: CHILD, turn: { id: 'side-turn', status: 'completed' } })
    await settle()
    check('streamed side answer reaches onText exactly', await pending, { answer: 'A B' })
    check('stream text is emitted by deltas without final duplication', text, ['A ', 'B'])
    check('side query only uses child sink, no main AgentEvent emitter', paramsOf(fake, 'thread/start').length, 0)
    await settle()
    check('successful side query unsubscribes child', paramsOf(fake, 'thread/unsubscribe').at(-1)?.threadId, CHILD)
    check('successful side query has no timer leak', clock.pending(), 0)
  } finally { await hub.close() }
})

await scenario('side query server error, interrupted cancel, closed and timeout clean up', async () => {
  const fake = createFakeAppServer()
  const clock = manualClock()
  const hub = await makeHub(fake, clock)
  try {
    fake.on('thread/fork', () => { throw new FakeRpcError(-32001, 'fork failed') })
    const failed = await sideDeps(hub, clock).ask('fail')
    check('fork error is returned without a dangling answer', failed.answer, null)
    check('fork error preserves backend message', failed.error, 'fork failed')
    check('fork error has no child unsubscribe', paramsOf(fake, 'thread/unsubscribe').length, 0)

    fake.off('thread/fork')
    fake.on('thread/fork', () => ({ thread: { id: CHILD } }))
    fake.on('turn/start', () => ({ turn: { id: 'cancel-turn', status: 'inProgress' } }))
    const controller = new AbortController()
    const cancelled = sideDeps(hub, clock).ask('cancel', { signal: controller.signal })
    await fake.waitForRequest('turn/start')
    fake.notify('turn/started', { threadId: CHILD, turn: { id: 'cancel-turn', status: 'inProgress' } })
    controller.abort()
    check('signal cancellation returns null answer', await cancelled, { answer: null })
    await fake.waitForRequest('turn/interrupt')
    check('signal cancellation interrupts the child turn', paramsOf(fake, 'turn/interrupt').at(-1)?.turnId, 'cancel-turn')
    await fake.waitForRequest('thread/unsubscribe')
    check('signal cancellation unsubscribes the child', paramsOf(fake, 'thread/unsubscribe').at(-1)?.threadId, CHILD)

    const closed = await sideDeps(hub, clock, true).ask('closed')
    check('closed session rejects before fork', closed.error, t('codex-session-closed'))

    const debug: string[] = []
    const after = fake.requests.length
    const timed = sideDeps(hub, clock, false, debug).ask('timeout')
    await fake.waitForRequest('turn/start', { after })
    await settle()
    clock.advance(120_000)
    check('timeout returns null answer', await timed, { answer: null })
    await fake.waitForRequest('turn/interrupt')
    await settle()
    check('timeout unsubscribes after real acknowledgements', paramsOf(fake, 'thread/unsubscribe').at(-1)?.threadId, CHILD)
    check('timeout clears all timers', clock.pending(), 0)
  } finally { await hub.close() }
})

await scenario('activity narrates native milestones and never re-narrates settled commentary', async () => {
  const clock = manualClock()
  let now = 0
  const emitted: { type: string; key?: string }[] = []
  const views: { phase: string; line: string; toolCount: number }[] = []
  const activity = createCodexActivity({ clock, now: () => ++now, emit: events => emitted.push(...events.map(event => ({ type: event.type, ...('key' in event && event.key !== undefined ? { key: event.key } : {}) }))) })
  const unsubscribe = activity.capability.subscribe(view => views.push({ phase: view.phase, line: view.line, toolCount: view.toolCount }))
  activity.notification('turn/started', { turn: { id: 'a' } })
  activity.notification('item/started', { item: { type: 'agentMessage' } })
  for (const delta of ['one', 'two', 'three']) activity.notification('item/agentMessage/delta', { delta })
  activity.notification('item/completed', { item: { type: 'agentMessage', phase: 'commentary', text: 'Checking the files.' } })
  // The commentary settles into the transcript as an assistant message
  // (verify-codex-translate locks that side); the working line must not keep
  // narrating it — that showed the same sentence twice at once, under the
  // spinner AND as the reply's first message.
  check('settled commentary never appears as a working line', views.filter(view => view.line === 'Checking the files.').length, 0)
  check('working line stays on the thinking copy after commentary settles', views.at(-1)?.line, t('codex-working-thinking'))
  activity.notification('item/started', { item: { type: 'commandExecution', command: 'pwsh -NoLogo -c ls', commandActions: [] } })
  check('command milestone is narrated', views.at(-1)?.line.includes('ls') && views.at(-1)?.phase === 'tool')
  activity.notification('item/completed', { item: { type: 'commandExecution' } })
  activity.notification('item/started', { item: { type: 'fileChange', changes: [{ path: 'a.ts' }, { path: 'b.ts' }] } })
  check('file milestone is narrated', views.at(-1)?.line.includes('a.ts') && views.at(-1)?.phase === 'tool')
  activity.notification('item/completed', { item: { type: 'fileChange' } })
  activity.notification('item/started', { item: { type: 'collabAgentToolCall' } })
  check('subagent wait milestone is narrated', views.at(-1)?.line === t('codex-working-subagents'))
  activity.notification('item/completed', { item: { type: 'collabAgentToolCall' } })
  check('tool completion increments count', views.at(-1)?.toolCount, 3)
  unsubscribe()
  activity.close()
})

await scenario('activity waiting timers are bounded and never fake-stall tools or blocked turns', async () => {
  const clock = manualClock()
  let now = 0
  const emitted: { type: string; key?: string }[] = []
  const activity = createCodexActivity({ clock, now: () => ++now, emit: events => emitted.push(...events.map(event => ({ type: event.type, ...('key' in event && event.key !== undefined ? { key: event.key } : {}) }))) })
  const views: WorkingActivityView[] = []
  activity.capability.subscribe(view => views.push(view))
  activity.notification('turn/started', {})
  clock.advance(29_999)
  check('waiting warning not early', views.at(-1)?.line, t('codex-working-thinking'))
  clock.advance(1)
  check('30s model waiting line appears', views.at(-1)?.line, t('codex-model-waiting'))
  activity.notification('thread/status/changed', { status: { type: 'active', activeFlags: ['waitingOnApproval'] } })
  clock.advance(120_000)
  check('requires-action never emits stalled warning', emitted.filter(event => event.key === 'codex-model-stalled').length, 0)
  activity.notification('turn/completed', { turn: { status: 'completed' } })
  clock.advance(120_000)
  check('idle clears all timers', emitted.length, 0)

  activity.notification('turn/started', {})
  activity.notification('item/started', { item: { type: 'commandExecution', command: 'sleep 1', commandActions: [] } })
  clock.advance(120_000)
  check('running tool never emits model stalled warning', emitted.filter(event => event.key === 'codex-model-stalled').length, 0)
  activity.reset()
  clock.advance(120_000)
  activity.close()
  check('reset and dispose leave no timer callbacks', emitted.length, 0)
})

await scenario('tool output coalesces, flushes before result and closes without a tick', async () => {
  const clock = manualClock()
  const emitted: { readonly callId: string; readonly text: string }[] = []
  const buffer = createToolOutputBuffer(events => emitted.push(...events.filter((event): event is Extract<typeof event, { type: 'tool.output' }> => event.type === 'tool.output').map(event => ({ callId: event.callId, text: event.text }))), clock)
  const output = (text: string) => ({ type: 'tool.output' as const, callId: 'call-1', text, time: 1 })
  buffer.push(output('a'))
  buffer.push(output('b'))
  clock.advance(99)
  check('output waits for 100ms window', emitted, [])
  clock.advance(1)
  check('output coalesces same call', emitted, [{ callId: 'call-1', text: 'ab' }])
  buffer.push(output('c'))
  buffer.flush('call-1')
  check('flush-before-result emits immediately', emitted, [{ callId: 'call-1', text: 'ab' }, { callId: 'call-1', text: 'c' }])
  buffer.push(output('d'))
  buffer.close()
  clock.advance(100)
  check('close clears pending timer and output', emitted, [{ callId: 'call-1', text: 'ab' }, { callId: 'call-1', text: 'c' }])
})


await scenario('side query owner close and late fork cleanup', async () => {
  const fake = createFakeAppServer()
  const clock = manualClock()
  fake.on('thread/fork', () => ({ thread: { id: CHILD } }))
  fake.on('turn/start', () => ({ turn: { id: 'owner-turn', status: 'inProgress' } }))
  const hub = await makeHub(fake, clock)
  const attached = new Set<string>()
  const attach = hub.attach.bind(hub)
  hub.attach = (id, sink) => { attached.add(id); const off = attach(id, sink); return () => { attached.delete(id); off() } }
  try {
    const text: string[] = []
    const runtime = sideRuntime(hub, clock)
    const answer = runtime.capability.ask('owner close', { onText: value => text.push(value) })
    await fake.waitForRequest('turn/start')
    await settle()
    runtime.close()
    check('R2 owner close terminates existing ask immediately', await answer, { answer: null })
    fake.notify('item/agentMessage/delta', { threadId: CHILD, delta: 'must not leak after close' })
    await settle()
    check('owner close blocks later onText callbacks', text, [])
    check('owner close sends child interrupt', paramsOf(fake, 'turn/interrupt').at(-1)?.turnId, 'owner-turn')
    check('owner close cleans child subscription and sink', paramsOf(fake, 'thread/unsubscribe').at(-1)?.threadId === CHILD && !attached.has(CHILD))
    check('owner close clears all request and query timers', clock.pending(), 0)
    check('closed runtime refuses new side query', (await runtime.capability.ask('closed')).error, t('codex-session-closed'))

    let forkId: number | string | undefined
    fake.on('thread/fork', (_params, request) => { forkId = request.id; return NO_REPLY })
    const next = sideRuntime(hub, clock)
    const after = fake.requests.length
    const late = next.capability.ask('late fork')
    forkId = (await fake.waitForRequest('thread/fork', { after })).id
    next.reset()
    check('reset settles caller while fork RPC is still pending', await late, { answer: null })
    const turns = paramsOf(fake, 'turn/start').length
    fake.reply(forkId, { thread: { id: 'late-child' } })
    await fake.waitForRequest('thread/unsubscribe', { after })
    await settle()
    check('cancelled late fork never starts a model turn', paramsOf(fake, 'turn/start').length, turns)
    check('cancelled late fork unsubscribes acknowledged child', paramsOf(fake, 'thread/unsubscribe').at(-1)?.threadId, 'late-child')
    check('late fork cleanup leaves no sink or timer', !attached.has('late-child') && clock.pending() === 0)
    next.close()
  } finally { await hub.close() }
})

await scenario('side request boundary and failed/interrupted turn cleanup', async () => {
  const fake = createFakeAppServer()
  const clock = manualClock()
  fake.on('thread/fork', () => ({ thread: { id: CHILD } }))
  fake.on('turn/start', () => ({ turn: { id: 'boundary-turn', status: 'inProgress' } }))
  const hub = await makeHub(fake, clock)
  const mainTraffic: string[] = []
  const off = hub.attach(THREAD, { notification: method => mainTraffic.push(method), serverRequest: request => { mainTraffic.push(request.method); request.respond({}) }, connectionLost() {}, connectionRestored() {} })
  try {
    const query = sideDeps(hub, clock)
    const pending = query.ask('boundary')
    await fake.waitForRequest('turn/start')
    const request = await fake.request('item/commandExecution/requestApproval', { threadId: CHILD, turnId: 'boundary-turn', itemId: 'blocked-tool', command: 'write file' })
    check('side query refuses tool or approval requests fail-closed', request.error?.code, -32601)
    fake.notify('turn/completed', { threadId: CHILD, turn: { id: 'boundary-turn', status: 'failed', error: { message: 'backend failure' } } })
    check('failed side turn exposes error instead of partial answer', await pending, { answer: null, error: 'backend failure' })
    await settle()
    check('side thread request and completion never touch parent sink', mainTraffic, [])
    check('failed turn clears query timer', clock.pending(), 0)
    const after = fake.requests.length
    const interrupted = query.ask('interrupted')
    await fake.waitForRequest('turn/start', { after })
    fake.notify('turn/completed', { threadId: CHILD, turn: { id: 'boundary-turn', status: 'interrupted' } })
    check('interrupted side turn returns null without error', await interrupted, { answer: null })
    await settle()
    check('interrupted side turn unsubscribes and clears timer', paramsOf(fake, 'thread/unsubscribe').at(-1)?.threadId === CHILD && clock.pending() === 0)
  } finally { off(); await hub.close() }
})

for (const type of ['mcpToolCall', 'webSearch']) await scenario('activity never fake-stalls native ' + type, async () => {
  const clock = manualClock()
  const events: AgentEvent[] = []
  const views: WorkingActivityView[] = []
  const activity = createCodexActivity({ clock, now: clock.now, emit: batch => events.push(...batch) })
  activity.capability.subscribe(view => views.push(view))
  activity.notification('turn/started', {})
  activity.notification('item/started', { item: { type, id: 'native-tool', server: 'docs', tool: 'search', query: 'terms' } })
  clock.advance(120_000)
  check('R3 native ' + type + ' is classified as tool', views.at(-1)?.phase, 'tool')
  check('R3 native ' + type + ' emits no false model-stalled notice', events.filter(event => event.type === 'notice' && event.key === 'codex-model-stalled').length, 0)
  activity.close()
  check(type + ' close cancels timers', clock.pending(), 0)
})

await scenario('activity stall and output timer boundaries', async () => {
  const clock = manualClock()
  const events: AgentEvent[] = []
  const views: WorkingActivityView[] = []
  const activity = createCodexActivity({ clock, now: clock.now, emit: batch => events.push(...batch) })
  activity.capability.subscribe(view => views.push(view))
  activity.notification('turn/started', {})
  clock.advance(119_999)
  check('120s stalled notice not early', events.length, 0)
  clock.advance(1)
  check('120s stalled notice emitted once', events.filter(event => event.type === 'notice' && event.key === 'codex-model-stalled').length, 1)
  clock.advance(120_000)
  check('continued silence does not repeat stalled notice', events.length, 1)
  activity.notification('turn/completed', {})
  check('idle removes all wait timers', clock.pending(), 0)
  activity.notification('turn/started', {})
  activity.notification('item/started', { item: { type: 'commandExecution', id: 'cmd', command: 'echo ready', commandActions: [] } })
  const before = views.length
  for (let index = 0; index < 60; index += 1) { activity.notification('item/commandExecution/outputDelta', { itemId: 'cmd', delta: 'tick' }); clock.advance(16) }
  check('60Hz command output does not publish line per token', views.length, before)
  check('tool output does not arm model wait timer', clock.pending(), 0)
  activity.close()
  check('closed activity clears all timers', clock.pending(), 0)
})


await scenario('real session side isolation dispose and output-before-result wiring', async () => {
  const fake = createFakeAppServer()
  const clock = manualClock()
  fake.on('thread/start', () => ({ thread: { id: THREAD, cwd: '/TMP/cwd', turns: [], status: { type: 'idle' } }, model: 'gpt-test', cwd: '/TMP/cwd', modelProvider: 'relay', reasoningEffort: 'low', approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' } }))
  fake.on('model/list', () => ({ data: [], nextCursor: null }))
  fake.on('collaborationMode/list', () => ({ data: [{ mode: 'default' }, { mode: 'plan' }] }))
  fake.on('thread/backgroundTerminals/list', () => ({ terminals: [] }))
  fake.on('thread/goal/get', () => ({ goal: null }))
  fake.on('thread/fork', () => ({ thread: { id: CHILD } }))
  fake.on('turn/start', () => ({ turn: { id: 'session-side', status: 'inProgress' } }))
  const hub = await makeHub(fake, clock)
  const sharedRetain = hub.retain()
  let session: Awaited<ReturnType<typeof openCodexSession>> | undefined
  try {
    session = await openCodexSession({ hub, release: hub.retain(), target: { kind: 'create', cwd: '/TMP/cwd' }, cwd: '/TMP/cwd', prefs: memoryCodexPrefs({}), config: {}, executable: { path: '/fake/codex', source: 'env', version: '0.160.1' }, host: { debug() {} }, clock, now: clock.now })
    const events: AgentEvent[] = []
    session.subscribe(batch => events.push(...batch))
    await settle()
    const before = events.length
    const first = session.capabilities.sideQuery!.ask('isolated')
    await fake.waitForRequest('turn/start')
    fake.notify('item/agentMessage/delta', { threadId: CHILD, turnId: 'session-side', delta: 'only the side answer' })
    fake.notify('turn/completed', { threadId: CHILD, turn: { id: 'session-side', status: 'completed' } })
    check('real session returns isolated streamed side answer', await first, { answer: 'only the side answer' })
    await settle()
    check('side result never enters main AgentEvent stream', events.length, before)

    fake.notify('turn/started', { threadId: THREAD, turn: { id: 'main-turn', status: 'inProgress' } })
    fake.notify('item/started', { threadId: THREAD, turnId: 'main-turn', item: { type: 'commandExecution', id: 'main-command', command: 'echo live', status: 'inProgress', source: 'agent' } })
    fake.notify('item/commandExecution/outputDelta', { threadId: THREAD, turnId: 'main-turn', itemId: 'main-command', delta: 'live output' })
    fake.notify('item/completed', { threadId: THREAD, turnId: 'main-turn', item: { type: 'commandExecution', id: 'main-command', command: 'echo live', status: 'completed', source: 'agent', aggregatedOutput: 'live output', exitCode: 0 } })
    await settle()
    const output = events.findIndex(event => event.type === 'tool.output' && event.callId === 'main-command')
    const result = events.findIndex(event => event.type === 'tool.result' && event.callId === 'main-command')
    check('production session flushes pending output before tool result without 100ms tick', output >= 0 && result > output)
    fake.notify('turn/completed', { threadId: THREAD, turn: { id: 'main-turn', status: 'completed' } })
    await settle()

    const after = fake.requests.length
    const inFlight = session.capabilities.sideQuery!.ask('dispose me')
    await fake.waitForRequest('turn/start', { after })
    await settle()
    await session.dispose()
    check('session.dispose cancels in-flight side ask on still-shared hub', await inFlight, { answer: null })
    await settle()
    check('session.dispose unsubscribes both side and main threads', paramsOf(fake, 'thread/unsubscribe').some(params => params.threadId === CHILD) && paramsOf(fake, 'thread/unsubscribe').some(params => params.threadId === THREAD))
    check('session.dispose does not close another hub owner', hub.state, 'ready')
    check('session.dispose clears owned timers while shared hub stays live', clock.pending(), 0)
  } finally { await session?.dispose(); sharedRetain(); await hub.close() }
})


await scenario('late turn-start acknowledgement after reset is interrupted and detached', async () => {
  const fake = createFakeAppServer()
  const clock = manualClock()
  fake.on('thread/fork', () => ({ thread: { id: CHILD } }))
  fake.on('turn/start', () => NO_REPLY)
  const hub = await makeHub(fake, clock)
  try {
    const runtime = sideRuntime(hub, clock)
    const answer = runtime.capability.ask('late turn')
    const start = await fake.waitForRequest('turn/start')
    runtime.reset()
    check('reset resolves while turn-start RPC is unacknowledged', await answer, { answer: null })
    fake.reply(start.id, { turn: { id: 'late-start', status: 'inProgress' } })
    await fake.waitForRequest('thread/unsubscribe')
    await settle()
    check('late acknowledged turn is still interrupted', paramsOf(fake, 'turn/interrupt').some(params => params.threadId === CHILD && params.turnId === 'late-start'))
    check('late acknowledged turn child is unsubscribed', paramsOf(fake, 'thread/unsubscribe').at(-1)?.threadId, CHILD)
    check('late start cleanup clears all timers', clock.pending(), 0)
    runtime.close()
  } finally { await hub.close() }
})

console.log('\nverify-codex-side-query OK (' + passed + ' checks)')
if (failures.length > 0) process.exitCode = 1
