/**
 * Production Codex Plan review / MCP elicitation on the fake app-server + hub.
 * No credentials or real model calls. Owns/disposes every session and hub.
 * Run: node --import tsx/esm scripts/verify-codex-plans.ts
 */
import assert from 'node:assert/strict'
import type { AgentEvent, QuestionRequestView } from '../src/agent/events.js'
import { setLang, t } from '../src/i18n.js'
import { memoryCodexPrefs } from '../src/backends/codex/prefs.js'
import { CLIENT, NOTIFY, SERVER_REQUEST } from '../src/backends/codex/protocol/index.js'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PLAN_IMPLEMENTATION_PROMPT } from '../src/backends/codex/session/prompts.js'
import { createFakeAppServer } from './lib/codex-fake-app-server.js'
import { CWD, THREAD, manualClock, threadAnswer } from './lib/codex-session-harness.js'

setLang('en')
// Run against an integration tree without copying or modifying its sources.
const runtimeRoot = process.env.CODEX_TEST_SOURCE_ROOT ?? fileURLToPath(new URL('../', import.meta.url))
const { createCodexHub } = await import(pathToFileURL(resolve(runtimeRoot, 'src/backends/codex/rpc/hub.js')).href) as typeof import('../src/backends/codex/rpc/hub.js')
const { openCodexSession } = await import(pathToFileURL(resolve(runtimeRoot, 'src/backends/codex/session/session.js')).href) as typeof import('../src/backends/codex/session/session.js')
type Rec = Record<string, unknown>
const runtimeI18n = await import(pathToFileURL(resolve(runtimeRoot, 'src/i18n.js')).href) as typeof import('../src/i18n.js')
runtimeI18n.setLang('en')
let passed = 0
const failed: string[] = []
function check(name: string, actual: unknown, expected: unknown = true): void {
  try { assert.deepEqual(actual, expected); passed += 1; console.log('PASS', name) }
  catch (error) { failed.push(name); console.error('FAIL', name, error instanceof Error ? error.message : String(error)) }
}
// 固定窗:探针 drain asynchronous fake transport messages, not a latency assertion.
const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })
async function fixture() {
  const fake = createFakeAppServer()
  const clock = manualClock()
  const hub = createCodexHub({ executable: '/fake/codex', args: ['app-server'], env: {}, cwd: CWD }, { transportFactory: fake.transportFactory, clock, debug: () => {} })
  await hub.ready
  let starts = 0
  fake.on(CLIENT.threadStart, () => threadAnswer({ thread: { id: starts++ === 0 ? THREAD : 'new-thread', cwd: CWD, turns: [], status: { type: 'idle' } } }))
  fake.on(CLIENT.modelList, () => ({ data: [], nextCursor: null }))
  fake.on(CLIENT.collaborationModeList, () => ({ data: [{ mode: 'default' }, { mode: 'plan' }] }))
  fake.on(CLIENT.threadSettingsUpdate, () => ({}))
  fake.on(CLIENT.threadUnsubscribe, () => ({}))
  fake.on(CLIENT.turnInterrupt, () => ({}))
  let turns = 0
  fake.on(CLIENT.turnStart, () => ({ turn: { id: 'turn-' + ++turns, status: 'inProgress', items: [] } }))
  const events: AgentEvent[] = []
  const session = await openCodexSession({ hub, release: hub.retain(), target: { kind: 'create', cwd: CWD }, cwd: CWD, prefs: memoryCodexPrefs({}), executable: { path: '/fake/codex', source: 'env', version: '0.160.1' }, host: { debug: () => {} }, clock })
  session.subscribe(batch => events.push(...batch))
  await settle()
  const sent = (method: string): Rec[] => fake.requests.filter(request => request.method === method).map(request => request.params)
  const last = (method: string): Rec => sent(method).at(-1) ?? {}
  const notify = async (method: string, params: Rec): Promise<void> => { fake.notify(method, { threadId: session.ref.sessionId, ...params }); await settle() }
  const ask = (): QuestionRequestView => {
    const event = events.filter(event => event.type === 'question.request').at(-1)
    if (event?.type !== 'question.request') throw new Error('No question request')
    return event.request
  }
  const offer = async (): Promise<QuestionRequestView> => {
    const accepted = await session.submit({ text: '/plan outline the task', clientMessageId: 'plan-' + (turns + 1) }, 'followup')
    assert.equal(accepted.accepted, true)
    const id = 'turn-' + turns
    await notify(NOTIFY.turnStarted, { turn: { id, status: 'inProgress', items: [] } })
    await notify(NOTIFY.itemStarted, { turnId: id, item: { type: 'plan', id: 'plan-' + id, text: '' } })
    await notify(NOTIFY.itemCompleted, { turnId: id, item: { type: 'plan', id: 'plan-' + id, text: '1. Keep all constraints.\n2. Implement safely.' } })
    await notify(NOTIFY.turnCompleted, { turn: { id, status: 'completed', items: [], error: null } })
    return ask()
  }
  return { fake, hub, clock, session, events, sent, last, notify, ask, offer, close: async () => { await session.dispose(); await hub.close() } }
}
async function scenario(name: string, action: () => Promise<void>): Promise<void> {
  console.log('\n' + name)
  try { await action() } catch (error) { failed.push(name); console.error('FAIL', name, error) }
}

