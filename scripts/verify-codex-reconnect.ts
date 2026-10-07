/** Real Codex hub/session/channel reconnect regression; only app-server is fake.
 * Same-turn recovery must preserve tool cards, partial reply, inputs and billing.
 * Run: node --import tsx/esm scripts/verify-codex-reconnect.ts
 * CODEX_TEST_SOURCE_ROOT may point at an unmodified baseline for a red proof.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const home = mkdtempSync(join(tmpdir(), 'codex-reconnect-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_TUI_LANG = 'en'
const root = process.env.CODEX_TEST_SOURCE_ROOT ?? resolve('.')
const [{ createCodexHub }, { openCodexSession }, { createFakeAppServer, NO_REPLY }, { memoryCodexPrefs }, { manualClock, threadAnswer, THREAD, CWD }, { createChannel }, { settled }, { agentEventInvariantViolations }, { setLang }] = await Promise.all([
  import(pathToFileURL(resolve(root, 'src/backends/codex/rpc/hub.ts')).href),
  import(pathToFileURL(resolve(root, 'src/backends/codex/session/session.ts')).href),
  import('./lib/codex-fake-app-server.js'), import('../src/backends/codex/prefs.js'), import('./lib/codex-session-harness.js'),
  import('../src/dsh-adapter/channel.js'), import('./lib/term-test.mjs'), import('./lib/agent-event-invariants.js'), import('../src/i18n.js'),
])
setLang('en')
type Rec = Record<string, unknown>
type Event = import('../src/agent/events.js').AgentEvent
let passed = 0
const check = (name: string, ok: unknown, detail = ''): void => { assert.ok(ok, detail === '' ? name : name + '\n' + detail); passed += 1; console.log('PASS ' + name) }
const user = { type: 'userMessage', id: 'user-item', clientId: 'client', content: [{ type: 'text', text: 'work', text_elements: [] }] }
const command = (id: string, status: string, output: string | null = null): Rec => ({ type: 'commandExecution', id, command: 'echo ' + id, cwd: '/TMP/cwd', source: 'agent', status, commandActions: [{ type: 'unknown', command: 'echo ' + id }], aggregatedOutput: output, exitCode: output === null ? null : 0 })
async function fixture() {
  const fake = createFakeAppServer()
  const clock = manualClock()
  const hub = createCodexHub({ executable: '/fake/codex', args: ['app-server'], env: {}, cwd: CWD }, { transportFactory: fake.transportFactory, clock })
  await hub.ready
  fake.on('thread/start', () => threadAnswer())
  fake.on('thread/unsubscribe', () => ({}))
  fake.on('turn/interrupt', () => ({}))
  fake.on('model/list', () => ({ data: [], nextCursor: null }))
  fake.on('collaborationMode/list', () => ({ data: [] }))
  fake.on('thread/backgroundTerminals/list', () => ({ data: [], nextCursor: null }))
  fake.on('thread/goal/get', () => ({ goal: null }))
  fake.on('mcpServerStatus/list', () => ({ data: [], nextCursor: null }))
  let turns = 0
  fake.on('turn/start', () => ({ turn: { id: 'turn-' + ++turns, status: 'inProgress', items: [] } }))
  const session = await openCodexSession({ hub, release: hub.retain(), target: { kind: 'create', cwd: CWD }, cwd: CWD, config: {}, prefs: memoryCodexPrefs({}), executable: { path: '/fake/codex', source: 'env', version: '0.160.1' }, host: { debug: () => undefined }, clock }) as import('../src/agent/session.js').AgentSession
  const events: Event[] = []
  session.subscribe(batch => events.push(...batch))
  const ctx = { on: () => () => undefined, get: () => undefined, logger: { warn: () => undefined, info: () => undefined, debug: () => undefined } } as never
  const channel = createChannel(ctx, session, { model: 'Codex', provider: 'codex', cwd: CWD, backendLabel: 'Codex', activity: false })
  const note = (method: string, params: Rec): void => fake.notify(method, { threadId: THREAD, ...params })
  const start = async (completeUser = true): Promise<void> => {
    await session.submit({ text: 'work', clientMessageId: 'client' }, 'turn')
    note('turn/started', { turn: { id: 'turn-1', status: 'inProgress', items: [] } })
    note('item/started', { turnId: 'turn-1', item: user })
    if (completeUser) note('item/completed', { turnId: 'turn-1', item: user })
    check('native user is projected once', await settled(() => channel.rows.filter(row => row.kind === 'user').length === 1))
  }
  const crash = async (): Promise<void> => {
    fake.crash()
    check('hub enters retry without a native turn completion', await settled(() => hub.state === 'restarting'))
    clock.advance(500)
    check('hub reconnects', await settled(() => hub.state === 'ready'))
  }
  const close = async (): Promise<void> => { channel.releaseContributions(); await session.dispose(); await hub.close() }
  return { fake, clock, hub, session, channel, events, note, start, crash, close }
}

// The persisted snapshot completes a tool and an already-streaming reply in
// the same native turn, alongside an already-completed tool.
{
  const f = await fixture()
  try {
    await f.start()
    f.note('item/started', { turnId: 'turn-1', item: command('done', 'inProgress') })
    f.note('item/completed', { turnId: 'turn-1', item: command('done', 'completed', 'old-output') })
    f.note('item/started', { turnId: 'turn-1', item: command('running', 'inProgress') })
    f.note('item/started', { turnId: 'turn-1', item: { type: 'agentMessage', id: 'reply', text: '', phase: 'final_answer' } })
    f.note('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'reply', delta: 'partial' })
    f.note('thread/tokenUsage/updated', { turnId: 'turn-1', tokenUsage: { total: {}, last: { totalTokens: 200, inputTokens: 180, outputTokens: 20, cachedInputTokens: 100 }, modelContextWindow: 128000 } })
    check('partial reply is painted before outage', await settled(() => f.channel.rows.some(row => row.kind === 'assistant' && row.text === 'partial')))
    const counters = JSON.stringify({ tokens: f.channel.tokens, cost: f.channel.mainCost })
    f.fake.on('thread/resume', () => threadAnswer({ initialTurnsPage: { data: [{ id: 'turn-1', status: 'completed', items: [user, command('done', 'completed', 'old-output'), command('running', 'completed', 'recovered-output'), { type: 'agentMessage', id: 'reply', text: 'partial recovered-final', phase: 'final_answer' }] }], nextCursor: null } }))
    await f.crash()
    check('same-turn completed reply replaces partial, not another bubble', await settled(() => f.channel.rows.some(row => row.kind === 'assistant' && row.text === 'partial recovered-final')) && f.channel.rows.filter(row => row.kind === 'assistant').length === 1)
    check('recovered result settles the original running tool card', f.channel.rows.filter(row => row.tool?.callId === 'running').length === 1 && f.channel.rows.find(row => row.tool?.callId === 'running')?.tool?.resultText === 'recovered-output')
    check('already-painted user and completed tool do not repeat', f.channel.rows.filter(row => row.kind === 'user').length === 1 && f.channel.rows.filter(row => row.tool?.callId === 'done').length === 1)
    check('billing and usage survive recovery without double booking', JSON.stringify({ tokens: f.channel.tokens, cost: f.channel.mainCost }) === counters)
    check('transport outage does not fabricate an interrupted result', !f.events.some(event => event.type === 'tool.result' && event.callId === 'running' && event.isError) && !f.channel.rows.some(row => row.kind === 'interrupt'))
    check('foreground turn boundaries remain valid across recovery', agentEventInvariantViolations(f.events, { enqueuedInputs: [{ id: 'client', beforeEvent: 0 }] }).length === 0)
    const before = f.events.length
    await f.crash()
    check('a repeated resume of completed facts adds no transcript facts', !f.events.slice(before).some(event => event.type === 'user.message' || event.type === 'assistant.message' || event.type === 'tool.call' || event.type === 'tool.result'))
  } finally { await f.close() }
}

// Native turn remains active. Its started-only user must not repeat and a
// parked follow-up cannot start until the server's real turn completion.
{
  const f = await fixture()
  try {
    await f.start(false)
    f.note('item/started', { turnId: 'turn-1', item: command('active', 'inProgress') })
    check('running tool card exists', await settled(() => f.channel.rows.some(row => row.tool?.callId === 'active')))
    f.fake.on('thread/resume', () => threadAnswer({ thread: { id: THREAD, cwd: CWD, status: { type: 'active' } }, initialTurnsPage: { data: [{ id: 'turn-1', status: 'inProgress', items: [user, command('active', 'inProgress')] }], nextCursor: null } }))
    f.fake.crash()
    check('active outage is offline', await settled(() => f.hub.state === 'restarting'))
    await f.session.submit({ text: 'queued', clientMessageId: 'queued' }, 'followup')
    f.clock.advance(500)
    check('active resume waits for native turn instead of draining follow-up', await settled(() => f.hub.state === 'ready' && f.session.status === 'running' && f.events.some(event => event.type === 'notice' && event.key === 'codex-connection' && event.level === 'info')) && f.fake.requests.filter(request => request.method === 'turn/start').length === 1)
    check('active resume does not duplicate prior user/tool', f.channel.rows.filter(row => row.kind === 'user').length === 1 && f.channel.rows.filter(row => row.tool?.callId === 'active').length === 1)
    f.note('item/completed', { turnId: 'turn-1', item: command('active', 'completed', 'continued-output') })
    f.note('turn/completed', { turn: { id: 'turn-1', status: 'completed', items: [] } })
    check('live continuation completes same card then drains exactly once', await settled(() => f.channel.rows.find(row => row.tool?.callId === 'active')?.tool?.resultText === 'continued-output' && f.fake.requests.filter(request => request.method === 'turn/start').length === 2))
    f.note('turn/completed', { turn: { id: 'turn-2', status: 'completed', items: [] } })
  } finally { await f.close() }
}

// A completely new missed native turn is admitted normally, while previous
// closed turns are skipped. Resume notifications arriving before the response
// wait behind the authoritative snapshot, then deduplicate by native item ID.
{
  const f = await fixture()
  try {
    await f.start()
    f.note('turn/completed', { turn: { id: 'turn-1', status: 'completed', items: [user] } })
    check('initial turn is idle', await settled(() => !f.channel.working))
    const newUser = { ...user, id: 'missing-user', clientId: 'missing', content: [{ type: 'text', text: 'missed prompt', text_elements: [] }] }
    const completed = { id: 'turn-missed', status: 'completed', items: [newUser, command('missed-command', 'completed', 'missed-output'), { type: 'agentMessage', id: 'missed-reply', text: 'missed-final', phase: 'final_answer' }] }
    f.fake.on('thread/resume', (_params, request) => {
      f.note('item/started', { turnId: 'turn-missed', item: newUser })
      f.note('item/completed', { turnId: 'turn-missed', item: completed.items[2] })
      f.fake.reply(request.id, threadAnswer({ initialTurnsPage: { data: [completed, { id: 'turn-1', status: 'completed', items: [user] }], nextCursor: null } }))
      return NO_REPLY
    })
    await f.crash()
    check('new missed turn replays complete user/tool/reply facts', await settled(() => f.channel.rows.some(row => row.text === 'missed-final') && f.channel.rows.some(row => row.tool?.resultText === 'missed-output')))
    check('early replay notifications do not duplicate missing-turn facts', f.channel.rows.filter(row => row.kind === 'user').length === 2 && f.channel.rows.filter(row => row.text === 'missed-final').length === 1 && f.channel.rows.filter(row => row.tool?.callId === 'missed-command').length === 1)
    check('missed turn keeps global sequence and lifecycle ordered', agentEventInvariantViolations(f.events, { enqueuedInputs: [{ id: 'client', beforeEvent: 0 }] }).length === 0)
  } finally { await f.close() }
}
// More than the first twenty resumed turns are missing. The old unfinished
// turn is on a second page and must settle before every later turn is replayed.
{
  const f = await fixture()
  try {
    await f.start()
    f.note('item/started', { turnId: 'turn-1', item: command('older-active', 'inProgress') })
    check('long-gap original running card exists', await settled(() => f.channel.rows.some(row => row.tool?.callId === 'older-active')))
    const missed = Array.from({ length: 25 }, (_, index) => ({ id: 'missed-' + (index + 1), status: 'completed', items: [
      { type: 'userMessage', id: 'gap-user-' + index, clientId: 'gap-client-' + index, content: [{ type: 'text', text: 'gap prompt ' + index, text_elements: [] }] },
      { type: 'agentMessage', id: 'gap-reply-' + index, text: 'gap reply ' + index, phase: 'final_answer' },
    ] })).reverse()
    const original = { id: 'turn-1', status: 'completed', items: [user, command('older-active', 'completed', 'older-recovered-output')] }
    const cursor = 'opaque:gap/older+=='
    let pages = 0
    f.fake.on('thread/resume', () => threadAnswer({ initialTurnsPage: { data: missed.slice(0, 20), nextCursor: cursor } }))
    f.fake.on('thread/turns/list', (params, request) => {
      pages += 1
      check('gap paging keeps full items and exact opaque cursor', params.cursor === cursor && params.itemsView === 'full' && params.sortDirection === 'desc' && params.limit === 20)
      // This completion is also in the page; the rejoin hold must deduplicate it.
      f.note('item/completed', { turnId: 'missed-25', item: missed[0]!.items[1] })
      f.fake.reply(request.id, { data: [...missed.slice(20), original], nextCursor: null })
      return NO_REPLY
    })
    await f.crash()
    check('long gap restores all 25 replies, once each', await settled(() => f.channel.rows.filter(row => row.kind === 'assistant' && row.text.startsWith('gap reply ')).length === 25) && Array.from({ length: 25 }, (_, index) => 'gap reply ' + index).every(text => f.channel.rows.filter(row => row.kind === 'assistant' && row.text === text).length === 1), JSON.stringify({ replies: f.channel.rows.filter(row => row.kind === 'assistant').map(row => row.text), events: f.events.filter(event => event.type === 'assistant.message').map(event => event.blocks) }))
    check('original older running tool completes on the same card', f.channel.rows.filter(row => row.tool?.callId === 'older-active').length === 1 && f.channel.rows.find(row => row.tool?.callId === 'older-active')?.tool?.resultText === 'older-recovered-output')
    check('long gap keeps all user anchors unique', f.channel.rows.filter(row => row.kind === 'user').length === 26 && new Set(f.channel.rows.filter(row => row.kind === 'user').map(row => row.anchor)).size === 26)
    check('gap fill stops exactly when it reaches retained original turn', pages === 1 && f.events.filter(event => event.type === 'turn.end').length === 26)
    check('multi-page gap lifecycle and global seq remain ordered', agentEventInvariantViolations(f.events, { enqueuedInputs: [{ id: 'client', beforeEvent: 0 }] }).length === 0)
  } finally { await f.close() }
}

// A bounded failure is actionable, never a false reconnect success or a
// skipped history followed by a new queued model request.
for (const loop of [false, true]) {
  const f = await fixture()
  try {
    await f.start()
    f.note('item/started', { turnId: 'turn-1', item: command('unreachable-active', 'inProgress') })
    let pages = 0
    const page = (index: number) => ({ data: Array.from({ length: 20 }, (_, item) => ({ id: 'unseen-' + index + '-' + item, status: 'completed', items: [] })), nextCursor: loop ? 'looping-cursor' : 'budget-cursor-' + index })
    f.fake.on('thread/resume', () => threadAnswer({ initialTurnsPage: page(0) }))
    f.fake.on('thread/turns/list', () => page(++pages))
    await f.crash()
    check((loop ? 'cyclic cursor' : '50-page budget') + ' produces explicit recovery warning', await settled(() => f.events.some(event => event.type === 'notice' && event.key === 'codex-connection' && event.level === 'warning' && event.text.includes('recovery'))))
    check('incomplete gap never reports success or starts another turn', !f.events.some(event => event.type === 'notice' && event.key === 'codex-connection' && event.level === 'info') && f.fake.requests.filter(request => request.method === 'turn/start').length === 1)
    check('gap reads are bounded at the declared budget', pages === (loop ? 1 : 49))
  } finally { await f.close() }
}
console.log('\nverify-codex-reconnect OK (' + passed + ' checks)')
