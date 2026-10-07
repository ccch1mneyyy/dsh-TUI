/** C3 production lifecycle: real hub/session/prefs/images on a scripted
 * external app-server. No private credentials/history or live model calls.
 * CODEX_TEST_SOURCE_ROOT selects an integration checkout; every runtime
 * module (including protocol/i18n/prefs) loads from that same source plane.
 * Reconnect-specific recovery belongs to verify-codex-reconnect.
 * Run: node --import tsx/esm scripts/verify-codex-lifecycle.ts */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { AgentEvent, ImageRef, QuestionRequestView } from '../src/agent/events.js'
import type { AgentSession } from '../src/agent/session.js'
import type { CodexPrefsData } from '../src/backends/codex/prefs.js'
import type { RpcClock } from '../src/backends/codex/rpc/client.js'
import { createFakeAppServer, FakeRpcError, NO_REPLY, type FakeAppServer } from './lib/codex-fake-app-server.js'

const root = process.env.CODEX_TEST_SOURCE_ROOT ?? fileURLToPath(new URL('../', import.meta.url))
const fromSource = (path: string) => import(pathToFileURL(resolve(root, 'src', path)).href)
const { createCodexHub } = await fromSource('backends/codex/rpc/hub.js') as typeof import('../src/backends/codex/rpc/hub.js')
const { openCodexSession } = await fromSource('backends/codex/session/session.js') as typeof import('../src/backends/codex/session/session.js')
const { memoryCodexPrefs, fileCodexPrefs } = await fromSource('backends/codex/prefs.js') as typeof import('../src/backends/codex/prefs.js')
const { dataUrlImageFacade, CODEX_IMAGE_LIMITS } = await fromSource('backends/codex/session/images.js') as typeof import('../src/backends/codex/session/images.js')
const { CLIENT, NOTIFY } = await fromSource('backends/codex/protocol/index.js') as { CLIENT: Readonly<Record<string, string>>; NOTIFY: Readonly<Record<string, string>> }
const { setLang, t } = await fromSource('i18n.js') as typeof import('../src/i18n.js')
setLang('en')
type Rec = Record<string, unknown>
const asRec = (value: unknown): Rec | undefined => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Rec : undefined
const THREAD = 'lifecycle-root'
const CWD = '/TMP/codex-lifecycle'
let passed = 0
const failures: string[] = []
function check(label: string, value: unknown, expected: unknown = true): void {
  try { assert.deepEqual(value, expected); passed += 1; console.log('PASS ' + label) }
  catch (error) { failures.push(label); console.error('FAIL ' + label + ': ' + (error instanceof Error ? error.message : String(error))) }
}
async function scenario(label: string, run: () => Promise<void>): Promise<void> {
  console.log('\n' + label)
  try { await run() } catch (error) { failures.push(label); console.error('FAIL ' + label + ': ' + (error instanceof Error ? error.stack : String(error))) }
}
// 固定窗:探针 drain fake-transport microtasks; this is not a latency assertion.
const tick = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })
function manualClock(): RpcClock & { advance(ms: number): void } {
  let now = 0
  let next = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  return {
    setTimeout: (callback, ms) => { const id = ++next; timers.set(id, { at: now + ms, callback }); return id },
    clearTimeout: handle => { timers.delete(handle as number) },
    advance: ms => { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback() } },
  }
}
const turn = (id: string, items?: readonly Rec[], status = 'completed'): Rec => ({
  id, status, startedAt: 100, completedAt: status === 'completed' ? 101 : null, error: null,
  items: items ?? [
    { type: 'userMessage', id: 'user-' + id, clientId: null, content: [{ type: 'text', text: 'prompt-' + id, text_elements: [] }] },
    { type: 'agentMessage', id: 'reply-' + id, text: 'answer-' + id, phase: 'final_answer' },
  ],
})
function answer(id = THREAD, extra: Rec = {}): Rec {
  return { thread: { id, cwd: CWD, status: { type: 'idle' }, turns: [], name: null, model: 'gpt-fixture', modelProvider: 'relay' }, cwd: CWD, model: 'gpt-fixture', modelProvider: 'relay', approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite', writableRoots: [CWD], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, reasoningEffort: 'low', ...extra }
}
const resume = (turns: readonly Rec[], cursor?: string): Rec => answer(THREAD, { initialTurnsPage: { data: turns, nextCursor: cursor ?? null } })
async function fixture(options: {
  readonly resume?: Rec
  readonly prefs?: CodexPrefsData
  readonly store?: ReturnType<typeof memoryCodexPrefs>
  readonly configure?: (fake: FakeAppServer) => void
} = {}) {
  const fake = createFakeAppServer()
  const clock = manualClock()
  const debug: string[] = []
  const hub = createCodexHub({ executable: '/fake/codex', args: ['app-server'], env: {}, cwd: CWD }, { transportFactory: fake.transportFactory, clock, debug: line => debug.push(line) })
  await hub.ready
  let starts = 0
  let forks = 0
  let turns = 0
  fake.on(CLIENT.threadStart, () => answer(starts++ === 0 && options.resume === undefined ? THREAD : 'lifecycle-reset'))
  fake.on(CLIENT.threadResume, () => options.resume ?? answer())
  fake.on(CLIENT.threadFork, () => answer('lifecycle-fork-' + ++forks))
  fake.on(CLIENT.threadRead, () => ({ thread: { parentThreadId: null } }))
  fake.on(CLIENT.threadUnsubscribe, () => ({}))
  fake.on(CLIENT.threadNameSet, () => ({}))
  fake.on(CLIENT.threadSettingsUpdate, () => ({}))
  fake.on(CLIENT.modelList, () => ({ data: [{ id: 'gpt-fixture', model: 'gpt-fixture', displayName: 'Fixture', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' }], nextCursor: null }))
  fake.on(CLIENT.collaborationModeList, () => ({ data: [{ mode: 'default' }, { mode: 'plan' }] }))
  fake.on(CLIENT.backgroundTerminalsList, () => ({ data: [], nextCursor: null }))
  fake.on(CLIENT.threadGoalGet, () => ({ goal: null }))
  fake.on(CLIENT.turnStart, () => ({ turn: { id: 'live-turn-' + ++turns, items: [], status: 'inProgress' } }))
  fake.on(CLIENT.turnSteer, params => ({ turnId: params.expectedTurnId }))
  fake.on(CLIENT.turnInterrupt, () => ({}))
  options.configure?.(fake)
  const prefs = options.store ?? memoryCodexPrefs(options.prefs ?? {})
  let releases = 0
  const release = hub.retain()
  let session: AgentSession
  try {
    session = await openCodexSession({ hub, release: () => { releases += 1; release() }, target: options.resume === undefined ? { kind: 'create', cwd: CWD } : { kind: 'resume', sessionId: THREAD }, cwd: CWD, prefs, config: {}, executable: { path: '/fake/codex', source: 'env', version: '0.160.1' }, host: { debug: line => debug.push(line) }, clock })
  } catch (error) { await hub.close(); throw error }
  const events: AgentEvent[] = []
  const off = session.subscribe(batch => events.push(...batch))
  await tick()
  const sent = (method: string): Rec[] => fake.requests.filter(request => request.method === method).map(request => request.params)
  const notify = async (method: string, params: Rec): Promise<void> => { fake.notify(method, { threadId: session.ref.sessionId, ...params }); await tick() }
  return { fake, hub, clock, prefs, session, events, debug, sent, notify, get releases() { return releases }, close: async () => { await session.dispose(); await session.dispose(); off(); await hub.close() } }
}

await scenario('Fork and rewind production capability', async () => {
  const f = await fixture({ resume: resume([turn('3'), turn('2'), turn('1')]) })
  try {
    const seed = await f.session.history()
    check('resume replays oldest first once', seed.filter(event => event.type === 'user.message').map(event => event.text), ['prompt-1', 'prompt-2', 'prompt-3'])
    check('second history read is empty', (await f.session.history()).length, 0)
    const branch = await f.session.capabilities.fork!.fork('user-2', 'Branch title')
    check('fork includes selected native turn rather than predecessor', f.sent(CLIENT.threadFork).at(-1)?.lastTurnId, '2')
    check('fork returns separate Codex ref without adopting it', branch.backendId === 'codex' && branch.sessionId !== THREAD && f.session.ref.sessionId === THREAD)
    check('fork title is applied to new branch and releases its subscription', f.sent(CLIENT.threadNameSet).at(-1)?.threadId === branch.sessionId && f.sent(CLIENT.threadNameSet).at(-1)?.name === 'Branch title' && f.sent(CLIENT.threadUnsubscribe).some(row => row.threadId === branch.sessionId))
    await f.session.capabilities.fork!.fork()
    check('unanchored fork requests the whole conversation', f.sent(CLIENT.threadFork).at(-1)?.lastTurnId === undefined)
    const rewound = await f.session.capabilities.rewind!.rewind('user-3', 'conversation')
    check('rewind forks to predecessor and returns a new ref', rewound.kind === 'rewound' && rewound.session.sessionId !== THREAD && f.sent(CLIENT.threadFork).at(-1)?.lastTurnId === '2')
    const beforeStart = f.sent(CLIENT.threadStart).length
    const first = await f.session.capabilities.rewind!.rewind('user-1', 'conversation')
    check('rewind original first turn creates an empty same-cwd thread', first.kind === 'rewound' && f.sent(CLIENT.threadStart).length === beforeStart + 1 && f.sent(CLIENT.threadStart).at(-1)?.cwd === CWD)
    const beforeMutations = f.sent(CLIENT.threadStart).length + f.sent(CLIENT.threadFork).length
    check('file rewind explicitly refuses', (await f.session.capabilities.rewind!.rewind('user-2', 'files')).kind, 'refused')
    check('combined rewind explicitly refuses without native mutation', (await f.session.capabilities.rewind!.rewind('user-2', 'both')).kind === 'refused' && f.sent(CLIENT.threadStart).length + f.sent(CLIENT.threadFork).length === beforeMutations)
    check('missing rewind anchor explicitly refuses', (await f.session.capabilities.rewind!.rewind('absent', 'conversation')).kind, 'refused')
    check('fork/rewind never use destructive revert or experimental beforeTurnId', !f.fake.requests.some(request => request.method === 'thread/revert' || Object.hasOwn(request.params, 'beforeTurnId')))
  } finally { await f.close() }
  check('normal dispose releases hub exactly once', f.releases, 1)
})

await scenario('Older anchor and prefetch predecessor production capability', async () => {
  const f = await fixture({ resume: resume([turn('3')], 'older'), configure: fake => fake.on(CLIENT.threadTurnsList, () => ({ data: [turn('2'), turn('1')], nextCursor: null })) })
  try {
    await f.session.history()
    await tick()
    const initialRecord = f.session.capabilities.transcript!.record()!
    check('record contains displayed page before older adoption', initialRecord.filter(event => event.type === 'user.message').map(event => event.text), ['prompt-3'])
    const rewound = await f.session.capabilities.rewind!.rewind('user-3', 'conversation')
    check('rewind earliest loaded turn uses prefetched real predecessor', rewound.kind === 'rewound' && f.sent(CLIENT.threadFork).at(-1)?.lastTurnId === '2' && f.sent(CLIENT.threadStart).length === 0)
    const older = f.session.capabilities.transcript!.older()
    check('older capability is synchronous and exposes full ordered history', Array.isArray(older) && older.filter(event => event.type === 'user.message').map(event => event.text).join(',') === 'prompt-1,prompt-2')
    check('older cursor exhausts without returning the same page twice', !f.session.capabilities.transcript!.hasOlder() && f.session.capabilities.transcript!.older().length === 0)
    await f.session.capabilities.fork!.fork('user-2')
    check('fork can locate an older anchor outside initial live context', f.sent(CLIENT.threadFork).at(-1)?.lastTurnId, '2')
    check('record now includes all adopted native turns', f.session.capabilities.transcript!.record()!.filter(event => event.type === 'user.message').map(event => event.text), ['prompt-1', 'prompt-2', 'prompt-3'])
  } finally { await f.close() }
})

await scenario('Pending older cache cannot be mistaken for original first turn', async () => {
  const f = await fixture({ resume: resume([turn('3')], 'older'), configure: fake => fake.on(CLIENT.threadTurnsList, () => NO_REPLY) })
  try {
    await f.session.history()
    const refused = await f.session.capabilities.rewind!.rewind('user-3', 'conversation')
    check('rewind with unresolved ancestry does not create empty thread', refused.kind === 'refused' && f.sent(CLIENT.threadStart).length === 0 && f.sent(CLIENT.threadFork).length === 0)
    check('pending prefetch older click stays synchronous and keeps affordance', f.session.capabilities.transcript!.older().length === 0 && f.session.capabilities.transcript!.hasOlder())
    const page = await f.fake.waitForRequest(CLIENT.threadTurnsList)
    f.fake.reply(page.id, { data: [turn('2')], nextCursor: null })
    await tick()
    const rewound = await f.session.capabilities.rewind!.rewind('user-3', 'conversation')
    check('rewind succeeds against predecessor after page arrives', rewound.kind === 'rewound' && f.sent(CLIENT.threadFork).at(-1)?.lastTurnId === '2')
  } finally { await f.close() }
})

await scenario('Per-thread color persistence and bounded file preferences', async () => {
  const store = memoryCodexPrefs({ colors: { [THREAD]: 'red', other: 'green' } } as CodexPrefsData)
  const f = await fixture({ store })
  try {
    check('stored thread color is emitted at open and current capability reflects it', f.session.capabilities.color!.current() === 'red' && f.events.some(event => event.type === 'session.color' && event.color === 'red'))
    f.session.capabilities.color!.set('blue')
    check('color set persists by native thread id without changing another thread', asRec(store.read().colors)?.[THREAD] === 'blue' && asRec(store.read().colors)?.other === 'green')
    f.session.capabilities.color!.set('')
    check('clearing color removes own preference and emits theme default', asRec(store.read().colors)?.[THREAD] === undefined && f.session.capabilities.color!.current() === '' && f.events.some(event => event.type === 'session.color' && event.color === ''))
  } finally { await f.close() }
  const dir = mkdtempSync(join(tmpdir(), 'codex-lifecycle-prefs-'))
  try {
    const prefs = fileCodexPrefs(dir)
    prefs.write({ colors: Object.fromEntries(Array.from({ length: 205 }, (_, index) => ['thread-' + index, 'blue'])) } as Parameters<typeof prefs.write>[0])
    const colors = asRec(prefs.read().colors) ?? {}
    check('file color map keeps the newest 200 entries', Object.keys(colors).length === 200 && colors['thread-0'] === undefined && colors['thread-204'] === 'blue')
    check('reloaded color state comes only from TUI prefs file', Object.keys(asRec(JSON.parse(readFileSync(join(dir, 'prefs.json'), 'utf8'))?.colors) ?? {}).length, 200)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await scenario('Images traverse real submit/live/replay session path', async () => {
  const f = await fixture()
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xkAAAAASUVORK5CYII=', 'base64')
    const url = 'data:image/png;base64,' + png.toString('base64')
    const image = dataUrlImageFacade('staged', url)!
    check('session advertises real Codex image budget', f.session.capabilities.images?.limits.maxImagesPerMessage, CODEX_IMAGE_LIMITS.maxImagesPerMessage)
    const accepted = await f.session.submit({ text: 'inspect', images: [image], clientMessageId: 'image-submit' }, 'turn')
    const params = f.sent(CLIENT.turnStart).at(-1)!
    const wire = params.input as readonly Rec[]
    check('submit accepts image and persists data URL after text', accepted.accepted && wire[0]?.type === 'text' && wire[1]?.type === 'image' && wire[1]?.url === url)
    const item = { type: 'userMessage', id: 'image-user', clientId: 'image-submit', content: wire }
    await f.notify(NOTIFY.turnStarted, { turn: { id: 'live-turn-1', status: 'inProgress', items: [] } })
    await f.notify(NOTIFY.itemStarted, { turnId: 'live-turn-1', item })
    await f.notify(NOTIFY.itemCompleted, { turnId: 'live-turn-1', item })
    await f.notify(NOTIFY.itemStarted, { turnId: 'live-turn-1', item: { type: 'agentMessage', id: 'image-reply', text: '', phase: 'final_answer' } })
    await f.notify(NOTIFY.itemCompleted, { turnId: 'live-turn-1', item: { type: 'agentMessage', id: 'image-reply', text: 'One pixel.', phase: 'final_answer' } })
    await f.notify(NOTIFY.turnCompleted, { turn: { id: 'live-turn-1', status: 'completed', items: [] } })
    const liveUser = f.events.find(event => event.type === 'user.message' && event.anchor === 'image-user')
    check('live user message owns lazy image facade from durable echoed input', liveUser?.type === 'user.message' && liveUser.images?.[0]?.width === 1 && Buffer.from(await liveUser.images[0].read()).equals(png))
    const replayUser = f.session.capabilities.transcript!.record()!.find(event => event.type === 'user.message' && event.anchor === 'image-user')
    check('record replay restores the same image bytes and typed text', replayUser?.type === 'user.message' && replayUser.text === 'inspect' && replayUser.images?.[0]?.id === 'image-user#1' && Buffer.from(await replayUser.images[0].read()).equals(png))
    const before = f.sent(CLIENT.turnStart).length
    let refused = false
    try { await f.session.submit({ text: 'bad image', images: [{ ...image, mediaType: 'image/svg+xml' }], clientMessageId: 'bad' }, 'turn') } catch { refused = true }
    check('invalid image fails before a native turn request', refused && f.sent(CLIENT.turnStart).length === before)
  } finally { await f.close() }
})

await scenario('Plan clear-context rebinds every subsequent lifecycle action', async () => {
  const f = await fixture({ resume: resume([turn('old')]) })
  try {
    await f.session.history()
    await f.session.capabilities.modes!.set('plan')
    await f.session.submit({ text: '/plan preserve this design', clientMessageId: 'plan-submit' }, 'turn')
    await f.notify(NOTIFY.turnStarted, { turn: { id: 'live-turn-1', status: 'inProgress', items: [] } })
    await f.notify(NOTIFY.itemStarted, { turnId: 'live-turn-1', item: { type: 'plan', id: 'plan-item', text: '' } })
    await f.notify(NOTIFY.itemCompleted, { turnId: 'live-turn-1', item: { type: 'plan', id: 'plan-item', text: '1. Preserve identity.\n2. Keep the native design.' } })
    await f.notify(NOTIFY.turnCompleted, { turn: { id: 'live-turn-1', status: 'completed', items: [] } })
    const event = f.events.filter(event => event.type === 'question.request').at(-1)
    assert.ok(event?.type === 'question.request')
    const question: QuestionRequestView = event.request
    const after = f.fake.requests.length
    f.session.capabilities.questions!.respond(question.requestId, { answers: [{ selected: [t('codex-plan-clear')] }] })
    await f.fake.waitForRequest(CLIENT.threadStart, { after })
    await f.fake.waitForRequest(CLIENT.turnStart, { after })
    await tick()
    const resetId = f.session.ref.sessionId
    check('Plan reset publishes a new native ref and session reset identity', resetId !== THREAD && f.events.some(event => event.type === 'session.reset') && f.events.some(event => event.type === 'session.ready' && event.sessionId === resetId))
    check('carried Plan implementation is sent on the newly bound thread', f.sent(CLIENT.turnStart).at(-1)?.threadId === resetId && JSON.stringify(f.sent(CLIENT.turnStart).at(-1)?.input).includes('Preserve identity'))
    check('Plan reset removes old transcript/cache and old anchor fact', f.session.capabilities.transcript!.record()!.every(event => event.type !== 'user.message' || event.anchor !== 'user-old') && !f.session.capabilities.transcript!.hasOlder())
    check('Plan reset unsubscribes old thread without archiving it', f.sent(CLIENT.threadUnsubscribe).some(params => params.threadId === THREAD) && !f.fake.requests.some(request => request.method === CLIENT.threadArchive))
    check('Plan review settles and permission returns without escalation', f.events.some(event => event.type === 'question.settled' && event.requestId === question.requestId) && f.session.capabilities.modes!.current() === 'auto')
    f.session.capabilities.color!.set('cyan')
    check('color after Plan reset belongs to new thread', asRec(f.prefs.read().colors)?.[resetId], 'cyan')
    await f.notify(NOTIFY.turnCompleted, { turn: { id: 'live-turn-2', status: 'completed', items: [] } })
    await f.session.capabilities.fork!.fork()
    check('fork after Plan reset targets current native thread', f.sent(CLIENT.threadFork).at(-1)?.threadId, resetId)
    await f.session.capabilities.rename!.rename('After reset')
    check('rename after Plan reset targets current native thread', f.sent(CLIENT.threadNameSet).at(-1)?.threadId, resetId)
  } finally { await f.close() }
})

await scenario('Running resume continues one native turn without duplicated tool call', async () => {
  const user = { type: 'userMessage', id: 'running-user', clientId: null, content: [{ type: 'text', text: 'continue' }] }
  const command = { type: 'commandExecution', id: 'running-tool', command: 'echo running', cwd: CWD, status: 'inProgress', aggregatedOutput: '', exitCode: null }
  const running = turn('running', [user, command], 'inProgress')
  const f = await fixture({ resume: answer(THREAD, { thread: { id: THREAD, cwd: CWD, status: { type: 'active' }, turns: [] }, initialTurnsPage: { data: [running], nextCursor: null } }) })
  try {
    const seed = await f.session.history()
    check('running resume starts in running status with one open durable turn', f.session.status === 'running' && seed.filter(event => event.type === 'turn.start').length === 1 && !seed.some(event => event.type === 'turn.end'))
    await f.notify(NOTIFY.itemCompleted, { turnId: 'running', item: { ...command, status: 'completed', aggregatedOutput: 'full output', exitCode: 0 } })
    await f.notify(NOTIFY.turnCompleted, { turn: { id: 'running', status: 'completed', items: [{ type: 'commandExecution', id: 'running-tool', aggregatedOutput: null }] } })
    check('running resume completion settles exactly the replayed tool', [...seed, ...f.events].filter(event => event.type === 'tool.call' && event.callId === 'running-tool').length === 1 && f.events.filter(event => event.type === 'tool.result' && event.callId === 'running-tool').length === 1)
    check('running resume ends the original turn once and returns idle', [...seed, ...f.events].filter(event => event.type === 'turn.start').length === 1 && f.events.filter(event => event.type === 'turn.end').length === 1 && f.session.status === 'idle')
    const record = f.session.capabilities.transcript!.record()!
    check('production summary completion preserves full tool body for folded restore', record.some(event => event.type === 'tool.result' && event.callId === 'running-tool' && event.text === 'full output'))
  } finally { await f.close() }
})

await scenario('Post-open initialization failure releases subscription and hub retain', async () => {
  const fake = createFakeAppServer()
  const clock = manualClock()
  const hub = createCodexHub({ executable: '/fake/codex', args: ['app-server'], env: {}, cwd: CWD }, { transportFactory: fake.transportFactory, clock })
  await hub.ready
  fake.on(CLIENT.threadStart, () => answer())
  fake.on(CLIENT.modelList, () => ({ data: [], nextCursor: null }))
  fake.on(CLIENT.collaborationModeList, () => ({ data: [{ mode: 'plan' }] }))
  fake.on(CLIENT.threadSettingsUpdate, () => { throw new FakeRpcError(-32603, 'fixture initialization failed') })
  fake.on(CLIENT.backgroundTerminalsList, () => ({ data: [], nextCursor: null }))
  fake.on(CLIENT.threadGoalGet, () => ({ goal: null }))
  fake.on(CLIENT.threadUnsubscribe, () => ({}))
  let released = 0
  const release = hub.retain()
  try {
    let error: unknown
    try { await openCodexSession({ hub, release: () => { released += 1; release() }, target: { kind: 'create', cwd: CWD }, cwd: CWD, prefs: memoryCodexPrefs({ plan: true }), config: {}, executable: { path: '/fake/codex', source: 'env', version: '0.160.1' }, host: { debug: () => undefined }, clock }) } catch (caught) { error = caught }
    check('post-open initialization failure rejects rather than leaking a session', error instanceof Error && error.message.includes('fixture initialization failed'))
    check('post-open initialization failure unsubscribes opened thread and releases exactly once', released === 1 && fake.requests.some(request => request.method === CLIENT.threadUnsubscribe && request.params.threadId === THREAD))
    clock.advance(30_000)
    await tick()
    check('failed open has no hidden retain preventing idle child shutdown', hub.state, 'closed')
  } finally { await hub.close() }
})

if (failures.length > 0) {
  console.error('\nverify-codex-lifecycle FAILED (' + passed + ' passed, ' + failures.length + ' failed): ' + failures.join(', '))
  process.exitCode = 1
} else console.log('\nverify-codex-lifecycle OK (' + passed + ' checks)')