await scenario('Plan ask, stay and implementation', async () => {
  const f = await fixture()
  try {
    const ask = await f.offer()
    check('plan prompt sent through normal turn input', JSON.stringify(f.last(CLIENT.turnStart).input).includes('outline the task'))
    check('Plan review carries full markdown', ask.questions[0]?.detail?.includes('Keep all constraints.'))
    check('Plan review intent owns implementation labels', ask.questions[0]?.intent?.kind, 'plan-review')
    f.session.capabilities.questions!.respond(ask.requestId, { answers: [{ selected: [t('codex-plan-stay')] }] })
    await settle()
    check('stay settles review without starting a turn', f.sent(CLIENT.turnStart).length, 1)
    check('stay keeps Plan selected', f.session.capabilities.modes!.current(), 'plan')
    const implement = await f.offer()
    f.session.capabilities.questions!.respond(implement.requestId, { answers: [{ selected: [t('codex-plan-yes')] }] })
    await f.fake.waitForRequest(CLIENT.turnStart, { after: f.fake.requests.length - 1 })
    await settle()
    check('implementation switches collaboration back to Default', f.session.capabilities.modes!.current(), 'auto')
    check('implementation uses canonical native prompt', JSON.stringify(f.last(CLIENT.turnStart).input).includes(PLAN_IMPLEMENTATION_PROMPT))
    check('implementation does not escalate permission', f.last(CLIENT.threadSettingsUpdate).approvalPolicy, 'on-request')
  } finally { await f.close() }
})

await scenario('Plan command grammar: `on`/`off` are the switches, anything else is the prompt', async () => {
  const f = await fixture()
  try {
    // `/plan on` is the TUI catalog's own on token (the `/plan` completion
    // child): it must mean the BARE switch, or the word "on" is submitted as
    // the prompt.
    const accepted = await f.session.submit({ text: '/plan on', clientMessageId: 'plan-grammar-on' }, 'followup')
    await settle()
    check('`/plan on` is accepted', accepted.accepted, true)
    check('`/plan on` still selects Plan', f.session.capabilities.modes!.current(), 'plan')
    check('`/plan on` starts no turn (no "on" prompt)', f.sent(CLIENT.turnStart).length, 0)
    // `/plan <message>` keeps upstream codex semantics: enter plan mode and
    // submit the message as the turn's prompt.
    await f.session.submit({ text: '/plan outline the task', clientMessageId: 'plan-grammar-message' }, 'followup')
    await settle()
    check('message argument starts a turn with that prompt', JSON.stringify(f.last(CLIENT.turnStart).input).includes('outline the task'))
    // `/plan off` is the catalog's off token (its other completion child): it
    // must LEAVE Plan, and never submit the word "off" as a prompt.
    await f.session.submit({ text: '/plan off', clientMessageId: 'plan-grammar-off' }, 'followup')
    await settle()
    check('`/plan off` leaves Plan', f.session.capabilities.modes!.current() !== 'plan')
    check('`/plan off` starts no turn (no "off" prompt)', f.sent(CLIENT.turnStart).length, 1)
  } finally { await f.close() }
})

await scenario('Plan clear context rebinds thread and preserves tool output', async () => {
  const f = await fixture()
  try {
    const ask = await f.offer()
    f.session.capabilities.questions!.respond(ask.requestId, { answers: [{ selected: [t('codex-plan-clear')] }] })
    await f.fake.waitForRequest(CLIENT.threadStart, { after: f.fake.requests.length - 1 })
    await f.fake.waitForRequest(CLIENT.turnStart, { after: f.fake.requests.length - 1 })
    await settle()
    check('clear context session ref rebinds new real thread', f.session.ref.sessionId, 'new-thread')
    check('clear context sends carried plan to new thread', f.last(CLIENT.turnStart).threadId === 'new-thread' && JSON.stringify(f.last(CLIENT.turnStart).input).includes('Keep all constraints.'))
    check('clear context announces new session identity', f.events.some(event => event.type === 'session.ready' && event.sessionId === 'new-thread'))
    check('clear context unsubscribes old thread', f.sent(CLIENT.threadUnsubscribe).some(params => params.threadId === THREAD))
    await f.notify(NOTIFY.turnStarted, { turn: { id: 'turn-2', status: 'inProgress', items: [] } })
    await f.notify(NOTIFY.itemStarted, { turnId: 'turn-2', item: { type: 'commandExecution', id: 'command-after-clear', command: 'echo hello', cwd: CWD, status: 'inProgress' } })
    await f.notify(NOTIFY.commandOutputDelta, { turnId: 'turn-2', itemId: 'command-after-clear', delta: 'hello after clear\n' })
    f.clock.advance(100)
    await settle()
    check('clear context keeps real tool.output buffer alive', f.events.some(event => event.type === 'tool.output' && event.callId === 'command-after-clear' && event.text.includes('hello after clear')))
  } finally { await f.close() }
})

await scenario('form elicitation validates and reasks only invalid fields', async () => {
  const f = await fixture()
  try {
    const answer = f.fake.request(SERVER_REQUEST.elicitation, { threadId: THREAD, serverName: 'demo', mode: 'form', message: 'Provide values', requestedSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 1 }, label: { type: 'string' } }, required: ['count', 'label'] } })
    await settle()
    const first = f.ask()
    check('elicitation schema plus send consent reaches production questions', first.questions.length, 3)
    f.session.capabilities.questions!.respond(first.requestId, { answers: [{ selected: [], custom: '0' }, { selected: [], custom: 'kept' }, { selected: [t('elicit-send')] }] })
    await settle()
    const retry = f.ask()
    check('elicitation invalid integer creates fresh ask id', retry.requestId !== first.requestId)
    check('elicitation retains valid fields and reasks only invalid', retry.questions.length, 1)
    f.session.capabilities.questions!.respond(retry.requestId, { answers: [{ selected: [], custom: '2' }] })
    check('elicitation actual RPC typed answer', (await answer).result, { action: 'accept', content: { count: 2, label: 'kept' }, _meta: null })
    await f.notify(NOTIFY.serverRequestResolved, { requestId: 0 })
    check('elicitation resolved settles current retry ask', f.events.some(event => event.type === 'question.settled' && event.requestId === retry.requestId))
  } finally { await f.close() }
})

await scenario('URL elicitation cancel + missing URL fallback', async () => {
  const f = await fixture()
  try {
    const result = f.fake.request(SERVER_REQUEST.elicitation, { threadId: THREAD, serverName: 'demo', mode: 'url', url: 'https://example.invalid/authorize', message: 'Authorize outside terminal' })
    await settle()
    const ask = f.ask()
    check('URL elicitation includes confirmation request', ask.questions.length, 1)
    f.session.capabilities.questions!.cancel(ask.requestId)
    check('URL elicitation cancel exact wire response', (await result).result, { action: 'cancel', content: null, _meta: null })
    await f.notify(NOTIFY.serverRequestResolved, { requestId: 0 })
    check('URL cancel does not interrupt regular model turn', f.sent(CLIENT.turnInterrupt).length, 0)
    const missing = f.fake.request(SERVER_REQUEST.elicitation, { threadId: THREAD, serverName: 'demo', mode: 'url' })
    check('missing URL declines rather than hanging', (await missing).result, { action: 'decline', content: null, _meta: null })
  } finally { await f.close() }
})

await scenario('question secret input and native auto-resolution timer', async () => {
  const f = await fixture()
  try {
    const result = f.fake.request(SERVER_REQUEST.userInput, { threadId: THREAD, turnId: 'turn-q', itemId: 'question-q', isBlocking: false, autoResolutionMs: 100, questions: [{ id: 'choice', header: 'Select', question: 'Choose', isOther: false, isSecret: true, options: [{ label: 'First' }, { label: 'Second' }] }] })
    await settle()
    check('native secret marker reaches questionnaire', f.ask().questions[0]?.secret)
    f.clock.advance(100)
    check('auto-resolution chooses first native option', (await result).result, { answers: { choice: { answers: ['First'] } } })
    check('auto-resolution has explicit notice', f.events.some(event => event.type === 'notice' && event.key?.startsWith('codex-auto-answer:')))
  } finally { await f.close() }
})

console.log('\nCodex Plan/elicitation: ' + passed + ' passed, ' + failed.length + ' failed')
if (failed.length > 0) process.exitCode = 1
